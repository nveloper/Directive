package main

import (
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Automatic backups. -backup still writes one copy by hand and exits; this is
// the server doing it by itself once a day, at a time an administrator picks,
// and keeping the last few. Where the files go is a start-up flag rather than
// a setting: letting the web app choose a path would let it write a file
// anywhere the server process can.
//
// The time is the server's local time, and a day whose time passed while the
// server was down is caught up as soon as it starts.

// backupDir is set once at start from -backup-dir.
var backupDir string

const (
	defaultBackupTime = "03:00"
	defaultBackupKeep = 14
	maxBackupKeep     = 365
)

var backupTimeRe = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)

// Only files this server named are listed, offered for download, or pruned -
// anything else someone keeps in the folder is left alone.
var backupNameRe = regexp.MustCompile(`^directive-\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?\.db$`)

// backupMu keeps a scheduled run and a "back up now" from racing for a name.
var backupMu sync.Mutex

type backupSettings struct {
	Enabled bool   `json:"enabled"`
	Time    string `json:"time"`
	Keep    int    `json:"keep"`
}

func getSetting(db *sql.DB, key string) string {
	var v string
	db.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&v)
	return v
}

func putSetting(db *sql.DB, key, value string) {
	db.Exec(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
}

func loadBackupSettings(db *sql.DB) backupSettings {
	s := backupSettings{Enabled: getSetting(db, "backup_enabled") == "1", Time: getSetting(db, "backup_time"), Keep: defaultBackupKeep}
	if !backupTimeRe.MatchString(s.Time) {
		s.Time = defaultBackupTime
	}
	if n, err := strconv.Atoi(getSetting(db, "backup_keep")); err == nil && n > 0 {
		s.Keep = n
	}
	return s
}

type backupFile struct {
	Name       string `json:"name"`
	Size       int64  `json:"size"`
	ModifiedAt string `json:"modifiedAt"`
}

func listBackups() []backupFile {
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		return []backupFile{}
	}
	out := []backupFile{}
	for _, e := range entries {
		if e.IsDir() || !backupNameRe.MatchString(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, backupFile{Name: e.Name(), Size: info.Size(), ModifiedAt: info.ModTime().UTC().Format(time.RFC3339)})
	}
	sort.Slice(out, func(i, j int) bool { return backupNewer(out[i].Name, out[j].Name) })
	return out
}

// backupNewer orders by the minute in the name, then by the -2, -3 suffix
// that separates several backups in the same minute. Comparing whole names
// would put "-1050.db" after "-1050-3.db", because '.' sorts above '-'.
func backupNewer(a, b string) bool {
	ta, na := backupSortKey(a)
	tb, nb := backupSortKey(b)
	if ta != tb {
		return ta > tb
	}
	return na > nb
}

func backupSortKey(name string) (string, int) {
	stem := strings.TrimSuffix(strings.TrimPrefix(name, "directive-"), ".db")
	stamp, suffix := stem, 1
	if len(stem) > len("2006-01-02-1504") {
		stamp = stem[:len("2006-01-02-1504")]
		if n, err := strconv.Atoi(strings.TrimPrefix(stem[len(stamp):], "-")); err == nil {
			suffix = n
		}
	}
	return stamp, suffix
}

