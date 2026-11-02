package main

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"
)

// Filtering, searching and paging used to happen in the browser over every
// task in the database. This moves it into SQL, so a client holds one page
// instead of the whole table. The counts the tabs show cannot come from a
// page, so they are computed here too.

const defaultPageSize = 6
const maxPageSize = 100

type taskQuery struct {
	scope      string // "all", "mine", or a department id
	search     string
	statuses   []string // todo | inprogress | review | done | overdue
	priorities []string
	calendar   string // all | shown | hidden
	assignee   string // "" for anyone, "none" for unassigned, or an account id
	dueFrom    string // YYYY-MM-DD, inclusive; "" for no lower bound
	dueTo      string // YYYY-MM-DD, inclusive; "" for no upper bound
	sort       string // a key of taskOrders
	page       int
	pageSize   int
}

func parseTaskQuery(r *http.Request) taskQuery {
	q := r.URL.Query()
	tq := taskQuery{
		scope:    strings.TrimSpace(q.Get("scope")),
		search:   strings.TrimSpace(q.Get("q")),
		calendar: q.Get("calendar"),
		assignee: strings.TrimSpace(q.Get("assignee")),
		sort:     q.Get("sort"),
		page:     1,
		pageSize: defaultPageSize,
	}
	if tq.scope == "" {
		tq.scope = "all"
	}
	if _, ok := taskOrders[tq.sort]; !ok {
		tq.sort = "created"
	}
	if tq.calendar != "shown" && tq.calendar != "hidden" {
		tq.calendar = "all"
	}
	// dueFrom/dueTo bound the due date, for the month the calendar view
	// shows. A value that is not a date is ignored rather than refused.
	if v := q.Get("dueFrom"); dueDateRe.MatchString(v) {
		tq.dueFrom = v
	}
	if v := q.Get("dueTo"); dueDateRe.MatchString(v) {
		tq.dueTo = v
	}
	if s := q.Get("status"); s != "" && s != "all" {
		tq.statuses = strings.Split(s, ",")
	}
	if p := q.Get("priority"); p != "" && p != "all" {
		tq.priorities = strings.Split(p, ",")
	}
	if n, err := strconv.Atoi(q.Get("page")); err == nil && n > 0 {
		tq.page = n
	}
	if n, err := strconv.Atoi(q.Get("pageSize")); err == nil && n > 0 {
		tq.pageSize = n
		if tq.pageSize > maxPageSize {
			tq.pageSize = maxPageSize
		}
	}
	return tq
}

// Tasks without a due date go after the ones with one, whichever way the
// list is sorted by it: "no deadline" is not "the earliest deadline".
const dueOrder = `CASE WHEN t.due_date = '' THEN 1 ELSE 0 END, t.due_date`

// taskOrders are the list's sort choices. Each ends on the id, so a page
// boundary never falls between two rows that sort equal and shows one twice.
var taskOrders = map[string]string{
	"created":  "t.id",
	"due":      dueOrder + ", t.id",
	"priority": "CASE t.priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 WHEN 'Low' THEN 2 ELSE 3 END, " + dueOrder + ", t.id",
	"updated":  "t.updated_at DESC, t.id DESC",
	"title":    "LOWER(t.title), t.id",
}

