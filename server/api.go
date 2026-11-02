package main

import (
	"database/sql"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ---- auth endpoints ----

type registerReq struct {
	Username    string `json:"username"`
	Password    string `json:"password"`
	DisplayName string `json:"displayName"`
}

func handleRegister(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req registerReq
		if err := readJSON(r, &req); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		req.Username = strings.TrimSpace(req.Username)
		req.DisplayName = strings.TrimSpace(req.DisplayName)
		if req.Username == "" || len(req.Password) < 8 || req.DisplayName == "" {
			writeJSONError(w, http.StatusBadRequest, "username, display name, and a password of at least 8 characters are required")
			return
		}

		var count int
		db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count)

		// The first account on a fresh install is the administrator and is
		// active immediately. Everyone after that waits for approval, so simply
		// reaching the server is not enough to read the organisation's tasks.
		role, status := "member", statusPending
		if count == 0 {
			role, status = "admin", statusActive
		}

		hash, err := hashPassword(req.Password)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not process password")
			return
		}

		res, err := db.Exec(`INSERT INTO users (username, password_hash, display_name, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
			req.Username, hash, req.DisplayName, role, status, time.Now().UTC().Format(time.RFC3339))
		if err != nil {
			writeJSONError(w, http.StatusConflict, "that username is already taken")
			return
		}
		userID, _ := res.LastInsertId()

		if status == statusPending {
			publishFor(r, "users")
			writeJSON(w, http.StatusAccepted, map[string]interface{}{
				"status":  statusPending,
				"message": "Account created. An administrator has to approve it before you can sign in.",
			})
			return
		}

		token, err := createSession(db, userID)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not start session")
			return
		}
		setSessionCookie(w, r, token)
		writeJSON(w, http.StatusCreated, map[string]interface{}{
			"id": userID, "username": req.Username, "displayName": req.DisplayName,
			"role": role, "status": status, "deptId": "",
		})
	}
}

type loginReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func handleLogin(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req loginReq
		if err := readJSON(r, &req); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		var id int64
		var hash, displayName, role, status, deptID string
		var mustChange bool
		row := db.QueryRow(`SELECT id, password_hash, display_name, role, status, COALESCE(dept_id, ''), must_change_password FROM users WHERE username = ?`,
			strings.TrimSpace(req.Username))
		if err := row.Scan(&id, &hash, &displayName, &role, &status, &deptID, &mustChange); err != nil {
			// Spend the same time as a real comparison so a missing account
			// cannot be told apart from a wrong password by response timing.
			burnPasswordTime()
			writeJSONError(w, http.StatusUnauthorized, "incorrect username or password")
			return
		}
		if !checkPassword(hash, req.Password) {
			writeJSONError(w, http.StatusUnauthorized, "incorrect username or password")
			return
		}
		switch status {
		case statusPending:
			writeJSONError(w, http.StatusForbidden, "your account is waiting for an administrator to approve it")
			return
		case statusDisabled:
			writeJSONError(w, http.StatusForbidden, "this account has been disabled")
			return
		}
		token, err := createSession(db, id)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not start session")
			return
		}
		setSessionCookie(w, r, token)
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"id": id, "username": req.Username, "displayName": displayName,
			"role": role, "status": status, "deptId": deptID, "mustChangePassword": mustChange,
		})
	}
}

func handleLogout(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if cookie, err := r.Cookie(sessionCookieName); err == nil {
			destroySession(db, cookie.Value)
		}
		clearSessionCookie(w, r)
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleMe(w http.ResponseWriter, r *http.Request) {
	u := userFromContext(r)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"id": u.ID, "username": u.Username, "displayName": u.DisplayName,
		"role": u.Role, "status": u.Status, "deptId": u.DeptID,
		"mustChangePassword": u.MustChangePassword,
	})
}

type updateMeReq struct {
	DisplayName string `json:"displayName"`
}

func handleUpdateMe(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromContext(r)
		var req updateMeReq
		if err := readJSON(r, &req); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		name := strings.TrimSpace(req.DisplayName)
		if name == "" || len([]rune(name)) > 60 {
			writeJSONError(w, http.StatusBadRequest, "display name must be 1-60 characters")
			return
		}
		if _, err := db.Exec(`UPDATE users SET display_name = ? WHERE id = ?`, name, u.ID); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not update display name")
			return
		}
		logActivityID(db, r, "renamed", "account", u.ID, name)
		// The name shows on every task they are assigned or created, and in
		// the member picker.
		publishFor(r, "users", "members", "tasks", "comments")
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"id": u.ID, "username": u.Username, "displayName": name,
			"role": u.Role, "status": u.Status, "deptId": u.DeptID,
		})
	}
}

// ---- user administration ----

type AccountSummary struct {
	ID          int64  `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	Role        string `json:"role"`
	Status      string `json:"status"`
	DeptID      string `json:"deptId"`
	CreatedAt   string `json:"createdAt"`
	// A reset is waiting for its owner to choose a new password.
	MustChangePassword bool `json:"mustChangePassword"`
}

