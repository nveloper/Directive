package main

import (
	"context"
	"database/sql"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode"
)

// Notifications are the personal counterpart to the shared activity feed.
// Activity says what happened to everything; a notification says "this one
// is for you" - someone handed you a task, named you in a comment, or
// commented on work that is yours. Each belongs to one account, and only that
// account's open tabs are told when one arrives.

const (
	notifyAssigned  = "assigned"
	notifyMentioned = "mentioned"
	notifyCommented = "commented"
)

// Enough history to scroll back through a busy week; older ones are trimmed.
const notificationsKeep = 200

type Notification struct {
	ID        int64  `json:"id"`
	Kind      string `json:"kind"`
	TaskID    int64  `json:"taskId"`
	TaskTitle string `json:"taskTitle"`
	TaskGone  bool   `json:"taskGone"`
	ActorID   int64  `json:"actorId"`
	ActorName string `json:"actorName"`
	Summary   string `json:"summary"`
	CreatedAt string `json:"createdAt"`
	Read      bool   `json:"read"`
}

// notify files one notification for recipient. Nobody is notified about what
// they did themselves. Like logActivity it never fails the request that
// caused it.
func notify(db *sql.DB, ctx context.Context, origin string, recipient int64, kind string, taskID int64, summary string) {
	actor, _ := ctx.Value(userCtxKey).(*User)
	if recipient <= 0 || (actor != nil && actor.ID == recipient) {
		return
	}
	var active int
	db.QueryRow(`SELECT COUNT(*) FROM users WHERE id = ? AND status = ?`, recipient, statusActive).Scan(&active)
	if active == 0 {
		return
	}
	var actorID interface{}
	actorName := "Someone"
	if actor != nil {
		actorID = actor.ID
		actorName = actor.DisplayName
	}
	var task interface{}
	if taskID > 0 {
		task = taskID
	}
	if _, err := db.Exec(`INSERT INTO notifications (user_id, kind, task_id, actor_id, actor_name, summary, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		recipient, kind, task, actorID, actorName, summary, time.Now().UTC().Format(time.RFC3339)); err != nil {
		return
	}
	db.Exec(`DELETE FROM notifications WHERE user_id = ? AND id <= (
		SELECT MAX(id) - ? FROM notifications WHERE user_id = ?)`, recipient, notificationsKeep, recipient)
	events.publishUser(recipient, "notifications", origin)
}

func notifyReq(db *sql.DB, r *http.Request, recipient int64, kind string, taskID int64, summary string) {
	notify(db, r.Context(), clientID(r), recipient, kind, taskID, summary)
}

type mentionable struct {
	id    int64
	names []string // display name and username, lower-cased
}

// findMentions returns the accounts named in body as "@Display Name" or
// "@username". Display names can hold spaces, so rather than guess where a
// name ends, every active member's names are looked for - longest first, so
// "@Ada Lovelace" is not also read as a mention of someone called "Ada".
func findMentions(db *sql.DB, body string) []int64 {
	if !strings.Contains(body, "@") {
		return nil
	}
	rows, err := db.Query(`SELECT id, username, display_name FROM users WHERE status = ?`, statusActive)
	if err != nil {
		return nil
	}
	var people []mentionable
	for rows.Next() {
		var m mentionable
		var username, display string
		if rows.Scan(&m.id, &username, &display) == nil {
			m.names = []string{strings.ToLower(strings.TrimSpace(display)), strings.ToLower(strings.TrimSpace(username))}
			people = append(people, m)
		}
	}
	rows.Close()

	type candidate struct {
		id   int64
		name string
	}
	var cands []candidate
	for _, p := range people {
		for _, n := range p.names {
			if n != "" {
				cands = append(cands, candidate{p.id, n})
			}
		}
	}
	sort.Slice(cands, func(i, j int) bool { return len(cands[i].name) > len(cands[j].name) })

	lower := []rune(strings.ToLower(body))
	claimed := make([]bool, len(lower))
	seen := map[int64]bool{}
	var out []int64
	for _, c := range cands {
		needle := []rune("@" + c.name)
		for i := 0; i+len(needle) <= len(lower); i++ {
			if claimed[i] || string(lower[i:i+len(needle)]) != string(needle) {
				continue
			}
			// The name has to end there: "@ada" must not match inside "@adam".
			if end := i + len(needle); end < len(lower) && (unicode.IsLetter(lower[end]) || unicode.IsDigit(lower[end])) {
				continue
			}
			for k := i; k < i+len(needle); k++ {
				claimed[k] = true
			}
			if !seen[c.id] {
				seen[c.id] = true
				out = append(out, c.id)
			}
		}
	}
	return out
}

func handleListNotifications(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromContext(r)
		// The task's current title is shown when it still exists, so a rename
		// follows; the stored summary covers one that has since gone.
		rows, err := db.Query(`SELECT n.id, n.kind, COALESCE(n.task_id, 0),
				COALESCE(t.title, ''), CASE WHEN t.id IS NULL OR t.deleted_at <> '' THEN 1 ELSE 0 END,
				COALESCE(n.actor_id, 0), COALESCE(NULLIF(au.display_name, ''), n.actor_name),
				n.summary, n.created_at, n.read_at
			FROM notifications n
			LEFT JOIN tasks t ON t.id = n.task_id
			LEFT JOIN users au ON au.id = n.actor_id
			WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 60`, u.ID)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not load notifications")
			return
		}
		defer rows.Close()
		items := []Notification{}
		for rows.Next() {
			var n Notification
			var gone int
			var readAt string
			if err := rows.Scan(&n.ID, &n.Kind, &n.TaskID, &n.TaskTitle, &gone, &n.ActorID, &n.ActorName,
				&n.Summary, &n.CreatedAt, &readAt); err != nil {
				writeJSONError(w, http.StatusInternalServerError, "could not read notifications")
				return
			}
			n.TaskGone = gone != 0
			n.Read = readAt != ""
			if n.TaskTitle == "" {
				n.TaskTitle = n.Summary
			}
			items = append(items, n)
		}
		rows.Close()
		var unread int
		db.QueryRow(`SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at = ''`, u.ID).Scan(&unread)
		writeJSON(w, http.StatusOK, map[string]interface{}{"items": items, "unread": unread})
	}
}

type markNotificationsReq struct {
	IDs []int64 `json:"ids"`
	All bool    `json:"all"`
}

func handleMarkNotificationsRead(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromContext(r)
		var req markNotificationsReq
		if err := readJSON(r, &req); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		now := time.Now().UTC().Format(time.RFC3339)
		if req.All {
			db.Exec(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at = ''`, now, u.ID)
		} else {
			for _, id := range req.IDs {
				db.Exec(`UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at = ''`, now, id, u.ID)
			}
		}
		// Their other tabs should drop the badge too.
		events.publishUser(u.ID, "notifications", clientID(r))
		w.WriteHeader(http.StatusNoContent)
	}
}
