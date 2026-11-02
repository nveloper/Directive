package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-ical"
	"github.com/emersion/go-webdav"
	"github.com/emersion/go-webdav/caldav"
)

// Directive speaks CalDAV so a phone's own reminders app can hold its tasks
// and write back to them. This is the opposite of the iCloud sync the README
// rules out: there, Directive would have to keep someone's Apple password and
// reach out to their account; here the client comes to us and signs in with
// the Directive account it already has, so there is no third-party credential
// to hold and no browser in the path to be blocked by CORS.
//
// The read-only .ics feed stays exactly as it was - it is the only option for
// Google Calendar and Outlook, which cannot talk CalDAV.

const caldavPrefix = "/caldav"

// go-webdav decides what a path refers to purely by how deep it is under the
// prefix: 1 is the principal, 2 the calendar home, 3 a calendar, 4 an object.
// The layout has to line up with that exactly.
//
//	/caldav/<user>/                      principal
//	/caldav/<user>/calendars/            home set
//	/caldav/<user>/calendars/<dept>/     one calendar per department
//	/caldav/<user>/calendars/<dept>/task-12.ics
const caldavCalendarsSegment = "calendars"

// A department id contains slashes ("engineering/backend"), which cannot
// survive a URL path segment, so they are folded to '~' and back.
const deptPathSep = "~"

// Tasks filed under no department at all still need somewhere to live.
const noDeptSegment = "_none"

func deptToSegment(id string) string {
	if id == "" {
		return noDeptSegment
	}
	return strings.ReplaceAll(id, "/", deptPathSep)
}

func segmentToDept(seg string) string {
	if seg == noDeptSegment {
		return ""
	}
	return strings.ReplaceAll(seg, deptPathSep, "/")
}

// ---- authentication ----

// CalDAV clients authenticate with HTTP Basic on every request, and they poll
// often with several connections at once. bcrypt at our cost setting takes
// long enough that doing it per request would be the slowest thing in the
// server, so a success is remembered briefly. The cache holds a digest of the
// password, never the password.
type credCache struct {
	mu      sync.Mutex
	entries map[string]credEntry
	ttl     time.Duration
}

type credEntry struct {
	user    User
	expires time.Time
}

func newCredCache(ttl time.Duration) *credCache {
	c := &credCache{entries: map[string]credEntry{}, ttl: ttl}
	go func() {
		for range time.Tick(ttl) {
			c.sweep()
		}
	}()
	return c
}

func (c *credCache) sweep() {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	for k, e := range c.entries {
		if now.After(e.expires) {
			delete(c.entries, k)
		}
	}
}

func credKey(username, password string) string {
	sum := sha256.Sum256([]byte(username + "\x00" + password))
	return hex.EncodeToString(sum[:])
}

func (c *credCache) get(key string) (User, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok || time.Now().After(e.expires) {
		return User{}, false
	}
	return e.user, true
}

func (c *credCache) put(key string, u User) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = credEntry{user: u, expires: time.Now().Add(c.ttl)}
}

// forgetUser drops everything remembered for one account, so revoking an app
// password or disabling someone takes effect on their next request rather
// than when the cache happens to expire.
func (c *credCache) forgetUser(userID int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k, e := range c.entries {
		if e.user.ID == userID {
			delete(c.entries, k)
		}
	}
}

// caldavCreds is the one cache the CalDAV handler uses; the account and
// app-password handlers reach it to invalidate.
var caldavCreds = newCredCache(5 * time.Minute)

