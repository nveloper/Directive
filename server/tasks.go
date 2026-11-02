package main

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// ---- creating, editing and finishing tasks ----

const maxChecklistItemBytes = 500
const maxChecklistItems = 100

func handleCreateTask(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromContext(r)
		var req taskReq
		if err := readJSON(r, &req); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if status, msg := validateTask(&req, false); status != 0 {
			writeJSONError(w, status, msg)
			return
		}
		if msg := deptWriteDenied(u, req.DeptID); msg != "" {
			writeJSONError(w, http.StatusForbidden, msg)
			return
		}
		if req.DeptID != "" && !deptExists(db, req.DeptID) {
			writeJSONError(w, http.StatusBadRequest, "no such department")
			return
		}
		items, msg := cleanChecklist(req.Checklist)
		if msg != "" {
			writeJSONError(w, http.StatusBadRequest, msg)
			return
		}

		now := time.Now().UTC().Format(time.RFC3339)
		var deptID interface{}
		if req.DeptID != "" {
			deptID = req.DeptID
		}
		visible := 0
		if req.CalendarVisible {
			visible = 1
		}
		assigneeID, assigneeName, aStatus, aMsg := resolveAssignee(db, &req)
		if aStatus != 0 {
			writeJSONError(w, aStatus, aMsg)
			return
		}
		title := strings.TrimSpace(req.Title)
		res, err := db.Exec(`INSERT INTO tasks (title, description, dept_id, assignee, assignee_id, priority, due_date, status, calendar_visible, recurrence, created_by, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?)`,
			title, strings.TrimSpace(req.Description), deptID, assigneeName, assigneeID, req.Priority, req.DueDate, visible, req.Recurrence, u.ID, now, now)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not create task")
			return
		}
		id, _ := res.LastInsertId()
		for i, body := range items {
			db.Exec(`INSERT INTO checklist_items (task_id, body, done, position, created_at) VALUES (?, ?, 0, ?, ?)`, id, body, i, now)
		}
		logActivityID(db, r, "created", "task", id, title)
		if req.AssigneeID > 0 {
			notifyReq(db, r, req.AssigneeID, notifyAssigned, id, title)
		}
		publishFor(r, "tasks")
		writeJSON(w, http.StatusCreated, Task{
			ID: id, Title: title, Description: strings.TrimSpace(req.Description),
			DeptID: req.DeptID, Assignee: assigneeName, AssigneeID: req.AssigneeID,
			Priority: req.Priority, DueDate: req.DueDate, Status: "todo",
			Overdue:         isOverdue("todo", req.DueDate, today()),
			CalendarVisible: req.CalendarVisible, Recurrence: req.Recurrence,
			ChecklistTotal: len(items), CreatedByName: u.DisplayName, UpdatedAt: now,
		})
	}
}

// cleanChecklist trims the items handed over with a new task and drops the
// blank ones.
func cleanChecklist(in []string) ([]string, string) {
	var out []string
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if len(s) > maxChecklistItemBytes {
			return nil, "a checklist item is too long"
		}
		out = append(out, s)
	}
	if len(out) > maxChecklistItems {
		return nil, "a checklist can hold at most 100 items"
	}
	return out, ""
}

// liveTask reads the fields a write needs to check against, and refuses a
// task that is in the trash - it has to be restored before it can change.
func liveTask(db *sql.DB, id int64) (dept, title, status string, assigneeID int64, ok bool) {
	var aID sql.NullInt64
	err := db.QueryRow(`SELECT COALESCE(dept_id, ''), title, status, assignee_id FROM tasks WHERE id = ? AND deleted_at = ''`, id).
		Scan(&dept, &title, &status, &aID)
	if err != nil {
		return "", "", "", 0, false
	}
	return dept, title, status, aID.Int64, true
}

