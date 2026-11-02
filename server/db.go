package main

import (
	"database/sql"
	"log"
	"time"

	_ "modernc.org/sqlite"
)

func openDB(path string) *sql.DB {
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(ON)")
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	// SQLite takes a database-wide write lock, so a pool of connections buys
	// nothing for writes and invites SQLITE_BUSY under concurrent updates.
	// One connection serialises everything; at this scale that is free.
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		log.Fatalf("ping db: %v", err)
	}
	if _, err := db.Exec(schema); err != nil {
		log.Fatalf("apply schema: %v", err)
	}
	migrate(db)
	absorbReminders(db)
	if _, err := db.Exec(`INSERT OR IGNORE INTO settings (key, value) VALUES ('app_name', 'Directive')`); err != nil {
		log.Fatalf("seed settings: %v", err)
	}
	return db
}

func columnExists(db *sql.DB, table, column string) bool {
	rows, err := db.Query(`SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		return false
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if rows.Scan(&name) == nil && name == column {
			return true
		}
	}
	return false
}

// migrate brings a database created by an earlier build up to the current
// schema. Every step is guarded so it is safe to run on every start.
func migrate(db *sql.DB) {
	// Accounts now need an approval state and a home department, because
	// membership is what grants the right to edit a department's tasks.
	if !columnExists(db, "users", "status") {
		mustExec(db, `ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`)
		log.Println("migration: users.status added (existing accounts kept active)")
	}
	if !columnExists(db, "users", "dept_id") {
		mustExec(db, `ALTER TABLE users ADD COLUMN dept_id TEXT`)
		log.Println("migration: users.dept_id added")
	}

	// `synced` was decorative — the calendar feed ignored it. It now means
	// "show this task in the department's .ics feed". Existing rows are set
	// visible so nothing disappears from a calendar someone already subscribed to.
	if columnExists(db, "tasks", "synced") && !columnExists(db, "tasks", "calendar_visible") {
		mustExec(db, `ALTER TABLE tasks RENAME COLUMN synced TO calendar_visible`)
		mustExec(db, `UPDATE tasks SET calendar_visible = 1`)
		log.Println("migration: tasks.synced renamed to calendar_visible (all existing tasks made visible)")
	}

	// Assignees were free text, so they could not carry an avatar, be filtered
	// by "mine", or survive a rename. The text column stays: it is the only
	// record of people who never had an account (contractors, someone who has
	// left, a typo), and dropping it would lose information the database
	// already holds. assignee_id links the ones that do match an account.
	if !columnExists(db, "tasks", "assignee_id") {
		mustExec(db, `ALTER TABLE tasks ADD COLUMN assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL`)
		mustExec(db, `UPDATE tasks SET assignee_id = (
			SELECT u.id FROM users u
			WHERE TRIM(LOWER(u.display_name)) = TRIM(LOWER(tasks.assignee))
			LIMIT 1
		) WHERE assignee <> '' AND assignee <> 'Unassigned'`)
		var linked, unlinked int
		db.QueryRow(`SELECT COUNT(*) FROM tasks WHERE assignee_id IS NOT NULL`).Scan(&linked)
		db.QueryRow(`SELECT COUNT(*) FROM tasks WHERE assignee_id IS NULL AND assignee <> '' AND assignee <> 'Unassigned'`).Scan(&unlinked)
		log.Printf("migration: tasks.assignee_id added - %d linked to an account, %d kept as text (no matching account)", linked, unlinked)
	}

	// 'overdue' is derived from due_date now, never stored, so a task can't get
	// stuck in it after its due date moves.
	mustExec(db, `UPDATE tasks SET status = 'todo' WHERE status = 'overdue'`)

	// A CalDAV client picks its own file name when it creates something, and
	// then addresses that resource by it forever, so the name it chose has to
	// be remembered rather than derived from the row id.
	if !columnExists(db, "tasks", "caldav_name") {
		mustExec(db, `ALTER TABLE tasks ADD COLUMN caldav_name TEXT NOT NULL DEFAULT ''`)
		mustExec(db, `CREATE INDEX IF NOT EXISTS idx_tasks_caldav ON tasks(caldav_name)`)
		log.Println("migration: tasks.caldav_name added")
	}
	// The UID a client assigned has to come back unchanged, or a client that
	// created the object may not recognise it as the same one.
	if !columnExists(db, "tasks", "caldav_uid") {
		mustExec(db, `ALTER TABLE tasks ADD COLUMN caldav_uid TEXT NOT NULL DEFAULT ''`)
		log.Println("migration: tasks.caldav_uid added")
	}

	// A task was a single line of text. There was nowhere to say why it exists
	// or what "done" means for it, and no way to discuss it.
	if !columnExists(db, "tasks", "description") {
		mustExec(db, `ALTER TABLE tasks ADD COLUMN description TEXT NOT NULL DEFAULT ''`)
		log.Println("migration: tasks.description added")
	}

	// A repeating task carries its rule as an RFC 5545 RRULE value, the same
	// string a reminders app sends, so a rule made on a phone survives the
	// round trip even when the web app has no preset for it.
	if !columnExists(db, "tasks", "recurrence") {
		mustExec(db, `ALTER TABLE tasks ADD COLUMN recurrence TEXT NOT NULL DEFAULT ''`)
		log.Println("migration: tasks.recurrence added")
	}

	// Deleting a task moves it to the trash for a while instead of losing it -
	// a slip of the finger, or a phone's sync deciding something is gone, was
	// otherwise final.
	if !columnExists(db, "tasks", "deleted_at") {
		mustExec(db, `ALTER TABLE tasks ADD COLUMN deleted_at TEXT NOT NULL DEFAULT ''`)
		mustExec(db, `ALTER TABLE tasks ADD COLUMN deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL`)
		log.Println("migration: tasks.deleted_at added (trash)")
	}

	// A department's colour, a "#rrggbb" an administrator picks so its work
	// can be told apart at a glance; empty for none.
	if !columnExists(db, "departments", "color") {
		mustExec(db, `ALTER TABLE departments ADD COLUMN color TEXT NOT NULL DEFAULT ''`)
		log.Println("migration: departments.color added")
	}

	// A task's icon: an emoji, "image" for an uploaded picture (kept in images
	// as task:<id>), or empty for none.
	if !columnExists(db, "tasks", "icon") {
		mustExec(db, `ALTER TABLE tasks ADD COLUMN icon TEXT NOT NULL DEFAULT ''`)
		log.Println("migration: tasks.icon added")
	}

	// Set when an administrator resets someone's password: the temporary one
	// gets them in, and the app then asks for a password of their own before
	// anything else.
	if !columnExists(db, "users", "must_change_password") {
		mustExec(db, `ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0`)
		log.Println("migration: users.must_change_password added")
	}

	// Attachments moved out of the database into files (files.go). path is
	// where the file is; data is left empty once it has moved.
	if !columnExists(db, "attachments", "path") {
		mustExec(db, `ALTER TABLE attachments ADD COLUMN path TEXT NOT NULL DEFAULT ''`)
		log.Println("migration: attachments.path added")
	}
	mustExec(db, `CREATE TABLE IF NOT EXISTS attachment_files_gone (path TEXT PRIMARY KEY)`)
	// Fires for cascaded deletes too, which is the point: a purged task's
	// files are found this way.
	mustExec(db, `CREATE TRIGGER IF NOT EXISTS attachments_file_gone AFTER DELETE ON attachments
		WHEN old.path <> '' BEGIN
			INSERT OR IGNORE INTO attachment_files_gone (path) VALUES (old.path);
		END`)

	mustExec(db, `CREATE INDEX IF NOT EXISTS idx_tasks_dept ON tasks(dept_id)`)
	mustExec(db, `CREATE INDEX IF NOT EXISTS idx_tasks_deleted ON tasks(deleted_at)`)
	mustExec(db, `CREATE INDEX IF NOT EXISTS idx_attachments_task ON attachments(task_id)`)
	mustExec(db, `CREATE INDEX IF NOT EXISTS idx_checklist_task ON checklist_items(task_id)`)
	mustExec(db, `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id DESC)`)
	mustExec(db, `CREATE INDEX IF NOT EXISTS idx_app_passwords_user ON app_passwords(user_id)`)
	mustExec(db, `CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id)`)
	mustExec(db, `CREATE INDEX IF NOT EXISTS idx_activity_id ON activity(id DESC)`)
	mustExec(db, `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`)
}

func tableExists(db *sql.DB, name string) bool {
	var n int
	db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, name).Scan(&n)
	return n > 0
}

// absorbReminders folds the old stand-alone reminders into tasks. They were a
// second, thinner kind of to-do - text, a department, a tick - and in a phone's
// reminders app the two are indistinguishable anyway. Every row is carried
// over; the old table is left in place untouched rather than dropped, so the
// original data is still there if it is ever wanted. A settings key makes this
// run once.
func absorbReminders(db *sql.DB) {
	if !tableExists(db, "reminders") {
		return
	}
	var done string
	db.QueryRow(`SELECT value FROM settings WHERE key = 'reminders_absorbed'`).Scan(&done)
	if done != "" {
		return
	}
	res, err := db.Exec(`INSERT INTO tasks (title, description, dept_id, assignee, priority, due_date, status,
			calendar_visible, created_by, created_at, updated_at)
		SELECT text, '', dept_id, 'Unassigned', 'Medium', '',
			CASE WHEN done = 1 THEN 'done' ELSE 'todo' END,
			0, NULL, created_at, created_at
		FROM reminders ORDER BY id`)
	if err != nil {
		log.Fatalf("migrate reminders into tasks: %v", err)
	}
	n, _ := res.RowsAffected()
	mustExec(db, `INSERT INTO settings (key, value) VALUES ('reminders_absorbed', ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, time.Now().UTC().Format(time.RFC3339))
	log.Printf("migration: %d reminder(s) moved into tasks (the old reminders table is kept as-is)", n)
}