func handleListUsers(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.Query(`SELECT id, username, display_name, role, status, COALESCE(dept_id, ''), created_at, must_change_password
			FROM users ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, id`)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not load accounts")
			return
		}
		defer rows.Close()
		out := []AccountSummary{}
		for rows.Next() {
			var a AccountSummary
			if err := rows.Scan(&a.ID, &a.Username, &a.DisplayName, &a.Role, &a.Status, &a.DeptID, &a.CreatedAt, &a.MustChangePassword); err != nil {
				writeJSONError(w, http.StatusInternalServerError, "could not read accounts")
				return
			}
			out = append(out, a)
		}
		writeJSON(w, http.StatusOK, out)
	}
}

type updateUserReq struct {
	Status *string `json:"status"`
	Role   *string `json:"role"`
	DeptID *string `json:"deptId"`
}

var validUserStatus = map[string]bool{statusPending: true, statusActive: true, statusDisabled: true}
var validRole = map[string]bool{"admin": true, "member": true}

func handleUpdateUser(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actor := userFromContext(r)
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid user id")
			return
		}
		var req updateUserReq
		if err := readJSON(r, &req); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid request body")
			return
		}

		var currentRole, currentStatus, targetName string
		if err := db.QueryRow(`SELECT role, status, display_name FROM users WHERE id = ?`, id).Scan(&currentRole, &currentStatus, &targetName); err != nil {
			writeJSONError(w, http.StatusNotFound, "no such account")
			return
		}
		if req.Status != nil && !validUserStatus[*req.Status] {
			writeJSONError(w, http.StatusBadRequest, "status must be pending, active, or disabled")
			return
		}
		if req.Role != nil && !validRole[*req.Role] {
			writeJSONError(w, http.StatusBadRequest, "role must be admin or member")
			return
		}
		if req.Status != nil && *req.Status != statusActive && id == actor.ID {
			writeJSONError(w, http.StatusConflict, "you cannot disable your own account")
			return
		}

		// Guard against locking everyone out of administration by demoting or
		// disabling the last active admin.
		demoting := req.Role != nil && *req.Role != "admin" && currentRole == "admin"
		deactivating := req.Status != nil && *req.Status != statusActive && currentRole == "admin" && currentStatus == statusActive
		if demoting || deactivating {
			var admins int
			db.QueryRow(`SELECT COUNT(*) FROM users WHERE role = 'admin' AND status = ?`, statusActive).Scan(&admins)
			if admins <= 1 {
				writeJSONError(w, http.StatusConflict, "this is the last administrator - promote someone else first")
				return
			}
		}

		if req.DeptID != nil {
			dept := strings.TrimSpace(*req.DeptID)
			if dept != "" && !deptExists(db, dept) {
				writeJSONError(w, http.StatusBadRequest, "no such department")
				return
			}
			if dept == "" {
				db.Exec(`UPDATE users SET dept_id = NULL WHERE id = ?`, id)
			} else {
				db.Exec(`UPDATE users SET dept_id = ? WHERE id = ?`, dept, id)
			}
		}
		if req.Role != nil {
			db.Exec(`UPDATE users SET role = ? WHERE id = ?`, *req.Role, id)
		}
		if req.Status != nil {
			if _, err := db.Exec(`UPDATE users SET status = ? WHERE id = ?`, *req.Status, id); err != nil {
				writeJSONError(w, http.StatusInternalServerError, "could not update the account")
				return
			}
			// Disabling someone should take effect now, not in 30 days - or
			// in five minutes, for a phone the CalDAV cache still remembers.
			if *req.Status != statusActive {
				db.Exec(`DELETE FROM sessions WHERE user_id = ?`, id)
				caldavCreds.forgetUser(id)
			}
		}
		if req.Status != nil && *req.Status != currentStatus {
			verb := "disabled"
			if *req.Status == statusActive {
				verb = "approved"
				if currentStatus == statusDisabled {
					verb = "re-enabled"
				}
			}
			logActivityID(db, r, verb, "account", id, targetName)
		}
		if req.Role != nil && *req.Role != currentRole {
			verb := "made a member"
			if *req.Role == "admin" {
				verb = "made an administrator"
			}
			logActivityID(db, r, verb, "account", id, targetName)
		}
		publishFor(r, "users", "members")
		w.WriteHeader(http.StatusNoContent)
	}
}