// likeEscape neutralises the wildcards in a search term so a literal % or _
// finds itself instead of matching everything.
func likeEscape(s string) string {
	r := strings.NewReplacer(`\`, `\`, `%`, `\%`, `_`, `\_`)
	return "%" + r.Replace(strings.ToLower(s)) + "%"
}

const taskJoins = `
	FROM tasks t
	LEFT JOIN departments d ON d.id = t.dept_id
	LEFT JOIN departments pd ON pd.id = d.parent_id
	LEFT JOIN users cu ON cu.id = t.created_by
	LEFT JOIN users au ON au.id = t.assignee_id`

// taskSelectColumns is everything a Task carries, in the order
// taskScanTargets expects. Every place that hands tasks to the client reads
// them through this pair, so a new field is added once.
const taskSelectColumns = `t.id, t.title, t.description,
		(SELECT COUNT(*) FROM comments ct WHERE ct.task_id = t.id),
		COALESCE(t.dept_id,''),
		COALESCE(NULLIF(au.display_name, ''), t.assignee), COALESCE(t.assignee_id, 0),
		t.priority, t.due_date, t.status, t.calendar_visible, t.recurrence, t.icon,
		(SELECT COUNT(*) FROM attachments ax WHERE ax.task_id = t.id),
		(SELECT COUNT(*) FROM checklist_items ci WHERE ci.task_id = t.id),
		(SELECT COUNT(*) FROM checklist_items ci WHERE ci.task_id = t.id AND ci.done = 1),
		COALESCE(cu.display_name, ''), t.updated_at`

func taskScanTargets(t *Task, visible *int, extra ...interface{}) []interface{} {
	return append([]interface{}{&t.ID, &t.Title, &t.Description, &t.CommentCount, &t.DeptID,
		&t.Assignee, &t.AssigneeID, &t.Priority, &t.DueDate, &t.Status, visible, &t.Recurrence,
		&t.Icon, &t.AttachmentCount, &t.ChecklistTotal, &t.ChecklistDone, &t.CreatedByName, &t.UpdatedAt}, extra...)
}

func finishTask(t *Task, visible int, todayStr string) {
	t.CalendarVisible = visible != 0
	t.Overdue = isOverdue(t.Status, t.DueDate, todayStr)
}

func scanTask(row interface{ Scan(...interface{}) error }, todayStr string) (Task, error) {
	var t Task
	var visible int
	if err := row.Scan(taskScanTargets(&t, &visible)...); err != nil {
		return t, err
	}
	finishTask(&t, visible, todayStr)
	return t, nil
}

// where builds the shared filter. overdue is derived from the due date rather
// than stored, so it has to be expressed here rather than compared as a status.
func (tq taskQuery) where(u *User, todayStr string) (string, []interface{}) {
	// Trashed tasks are out of every list; the trash has its own.
	clauses := []string{"t.deleted_at = ''"}
	var args []interface{}

	switch tq.scope {
	case "all":
	case "mine":
		clauses = append(clauses, "t.assignee_id = ?")
		args = append(args, u.ID)
	default:
		clauses = append(clauses, "(t.dept_id = ? OR t.dept_id LIKE ?)")
		args = append(args, tq.scope, tq.scope+"/%")
	}

	if tq.search != "" {
		term := likeEscape(tq.search)
		// The department is matched by its own name and by its parent's,
		// because that pair is what the sidebar shows. Past what the list
		// shows, the words inside a task count too: its description,
		// checklist, comments and file names.
		clauses = append(clauses, `(
			LOWER(t.title) LIKE ? ESCAPE '\' OR
			LOWER(t.assignee) LIKE ? ESCAPE '\' OR
			LOWER(COALESCE(d.name, '')) LIKE ? ESCAPE '\' OR
			LOWER(COALESCE(pd.name, '')) LIKE ? ESCAPE '\' OR
			LOWER(t.description) LIKE ? ESCAPE '\' OR
			EXISTS (SELECT 1 FROM checklist_items sc WHERE sc.task_id = t.id AND LOWER(sc.body) LIKE ? ESCAPE '\') OR
			EXISTS (SELECT 1 FROM comments sm WHERE sm.task_id = t.id AND LOWER(sm.body) LIKE ? ESCAPE '\') OR
			EXISTS (SELECT 1 FROM attachments sa WHERE sa.task_id = t.id AND LOWER(sa.name) LIKE ? ESCAPE '\')
		)`)
		args = append(args, term, term, term, term, term, term, term, term)
	}

	if len(tq.priorities) > 0 {
		holes := make([]string, len(tq.priorities))
		for i, p := range tq.priorities {
			holes[i] = "?"
			args = append(args, p)
		}
		clauses = append(clauses, "t.priority IN ("+strings.Join(holes, ",")+")")
	}

	switch tq.assignee {
	case "":
	case "none":
		clauses = append(clauses, "(t.assignee_id IS NULL AND t.assignee IN ('', 'Unassigned'))")
	default:
		if id, err := strconv.ParseInt(tq.assignee, 10, 64); err == nil {
			clauses = append(clauses, "t.assignee_id = ?")
			args = append(args, id)
		} else {
			clauses = append(clauses, "1 = 0")
		}
	}

	if tq.dueFrom != "" {
		clauses = append(clauses, "t.due_date <> '' AND t.due_date >= ?")
		args = append(args, tq.dueFrom)
	}
	if tq.dueTo != "" {
		clauses = append(clauses, "t.due_date <> '' AND t.due_date <= ?")
		args = append(args, tq.dueTo)
	}

	switch tq.calendar {
	case "shown":
		clauses = append(clauses, "t.calendar_visible = 1")
	case "hidden":
		clauses = append(clauses, "t.calendar_visible = 0")
	}

	if len(tq.statuses) > 0 {
		var parts []string
		for _, st := range tq.statuses {
			if st == "overdue" {
				parts = append(parts, "(t.status <> 'done' AND t.due_date <> '' AND t.due_date < ?)")
				args = append(args, todayStr)
			} else if validStatus[st] {
				parts = append(parts, "t.status = ?")
				args = append(args, st)
			}
		}
		if len(parts) == 0 {
			// Every requested status was unrecognised; match nothing rather
			// than silently falling back to everything.
			clauses = append(clauses, "1 = 0")
		} else {
			clauses = append(clauses, "("+strings.Join(parts, " OR ")+")")
		}
	}

	return " WHERE " + strings.Join(clauses, " AND "), args
}

type taskListResponse struct {
	Tasks        []Task         `json:"tasks"`
	Page         int            `json:"page"`
	PageSize     int            `json:"pageSize"`
	Total        int            `json:"total"`
	TotalPages   int            `json:"totalPages"`
	StatusCounts map[string]int `json:"statusCounts"`
}

func handleListTasks(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromContext(r)
		tq := parseTaskQuery(r)
		todayStr := today()

		// The tab counts have to ignore the tab itself, or every tab would
		// show the count of whichever one is selected.
		countQuery := tq
		countQuery.statuses = nil
		countWhere, countArgs := countQuery.where(u, todayStr)
		row := db.QueryRow(`SELECT
				COUNT(*),
				SUM(CASE WHEN t.status = 'todo' THEN 1 ELSE 0 END),
				SUM(CASE WHEN t.status = 'inprogress' THEN 1 ELSE 0 END),
				SUM(CASE WHEN t.status = 'review' THEN 1 ELSE 0 END),
				SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END),
				SUM(CASE WHEN t.status <> 'done' AND t.due_date <> '' AND t.due_date < ? THEN 1 ELSE 0 END)`+
			taskJoins+countWhere, append([]interface{}{todayStr}, countArgs...)...)
		var all int
		var todo, inprogress, review, done, overdue sql.NullInt64
		if err := row.Scan(&all, &todo, &inprogress, &review, &done, &overdue); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not count tasks")
			return
		}
		counts := map[string]int{
			"all":        all,
			"todo":       int(todo.Int64),
			"inprogress": int(inprogress.Int64),
			"review":     int(review.Int64),
			"done":       int(done.Int64),
			"overdue":    int(overdue.Int64),
		}

		where, args := tq.where(u, todayStr)
		var total int
		if err := db.QueryRow(`SELECT COUNT(*)`+taskJoins+where, args...).Scan(&total); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not count tasks")
			return
		}
		totalPages := (total + tq.pageSize - 1) / tq.pageSize
		if totalPages < 1 {
			totalPages = 1
		}
		if tq.page > totalPages {
			tq.page = totalPages
		}

		rows, err := db.Query(`SELECT `+taskSelectColumns+
			taskJoins+where+` ORDER BY `+taskOrders[tq.sort]+` LIMIT ? OFFSET ?`,
			append(args, tq.pageSize, (tq.page-1)*tq.pageSize)...)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not load tasks")
			return
		}
		defer rows.Close()

		out := []Task{}
		for rows.Next() {
			t, err := scanTask(rows, todayStr)
			if err != nil {
				writeJSONError(w, http.StatusInternalServerError, "could not read tasks")
				return
			}
			out = append(out, t)
		}
		rows.Close()
		if tq.search != "" {
			for i := range out {
				out[i].Match = searchMatch(db, &out[i], tq.search)
			}
		}

		writeJSON(w, http.StatusOK, taskListResponse{
			Tasks: out, Page: tq.page, PageSize: tq.pageSize,
			Total: total, TotalPages: totalPages, StatusCounts: counts,
		})
	}
}

// handleTaskSummary feeds the sidebar, whose counts are totals per department
// and are deliberately unaffected by the filters applied to the list.
func handleTaskSummary(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromContext(r)
		var all, mine, trash int
		db.QueryRow(`SELECT COUNT(*) FROM tasks WHERE deleted_at = ''`).Scan(&all)
		db.QueryRow(`SELECT COUNT(*) FROM tasks WHERE assignee_id = ? AND deleted_at = ''`, u.ID).Scan(&mine)
		db.QueryRow(`SELECT COUNT(*) FROM tasks WHERE deleted_at <> ''`).Scan(&trash)

		byDept := map[string]int{}
		rows, err := db.Query(`SELECT d.id, (
				SELECT COUNT(*) FROM tasks t WHERE (t.dept_id = d.id OR t.dept_id LIKE d.id || '/%') AND t.deleted_at = ''
			) FROM departments d`)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not count tasks")
			return
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			var n int
			if err := rows.Scan(&id, &n); err == nil {
				byDept[id] = n
			}
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"all": all, "mine": mine, "trash": trash, "byDept": byDept})
	}
}

// handleTasksToday feeds the "Due today" card: unfinished work due today or
// already past due, soonest first. It is what the old stand-alone reminders
// list was trying to be, drawn from the tasks themselves.
func handleTasksToday(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		todayStr := today()
		rows, err := db.Query(`SELECT `+taskSelectColumns+
			taskJoins+`
			WHERE t.status <> 'done' AND t.due_date <> '' AND t.due_date <= ? AND t.deleted_at = ''
			ORDER BY t.due_date, t.id LIMIT 50`, todayStr)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not load today's tasks")
			return
		}
		defer rows.Close()
		out := []Task{}
		for rows.Next() {
			t, err := scanTask(rows, todayStr)
			if err != nil {
				writeJSONError(w, http.StatusInternalServerError, "could not read today's tasks")
				return
			}
			out = append(out, t)
		}
		writeJSON(w, http.StatusOK, out)
	}
}