// requireBasicAuth admits a CalDAV client using the same accounts and approval
// state as the web app. The password may be the account's own or one of its
// app passwords.
func requireBasicAuth(db *sql.DB, cache *credCache, next http.Handler) http.Handler {
	deny := func(w http.ResponseWriter) {
		w.Header().Set("WWW-Authenticate", `Basic realm="Directive", charset="UTF-8"`)
		http.Error(w, "authentication required", http.StatusUnauthorized)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		username, password, ok := r.BasicAuth()
		if !ok || username == "" {
			deny(w)
			return
		}

		key := credKey(username, password)
		if u, hit := cache.get(key); hit {
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userCtxKey, &u)))
			return
		}

		var u User
		var hash string
		err := db.QueryRow(`SELECT id, username, display_name, role, status, COALESCE(dept_id, ''), password_hash, must_change_password
			FROM users WHERE username = ?`, strings.TrimSpace(username)).
			Scan(&u.ID, &u.Username, &u.DisplayName, &u.Role, &u.Status, &u.DeptID, &hash, &u.MustChangePassword)
		if err != nil {
			burnPasswordTime()
			deny(w)
			return
		}
		// The app password is checked first: it is a hash lookup, where the
		// account password costs a full bcrypt round.
		// A temporary password from a reset is for signing in to choose a new
		// one, not for a phone to keep.
		if !checkAppPassword(db, u.ID, password) && (u.MustChangePassword || !checkPassword(hash, password)) {
			deny(w)
			return
		}
		if u.Status != statusActive {
			deny(w)
			return
		}
		cache.put(key, u)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userCtxKey, &u)))
	})
}

func userFromCtx(ctx context.Context) *User {
	u, _ := ctx.Value(userCtxKey).(*User)
	return u
}

// ---- backend ----

type caldavBackend struct {
	db *sql.DB
}

func (b *caldavBackend) CurrentUserPrincipal(ctx context.Context) (string, error) {
	u := userFromCtx(ctx)
	if u == nil {
		return "", webdav.NewHTTPError(http.StatusUnauthorized, fmt.Errorf("not signed in"))
	}
	return caldavPrefix + "/" + u.Username + "/", nil
}

func (b *caldavBackend) CalendarHomeSetPath(ctx context.Context) (string, error) {
	u := userFromCtx(ctx)
	if u == nil {
		return "", webdav.NewHTTPError(http.StatusUnauthorized, fmt.Errorf("not signed in"))
	}
	return caldavPrefix + "/" + u.Username + "/" + caldavCalendarsSegment + "/", nil
}

func (b *caldavBackend) calendarPath(u *User, deptID string) string {
	return caldavPrefix + "/" + u.Username + "/" + caldavCalendarsSegment + "/" + deptToSegment(deptID) + "/"
}

// calendarFor turns a request path back into the department it stands for.
func (b *caldavBackend) calendarFor(ctx context.Context, path string) (*User, string, error) {
	u := userFromCtx(ctx)
	if u == nil {
		return nil, "", webdav.NewHTTPError(http.StatusUnauthorized, fmt.Errorf("not signed in"))
	}
	rest := strings.TrimPrefix(path, caldavPrefix+"/"+u.Username+"/"+caldavCalendarsSegment+"/")
	rest = strings.Trim(rest, "/")
	if rest == "" {
		return nil, "", webdav.NewHTTPError(http.StatusNotFound, fmt.Errorf("no such calendar"))
	}
	seg := strings.SplitN(rest, "/", 2)[0]
	return u, segmentToDept(seg), nil
}

// Every approved member can read every task, which is what the web app does,
// so every department shows up as a calendar. Writing is still checked per
// department when a change comes back.
func (b *caldavBackend) ListCalendars(ctx context.Context) ([]caldav.Calendar, error) {
	u := userFromCtx(ctx)
	if u == nil {
		return nil, webdav.NewHTTPError(http.StatusUnauthorized, fmt.Errorf("not signed in"))
	}
	depts, err := listDepartments(b.db)
	if err != nil {
		return nil, err
	}
	out := make([]caldav.Calendar, 0, len(depts)+1)
	for _, d := range depts {
		out = append(out, caldav.Calendar{
			Path:                  b.calendarPath(u, d.ID),
			Name:                  nodeLabelFor(depts, d.ID),
			Description:           "Directive tasks for " + d.Name,
			MaxResourceSize:       1 << 20,
			SupportedComponentSet: []string{ical.CompToDo},
		})
	}
	out = append(out, caldav.Calendar{
		Path:                  b.calendarPath(u, ""),
		Name:                  "Directive (no department)",
		MaxResourceSize:       1 << 20,
		SupportedComponentSet: []string{ical.CompToDo},
	})
	return out, nil
}