// ---- member directory ----

// Member is the minimum every approved user needs to pick an assignee: who
// exists and what to call them. The full account list, with usernames and
// approval state, stays administrator-only.
type Member struct {
	ID          int64  `json:"id"`
	DisplayName string `json:"displayName"`
	DeptID      string `json:"deptId"`
}

func handleListMembers(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.Query(`SELECT id, display_name, COALESCE(dept_id, '') FROM users WHERE status = ? ORDER BY display_name`, statusActive)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not load members")
			return
		}
		defer rows.Close()
		out := []Member{}
		for rows.Next() {
			var m Member
			if err := rows.Scan(&m.ID, &m.DisplayName, &m.DeptID); err != nil {
				writeJSONError(w, http.StatusInternalServerError, "could not read members")
				return
			}
			out = append(out, m)
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// ---- settings ----

func getAppName(db *sql.DB) string {
	var name string
	if err := db.QueryRow(`SELECT value FROM settings WHERE key = 'app_name'`).Scan(&name); err != nil || name == "" {
		return "Directive"
	}
	return name
}

// setupRequired reports whether this install has no accounts at all, which is
// the only time registering gets you in without waiting for an approval.
func setupRequired(db *sql.DB) bool {
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count); err != nil {
		return false
	}
	return count == 0
}

func handleGetSettings(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Readable without a session: the sign-in screen needs the app name
		// before anyone is logged in, and it has to know whether this is a
		// first run so it does not tell the very first person - who becomes the
		// administrator - that an administrator must approve them.
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"appName":       getAppName(db),
			"setupRequired": setupRequired(db),
		})
	}
}

type updateSettingsReq struct {
	AppName string `json:"appName"`
}

