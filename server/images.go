package main

import (
	"database/sql"
	"encoding/base64"
	"net/http"
	"strconv"
	"time"
)

const maxImageBytes = 1 << 20     // 1MB decoded
const maxImageBodyBytes = 2 << 20 // 2MB request body (base64 is ~33% bigger than raw)

var allowedImageMime = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/webp": true,
	"image/gif":  true,
}

type imageUploadReq struct {
	Mime string `json:"mime"`
	Data string `json:"data"` // base64, no "data:...;base64," prefix
}

func saveImage(db *sql.DB, id string, req imageUploadReq) (int, string) {
	if !allowedImageMime[req.Mime] {
		return http.StatusBadRequest, "image must be PNG, JPEG, WebP, or GIF"
	}
	raw, err := base64.StdEncoding.DecodeString(req.Data)
	if err != nil {
		return http.StatusBadRequest, "invalid image data"
	}
	if len(raw) == 0 || len(raw) > maxImageBytes {
		return http.StatusBadRequest, "image must be under 1MB"
	}
	_, err = db.Exec(`INSERT INTO images (id, mime, data, updated_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`,
		id, req.Mime, raw, time.Now().UTC().Format(time.RFC3339))
	if err != nil {
		return http.StatusInternalServerError, "could not save image"
	}
	return http.StatusOK, ""
}

func handleGetImage(db *sql.DB, id string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var mime string
		var data []byte
		if err := db.QueryRow(`SELECT mime, data FROM images WHERE id = ?`, id).Scan(&mime, &data); err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", mime)
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(data)
	}
}

// ---- app icon (also used as the favicon) ----

func handleGetAppIcon(db *sql.DB) http.HandlerFunc {
	return handleGetImage(db, "app_icon")
}

func handleSetAppIcon(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, maxImageBodyBytes)
		var req imageUploadReq
		if err := readJSON(r, &req); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if status, msg := saveImage(db, "app_icon", req); status != http.StatusOK {
			writeJSONError(w, status, msg)
			return
		}
		logActivity(db, r, "changed", "app icon", "app_icon", "")
		publishFor(r, "settings")
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleDeleteAppIcon(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		db.Exec(`DELETE FROM images WHERE id = 'app_icon'`)
		logActivity(db, r, "removed", "app icon", "app_icon", "")
		publishFor(r, "settings")
		w.WriteHeader(http.StatusNoContent)
	}
}

// ---- user avatars ----

func avatarImageID(userID int64) string {
	return "user:" + strconv.FormatInt(userID, 10)
}

func handleGetUserAvatar(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		handleGetImage(db, avatarImageID(id))(w, r)
	}
}

func handleSetMyAvatar(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromContext(r)
		r.Body = http.MaxBytesReader(w, r.Body, maxImageBodyBytes)
		var req imageUploadReq
		if err := readJSON(r, &req); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if status, msg := saveImage(db, avatarImageID(u.ID), req); status != http.StatusOK {
			writeJSONError(w, status, msg)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleDeleteMyAvatar(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromContext(r)
		db.Exec(`DELETE FROM images WHERE id = ?`, avatarImageID(u.ID))
		w.WriteHeader(http.StatusNoContent)
	}
}
