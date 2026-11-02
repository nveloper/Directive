package main

import (
	"context"
	"database/sql"
	"net/http"
	"strconv"
	"time"
)

// Activity is the shared record of what happened, replacing a notification
// list that only ever echoed your own clicks back at you and vanished on
// reload. It is append-only and deliberately thin: who, what, and enough text
// to recognise the thing afterwards, including for rows that have since been
// deleted.
type Activity struct {
	ID        int64  `json:"id"`
	At        string `json:"at"`
	ActorID   int64  `json:"actorId"`
	ActorName string `json:"actorName"`
	Verb      string `json:"verb"`
	Subject   string `json:"subject"`
	SubjectID string `json:"subjectId"`
	Summary   string `json:"summary"`
}

// logActivity records one change. It never fails a request: losing a log line
// is not a reason to reject work that already succeeded.
func logActivity(db *sql.DB, r *http.Request, verb, subject, subjectID, summary string) {
	logActivityCtx(db, r.Context(), clientID(r), verb, subject, subjectID, summary)
}

// logActivityCtx is the same thing for a caller that has a context but no
// request to read a client id from - a CalDAV client, for instance.
func logActivityCtx(db *sql.DB, ctx context.Context, origin, verb, subject, subjectID, summary string) {
	u, _ := ctx.Value(userCtxKey).(*User)
	var actorID interface{}
	actorName := "Someone"
	if u != nil {
		actorID = u.ID
		actorName = u.DisplayName
	}
	db.Exec(`INSERT INTO activity (at, user_id, actor_name, verb, subject, subject_id, summary) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		time.Now().UTC().Format(time.RFC3339), actorID, actorName, verb, subject, subjectID, summary)
	events.publish("activity", origin)
}

func logActivityID(db *sql.DB, r *http.Request, verb, subject string, subjectID int64, summary string) {
	logActivity(db, r, verb, subject, strconv.FormatInt(subjectID, 10), summary)
}

const activityKeep = 500

// trimActivity keeps the feed from growing without bound. It is a feed, not an
// audit trail - the last few hundred entries are what anyone reads.
func trimActivity(db *sql.DB) {
	db.Exec(`DELETE FROM activity WHERE id <= (SELECT MAX(id) - ? FROM activity)`, activityKeep)
}

func handleListActivity(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := 50
		if v := r.URL.Query().Get("limit"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
				limit = n
			}
		}
		// ?task=<id> narrows the feed to one task's history, for the
		// timeline in its detail panel.
		where, args := "", []interface{}{}
		if v := r.URL.Query().Get("task"); v != "" {
			if _, err := strconv.ParseInt(v, 10, 64); err != nil {
				writeJSONError(w, http.StatusBadRequest, "invalid task id")
				return
			}
			where = `WHERE a.subject = 'task' AND a.subject_id = ?`
			args = append(args, v)
		}
		args = append(args, limit)
		rows, err := db.Query(`SELECT a.id, a.at, COALESCE(a.user_id, 0),
				COALESCE(NULLIF(u.display_name, ''), a.actor_name),
				a.verb, a.subject, a.subject_id, a.summary
			FROM activity a LEFT JOIN users u ON u.id = a.user_id
			`+where+`
			ORDER BY a.id DESC LIMIT ?`, args...)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not load activity")
			return
		}
		defer rows.Close()
		out := []Activity{}
		for rows.Next() {
			var a Activity
			if err := rows.Scan(&a.ID, &a.At, &a.ActorID, &a.ActorName, &a.Verb, &a.Subject, &a.SubjectID, &a.Summary); err != nil {
				writeJSONError(w, http.StatusInternalServerError, "could not read activity")
				return
			}
			out = append(out, a)
		}
		writeJSON(w, http.StatusOK, out)
	}
}