func handleUpdateSettings(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req updateSettingsReq
		if err := readJSON(r, &req); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		name := strings.TrimSpace(req.AppName)
		if name == "" || len([]rune(name)) > 60 {
			writeJSONError(w, http.StatusBadRequest, "app name must be 1-60 characters")
			return
		}
		if _, err := db.Exec(`INSERT INTO settings (key, value) VALUES ('app_name', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, name); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not save settings")
			return
		}
		logActivity(db, r, "renamed", "app", "app_name", name)
		publishFor(r, "settings")
		writeJSON(w, http.StatusOK, map[string]interface{}{"appName": name})
	}
}

// ---- departments ----

type Department struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	ParentID     string `json:"parentId"`
	CalendarList string `json:"calendarList"`
	CalendarTag  string `json:"tag"`
	FeedToken    string `json:"feedToken"`
}

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = slugRe.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if s == "" {
		s = "dept"
	}
	return s
}

// nodeLabelFor renders a department the way the sidebar does: a child is
// shown under its parent's name so two "Backend" teams can be told apart.
func nodeLabelFor(depts []Department, id string) string {
	byID := map[string]Department{}
	for _, d := range depts {
		byID[d.ID] = d
	}
	d, ok := byID[id]
	if !ok {
		return id
	}
	if d.ParentID == "" {
		return d.Name
	}
	if p, ok := byID[d.ParentID]; ok {
		return p.Name + " / " + d.Name
	}
	return d.Name
}

func deptExists(db *sql.DB, id string) bool {
	var n int
	db.QueryRow(`SELECT COUNT(*) FROM departments WHERE id = ?`, id).Scan(&n)
	return n > 0
}

// deptDepth is 1 for a top-level department, 2 for its child, and so on. The
// sidebar renders two levels, so the API refuses to create a third - otherwise
// a department exists that nothing in the UI can ever show or select.
func deptDepth(id string) int { return strings.Count(id, "/") + 1 }

const maxDeptDepth = 2

func listDepartments(db *sql.DB) ([]Department, error) {
	rows, err := db.Query(`SELECT id, name, COALESCE(parent_id, ''), calendar_list, calendar_tag, feed_token FROM departments ORDER BY rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Department{}
	for rows.Next() {
		var d Department
		if err := rows.Scan(&d.ID, &d.Name, &d.ParentID, &d.CalendarList, &d.CalendarTag, &d.FeedToken); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, nil
}

func handleListDepartments(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		depts, err := listDepartments(db)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not load departments")
			return
		}
		writeJSON(w, http.StatusOK, depts)
	}
}

type createDeptReq struct {
	Name     string `json:"name"`
	ParentID string `json:"parentId"`
}

func handleCreateDepartment(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req createDeptReq
		if err := readJSON(r, &req); err != nil || strings.TrimSpace(req.Name) == "" {
			writeJSONError(w, http.StatusBadRequest, "a department name is required")
			return
		}
		req.ParentID = strings.TrimSpace(req.ParentID)
		if req.ParentID != "" && !deptExists(db, req.ParentID) {
			writeJSONError(w, http.StatusBadRequest, "no such parent department")
			return
		}

		base := slugify(req.Name)
		build := func(suffix string) string {
			if req.ParentID != "" {
				return req.ParentID + "/" + base + suffix
			}
			return base + suffix
		}
		id := build("")
		if deptDepth(id) > maxDeptDepth {
			writeJSONError(w, http.StatusBadRequest, "departments can only be nested one level deep")
			return
		}
		for i := 2; deptExists(db, id); i++ {
			id = build("-" + strconv.Itoa(i))
		}

		var parentID interface{}
		if req.ParentID != "" {
			parentID = req.ParentID
		}
		name := strings.TrimSpace(req.Name)
		token := randomToken()[:24]
		if _, err := db.Exec(`INSERT INTO departments (id, name, parent_id, feed_token) VALUES (?, ?, ?, ?)`, id, name, parentID, token); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not create department")
			return
		}
		logActivity(db, r, "created", "department", id, name)
		publishFor(r, "departments")
		writeJSON(w, http.StatusCreated, Department{ID: id, Name: name, ParentID: req.ParentID, FeedToken: token})
	}
}

type updateDeptReq struct {
	Name         *string `json:"name"`
	CalendarList *string `json:"calendarList"`
	CalendarTag  *string `json:"tag"`
}

func handleUpdateDepartment(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		var currentName string
		if err := db.QueryRow(`SELECT name FROM departments WHERE id = ?`, id).Scan(&currentName); err != nil {
			writeJSONError(w, http.StatusNotFound, "no such department")
			return
		}
		var req updateDeptReq
		if err := readJSON(r, &req); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if req.Name != nil {
			name := strings.TrimSpace(*req.Name)
			if name == "" {
				writeJSONError(w, http.StatusBadRequest, "a department name is required")
				return
			}
			db.Exec(`UPDATE departments SET name = ? WHERE id = ?`, name, id)
		}
		if req.CalendarList != nil {
			db.Exec(`UPDATE departments SET calendar_list = ? WHERE id = ?`, *req.CalendarList, id)
		}
		if req.CalendarTag != nil {
			db.Exec(`UPDATE departments SET calendar_tag = ? WHERE id = ?`, *req.CalendarTag, id)
		}
		if req.Name != nil && strings.TrimSpace(*req.Name) != currentName {
			logActivity(db, r, "renamed", "department", id, strings.TrimSpace(*req.Name))
		}
		publishFor(r, "departments")
		w.WriteHeader(http.StatusNoContent)
	}
}

