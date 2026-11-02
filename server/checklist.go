package main

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// A checklist breaks a task into steps that can be ticked off one at a time,
// so "3/5" can say how far along something is without splitting it into five
// tasks. Ticking a step changes the work, so it is scoped to the task's
// department exactly as editing the task is.

type ChecklistItem struct {
	ID       int64  `json:"id"`
	TaskID   int64  `json:"taskId"`
	Body     string `json:"body"`
	Done     bool   `json:"done"`
	Position int    `json:"position"`
}

func loadChecklist(db *sql.DB, taskID int64) ([]ChecklistItem, error) {
	rows, err := db.Query(`SELECT id, task_id, body, done, position FROM checklist_items
		WHERE task_id = ? ORDER BY position, id`, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ChecklistItem{}
	for rows.Next() {
		var it ChecklistItem
		var done int
		if err := rows.Scan(&it.ID, &it.TaskID, &it.Body, &done, &it.Position); err != nil {
			return nil, err
		}
		it.Done = done != 0
		out = append(out, it)
	}
	return out, rows.Err()
}

func handleListChecklist(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		taskID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid task id")
			return
		}
		items, err := loadChecklist(db, taskID)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not load the checklist")
			return
		}
		writeJSON(w, http.StatusOK, items)
	}
}

// touchTask marks the task as changed, so its ETag moves and anyone looking
// at a list sees the new count.
func touchTask(db *sql.DB, taskID int64) {
	db.Exec(`UPDATE tasks SET updated_at = ? WHERE id = ?`, time.Now().UTC().Format(time.RFC3339), taskID)
}

type checklistReq struct {
	Body *string `json:"body"`
	Done *bool   `json:"done"`
}

func handleAddChecklistItem(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromContext(r)
		taskID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid task id")
			return
		}
		dept, _, _, _, ok := liveTask(db, taskID)
		if !ok {
			writeJSONError(w, http.StatusNotFound, "task not found")
			return
		}
		if msg := deptWriteDenied(u, dept); msg != "" {
			writeJSONError(w, http.StatusForbidden, msg)
			return
		}
		var req checklistReq
		if err := readJSON(r, &req); err != nil || req.Body == nil {
			writeJSONError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		body := strings.TrimSpace(*req.Body)
		if body == "" {
			writeJSONError(w, http.StatusBadRequest, "a checklist item needs some text")
			return
		}
		if len(body) > maxChecklistItemBytes {
			writeJSONError(w, http.StatusBadRequest, "a checklist item is too long")
			return
		}
		var count, maxPos int
		db.QueryRow(`SELECT COUNT(*), COALESCE(MAX(position), -1) FROM checklist_items WHERE task_id = ?`, taskID).Scan(&count, &maxPos)
		if count >= maxChecklistItems {
			writeJSONError(w, http.StatusBadRequest, "a checklist can hold at most 100 items")
			return
		}
		res, err := db.Exec(`INSERT INTO checklist_items (task_id, body, done, position, created_at) VALUES (?, ?, 0, ?, ?)`,
			taskID, body, maxPos+1, time.Now().UTC().Format(time.RFC3339))
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not add the item")
			return
		}
		id, _ := res.LastInsertId()
		touchTask(db, taskID)
		publishFor(r, "checklist", "tasks")
		writeJSON(w, http.StatusCreated, ChecklistItem{ID: id, TaskID: taskID, Body: body, Position: maxPos + 1})
	}
}

// checklistItemTask finds the task an item belongs to and checks the caller
// may change it.
func checklistItemTask(db *sql.DB, w http.ResponseWriter, r *http.Request) (itemID, taskID int64, ok bool) {
	u := userFromContext(r)
	itemID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid item id")
		return 0, 0, false
	}
	if err := db.QueryRow(`SELECT task_id FROM checklist_items WHERE id = ?`, itemID).Scan(&taskID); err != nil {
		writeJSONError(w, http.StatusNotFound, "checklist item not found")
		return 0, 0, false
	}
	dept, _, _, _, live := liveTask(db, taskID)
	if !live {
		writeJSONError(w, http.StatusNotFound, "task not found")
		return 0, 0, false
	}
	if msg := deptWriteDenied(u, dept); msg != "" {
		writeJSONError(w, http.StatusForbidden, msg)
		return 0, 0, false
	}
	return itemID, taskID, true
}

func handleUpdateChecklistItem(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		itemID, taskID, ok := checklistItemTask(db, w, r)
		if !ok {
			return
		}
		var req checklistReq
		if err := readJSON(r, &req); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if req.Body != nil {
			body := strings.TrimSpace(*req.Body)
			if body == "" || len(body) > maxChecklistItemBytes {
				writeJSONError(w, http.StatusBadRequest, "a checklist item needs 1-500 bytes of text")
				return
			}
			db.Exec(`UPDATE checklist_items SET body = ? WHERE id = ?`, body, itemID)
		}
		if req.Done != nil {
			done := 0
			if *req.Done {
				done = 1
			}
			db.Exec(`UPDATE checklist_items SET done = ? WHERE id = ?`, done, itemID)
		}
		touchTask(db, taskID)
		publishFor(r, "checklist", "tasks")
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleDeleteChecklistItem(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		itemID, taskID, ok := checklistItemTask(db, w, r)
		if !ok {
			return
		}
		if _, err := db.Exec(`DELETE FROM checklist_items WHERE id = ?`, itemID); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not delete the item")
			return
		}
		touchTask(db, taskID)
		publishFor(r, "checklist", "tasks")
		w.WriteHeader(http.StatusNoContent)
	}
}

type reorderChecklistReq struct {
	IDs []int64 `json:"ids"`
}

// handleReorderChecklist takes the task's items in their new order.
func handleReorderChecklist(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromContext(r)
		taskID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid task id")
			return
		}
		dept, _, _, _, ok := liveTask(db, taskID)
		if !ok {
			writeJSONError(w, http.StatusNotFound, "task not found")
			return
		}
		if msg := deptWriteDenied(u, dept); msg != "" {
			writeJSONError(w, http.StatusForbidden, msg)
			return
		}
		var req reorderChecklistReq
		if err := readJSON(r, &req); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		// Only this task's items move; an id from another task is ignored.
		for i, id := range req.IDs {
			db.Exec(`UPDATE checklist_items SET position = ? WHERE id = ? AND task_id = ?`, i, id, taskID)
		}
		touchTask(db, taskID)
		publishFor(r, "checklist")
		w.WriteHeader(http.StatusNoContent)
	}
}