func (b *caldavBackend) GetCalendar(ctx context.Context, path string) (*caldav.Calendar, error) {
	cals, err := b.ListCalendars(ctx)
	if err != nil {
		return nil, err
	}
	want := strings.TrimSuffix(path, "/") + "/"
	for i := range cals {
		if cals[i].Path == want {
			return &cals[i], nil
		}
	}
	return nil, webdav.NewHTTPError(http.StatusNotFound, fmt.Errorf("no such calendar"))
}

func (b *caldavBackend) CreateCalendar(ctx context.Context, calendar *caldav.Calendar) error {
	// Calendars here are departments; they are created in the app, not by a
	// client deciding to add one.
	return webdav.NewHTTPError(http.StatusForbidden, fmt.Errorf("calendars mirror departments and are managed in Directive"))
}

// ---- tasks as VTODO ----

// priorityToICal follows RFC 5545: 1 is the most urgent, 9 the least, 0 means
// none given.
func priorityToICal(p string) int {
	switch p {
	case "High":
		return 1
	case "Medium":
		return 5
	case "Low":
		return 9
	}
	return 0
}

func icalToPriority(n int) string {
	switch {
	case n == 0:
		return "Medium"
	case n <= 4:
		return "High"
	case n <= 6:
		return "Medium"
	default:
		return "Low"
	}
}

// statusToICal maps our four states onto the three VTODO has. 'review' has no
// standard equivalent, so the exact state also travels in X-DIRECTIVE-STATUS
// and is preferred when it comes back - a client that does not understand it
// leaves it alone, and one that drops it still round-trips through STATUS.
func statusToICal(status string) string {
	switch status {
	case "done":
		return "COMPLETED"
	case "inprogress", "review":
		return "IN-PROCESS"
	default:
		return "NEEDS-ACTION"
	}
}

// The exact state only refines STATUS, never overrides it. A client that does
// not know X-DIRECTIVE-STATUS still carries it back untouched, so ticking a
// task off on a phone arrives as STATUS:COMPLETED beside the old
// X-DIRECTIVE-STATUS:todo - and the tick is what the person meant.
func icalToStatus(icalStatus, exact string) string {
	if validStatus[exact] && (icalStatus == "" || strings.EqualFold(statusToICal(exact), icalStatus)) {
		return exact
	}
	switch strings.ToUpper(icalStatus) {
	case "COMPLETED":
		return "done"
	case "IN-PROCESS":
		return "inprogress"
	case "CANCELLED", "NEEDS-ACTION":
		return "todo"
	}
	return "todo"
}

// taskObjectPath addresses a task by the name it is known at: the one a client
// chose when it created the object, or task-<id>.ics for everything the web
// app made. A client addresses a resource by the path it PUT to, so this has
// to give back the same one.
func taskObjectPath(u *User, deptID string, id int64, caldavName string) string {
	name := caldavName
	if name == "" {
		name = "task-" + strconv.FormatInt(id, 10) + ".ics"
	}
	return caldavPrefix + "/" + u.Username + "/" + caldavCalendarsSegment + "/" + deptToSegment(deptID) + "/" + name
}

// taskIDFromPath pulls the task id back out of ".../task-12.ics".
func taskIDFromPath(path string) (int64, bool) {
	base := path
	if i := strings.LastIndex(base, "/"); i >= 0 {
		base = base[i+1:]
	}
	base = strings.TrimSuffix(base, ".ics")
	if !strings.HasPrefix(base, "task-") {
		return 0, false
	}
	id, err := strconv.ParseInt(strings.TrimPrefix(base, "task-"), 10, 64)
	if err != nil {
		return 0, false
	}
	return id, true
}