// deptDependents counts what a department is still holding, so a delete can
// say what it would take with it instead of quietly orphaning work.
type deptDependents struct {
	Children int `json:"children"`
	Tasks    int `json:"tasks"`
	Members  int `json:"members"`
}

func (d deptDependents) any() bool {
	return d.Children > 0 || d.Tasks > 0 || d.Members > 0
}

func countDeptDependents(db *sql.DB, id string) deptDependents {
	var d deptDependents
	like := id + "/%"
	db.QueryRow(`SELECT COUNT(*) FROM departments WHERE id LIKE ?`, like).Scan(&d.Children)
	db.QueryRow(`SELECT COUNT(*) FROM tasks WHERE (dept_id = ? OR dept_id LIKE ?) AND deleted_at = ''`, id, like).Scan(&d.Tasks)
	db.QueryRow(`SELECT COUNT(*) FROM users WHERE dept_id = ? OR dept_id LIKE ?`, id, like).Scan(&d.Members)
	return d
}

// handleDeleteDepartment removes a department. Tasks filed under
// it are kept - their dept_id is cleared, so they stay in All Tasks rather than
// disappearing with the folder. Because that also puts them out of every
// member's reach, the call refuses until the caller passes ?confirm=1 and
// reports exactly what is attached.
func handleDeleteDepartment(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		var deptName string
		if err := db.QueryRow(`SELECT name FROM departments WHERE id = ?`, id).Scan(&deptName); err != nil {
			writeJSONError(w, http.StatusNotFound, "no such department")
			return
		}
		deps := countDeptDependents(db, id)
		if deps.any() && r.URL.Query().Get("confirm") != "1" {
			writeJSON(w, http.StatusConflict, map[string]interface{}{
				"error":      "this department still has things filed under it",
				"dependents": deps,
			})
			return
		}

		like := id + "/%"
		// users.dept_id has no foreign key, so clear it here or those accounts
		// would keep pointing at a department that no longer exists and lose
		// the right to change anything without any sign of why.
		if _, err := db.Exec(`UPDATE users SET dept_id = NULL WHERE dept_id = ? OR dept_id LIKE ?`, id, like); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not detach members")
			return
		}
		// tasks.dept_id is ON DELETE SET NULL, and child
		// departments cascade, so the rows survive the folder going away.
		if _, err := db.Exec(`DELETE FROM departments WHERE id = ?`, id); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not delete the department")
			return
		}
		logActivity(db, r, "deleted", "department", id, deptName)
		publishFor(r, "departments", "tasks", "users")
		writeJSON(w, http.StatusOK, map[string]interface{}{"released": deps})
	}
}

// ---- tasks ----

type Task struct {
	ID              int64  `json:"id"`
	Title           string `json:"title"`
	Description     string `json:"description"`
	CommentCount    int    `json:"commentCount"`
	DeptID          string `json:"deptId"`
	Assignee        string `json:"assignee"`
	AssigneeID      int64  `json:"assigneeId"`
	Priority        string `json:"priority"`
	DueDate         string `json:"dueDate"`
	Status          string `json:"status"`
	Overdue         bool   `json:"overdue"`
	CalendarVisible bool   `json:"calendarVisible"`
	Recurrence      string `json:"recurrence"`
	Icon            string `json:"icon"`
	AttachmentCount int    `json:"attachmentCount"`
	ChecklistTotal  int    `json:"checklistTotal"`
	ChecklistDone   int    `json:"checklistDone"`
	CreatedByName   string `json:"createdByName"`
	UpdatedAt       string `json:"updatedAt"`
	// Match says where a search found this task, when that was somewhere the
	// list does not show - a comment, say. Absent outside a search.
	Match *SearchMatch `json:"match,omitempty"`
}

