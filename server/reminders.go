package main

import (
	"context"
	"database/sql"
	"log"
	"net/http"
	"strings"
	"time"
)

// Due-date reminders. Once a day, at a time an administrator picks, whoever
// a task is assigned to is told about the unfinished ones due today and the
// ones due tomorrow. They arrive as ordinary notifications, so the bell, the
// badge and desktop alerts all carry them without anything new.
//
// Like the backups, the time is the server's local time, and a day whose
// time passed while the server was down is caught up as soon as it starts.

const (
	notifyDueToday    = "dueToday"
	notifyDueTomorrow = "dueTomorrow"

	defaultReminderTime = "09:00"
)

type reminderSettings struct {
	Enabled bool   `json:"enabled"`
	Time    string `json:"time"`
}

// Reminders are on unless someone turned them off, so the setting that is
// stored is the "off".
func loadReminderSettings(db *sql.DB) reminderSettings {
	s := reminderSettings{Enabled: getSetting(db, "reminders_off") != "1", Time: getSetting(db, "reminder_time")}
	if !backupTimeRe.MatchString(s.Time) {
		s.Time = defaultReminderTime
	}
	return s
}

// sendDueReminders files one notification per assigned, unfinished task due
// on day or the day after, and returns how many it filed.
func sendDueReminders(db *sql.DB, day time.Time) int {
	todayStr := day.Format("2006-01-02")
	tomorrowStr := day.AddDate(0, 0, 1).Format("2006-01-02")
	rows, err := db.Query(`SELECT id, title, assignee_id, due_date FROM tasks
		WHERE deleted_at = '' AND status <> 'done' AND assignee_id IS NOT NULL AND due_date IN (?, ?)
		ORDER BY due_date, id`, todayStr, tomorrowStr)
	if err != nil {
		log.Printf("reminders: %v", err)
		return 0
	}
	type due struct {
		id, assignee int64
		title, date  string
	}
	var list []due
	for rows.Next() {
		var d due
		if rows.Scan(&d.id, &d.title, &d.assignee, &d.date) == nil {
			list = append(list, d)
		}
	}
	rows.Close()
	for _, d := range list {
		kind := notifyDueToday
		if d.date == tomorrowStr {
			kind = notifyDueTomorrow
		}
		// No request and no person behind these: the server is the sender.
		notify(db, context.Background(), "", d.assignee, kind, d.id, d.title)
	}
	return len(list)
}

// startReminderScheduler checks once a minute whether today's reminders are due.
func startReminderScheduler(db *sql.DB) {
	check := func() {
		s := loadReminderSettings(db)
		if !s.Enabled {
			return
		}
		now := time.Now()
		day := now.Format("2006-01-02")
		if getSetting(db, "reminder_last_day") == day || now.Format("15:04") < s.Time {
			return
		}
		putSetting(db, "reminder_last_day", day)
		if n := sendDueReminders(db, now); n > 0 {
			log.Printf("reminders: %d sent", n)
		}
	}
	go func() {
		check()
		for range time.Tick(time.Minute) {
			check()
		}
	}()
}

// ---- administrator endpoints ----

func reminderStatus(db *sql.DB) map[string]interface{} {
	s := loadReminderSettings(db)
	now := time.Now()
	zone, _ := now.Zone()
	status := map[string]interface{}{
		"enabled":    s.Enabled,
		"time":       s.Time,
		"serverTime": now.Format("15:04"),
		"serverZone": zone,
	}
	if s.Enabled {
		status["nextAt"] = nextBackupAt(backupSettings{Time: s.Time}, getSetting(db, "reminder_last_day"), now).UTC().Format(time.RFC3339)
	}
	return status
}

func handleGetReminders(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, reminderStatus(db))
	}
}

func handleUpdateReminders(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req reminderSettings
		if err := readJSON(r, &req); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		req.Time = strings.TrimSpace(req.Time)
		if !backupTimeRe.MatchString(req.Time) {
			writeJSONError(w, http.StatusBadRequest, "reminder time must be HH:MM in 24-hour form")
			return
		}
		off := "1"
		if req.Enabled {
			off = ""
		}
		putSetting(db, "reminders_off", off)
		// Moving the time later does not re-send a day's reminders once they
		// have gone out: a second copy of the same list is only noise.
		putSetting(db, "reminder_time", req.Time)
		summary := "off"
		if req.Enabled {
			summary = "daily at " + req.Time
		}
		logActivity(db, r, "set", "due-date reminders", "reminder", summary)
		publishFor(r, "reminders")
		writeJSON(w, http.StatusOK, reminderStatus(db))
	}
}
