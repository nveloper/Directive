package main

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const maxCommentBytes = 4000

type Comment struct {
	ID         int64  `json:"id"`
	TaskID     int64  `json:"taskId"`
	AuthorID   int64  `json:"authorId"`
	AuthorName string `json:"authorName"`
	Body       string `json:"body"`
	CreatedAt  string `json:"createdAt"`
	Mine       bool   `json:"mine"`
}

// Commenting is deliberately not scoped to the commenter's department. Reading
// tasks is not, and a comment does not change the work - asking a question
// about another team's task is the point. Editing that task still is scoped.
func handleListComments(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromContext(r)
		taskID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid task id")
			return
		}
		// A comment's author is shown under their current display name, so a
		// rename follows the thread; author_name is the fallback for an account
		// that has since been removed.
		rows, err := db.Query(`SELECT c.id, c.task_id, COALESCE(c.user_id, 0),
				COALESCE(NULLIF(u.display_name, ''), c.author_name), c.body, c.created_at
			FROM comments c LEFT JOIN users u ON u.id = c.user_id
			WHERE c.task_id = ? ORDER BY c.id`, taskID)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not load comments")
			return
		}
		defer rows.Close()
		out := []Comment{}
		for rows.Next() {
			var c Comment
			if err := rows.Scan(&c.ID, &c.TaskID, &c.AuthorID, &c.AuthorName, &c.Body, &c.CreatedAt); err != nil {
				writeJSONError(w, http.StatusInternalServerError, "could not read comments")
				return
			}
			c.Mine = c.AuthorID == u.ID
			out = append(out, c)
		}
		writeJSON(w, http.StatusOK, out)
	}
}

type createCommentReq struct {
	Body string `json:"body"`
}

func handleCreateComment(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromContext(r)
		taskID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid task id")
			return
		}
		var taskTitle string
		var assigneeID sql.NullInt64
		if err := db.QueryRow(`SELECT title, assignee_id FROM tasks WHERE id = ? AND deleted_at = ''`, taskID).Scan(&taskTitle, &assigneeID); err != nil {
			writeJSONError(w, http.StatusNotFound, "task not found")
			return
		}
		var req createCommentReq
		if err := readJSON(r, &req); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		body := strings.TrimSpace(req.Body)
		if body == "" {
			writeJSONError(w, http.StatusBadRequest, "a comment cannot be empty")
			return
		}
		if len(body) > maxCommentBytes {
			writeJSONError(w, http.StatusBadRequest, "that comment is too long")
			return
		}
		now := time.Now().UTC().Format(time.RFC3339)
		res, err := db.Exec(`INSERT INTO comments (task_id, user_id, author_name, body, created_at) VALUES (?, ?, ?, ?, ?)`,
			taskID, u.ID, u.DisplayName, body, now)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not save the comment")
			return
		}
		id, _ := res.LastInsertId()
		logActivityID(db, r, "commented on", "task", taskID, taskTitle)
		// Someone named in the comment hears about it; so does whoever the
		// task is assigned to, once - a mention already covers them.
		mentioned := map[int64]bool{}
		for _, id := range findMentions(db, body) {
			mentioned[id] = true
			notifyReq(db, r, id, notifyMentioned, taskID, taskTitle)
		}
		if assigneeID.Valid && !mentioned[assigneeID.Int64] {
			notifyReq(db, r, assigneeID.Int64, notifyCommented, taskID, taskTitle)
		}
		publishFor(r, "comments", "tasks")
		writeJSON(w, http.StatusCreated, Comment{
			ID: id, TaskID: taskID, AuthorID: u.ID, AuthorName: u.DisplayName,
			Body: body, CreatedAt: now, Mine: true,
		})
	}
}

// handleDeleteComment lets someone remove their own comment; an administrator
// can remove any of them.
func handleDeleteComment(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromContext(r)
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid comment id")
			return
		}
		var authorID sql.NullInt64
		if err := db.QueryRow(`SELECT user_id FROM comments WHERE id = ?`, id).Scan(&authorID); err != nil {
			writeJSONError(w, http.StatusNotFound, "comment not found")
			return
		}
		if !u.isAdmin() && (!authorID.Valid || authorID.Int64 != u.ID) {
			writeJSONError(w, http.StatusForbidden, "you can only delete your own comments")
			return
		}
		if _, err := db.Exec(`DELETE FROM comments WHERE id = ?`, id); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not delete the comment")
			return
		}
		publishFor(r, "comments", "tasks")
		w.WriteHeader(http.StatusNoContent)
	}
}