var validStatus = map[string]bool{"todo": true, "inprogress": true, "review": true, "done": true}
var validPriority = map[string]bool{"High": true, "Medium": true, "Low": true}

func today() string { return time.Now().Format("2006-01-02") }

// isOverdue is derived, never stored: a task is overdue when it has a due date
// in the past and is not finished. As a stored status nothing ever set it, and
// anything that did get set stayed overdue after its due date moved.
func isOverdue(status, dueDate, todayStr string) bool {
	return status != "done" && dueDate != "" && dueDate < todayStr
}

type taskReq struct {
	Title           string `json:"title"`
	Description     string `json:"description"`
	DeptID          string `json:"deptId"`
	Assignee        string `json:"assignee"`
	AssigneeID      int64  `json:"assigneeId"`
	Priority        string `json:"priority"`
	DueDate         string `json:"dueDate"`
	Status          string `json:"status"`
	CalendarVisible bool   `json:"calendarVisible"`
	Recurrence      string `json:"recurrence"`
	// Checklist is only read when a task is created, so the new-task form
	// can hand over the items typed before the task existed. Afterwards
	// items are added and ticked one at a time through their own routes.
	Checklist []string `json:"checklist"`
}

var dueDateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

func validateTask(req *taskReq, requireStatus bool) (int, string) {
	if strings.TrimSpace(req.Title) == "" {
		return http.StatusBadRequest, "a task title is required"
	}
	if req.Priority == "" {
		req.Priority = "Medium"
	}
	if !validPriority[req.Priority] {
		return http.StatusBadRequest, "priority must be High, Medium, or Low"
	}
	if requireStatus && !validStatus[req.Status] {
		return http.StatusBadRequest, "status must be todo, inprogress, review, or done"
	}
	if req.DueDate != "" && !dueDateRe.MatchString(req.DueDate) {
		return http.StatusBadRequest, "due date must be in YYYY-MM-DD form"
	}
	if req.Assignee == "" {
		req.Assignee = "Unassigned"
	}
	rule, err := normalizeRecurrence(req.Recurrence)
	if err != nil {
		return http.StatusBadRequest, err.Error()
	}
	req.Recurrence = rule
	// The due date is what the rule counts from; without one there is no
	// "next" to work out.
	if req.Recurrence != "" && req.DueDate == "" {
		return http.StatusBadRequest, "a repeating task needs a due date to repeat from"
	}
	return 0, ""
}

// resolveAssignee turns whatever the client sent into the pair the tasks table
// stores: a link to an account when one was picked, and the text to show. The
// text is kept even for a linked assignee so that a task filed against someone
// still reads correctly if their account is later removed.
func resolveAssignee(db *sql.DB, req *taskReq) (interface{}, string, int, string) {
	if req.AssigneeID > 0 {
		var name, status string
		err := db.QueryRow(`SELECT display_name, status FROM users WHERE id = ?`, req.AssigneeID).Scan(&name, &status)
		if err != nil {
			return nil, "", http.StatusBadRequest, "no such member"
		}
		if status != statusActive {
			return nil, "", http.StatusBadRequest, "that account is not active"
		}
		return req.AssigneeID, name, 0, ""
	}
	name := strings.TrimSpace(req.Assignee)
	if name == "" {
		name = "Unassigned"
	}
	return nil, name, 0, ""
}

// deptWriteDenied returns the message to send when the user may not file work
// under deptID, or an empty string when they may.
func deptWriteDenied(u *User, deptID string) string {
	if u.canWriteDept(deptID) {
		return ""
	}
	if u.DeptID == "" {
		return "your account is not assigned to a department yet - ask an administrator"
	}
	if deptID == "" {
		return "only an administrator can file work outside every department"
	}
	return "you can only change work in your own department"
}