func handleUpdateTask(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromContext(r)
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid task id")
			return
		}
		var req taskReq
		if err := readJSON(r, &req); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if status, msg := validateTask(&req, true); status != 0 {
			writeJSONError(w, status, msg)
			return
		}

		currentDept, _, currentStatus, currentAssignee, ok := liveTask(db, id)
		if !ok {
			writeJSONError(w, http.StatusNotFound, "task not found")
			return
		}
		// Both ends of a move have to be in reach, or a member could push a task
		// out of their department and lose it, or pull one in from another.
		if msg := deptWriteDenied(u, currentDept); msg != "" {
			writeJSONError(w, http.StatusForbidden, msg)
			return
		}
		if msg := deptWriteDenied(u, req.DeptID); msg != "" {
			writeJSONError(w, http.StatusForbidden, msg)
			return
		}
		if req.DeptID != "" && !deptExists(db, req.DeptID) {
			writeJSONError(w, http.StatusBadRequest, "no such department")
			return
		}

		var deptID interface{}
		if req.DeptID != "" {
			deptID = req.DeptID
		}
		visible := 0
		if req.CalendarVisible {
			visible = 1
		}
		assigneeID, assigneeName, aStatus, aMsg := resolveAssignee(db, &req)
		if aStatus != 0 {
			writeJSONError(w, aStatus, aMsg)
			return
		}
		now := time.Now().UTC().Format(time.RFC3339)
		title := strings.TrimSpace(req.Title)
		res, err := db.Exec(`UPDATE tasks SET title=?, description=?, dept_id=?, assignee=?, assignee_id=?, priority=?, due_date=?, status=?, calendar_visible=?, recurrence=?, updated_at=? WHERE id=? AND deleted_at = ''`,
			title, strings.TrimSpace(req.Description), deptID, assigneeName, assigneeID, req.Priority, req.DueDate, req.Status, visible, req.Recurrence, now, id)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not update task")
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			writeJSONError(w, http.StatusNotFound, "task not found")
			return
		}
		logActivityID(db, r, "updated", "task", id, title)
		if req.AssigneeID > 0 && req.AssigneeID != currentAssignee {
			notifyReq(db, r, req.AssigneeID, notifyAssigned, id, title)
		}
		if req.Status == "done" && currentStatus != "done" {
			rollRecurrence(db, r.Context(), clientID(r), id)
		}
		publishFor(r, "tasks")
		w.WriteHeader(http.StatusNoContent)
	}
}

type taskStatusReq struct {
	Status string `json:"status"`
}

