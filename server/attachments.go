package main

import (
	"database/sql"
	"errors"
	"fmt"
	"log"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Attachments are files kept with a task - a screenshot, a quote, the
// spreadsheet the task is about. The files themselves are on disk beside the
// database (files.go); each has a cap, and the backups dialog shows how much
// they take in total.
//
// Uploading or removing one changes the work, so it is scoped to the task's
// department like editing it. Reading follows reading the task: everyone.

const maxAttachmentBytes = 20 << 20 // 20 MiB per file
const maxAttachmentsPerTask = 30

// Shown in the browser only for these - anything else, including SVG, which
// can carry script, is always a download.
var inlineAttachmentMime = map[string]bool{
	"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true,
}

type Attachment struct {
	ID           int64  `json:"id"`
	TaskID       int64  `json:"taskId"`
	Name         string `json:"name"`
	Mime         string `json:"mime"`
	Size         int64  `json:"size"`
	IsImage      bool   `json:"isImage"`
	UploaderID   int64  `json:"uploaderId"`
	UploaderName string `json:"uploaderName"`
	CreatedAt    string `json:"createdAt"`
}

func handleListAttachments(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		taskID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid task id")
			return
		}
		rows, err := db.Query(`SELECT a.id, a.task_id, a.name, a.mime, a.size, COALESCE(a.uploaded_by, 0),
				COALESCE(NULLIF(u.display_name, ''), a.uploader_name), a.created_at
			FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
			WHERE a.task_id = ? ORDER BY a.id`, taskID)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not load attachments")
			return
		}
		defer rows.Close()
		out := []Attachment{}
		for rows.Next() {
			var a Attachment
			if err := rows.Scan(&a.ID, &a.TaskID, &a.Name, &a.Mime, &a.Size, &a.UploaderID, &a.UploaderName, &a.CreatedAt); err != nil {
				writeJSONError(w, http.StatusInternalServerError, "could not read attachments")
				return
			}
			a.IsImage = inlineAttachmentMime[a.Mime]
			out = append(out, a)
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// cleanFileName keeps a name safe to store and to hand back in a
// Content-Disposition header: no path, no control characters, not too long.
func cleanFileName(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 || r == '"' {
			return -1
		}
		return r
	}, strings.TrimSpace(name))
	if name == "" || name == "." || name == "/" {
		name = "file"
	}
	for len(name) > 200 {
		_, size := utf8.DecodeLastRuneInString(name)
		name = name[:len(name)-size]
	}
	return name
}

// handleUploadAttachment takes the file as the raw request body, its name in
// X-Filename (URL-encoded, so any script survives a header) and its type in
// Content-Type. Raw rather than JSON-wrapped base64 keeps a 20 MiB file a
// 20 MiB request.
func handleUploadAttachment(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromContext(r)
		taskID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid task id")
			return
		}
		dept, title, _, _, ok := liveTask(db, taskID)
		if !ok {
			writeJSONError(w, http.StatusNotFound, "task not found")
			return
		}
		if msg := deptWriteDenied(u, dept); msg != "" {
			writeJSONError(w, http.StatusForbidden, msg)
			return
		}
		var count int
		db.QueryRow(`SELECT COUNT(*) FROM attachments WHERE task_id = ?`, taskID).Scan(&count)
		if count >= maxAttachmentsPerTask {
			writeJSONError(w, http.StatusConflict, fmt.Sprintf("a task can hold at most %d attachments", maxAttachmentsPerTask))
			return
		}
		// A big file on a slow link can outlast the server's usual timeouts.
		rc := http.NewResponseController(w)
		rc.SetReadDeadline(time.Now().Add(10 * time.Minute))
		rc.SetWriteDeadline(time.Now().Add(10 * time.Minute))
		rel, size, head, err := storeAttachment(http.MaxBytesReader(w, r.Body, maxAttachmentBytes))
		if err != nil {
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				writeJSONError(w, http.StatusRequestEntityTooLarge, "a file can be at most 20 MB")
				return
			}
			log.Printf("attachments: store: %v", err)
			writeJSONError(w, http.StatusInternalServerError, "could not save the file")
			return
		}
		if size == 0 {
			removeAttachmentFile(rel)
			writeJSONError(w, http.StatusBadRequest, "that file is empty")
			return
		}
		name := r.Header.Get("X-Filename")
		if decoded, err := url.QueryUnescape(name); err == nil {
			name = decoded
		}
		name = cleanFileName(name)
		// The browser's word for the type is a hint. What is stored is what
		// the bytes turn out to be when that is one of the image types shown
		// inline; otherwise the stated type, only ever served as a download.
		mimeType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if sniffed := http.DetectContentType(head); inlineAttachmentMime[sniffed] {
			mimeType = sniffed
		} else if inlineAttachmentMime[mimeType] {
			mimeType = "application/octet-stream"
		}
		if mimeType == "" {
			mimeType = "application/octet-stream"
		}
		now := time.Now().UTC().Format(time.RFC3339)
		res, err := db.Exec(`INSERT INTO attachments (task_id, name, mime, size, data, path, uploaded_by, uploader_name, created_at)
			VALUES (?, ?, ?, ?, x'', ?, ?, ?, ?)`, taskID, name, mimeType, size, rel, u.ID, u.DisplayName, now)
		if err != nil {
			removeAttachmentFile(rel)
			writeJSONError(w, http.StatusInternalServerError, "could not save the file")
			return
		}
		id, _ := res.LastInsertId()
		touchTask(db, taskID)
		logActivityID(db, r, "attached "+name+" to", "task", taskID, title)
		publishFor(r, "attachments", "tasks")
		writeJSON(w, http.StatusCreated, Attachment{ID: id, TaskID: taskID, Name: name, Mime: mimeType, Size: size,
			IsImage: inlineAttachmentMime[mimeType], UploaderID: u.ID, UploaderName: u.DisplayName, CreatedAt: now})
	}
}