// ConditionalMatch.MatchETag compares unquoted values, so the tag is stored
// that way and the library adds the quotes on the wire.
func taskETag(updatedAt string) string {
	sum := sha256.Sum256([]byte(updatedAt))
	return hex.EncodeToString(sum[:8])
}

type caldavTask struct {
	ID          int64
	Title       string
	Description string
	DeptID      string
	Assignee    string
	Priority    string
	DueDate     string
	Status      string
	CreatedAt   string
	UpdatedAt   string
	CaldavName  string
	CaldavUID   string
	Recurrence  string
}

func (t caldavTask) toICal(deptName string) *ical.Calendar {
	cal := ical.NewCalendar()
	cal.Props.SetText(ical.PropProductID, "-//Directive//EN")
	cal.Props.SetText(ical.PropVersion, "2.0")

	todo := ical.NewComponent(ical.CompToDo)
	// A client that created this object keeps the UID it chose.
	uid := t.CaldavUID
	if uid == "" {
		uid = fmt.Sprintf("task-%d@directive", t.ID)
	}
	todo.Props.SetText(ical.PropUID, uid)
	todo.Props.SetText(ical.PropSummary, t.Title)
	if t.Description != "" {
		todo.Props.SetText(ical.PropDescription, t.Description)
	}
	if created, err := time.Parse(time.RFC3339, t.CreatedAt); err == nil {
		todo.Props.SetDateTime(ical.PropCreated, created.UTC())
	}
	if updated, err := time.Parse(time.RFC3339, t.UpdatedAt); err == nil {
		todo.Props.SetDateTime(ical.PropDateTimeStamp, updated.UTC())
		todo.Props.SetDateTime(ical.PropLastModified, updated.UTC())
	}
	if due, ok := parseDueDate(t.DueDate); ok {
		todo.Props.SetDate(ical.PropDue, due)
		// A repeating VTODO needs DTSTART for its rule to count from, and
		// the due date is what the rule is anchored on here.
		if t.Recurrence != "" {
			todo.Props.SetDate(ical.PropDateTimeStart, due)
			todo.Props.Set(&ical.Prop{Name: ical.PropRecurrenceRule, Value: t.Recurrence})
		}
	}
	todo.Props.SetText(ical.PropStatus, statusToICal(t.Status))
	if t.Status == "done" {
		if updated, err := time.Parse(time.RFC3339, t.UpdatedAt); err == nil {
			todo.Props.SetDateTime(ical.PropCompleted, updated.UTC())
		}
		todo.Props.Set(&ical.Prop{Name: ical.PropPercentComplete, Value: "100"})
	}
	if p := priorityToICal(t.Priority); p > 0 {
		todo.Props.Set(&ical.Prop{Name: ical.PropPriority, Value: strconv.Itoa(p)})
	}
	if deptName != "" {
		todo.Props.SetText(ical.PropCategories, deptName)
	}
	if t.Assignee != "" && t.Assignee != "Unassigned" {
		todo.Props.SetText("X-DIRECTIVE-ASSIGNEE", t.Assignee)
	}
	// The exact state, for the round trip back.
	todo.Props.SetText("X-DIRECTIVE-STATUS", t.Status)

	cal.Children = append(cal.Children, todo)
	return cal
}

const caldavTaskColumns = `t.id, t.title, t.description, COALESCE(t.dept_id,''),
	COALESCE(NULLIF(au.display_name, ''), t.assignee), t.priority, t.due_date, t.status,
	t.created_at, t.updated_at, t.caldav_name, t.caldav_uid, t.recurrence`

func scanCaldavTask(rows interface{ Scan(...interface{}) error }) (caldavTask, error) {
	var t caldavTask
	err := rows.Scan(&t.ID, &t.Title, &t.Description, &t.DeptID, &t.Assignee,
		&t.Priority, &t.DueDate, &t.Status, &t.CreatedAt, &t.UpdatedAt, &t.CaldavName, &t.CaldavUID, &t.Recurrence)
	return t, err
}