// handleSetTaskStatus ticks a task off (or back on) without the caller having
// to resend every field. The full update needs the whole task, which is right
// for the editor and wrong for a checkbox - resending it all from a list row
// would quietly overwrite anything someone else changed in the meantime.
func handleSetTaskStatus(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromContext(r)
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid task id")
			return
		}
		var req taskStatusReq
		if err := readJSON(r, &req); err != nil || !validStatus[req.Status] {
			writeJSONError(w, http.StatusBadRequest, "status must be todo, inprogress, review, or done")
			return
		}
		dept, title, current, _, ok := liveTask(db, id)
		if !ok {
			writeJSONError(w, http.StatusNotFound, "task not found")
			return
		}
		if msg := deptWriteDenied(u, dept); msg != "" {
			writeJSONError(w, http.StatusForbidden, msg)
			return
		}
		if current == req.Status {
			writeJSON(w, http.StatusOK, map[string]interface{}{"nextId": 0})
			return
		}
		if _, err := db.Exec(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`,
			req.Status, time.Now().UTC().Format(time.RFC3339), id); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not update task")
			return
		}
		verb := "updated"
		if req.Status == "done" {
			verb = "completed"
		} else if current == "done" {
			verb = "reopened"
		}
		logActivityID(db, r, verb, "task", id, title)
		var nextID int64
		if req.Status == "done" {
			nextID = rollRecurrence(db, r.Context(), clientID(r), id)
		}
		publishFor(r, "tasks")
		writeJSON(w, http.StatusOK, map[string]interface{}{"nextId": nextID})
	}
}

// handleGetTask fetches one task, for opening something that is not on the
// page the list happens to be showing - a notification, say.
func handleGetTask(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid task id")
			return
		}
		row := db.QueryRow(`SELECT `+taskSelectColumns+taskJoins+` WHERE t.id = ? AND t.deleted_at = ''`, id)
		t, err := scanTask(row, today())
		if err != nil {
			writeJSONError(w, http.StatusNotFound, "task not found")
			return
		}
		writeJSON(w, http.StatusOK, t)
	}
}

// ---- trash ----

// A deleted task waits in the trash this long before it is gone for good.
const trashRetention = 10 * 24 * time.Hour

// handleDeleteTask moves a task to the trash. Its comments, checklist and
// place in any department stay exactly as they were, so restoring it puts
// everything back.
func handleDeleteTask(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromContext(r)
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid task id")
			return
		}
		dept, title, _, _, ok := liveTask(db, id)
		if !ok {
			writeJSONError(w, http.StatusNotFound, "task not found")
			return
		}
		if msg := deptWriteDenied(u, dept); msg != "" {
			writeJSONError(w, http.StatusForbidden, msg)
			return
		}
		if err := trashTask(db, id, u.ID); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not delete task")
			return
		}
		logActivityID(db, r, "moved to the trash", "task", id, title)
		publishFor(r, "tasks")
		w.WriteHeader(http.StatusNoContent)
	}
}

func trashTask(db *sql.DB, id, userID int64) error {
	now := time.Now().UTC().Format(time.RFC3339)
	// updated_at moves too, so a CalDAV client that polls by ETag notices.
	_, err := db.Exec(`UPDATE tasks SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ? AND deleted_at = ''`,
		now, userID, now, id)
	return err
}

type TrashedTask struct {
	Task
	DeletedAt     string `json:"deletedAt"`
	DeletedByName string `json:"deletedByName"`
	PurgeAt       string `json:"purgeAt"`
	CanRestore    bool   `json:"canRestore"`
}

func handleListTrash(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromContext(r)
		rows, err := db.Query(`SELECT ` + taskSelectColumns + `, t.deleted_at, COALESCE(du.display_name, '')` +
			taskJoins + ` LEFT JOIN users du ON du.id = t.deleted_by
			WHERE t.deleted_at <> '' ORDER BY t.deleted_at DESC, t.id DESC LIMIT 200`)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not load the trash")
			return
		}
		defer rows.Close()
		out := []TrashedTask{}
		todayStr := today()
		for rows.Next() {
			var tt TrashedTask
			var visible int
			if err := rows.Scan(taskScanTargets(&tt.Task, &visible, &tt.DeletedAt, &tt.DeletedByName)...); err != nil {
				writeJSONError(w, http.StatusInternalServerError, "could not read the trash")
				return
			}
			finishTask(&tt.Task, visible, todayStr)
			if at, err := time.Parse(time.RFC3339, tt.DeletedAt); err == nil {
				tt.PurgeAt = at.Add(trashRetention).Format(time.RFC3339)
			}
			tt.CanRestore = u.canWriteDept(tt.DeptID)
			out = append(out, tt)
		}
		writeJSON(w, http.StatusOK, out)
	}
}

func trashedTask(db *sql.DB, id int64) (dept, title string, ok bool) {
	err := db.QueryRow(`SELECT COALESCE(dept_id, ''), title FROM tasks WHERE id = ? AND deleted_at <> ''`, id).Scan(&dept, &title)
	return dept, title, err == nil
}

func handleRestoreTask(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromContext(r)
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid task id")
			return
		}
		dept, title, ok := trashedTask(db, id)
		if !ok {
			writeJSONError(w, http.StatusNotFound, "that task is not in the trash")
			return
		}
		if msg := deptWriteDenied(u, dept); msg != "" {
			writeJSONError(w, http.StatusForbidden, msg)
			return
		}
		// A department deleted while the task sat in the trash has already
		// released it (dept_id is ON DELETE SET NULL), so it comes back unfiled.
		if _, err := db.Exec(`UPDATE tasks SET deleted_at = '', deleted_by = NULL, updated_at = ? WHERE id = ?`,
			time.Now().UTC().Format(time.RFC3339), id); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not restore the task")
			return
		}
		logActivityID(db, r, "restored", "task", id, title)
		publishFor(r, "tasks", "trash")
		w.WriteHeader(http.StatusNoContent)
	}
}

// handlePurgeTask deletes one trashed task for good, ahead of its time.
func handlePurgeTask(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromContext(r)
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid task id")
			return
		}
		dept, title, ok := trashedTask(db, id)
		if !ok {
			writeJSONError(w, http.StatusNotFound, "that task is not in the trash")
			return
		}
		if msg := deptWriteDenied(u, dept); msg != "" {
			writeJSONError(w, http.StatusForbidden, msg)
			return
		}
		if _, err := db.Exec(`DELETE FROM tasks WHERE id = ? AND deleted_at <> ''`, id); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not delete the task")
			return
		}
		cleanOrphanTaskImages(db)
		sweepAttachmentFiles(db)
		logActivityID(db, r, "permanently deleted", "task", id, title)
		publishFor(r, "tasks", "trash")
		w.WriteHeader(http.StatusNoContent)
	}
}

// handleEmptyTrash deletes every trashed task the caller could restore - for
// an administrator, all of them.
func handleEmptyTrash(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromContext(r)
		rows, err := db.Query(`SELECT id, COALESCE(dept_id, '') FROM tasks WHERE deleted_at <> ''`)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not read the trash")
			return
		}
		var ids []int64
		for rows.Next() {
			var id int64
			var dept string
			if rows.Scan(&id, &dept) == nil && u.canWriteDept(dept) {
				ids = append(ids, id)
			}
		}
		rows.Close()
		for _, id := range ids {
			db.Exec(`DELETE FROM tasks WHERE id = ?`, id)
		}
		cleanOrphanTaskImages(db)
		sweepAttachmentFiles(db)
		if len(ids) > 0 {
			logActivity(db, r, "emptied", "trash", "", strconv.Itoa(len(ids))+" task(s)")
		}
		publishFor(r, "tasks", "trash")
		writeJSON(w, http.StatusOK, map[string]interface{}{"deleted": len(ids)})
	}
}

// purgeTrash runs at start and then hourly, deleting what has sat in the
// trash past its retention.
func purgeTrash(db *sql.DB) {
	clean := func() {
		cutoff := time.Now().UTC().Add(-trashRetention).Format(time.RFC3339)
		res, err := db.Exec(`DELETE FROM tasks WHERE deleted_at <> '' AND deleted_at <= ?`, cutoff)
		if err != nil {
			return
		}
		if n, _ := res.RowsAffected(); n > 0 {
			cleanOrphanTaskImages(db)
			sweepAttachmentFiles(db)
			events.publish("tasks", "")
			events.publish("trash", "")
		}
	}
	clean()
	go func() {
		for range time.Tick(time.Hour) {
			clean()
		}
	}()
}