// writeBackup takes a consistent copy of the live database. VACUUM INTO runs
// in its own read transaction, so the server keeps serving meanwhile.
func writeBackup(db *sql.DB) (backupFile, error) {
	backupMu.Lock()
	defer backupMu.Unlock()
	if err := os.MkdirAll(backupDir, 0o700); err != nil {
		return backupFile{}, fmt.Errorf("could not create %s: %w", backupDir, err)
	}
	base := "directive-" + time.Now().Format("2006-01-02-1504")
	name := base + ".db"
	for i := 2; ; i++ {
		if _, err := os.Stat(filepath.Join(backupDir, name)); errors.Is(err, os.ErrNotExist) {
			break
		}
		name = base + "-" + strconv.Itoa(i) + ".db"
	}
	path := filepath.Join(backupDir, name)
	// Attachment files are copied before the database and again after from
	// what the copy names: the first pass catches a file deleted meanwhile,
	// the second one uploaded meanwhile.
	if live, err := queryStoredPaths(db); err == nil {
		copyIntoBackup(live)
	}
	if _, err := db.Exec(`VACUUM INTO ?`, path); err != nil {
		return backupFile{}, err
	}
	if named, err := backupAttachmentPaths(path); err == nil {
		copyIntoBackup(named)
	} else {
		log.Printf("backup: could not read the new backup's attachment list: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		return backupFile{}, err
	}
	return backupFile{Name: name, Size: info.Size(), ModifiedAt: info.ModTime().UTC().Format(time.RFC3339)}, nil
}

// pruneBackups keeps the newest `keep` backups and deletes the rest.
func pruneBackups(keep int) {
	files := listBackups()
	for i := keep; i < len(files); i++ {
		if err := os.Remove(filepath.Join(backupDir, files[i].Name)); err != nil {
			log.Printf("backup: could not remove old %s: %v", files[i].Name, err)
		}
	}
	pruneBackupFiles()
}

// runBackupNow writes one, prunes, and records the outcome for the settings
// screen. why says what started it, for the log.
func runBackupNow(db *sql.DB, why string) (backupFile, error) {
	f, err := writeBackup(db)
	now := time.Now().UTC().Format(time.RFC3339)
	if err != nil {
		putSetting(db, "backup_last_error", err.Error())
		putSetting(db, "backup_last_error_at", now)
		log.Printf("backup (%s) failed: %v", why, err)
		return f, err
	}
	putSetting(db, "backup_last_at", now)
	putSetting(db, "backup_last_file", f.Name)
	putSetting(db, "backup_last_error", "")
	pruneBackups(loadBackupSettings(db).Keep)
	log.Printf("backup (%s) written: %s (%.1f MiB)", why, filepath.Join(backupDir, f.Name), float64(f.Size)/(1024*1024))
	return f, nil
}

// nextBackupAt is when the schedule will next fire, for display.
func nextBackupAt(s backupSettings, lastDay string, now time.Time) time.Time {
	hh, _ := strconv.Atoi(s.Time[:2])
	mm, _ := strconv.Atoi(s.Time[3:])
	at := time.Date(now.Year(), now.Month(), now.Day(), hh, mm, 0, 0, now.Location())
	if lastDay == now.Format("2006-01-02") {
		return at.AddDate(0, 0, 1)
	}
	if now.After(at) {
		// Due today and not yet done: it runs within the minute.
		return now
	}
	return at
}

// startBackupScheduler checks once a minute whether today's backup is due.
func startBackupScheduler(db *sql.DB) {
	check := func() {
		s := loadBackupSettings(db)
		if !s.Enabled {
			return
		}
		now := time.Now()
		day := now.Format("2006-01-02")
		if getSetting(db, "backup_last_day") == day || now.Format("15:04") < s.Time {
			return
		}
		// Marked before running, so a backup that fails is not retried every
		// minute for the rest of the day; the failure shows in the settings.
		putSetting(db, "backup_last_day", day)
		runBackupNow(db, "scheduled")
		events.publish("backups", "")
	}
	go func() {
		check()
		for range time.Tick(time.Minute) {
			check()
		}
	}()
}

// ---- administrator endpoints ----

func backupStatus(db *sql.DB) map[string]interface{} {
	s := loadBackupSettings(db)
	now := time.Now()
	abs, err := filepath.Abs(backupDir)
	if err != nil {
		abs = backupDir
	}
	zone, _ := now.Zone()
	status := map[string]interface{}{
		"enabled":     s.Enabled,
		"time":        s.Time,
		"keep":        s.Keep,
		"dir":         abs,
		"serverTime":  now.Format("15:04"),
		"serverZone":  zone,
		"lastAt":      getSetting(db, "backup_last_at"),
		"lastFile":    getSetting(db, "backup_last_file"),
		"lastError":   getSetting(db, "backup_last_error"),
		"lastErrorAt": getSetting(db, "backup_last_error_at"),
		"files":       listBackups(),
	}
	// Attachments are what makes the database - and so every backup - grow.
	var attBytes, attCount int64
	db.QueryRow(`SELECT COALESCE(SUM(size), 0), COUNT(*) FROM attachments`).Scan(&attBytes, &attCount)
	status["attachmentsBytes"] = attBytes
	if dir, err := filepath.Abs(attachmentsDir); err == nil {
		status["attachmentsDir"] = dir
	}
	status["attachmentsCount"] = attCount
	if s.Enabled {
		status["nextAt"] = nextBackupAt(s, getSetting(db, "backup_last_day"), now).UTC().Format(time.RFC3339)
	}
	return status
}

func handleGetBackups(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, backupStatus(db))
	}
}

func handleUpdateBackups(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req backupSettings
		if err := readJSON(r, &req); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		req.Time = strings.TrimSpace(req.Time)
		if !backupTimeRe.MatchString(req.Time) {
			writeJSONError(w, http.StatusBadRequest, "backup time must be HH:MM in 24-hour form")
			return
		}
		if req.Keep < 1 || req.Keep > maxBackupKeep {
			writeJSONError(w, http.StatusBadRequest, "keep between 1 and 365 backups")
			return
		}
		old := loadBackupSettings(db)
		enabled := ""
		if req.Enabled {
			enabled = "1"
		}
		putSetting(db, "backup_enabled", enabled)
		putSetting(db, "backup_time", req.Time)
		putSetting(db, "backup_keep", strconv.Itoa(req.Keep))
		// Moving the time later today should let today's run happen at the new
		// time, even if the old one already fired.
		if req.Time != old.Time && time.Now().Format("15:04") < req.Time {
			putSetting(db, "backup_last_day", "")
		}
		if req.Keep < old.Keep {
			pruneBackups(req.Keep)
		}
		summary := "off"
		if req.Enabled {
			summary = "daily at " + req.Time + ", keeping " + strconv.Itoa(req.Keep)
		}
		logActivity(db, r, "set", "automatic backups", "backup", summary)
		publishFor(r, "backups")
		writeJSON(w, http.StatusOK, backupStatus(db))
	}
}

func handleRunBackup(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		f, err := runBackupNow(db, "requested by "+userFromContext(r).Username)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "backup failed: "+err.Error())
			return
		}
		logActivity(db, r, "backed up", "the database", "backup", f.Name)
		publishFor(r, "backups")
		writeJSON(w, http.StatusOK, backupStatus(db))
	}
}

// handleDownloadBackup hands an administrator a backup file, so a copy can
// live somewhere other than the machine it protects.
func handleDownloadBackup(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		if !backupNameRe.MatchString(name) {
			http.NotFound(w, r)
			return
		}
		path := filepath.Join(backupDir, name)
		f, err := os.Open(path)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			http.NotFound(w, r)
			return
		}
		// A large file on a slow link can outlast the server's write timeout.
		http.NewResponseController(w).SetWriteDeadline(time.Now().Add(30 * time.Minute))
		// With attachment files it is a zip of the database and the files.
		if paths, err := backupAttachmentPaths(path); err == nil && len(paths) > 0 {
			serveBackupZip(w, name, path, paths)
			return
		}
		w.Header().Set("Content-Type", "application/vnd.sqlite3")
		w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
		http.ServeContent(w, r, name, info.ModTime(), f)
	}
}