func mustExec(db *sql.DB, q string, args ...interface{}) {
	if _, err := db.Exec(q, args...); err != nil {
		log.Fatalf("migrate (%s): %v", q, err)
	}
}

const schema = `
CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	username TEXT UNIQUE NOT NULL,
	password_hash TEXT NOT NULL,
	display_name TEXT NOT NULL,
	role TEXT NOT NULL DEFAULT 'member',
	status TEXT NOT NULL DEFAULT 'pending',
	dept_id TEXT,
	must_change_password INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
	token TEXT PRIMARY KEY,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS departments (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	parent_id TEXT REFERENCES departments(id) ON DELETE CASCADE,
	calendar_list TEXT NOT NULL DEFAULT '',
	calendar_tag TEXT NOT NULL DEFAULT '',
	feed_token TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS tasks (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	title TEXT NOT NULL,
	dept_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
	assignee TEXT NOT NULL DEFAULT 'Unassigned',
	priority TEXT NOT NULL DEFAULT 'Medium',
	due_date TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL DEFAULT 'todo',
	calendar_visible INTEGER NOT NULL DEFAULT 0,
	assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
	description TEXT NOT NULL DEFAULT '',
	caldav_name TEXT NOT NULL DEFAULT '',
	caldav_uid TEXT NOT NULL DEFAULT '',
	recurrence TEXT NOT NULL DEFAULT '',
	icon TEXT NOT NULL DEFAULT '',
	deleted_at TEXT NOT NULL DEFAULT '',
	deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
	created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checklist_items (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	body TEXT NOT NULL,
	done INTEGER NOT NULL DEFAULT 0,
	position INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	mime TEXT NOT NULL,
	size INTEGER NOT NULL,
	data BLOB NOT NULL,
	uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
	uploader_name TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
	actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
	actor_name TEXT NOT NULL,
	summary TEXT NOT NULL,
	created_at TEXT NOT NULL,
	read_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS app_passwords (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	token_hash TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL,
	last_used_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS images (
	id TEXT PRIMARY KEY,
	mime TEXT NOT NULL,
	data BLOB NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	at TEXT NOT NULL,
	user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
	actor_name TEXT NOT NULL,
	verb TEXT NOT NULL,
	subject TEXT NOT NULL,
	subject_id TEXT NOT NULL,
	summary TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
	author_name TEXT NOT NULL,
	body TEXT NOT NULL,
	created_at TEXT NOT NULL
);

`