// deptNames is a small lookup so each object can carry its department's label
// without a query per task.
func (b *caldavBackend) deptNames() map[string]string {
	out := map[string]string{}
	depts, err := listDepartments(b.db)
	if err != nil {
		return out
	}
	for _, d := range depts {
		out[d.ID] = nodeLabelFor(depts, d.ID)
	}
	return out
}

func (b *caldavBackend) objectFor(u *User, t caldavTask, names map[string]string) caldav.CalendarObject {
	data := t.toICal(names[t.DeptID])
	modTime, _ := time.Parse(time.RFC3339, t.UpdatedAt)
	return caldav.CalendarObject{
		Path:    taskObjectPath(u, t.DeptID, t.ID, t.CaldavName),
		ModTime: modTime,
		ETag:    taskETag(t.UpdatedAt),
		Data:    data,
	}
}

func (b *caldavBackend) ListCalendarObjects(ctx context.Context, path string, req *caldav.CalendarCompRequest) ([]caldav.CalendarObject, error) {
	u, deptID, err := b.calendarFor(ctx, path)
	if err != nil {
		return nil, err
	}
	// A department's calendar carries the work filed under it and under
	// anything nested beneath it, matching what the sidebar shows.
	query := `SELECT ` + caldavTaskColumns + ` FROM tasks t
		LEFT JOIN users au ON au.id = t.assignee_id
		WHERE (t.dept_id = ? OR t.dept_id LIKE ?) AND t.deleted_at = '' ORDER BY t.id`
	args := []interface{}{deptID, deptID + "/%"}
	if deptID == "" {
		query = `SELECT ` + caldavTaskColumns + ` FROM tasks t
			LEFT JOIN users au ON au.id = t.assignee_id
			WHERE (t.dept_id IS NULL OR t.dept_id = '') AND t.deleted_at = '' ORDER BY t.id`
		args = nil
	}
	// The pool holds a single SQLite connection, so every query this needs has
	// to finish before the rows below are opened - asking for the department
	// names while iterating would wait for a connection this loop is holding,
	// and wait forever.
	names := b.deptNames()

	rows, err := b.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []caldav.CalendarObject
	for rows.Next() {
		t, err := scanCaldavTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, b.objectFor(u, t, names))
	}
	return out, rows.Err()
}

func (b *caldavBackend) GetCalendarObject(ctx context.Context, path string, req *caldav.CalendarCompRequest) (*caldav.CalendarObject, error) {
	u := userFromCtx(ctx)
	if u == nil {
		return nil, webdav.NewHTTPError(http.StatusUnauthorized, fmt.Errorf("not signed in"))
	}
	id, ok := b.resolveTaskID(path)
	if !ok {
		return nil, webdav.NewHTTPError(http.StatusNotFound, fmt.Errorf("no such object"))
	}
	row := b.db.QueryRow(`SELECT `+caldavTaskColumns+` FROM tasks t
		LEFT JOIN users au ON au.id = t.assignee_id WHERE t.id = ? AND t.deleted_at = ''`, id)
	t, err := scanCaldavTask(row)
	if err != nil {
		return nil, webdav.NewHTTPError(http.StatusNotFound, fmt.Errorf("no such task"))
	}
	obj := b.objectFor(u, t, b.deptNames())
	return &obj, nil
}

func (b *caldavBackend) QueryCalendarObjects(ctx context.Context, path string, query *caldav.CalendarQuery) ([]caldav.CalendarObject, error) {
	objs, err := b.ListCalendarObjects(ctx, path, &query.CompRequest)
	if err != nil {
		return nil, err
	}
	return caldav.Filter(query, objs)
}

// resourceName is the last path segment, which is how a CalDAV client
// addresses an object.
func resourceName(path string) string {
	if i := strings.LastIndex(path, "/"); i >= 0 {
		return path[i+1:]
	}
	return path
}