// handleGetAttachment serves a file. Images of the safe kinds show in the
// page; everything else downloads, and nothing is allowed to run script
// under this origin.
func handleGetAttachment(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		var name, mimeType, rel, created string
		// A trashed task's files stay reachable, so the trash can still show
		// what is in it; a purged one is gone with its task.
		if err := db.QueryRow(`SELECT name, mime, path, created_at FROM attachments WHERE id = ?`, id).
			Scan(&name, &mimeType, &rel, &created); err != nil || !validStoredPath(rel) {
			http.NotFound(w, r)
			return
		}
		f, err := os.Open(attachmentFile(rel))
		if err != nil {
			log.Printf("attachments: %d: %v", id, err)
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		http.NewResponseController(w).SetWriteDeadline(time.Now().Add(10 * time.Minute))
		disposition := "attachment"
		if inlineAttachmentMime[mimeType] && r.URL.Query().Get("download") == "" {
			disposition = "inline"
		} else {
			mimeType = "application/octet-stream"
		}
		w.Header().Set("Content-Type", mimeType)
		w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": name}))
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; img-src 'self'; sandbox")
		w.Header().Set("Cache-Control", "private, max-age=86400")
		modTime, _ := time.Parse(time.RFC3339, created)
		http.ServeContent(w, r, "", modTime, f)
	}
}

func handleDeleteAttachment(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromContext(r)
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid attachment id")
			return
		}
		var taskID int64
		var name string
		if err := db.QueryRow(`SELECT task_id, name FROM attachments WHERE id = ?`, id).Scan(&taskID, &name); err != nil {
			writeJSONError(w, http.StatusNotFound, "attachment not found")
			return
		}
		dept, title, _, _, ok := liveTask(db, taskID)
		if !ok {
			writeJSONError(w, http.StatusNotFound, "task not found")
			return
		}
		if msg := deptWriteDenied(u, dept); msg != "" {
			writeJSONError(w, http.StatusForbidden, msg)
			return
		}
		if _, err := db.Exec(`DELETE FROM attachments WHERE id = ?`, id); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not delete the file")
			return
		}
		sweepAttachmentFiles(db)
		touchTask(db, taskID)
		logActivityID(db, r, "removed "+name+" from", "task", taskID, title)
		publishFor(r, "attachments", "tasks")
		w.WriteHeader(http.StatusNoContent)
	}
}

// ---- task icons ----

// A task's icon is an emoji or a small uploaded picture, like a page icon in
// Notion. It is how a task is recognised at a glance in a long list.

func taskIconImageID(taskID int64) string { return "task:" + strconv.FormatInt(taskID, 10) }

type taskIconReq struct {
	Emoji string `json:"emoji"`
	Mime  string `json:"mime"`
	Data  string `json:"data"`
}

// validEmoji accepts a short run of non-ASCII symbols - an emoji with its
// modifiers or joiners - and nothing that could be ordinary text.
func validEmoji(s string) bool {
	if s == "" || len(s) > 40 || utf8.RuneCountInString(s) > 10 {
		return false
	}
	for _, r := range s {
		if r < 0x80 && r != '#' && r != '*' && (r < '0' || r > '9') {
			return false
		}
	}
	return true
}

func handleSetTaskIcon(db *sql.DB) http.HandlerFunc {
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
		r.Body = http.MaxBytesReader(w, r.Body, maxImageBodyBytes)
		var req taskIconReq
		if err := readJSON(r, &req); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		icon := ""
		switch {
		case req.Data != "":
			if status, msg := saveImage(db, taskIconImageID(taskID), imageUploadReq{Mime: req.Mime, Data: req.Data}); status != http.StatusOK {
				writeJSONError(w, status, msg)
				return
			}
			icon = "image"
		case validEmoji(strings.TrimSpace(req.Emoji)):
			icon = strings.TrimSpace(req.Emoji)
			db.Exec(`DELETE FROM images WHERE id = ?`, taskIconImageID(taskID))
		default:
			writeJSONError(w, http.StatusBadRequest, "pick an emoji or upload an image")
			return
		}
		db.Exec(`UPDATE tasks SET icon = ?, updated_at = ? WHERE id = ?`, icon, time.Now().UTC().Format(time.RFC3339), taskID)
		publishFor(r, "tasks")
		writeJSON(w, http.StatusOK, map[string]string{"icon": icon})
	}
}

func handleDeleteTaskIcon(db *sql.DB) http.HandlerFunc {
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
		db.Exec(`DELETE FROM images WHERE id = ?`, taskIconImageID(taskID))
		db.Exec(`UPDATE tasks SET icon = '', updated_at = ? WHERE id = ?`, time.Now().UTC().Format(time.RFC3339), taskID)
		publishFor(r, "tasks")
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleGetTaskIcon(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		taskID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		handleGetImage(db, taskIconImageID(taskID))(w, r)
	}
}

// cleanOrphanTaskImages drops the icon pictures of tasks that no longer
// exist. images has no foreign key to tasks, so purging a task leaves its
// picture behind otherwise.
func cleanOrphanTaskImages(db *sql.DB) {
	db.Exec(`DELETE FROM images WHERE id LIKE 'task:%'
		AND CAST(substr(id, 6) AS INTEGER) NOT IN (SELECT id FROM tasks)`)
}
