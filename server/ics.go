package main

import (
	"database/sql"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

func icsEscape(s string) string {
	r := strings.NewReplacer(`\`, `\`, `;`, `\;`, `,`, `\,`, "\n", `\n`)
	return r.Replace(s)
}

// foldLine wraps a content line to the 75-octet limit RFC 5545 sets, using the
// continuation form (CRLF followed by one space). Strict parsers reject longer
// lines outright. The split is on rune boundaries, not bytes, so a multi-byte
// title is not cut in half.
func foldLine(s string) string {
	const limit = 75
	if len(s) <= limit {
		return s + "\r\n"
	}
	var b strings.Builder
	width := 0
	// The first line may use all 75 octets; every continuation spends one on
	// the leading space.
	max := limit
	for _, r := range s {
		n := len(string(r))
		if width+n > max {
			b.WriteString("\r\n ")
			width = 1
			max = limit
		}
		b.WriteRune(r)
		width += n
	}
	b.WriteString("\r\n")
	return b.String()
}

// writeProp writes one iCalendar property, folded.
func writeProp(b *strings.Builder, format string, args ...interface{}) {
	b.WriteString(foldLine(fmt.Sprintf(format, args...)))
}

var isoDateRe = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})$`)

// parseDueDate accepts an ISO date (YYYY-MM-DD) or falls back to nothing.
func parseDueDate(s string) (time.Time, bool) {
	m := isoDateRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return time.Time{}, false
	}
	y, _ := strconv.Atoi(m[1])
	mo, _ := strconv.Atoi(m[2])
	d, _ := strconv.Atoi(m[3])
	return time.Date(y, time.Month(mo), d, 0, 0, 0, 0, time.UTC), true
}

// handleCalendarFeed serves a per-department, token-secured .ics feed suitable for
// subscribing to from Apple Calendar / Google Calendar / Outlook via a webcal(s):// URL.
// It is intentionally unauthenticated (calendar apps cannot do cookie/session login) and
// instead relies on the feed token being unguessable, like most "subscribe by URL" features.
func handleCalendarFeed(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimSuffix(r.PathValue("file"), ".ics")
		var deptID, deptName string
		err := db.QueryRow(`SELECT id, name FROM departments WHERE feed_token = ?`, token).Scan(&deptID, &deptName)
		if err != nil {
			http.NotFound(w, r)
			return
		}

		// calendar_visible is what the task's "Show in calendar" switch sets.
		// It used to be ignored here, so turning it off changed nothing.
		rows, err := db.Query(`SELECT id, title, assignee, priority, status, due_date, updated_at, recurrence
			FROM tasks WHERE (dept_id = ? OR dept_id LIKE ?) AND calendar_visible = 1 AND deleted_at = ''`, deptID, deptID+"/%")
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not build calendar feed")
			return
		}
		defer rows.Close()

		var b strings.Builder
		b.WriteString("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Directive//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\n")
		writeProp(&b, "X-WR-CALNAME:%s", icsEscape(deptName))
		// Tell subscribers how often to come back; without it clients fall back
		// to their own default, which is often several hours.
		b.WriteString("X-PUBLISHED-TTL:PT15M\r\n")
		b.WriteString("REFRESH-INTERVAL;VALUE=DURATION:PT15M\r\n")

		todayStr := today()
		for rows.Next() {
			var id int64
			var title, assignee, priority, status, due, updatedAt, recurrence string
			if err := rows.Scan(&id, &title, &assignee, &priority, &status, &due, &updatedAt, &recurrence); err != nil {
				continue
			}
			d, ok := parseDueDate(due)
			if !ok {
				continue
			}
			stamp, err := time.Parse(time.RFC3339, updatedAt)
			if err != nil {
				stamp = time.Now().UTC()
			}
			state := status
			if isOverdue(status, due, todayStr) {
				state = "overdue"
			}
			b.WriteString("BEGIN:VEVENT\r\n")
			writeProp(&b, "UID:task-%d@directive", id)
			writeProp(&b, "DTSTAMP:%s", stamp.UTC().Format("20060102T150405Z"))
			writeProp(&b, "DTSTART;VALUE=DATE:%s", d.Format("20060102"))
			// An all-day VEVENT ends the following day; without DTEND some
			// clients guess, and a few render a zero-length event.
			writeProp(&b, "DTEND;VALUE=DATE:%s", d.AddDate(0, 0, 1).Format("20060102"))
			// The upcoming occurrences of a repeating task show ahead of time;
			// finishing it files the next one with a fresh UID, and the
			// finished one no longer carries the rule, so nothing doubles up.
			if recurrence != "" && status != "done" {
				writeProp(&b, "RRULE:%s", recurrence)
			}
			writeProp(&b, "SUMMARY:%s", icsEscape(title))
			writeProp(&b, "DESCRIPTION:%s", icsEscape(fmt.Sprintf("Assigned to %s - Priority: %s - Status: %s", assignee, priority, state)))
			b.WriteString("END:VEVENT\r\n")
		}
		b.WriteString("END:VCALENDAR\r\n")

		w.Header().Set("Content-Type", "text/calendar; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write([]byte(b.String()))
	}
}