// resolveTaskID finds the task a request path refers to. A client that created
// the object chose the name itself, so that is checked first; everything the
// web app made answers to task-<id>.ics.
func (b *caldavBackend) resolveTaskID(path string) (int64, bool) {
	name := resourceName(path)
	var id int64
	if err := b.db.QueryRow(`SELECT id FROM tasks WHERE caldav_name = ? AND caldav_name <> '' AND deleted_at = ''`, name).Scan(&id); err == nil {
		return id, true
	}
	return taskIDFromPath(path)
}

// firstToDo digs the VTODO out of whatever the client sent.
func firstToDo(cal *ical.Calendar) *ical.Component {
	for _, child := range cal.Children {
		if child.Name == ical.CompToDo {
			return child
		}
	}
	return nil
}

func propText(c *ical.Component, name string) string {
	v, err := c.Props.Text(name)
	if err != nil {
		return ""
	}
	return v
}

// PutCalendarObject takes a change from a client. A reminders app only knows
// about a handful of fields, so the ones it cannot see - department,
// assignee, calendar visibility, comments - are left exactly as they were
// rather than being wiped by a round trip through a client that never knew
// about them.
func (b *caldavBackend) PutCalendarObject(ctx context.Context, path string, cal *ical.Calendar, opts *caldav.PutCalendarObjectOptions) (*caldav.CalendarObject, error) {
	u, calDept, err := b.calendarFor(ctx, path)
	if err != nil {
		return nil, err
	}
	todo := firstToDo(cal)
	if todo == nil {
		return nil, webdav.NewHTTPError(http.StatusBadRequest, fmt.Errorf("only VTODO is supported here"))
	}

	title := strings.TrimSpace(propText(todo, ical.PropSummary))
	if title == "" {
		return nil, webdav.NewHTTPError(http.StatusBadRequest, fmt.Errorf("a task needs a title"))
	}
	description := propText(todo, ical.PropDescription)
	status := icalToStatus(propText(todo, ical.PropStatus), propText(todo, "X-DIRECTIVE-STATUS"))

	dueDate := ""
	if due, err := todo.Props.DateTime(ical.PropDue, time.UTC); err == nil && !due.IsZero() {
		dueDate = due.Format("2006-01-02")
	}
	// A rule the server cannot use (hourly, say) is dropped rather than
	// failing the whole write - the rest of the change is still good.
	recurrence := ""
	if p := todo.Props.Get(ical.PropRecurrenceRule); p != nil {
		if rule, err := normalizeRecurrence(p.Value); err == nil {
			recurrence = rule
		}
	}
	// Some clients anchor a repeating to-do on DTSTART and leave DUE off.
	if recurrence != "" && dueDate == "" {
		if start, err := todo.Props.DateTime(ical.PropDateTimeStart, time.UTC); err == nil && !start.IsZero() {
			dueDate = start.Format("2006-01-02")
		}
	}
	if dueDate == "" {
		recurrence = ""
	}
	priority := ""
	if p := todo.Props.Get(ical.PropPriority); p != nil {
		if n, err := strconv.Atoi(strings.TrimSpace(p.Value)); err == nil {
			priority = icalToPriority(n)
		}
	}

	now := time.Now().UTC().Format(time.RFC3339)
	id, existing := b.resolveTaskID(path)

	if existing {
		var curDept, curETagSource, curPriority, curStatus string
		if err := b.db.QueryRow(`SELECT COALESCE(dept_id,''), updated_at, priority, status FROM tasks WHERE id = ? AND deleted_at = ''`, id).
			Scan(&curDept, &curETagSource, &curPriority, &curStatus); err != nil {
			existing = false
		} else {
			if msg := deptWriteDenied(u, curDept); msg != "" {
				return nil, webdav.NewHTTPError(http.StatusForbidden, fmt.Errorf("%s", msg))
			}
			// Someone else changed it since this client last read it.
			if opts != nil && opts.IfMatch.IsSet() {
				ok, err := opts.IfMatch.MatchETag(taskETag(curETagSource))
				if err != nil {
					return nil, webdav.NewHTTPError(http.StatusBadRequest, err)
				}
				if !ok {
					return nil, webdav.NewHTTPError(http.StatusPreconditionFailed, fmt.Errorf("the task changed since you last read it"))
				}
			}
			if priority == "" {
				priority = curPriority
			}
			if _, err := b.db.Exec(`UPDATE tasks SET title=?, description=?, due_date=?, priority=?, status=?, recurrence=?, updated_at=? WHERE id=?`,
				title, description, dueDate, priority, status, recurrence, now, id); err != nil {
				return nil, err
			}
			logActivityCtx(b.db, ctx, "caldav", "updated", "task", strconv.FormatInt(id, 10), title)
			// A client that understands repetition advances the due date
			// itself and sends the task back unfinished; one that marks a
			// repeating task complete gets the next occurrence from us.
			if status == "done" && curStatus != "done" {
				rollRecurrence(b.db, ctx, "caldav", id)
			}
			events.publish("tasks", "caldav")
			events.publish("activity", "caldav")
		}
	}

	if !existing {
		if opts != nil && opts.IfMatch.IsSet() {
			return nil, webdav.NewHTTPError(http.StatusPreconditionFailed, fmt.Errorf("no such task"))
		}
		if msg := deptWriteDenied(u, calDept); msg != "" {
			return nil, webdav.NewHTTPError(http.StatusForbidden, fmt.Errorf("%s", msg))
		}
		if priority == "" {
			priority = "Medium"
		}
		var deptArg interface{}
		if calDept != "" {
			deptArg = calDept
		}
		res, err := b.db.Exec(`INSERT INTO tasks (title, description, dept_id, assignee, priority, due_date, status, calendar_visible, recurrence, created_by, created_at, updated_at, caldav_name, caldav_uid)
			VALUES (?, ?, ?, 'Unassigned', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
			title, description, deptArg, priority, dueDate, status, recurrence, u.ID, now, now,
			resourceName(path), strings.TrimSpace(propText(todo, ical.PropUID)))
		if err != nil {
			return nil, err
		}
		id, _ = res.LastInsertId()
		logActivityCtx(b.db, ctx, "caldav", "created", "task", strconv.FormatInt(id, 10), title)
		events.publish("tasks", "caldav")
		events.publish("activity", "caldav")
	}

	return b.GetCalendarObject(ctx, path, nil)
}

func (b *caldavBackend) DeleteCalendarObject(ctx context.Context, path string) error {
	u := userFromCtx(ctx)
	if u == nil {
		return webdav.NewHTTPError(http.StatusUnauthorized, fmt.Errorf("not signed in"))
	}
	id, ok := b.resolveTaskID(path)
	if !ok {
		return webdav.NewHTTPError(http.StatusNotFound, fmt.Errorf("no such task"))
	}
	var dept, title string
	if err := b.db.QueryRow(`SELECT COALESCE(dept_id,''), title FROM tasks WHERE id = ? AND deleted_at = ''`, id).Scan(&dept, &title); err != nil {
		return webdav.NewHTTPError(http.StatusNotFound, fmt.Errorf("no such task"))
	}
	if msg := deptWriteDenied(u, dept); msg != "" {
		return webdav.NewHTTPError(http.StatusForbidden, fmt.Errorf("%s", msg))
	}
	// A phone deleting something - by hand or because a sync went wrong -
	// lands in the trash like a delete from the web app, so it can be undone.
	if err := trashTask(b.db, id, u.ID); err != nil {
		return err
	}
	logActivityCtx(b.db, ctx, "caldav", "moved to the trash", "task", strconv.FormatInt(id, 10), title)
	events.publish("tasks", "caldav")
	events.publish("activity", "caldav")
	return nil
}
