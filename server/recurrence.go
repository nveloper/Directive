package main

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/teambition/rrule-go"
)

// A repeating task stores its rule as the value of an RFC 5545 RRULE
// ("FREQ=WEEKLY;BYDAY=MO"), anchored on the task's due date. It is the same
// string a phone's reminders app sends and expects back, so a rule made there
// - even one the web app has no preset for - survives the round trip.
//
// Finishing a repeating task closes that occurrence and files the next one as
// a new task. The finished one keeps its comments and shows up under Done like
// any other; the rule moves forward onto the new one.

const maxRecurrenceLen = 300

// normalizeRecurrence tidies a rule and checks it parses. An empty rule means
// "does not repeat". A leading "RRULE:" is accepted and dropped, so a value
// copied from an .ics file works.
func normalizeRecurrence(rule string) (string, error) {
	rule = strings.TrimSpace(rule)
	rule = strings.TrimPrefix(rule, "RRULE:")
	if rule == "" {
		return "", nil
	}
	if len(rule) > maxRecurrenceLen {
		return "", errors.New("repeat rule is too long")
	}
	if strings.ContainsAny(rule, "\r\n") {
		return "", errors.New("repeat rule must be a single RRULE value")
	}
	opt, err := rrule.StrToROption(rule)
	if err != nil {
		return "", errors.New("repeat rule is not a valid RRULE: " + err.Error())
	}
	switch opt.Freq {
	case rrule.YEARLY, rrule.MONTHLY, rrule.WEEKLY, rrule.DAILY:
	default:
		// A task is due on a date, so anything finer than a day has no
		// meaning here and would spawn a task per hour.
		return "", errors.New("a task can repeat daily, weekly, monthly or yearly")
	}
	if opt.Interval < 0 || opt.Interval > 999 {
		return "", errors.New("repeat interval must be between 1 and 999")
	}
	return rule, nil
}

func buildRule(rule string, dtstart time.Time) (*rrule.RRule, error) {
	opt, err := rrule.StrToROption(rule)
	if err != nil {
		return nil, err
	}
	opt.Dtstart = dtstart
	return rrule.NewRRule(*opt)
}

// nextOccurrence finds the due date the next task in the series should have:
// the first occurrence after the current due date that is not already in the
// past. Catching up on a weekly task finished three weeks late should give
// one task for this week, not three more that are overdue on arrival.
//
// The returned rule is the one the next task carries. It is the same string,
// except that a COUNT is reduced by the occurrences already used, because the
// next task's due date becomes the new anchor and COUNT counts from it.
func nextOccurrence(rule, dueDate, todayStr string) (string, string, bool) {
	due, ok := parseDueDate(dueDate)
	if !ok {
		return "", "", false
	}
	today, ok := parseDueDate(todayStr)
	if !ok {
		return "", "", false
	}
	r, err := buildRule(rule, due)
	if err != nil {
		return "", "", false
	}
	after := due
	if yesterday := today.AddDate(0, 0, -1); yesterday.After(after) {
		after = yesterday
	}
	next := r.After(after, false)
	if next.IsZero() {
		// UNTIL has passed or COUNT is used up: the series is over.
		return "", "", false
	}

	nextRule := rule
	if count := ruleCount(rule); count > 0 {
		used := len(r.Between(due, next, true)) - 1 // occurrences before next
		remaining := count - used
		if remaining <= 0 {
			return "", "", false
		}
		nextRule = setRuleCount(rule, remaining)
	}
	return nextRule, next.Format("2006-01-02"), true
}

func ruleCount(rule string) int {
	for _, part := range strings.Split(rule, ";") {
		if k, v, ok := strings.Cut(part, "="); ok && strings.EqualFold(k, "COUNT") {
			n, _ := strconv.Atoi(v)
			return n
		}
	}
	return 0
}

func setRuleCount(rule string, n int) string {
	parts := strings.Split(rule, ";")
	for i, part := range parts {
		if k, _, ok := strings.Cut(part, "="); ok && strings.EqualFold(k, "COUNT") {
			parts[i] = "COUNT=" + strconv.Itoa(n)
		}
	}
	return strings.Join(parts, ";")
}

// rollRecurrence runs after a task has been marked done. If it repeats, the
// finished task gives up its rule and the next occurrence is filed as a new
// task with the same title, department, assignee and checklist (unticked).
// It returns the new task's id, or 0 when nothing was created.
//
// A reminders app that understands repetition advances the due date itself
// and sends the task back unfinished, so this never runs for it; one that
// does not simply marks it complete, and gets the next occurrence from here.
func rollRecurrence(db *sql.DB, ctx context.Context, origin string, taskID int64) int64 {
	var rule, due, title, description, assignee, priority, icon string
	var assigneeID, createdBy sql.NullInt64
	var deptStr sql.NullString
	var visible int
	err := db.QueryRow(`SELECT recurrence, due_date, title, description, dept_id, assignee, assignee_id,
			priority, calendar_visible, created_by, icon
		FROM tasks WHERE id = ? AND status = 'done' AND deleted_at = ''`, taskID).
		Scan(&rule, &due, &title, &description, &deptStr, &assignee, &assigneeID, &priority, &visible, &createdBy, &icon)
	if err != nil || rule == "" {
		return 0
	}
	nextRule, nextDue, ok := nextOccurrence(rule, due, today())
	// The finished occurrence stops repeating either way: reopening it later
	// must not start a second copy of the series.
	db.Exec(`UPDATE tasks SET recurrence = '' WHERE id = ?`, taskID)
	if !ok {
		return 0
	}

	now := time.Now().UTC().Format(time.RFC3339)
	var dept, aID, creator interface{}
	if deptStr.Valid && deptStr.String != "" {
		dept = deptStr.String
	}
	if assigneeID.Valid {
		aID = assigneeID.Int64
	}
	if createdBy.Valid {
		creator = createdBy.Int64
	}
	res, err := db.Exec(`INSERT INTO tasks (title, description, dept_id, assignee, assignee_id, priority, due_date, status,
			calendar_visible, recurrence, icon, created_by, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?)`,
		title, description, dept, assignee, aID, priority, nextDue, visible, nextRule, icon, creator, now, now)
	if err != nil {
		return 0
	}
	newID, _ := res.LastInsertId()
	db.Exec(`INSERT INTO checklist_items (task_id, body, done, position, created_at)
		SELECT ?, body, 0, position, ? FROM checklist_items WHERE task_id = ? ORDER BY position, id`,
		newID, now, taskID)
	// The icon comes along; attachments stay with the occurrence they were
	// added to, since copying files every week would only grow the database.
	if icon == "image" {
		db.Exec(`INSERT OR REPLACE INTO images (id, mime, data, updated_at)
			SELECT ?, mime, data, updated_at FROM images WHERE id = ?`, taskIconImageID(newID), taskIconImageID(taskID))
	}
	logActivityCtx(db, ctx, origin, "scheduled the next", "task", strconv.FormatInt(newID, 10), title+" ("+nextDue+")")
	return newID
}
