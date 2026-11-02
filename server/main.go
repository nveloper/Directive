package main

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"flag"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/emersion/go-webdav/caldav"
)

//go:embed static
var staticFS embed.FS

func main() {
	addr := flag.String("addr", "0.0.0.0:8080", "address to listen on - this is an internal-network service, so the default binds every interface, not just localhost")
	dbPath := flag.String("db", defaultDBPath, "path to the SQLite database file (created if missing)")
	backupPath := flag.String("backup", "", "write a consistent copy of the database to this path and exit")
	backupDirFlag := flag.String("backup-dir", "", "folder for automatic backups (default: a 'backups' folder beside the database)")
	attachmentsDirFlag := flag.String("attachments-dir", "", "folder for task attachment files (default: an 'attachments' folder beside the database)")
	proxyFlag := flag.String("trusted-proxy", "127.0.0.1,::1", "comma-separated addresses or CIDR ranges of reverse proxies whose X-Forwarded-For and X-Forwarded-Proto are believed")
	tlsCert := flag.String("tls-cert", "", "serve HTTPS directly with this certificate file (PEM); needs -tls-key")
	tlsKey := flag.String("tls-key", "", "private key file (PEM) for -tls-cert")
	resetAdmin := flag.String("reset-admin", "", "give this account a new temporary password, print it and exit (for a forgotten administrator password; stop the server first)")
	flag.Parse()

	proxies, err := parseProxies(*proxyFlag)
	if err != nil {
		log.Fatalf("-trusted-proxy: %v", err)
	}
	trustedProxies = proxies
	if (*tlsCert == "") != (*tlsKey == "") {
		log.Fatal("-tls-cert and -tls-key go together")
	}

	if *backupPath != "" {
		runBackup(resolveDBPath(*dbPath), *backupPath)
		return
	}
	if *resetAdmin != "" {
		runResetAdmin(resolveDBPath(*dbPath), *resetAdmin)
		return
	}

	db := openDB(resolveDBPath(*dbPath))
	defer db.Close()
	backupDir = *backupDirFlag
	if backupDir == "" {
		backupDir = filepath.Join(filepath.Dir(resolveDBPath(*dbPath)), "backups")
	}
	attachmentsDir = *attachmentsDirFlag
	if attachmentsDir == "" {
		attachmentsDir = filepath.Join(filepath.Dir(resolveDBPath(*dbPath)), "attachments")
	}
	migrateAttachmentsToFiles(db)
	sweepAttachmentFiles(db)
	purgeExpiredSessions(db)
	purgeTrash(db)
	startBackupScheduler(db)
	startReminderScheduler(db)
	trimActivity(db)
	go func() {
		for range time.Tick(time.Hour) {
			trimActivity(db)
		}
	}()

	mux := newMux(db)

	srv := &http.Server{
		Addr:    *addr,
		Handler: mux,
		// Without these a single stalled client can hold a connection open
		// forever; the defaults are no timeout at all.
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		var err error
		if *tlsCert != "" {
			log.Printf("Directive listening on %s over HTTPS (database: %s)", *addr, resolveDBPath(*dbPath))
			err = srv.ListenAndServeTLS(*tlsCert, *tlsKey)
		} else {
			log.Printf("Directive listening on %s (database: %s)", *addr, resolveDBPath(*dbPath))
			err = srv.ListenAndServe()
		}
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()

	<-ctx.Done()
	log.Println("shutting down - finishing in-flight requests")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}

const defaultDBPath = "directive.db"
const legacyDBPath = "taskcontrolcenter.db"

// resolveDBPath keeps an existing database from an older build working. The
// default file was renamed along with the binary; if the caller did not ask for
// a specific path and only the old file is there, keep using it rather than
// silently starting empty next to someone's real data.
func resolveDBPath(path string) string {
	if path != defaultDBPath {
		return path
	}
	if _, err := os.Stat(defaultDBPath); err == nil {
		return defaultDBPath
	}
	if _, err := os.Stat(legacyDBPath); err == nil {
		log.Printf("using existing %s - rename it to %s when convenient", legacyDBPath, defaultDBPath)
		return legacyDBPath
	}
	return defaultDBPath
}

// runBackup writes a consistent snapshot of the database and exits. VACUUM
// INTO takes its own read transaction, so this is safe to run against a
// database the server is still serving - unlike copying the file, which can
// catch it mid-write and misses the WAL.
func runBackup(src, dst string) {
	if _, err := os.Stat(dst); err == nil {
		log.Fatalf("backup: %s already exists - pick a new path rather than overwriting a backup", dst)
	}
	db, err := sql.Open("sqlite", src)
	if err != nil {
		log.Fatalf("backup: open %s: %v", src, err)
	}
	defer db.Close()
	if _, err := db.Exec(`VACUUM INTO ?`, dst); err != nil {
		log.Fatalf("backup: %v", err)
	}
	info, err := os.Stat(dst)
	if err != nil {
		log.Fatalf("backup: %v", err)
	}
	log.Printf("backup written: %s (%.1f MiB) from %s", dst, float64(info.Size())/(1024*1024), src)
	log.Printf("attachment files are not inside it: copy the attachments folder beside %s too (its files never change, so copying it while the server runs is safe)", src)
}

// newMux registers every route. It is its own function so the tests can run
// the real routing against a scratch database without starting a server.
func newMux(db *sql.DB) *http.ServeMux {
	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		panic(err)
	}

	// Sign-in endpoints run bcrypt on every call, so an unthrottled one is both
	// a password oracle and a way to pin the CPU.
	authLimiter := newLimiter(10, time.Minute)

	mux := http.NewServeMux()

	// frontend (embedded in the binary - nothing to deploy alongside it)
	// Registered for every method rather than GET alone: Go's mux refuses to
	// order a method-specific catch-all against the all-method /caldav/ subtree
	// below. The file server answers anything that is not GET or HEAD with 405
	// by itself.
	mux.Handle("/", staticHandler(http.FileServer(http.FS(sub))))

	// auth
	mux.HandleFunc("POST /api/register", rateLimited(authLimiter, handleRegister(db)))
	mux.HandleFunc("POST /api/login", rateLimited(authLimiter, handleLogin(db)))
	mux.HandleFunc("POST /api/logout", handleLogout(db))
	mux.HandleFunc("GET /api/me", requireAuth(db, handleMe))

	// live updates: one stream per open tab, carrying "this collection
	// changed" so clients refetch instead of drifting
	mux.HandleFunc("GET /api/events", requireAuth(db, handleEvents))
	mux.HandleFunc("PUT /api/me", requireAuth(db, handleUpdateMe(db)))
	// passwords - your own needs the current one (and is throttled like
	// sign-in, since it runs bcrypt); a reset issues a temporary one
	mux.HandleFunc("PUT /api/me/password", rateLimited(authLimiter, requireAuth(db, handleChangePassword(db))))
	mux.HandleFunc("POST /api/users/{id}/reset-password", requireAdmin(db, handleResetPassword(db)))

	// notifications - the personal side of activity: assigned to you,
	// mentioned, a comment on your work
	mux.HandleFunc("GET /api/notifications", requireAuth(db, handleListNotifications(db)))
	mux.HandleFunc("POST /api/notifications/read", requireAuth(db, handleMarkNotificationsRead(db)))

	// app passwords - one per device, for a phone's reminders app, so the
	// account password never has to be stored on it
	mux.HandleFunc("GET /api/me/app-passwords", requireAuth(db, handleListAppPasswords(db)))
	mux.HandleFunc("POST /api/me/app-passwords", requireAuth(db, handleCreateAppPassword(db)))
	mux.HandleFunc("DELETE /api/me/app-passwords/{id}", requireAuth(db, handleDeleteAppPassword(db)))

	// accounts (administrator only: approving, disabling, assigning departments)
	mux.HandleFunc("GET /api/members", requireAuth(db, handleListMembers(db)))
	mux.HandleFunc("GET /api/activity", requireAuth(db, handleListActivity(db)))
	mux.HandleFunc("GET /api/users", requireAdmin(db, handleListUsers(db)))
	mux.HandleFunc("PUT /api/users/{id}", requireAdmin(db, handleUpdateUser(db)))

	// settings - the app name and icon are readable without a session because
	// the sign-in screen and the favicon need them before anyone is logged in.
	mux.HandleFunc("GET /api/settings", handleGetSettings(db))
	mux.HandleFunc("PUT /api/settings", requireAdmin(db, handleUpdateSettings(db)))
	mux.HandleFunc("GET /api/settings/icon", handleGetAppIcon(db))
	mux.HandleFunc("PUT /api/settings/icon", requireAdmin(db, handleSetAppIcon(db)))
	mux.HandleFunc("DELETE /api/settings/icon", requireAdmin(db, handleDeleteAppIcon(db)))

	// automatic backups (administrator only)
	mux.HandleFunc("GET /api/backups", requireAdmin(db, handleGetBackups(db)))
	mux.HandleFunc("PUT /api/backups", requireAdmin(db, handleUpdateBackups(db)))
	mux.HandleFunc("POST /api/backups/run", requireAdmin(db, handleRunBackup(db)))
	mux.HandleFunc("GET /api/backups/{name}", requireAdmin(db, handleDownloadBackup(db)))

	// Due-date reminders: when the daily notifications go out.
	mux.HandleFunc("GET /api/reminders", requireAdmin(db, handleGetReminders(db)))
	mux.HandleFunc("PUT /api/reminders", requireAdmin(db, handleUpdateReminders(db)))

	// avatars
	mux.HandleFunc("GET /api/users/{id}/avatar", requireAuth(db, handleGetUserAvatar(db)))
	mux.HandleFunc("PUT /api/me/avatar", requireAuth(db, handleSetMyAvatar(db)))
	mux.HandleFunc("DELETE /api/me/avatar", requireAuth(db, handleDeleteMyAvatar(db)))

	// departments - everyone sees the tree; only an administrator changes it
	mux.HandleFunc("GET /api/departments", requireAuth(db, handleListDepartments(db)))
	mux.HandleFunc("POST /api/departments", requireAdmin(db, handleCreateDepartment(db)))
	mux.HandleFunc("PUT /api/departments/{id...}", requireAdmin(db, handleUpdateDepartment(db)))
	mux.HandleFunc("DELETE /api/departments/{id...}", requireAdmin(db, handleDeleteDepartment(db)))

	// tasks - readable by every approved member, writable within your department
	mux.HandleFunc("GET /api/tasks", requireAuth(db, handleListTasks(db)))
	mux.HandleFunc("GET /api/tasks/summary", requireAuth(db, handleTaskSummary(db)))
	mux.HandleFunc("GET /api/tasks/today", requireAuth(db, handleTasksToday(db)))
	mux.HandleFunc("GET /api/tasks/{id}", requireAuth(db, handleGetTask(db)))
	mux.HandleFunc("PUT /api/tasks/{id}/status", requireAuth(db, handleSetTaskStatus(db)))
	mux.HandleFunc("POST /api/tasks", requireAuth(db, handleCreateTask(db)))
	mux.HandleFunc("PUT /api/tasks/{id}", requireAuth(db, handleUpdateTask(db)))
	// deleting moves a task to the trash; it is purged after ten days
	mux.HandleFunc("DELETE /api/tasks/{id}", requireAuth(db, handleDeleteTask(db)))

	// trash
	mux.HandleFunc("GET /api/trash", requireAuth(db, handleListTrash(db)))
	mux.HandleFunc("POST /api/trash/{id}/restore", requireAuth(db, handleRestoreTask(db)))
	mux.HandleFunc("DELETE /api/trash/{id}", requireAuth(db, handlePurgeTask(db)))
	mux.HandleFunc("DELETE /api/trash", requireAuth(db, handleEmptyTrash(db)))

	// checklists - scoped like editing the task they belong to
	mux.HandleFunc("GET /api/tasks/{id}/checklist", requireAuth(db, handleListChecklist(db)))
	mux.HandleFunc("POST /api/tasks/{id}/checklist", requireAuth(db, handleAddChecklistItem(db)))
	mux.HandleFunc("PUT /api/tasks/{id}/checklist/order", requireAuth(db, handleReorderChecklist(db)))
	mux.HandleFunc("PUT /api/checklist/{id}", requireAuth(db, handleUpdateChecklistItem(db)))
	mux.HandleFunc("DELETE /api/checklist/{id}", requireAuth(db, handleDeleteChecklistItem(db)))

	// attachments and the task icon - reading follows the task, changing is
	// scoped like editing it
	mux.HandleFunc("GET /api/tasks/{id}/attachments", requireAuth(db, handleListAttachments(db)))
	mux.HandleFunc("POST /api/tasks/{id}/attachments", requireAuth(db, handleUploadAttachment(db)))
	mux.HandleFunc("GET /api/attachments/{id}", requireAuth(db, handleGetAttachment(db)))
	mux.HandleFunc("DELETE /api/attachments/{id}", requireAuth(db, handleDeleteAttachment(db)))
	mux.HandleFunc("GET /api/tasks/{id}/icon", requireAuth(db, handleGetTaskIcon(db)))
	mux.HandleFunc("PUT /api/tasks/{id}/icon", requireAuth(db, handleSetTaskIcon(db)))
	mux.HandleFunc("DELETE /api/tasks/{id}/icon", requireAuth(db, handleDeleteTaskIcon(db)))

	// comments - readable and writable by any approved member, because a
	// comment is discussion rather than a change to the work itself
	mux.HandleFunc("GET /api/tasks/{id}/comments", requireAuth(db, handleListComments(db)))
	mux.HandleFunc("POST /api/tasks/{id}/comments", requireAuth(db, handleCreateComment(db)))
	mux.HandleFunc("DELETE /api/comments/{id}", requireAuth(db, handleDeleteComment(db)))

	// public, token-secured calendar subscription feed (no cookie auth: calendar apps cannot log in)
	mux.HandleFunc("GET /calendar/{file}", handleCalendarFeed(db))

	// CalDAV, so a phone's reminders app can hold these tasks and write back.
	// Clients authenticate with HTTP Basic against the same accounts as the
	// web app; the cookie session is a browser thing they cannot use. Every
	// method belongs to the handler, not just GET, so this is a subtree match.
	caldavHandler := &caldav.Handler{
		Backend: &caldavBackend{db: db},
		Prefix:  caldavPrefix,
	}
	mux.Handle(caldavPrefix+"/", requireBasicAuth(db, caldavCreds, caldavHandler))
	// Apple and Thunderbird probe this before anything else.
	mux.HandleFunc("/.well-known/caldav", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, caldavPrefix+"/", http.StatusMovedPermanently)
	})
	return mux
}

// staticHandler serves the embedded frontend. Font files carry their version
// in their name, so they never change under the same URL and can be cached
// for good - the Korean-capable font is about 2 MB, which should not be
// fetched again on every page load. Go's MIME table has no entry for woff2,
// so the type is set here rather than left to sniffing.
func staticHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/fonts/") && strings.HasSuffix(r.URL.Path, ".woff2") {
			w.Header().Set("Content-Type", "font/woff2")
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		next.ServeHTTP(w, r)
	})
}
