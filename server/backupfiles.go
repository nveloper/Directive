package main

import (
	"archive/zip"
	"database/sql"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Backups and attachment files. A backup's database names the files it
// needs; those are kept once each in an "attachments" folder inside the backup
// folder, shared by every backup that names them. Files never change after
// they are written, so a file copied once serves every later backup too, and
// a daily backup costs only what was added that day. When old backups are
// pruned, the files no remaining backup names are pruned with them.

func backupFilesDir() string { return filepath.Join(backupDir, "attachments") }

// backupAttachmentPaths lists the attachment files a backup's database names.
// A backup from before attachments moved out of the database names none: its
// files are inside it.
func backupAttachmentPaths(dbFile string) ([]string, error) {
	db, err := sql.Open("sqlite", dbFile)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if !columnExists(db, "attachments", "path") {
		if err := db.Ping(); err != nil {
			return nil, err
		}
		return nil, nil
	}
	return queryStoredPaths(db)
}

func queryStoredPaths(db *sql.DB) ([]string, error) {
	rows, err := db.Query(`SELECT path FROM attachments WHERE path <> ''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return cleanStoredPaths(out), rows.Err()
}

// copyIntoBackup makes sure each file is in the backup folder, as a hard link
// where the two folders share a disk and as a copy where they do not.
func copyIntoBackup(paths []string) {
	for _, rel := range paths {
		dst := filepath.Join(backupFilesDir(), filepath.FromSlash(rel))
		if _, err := os.Stat(dst); err == nil {
			continue
		}
		src := attachmentFile(rel)
		if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
			log.Printf("backup: %v", err)
			return
		}
		if os.Link(src, dst) == nil {
			continue
		}
		if err := copyFile(src, dst); err != nil {
			log.Printf("backup: attachment %s not copied: %v", rel, err)
		}
	}
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".copy-*")
	if err != nil {
		return err
	}
	if _, err := io.Copy(tmp, in); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), dst)
}

// pruneBackupFiles removes the backed-up files that no remaining backup
// names. If any backup cannot be read, nothing is removed: better a few
// extra files than a backup missing one.
func pruneBackupFiles() {
	keep := map[string]bool{}
	for _, b := range listBackups() {
		paths, err := backupAttachmentPaths(filepath.Join(backupDir, b.Name))
		if err != nil {
			log.Printf("backup: could not read %s, so no attachment files are pruned: %v", b.Name, err)
			return
		}
		for _, p := range paths {
			keep[p] = true
		}
	}
	root := backupFilesDir()
	filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if validStoredPath(rel) && !keep[rel] {
			os.Remove(path)
			os.Remove(filepath.Dir(path))
		}
		return nil
	})
}

// serveBackupZip hands over a backup with the attachment files it names, laid
// out the way a server expects them beside its database: the .db file and an
// attachments folder.
func serveBackupZip(w http.ResponseWriter, name, dbFile string, paths []string) {
	info, err := os.Stat(dbFile)
	if err != nil {
		http.Error(w, "backup not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+strings.TrimSuffix(name, ".db")+`.zip"`)
	zw := zip.NewWriter(w)
	add := func(entry, src string, method uint16, modified time.Time) error {
		f, err := os.Open(src)
		if err != nil {
			return err
		}
		defer f.Close()
		out, err := zw.CreateHeader(&zip.FileHeader{Name: entry, Method: method, Modified: modified})
		if err != nil {
			return err
		}
		_, err = io.Copy(out, f)
		return err
	}
	if err := add(name, dbFile, zip.Deflate, info.ModTime()); err != nil {
		log.Printf("backup download: %v", err)
		return
	}
	for _, rel := range paths {
		src := filepath.Join(backupFilesDir(), filepath.FromSlash(rel))
		if _, err := os.Stat(src); errors.Is(err, os.ErrNotExist) {
			// Not copied yet (or copying failed): the live file is the same.
			src = attachmentFile(rel)
		}
		// Most attachments are compressed already; storing them is faster.
		if err := add("attachments/"+rel, src, zip.Store, info.ModTime()); err != nil {
			log.Printf("backup download: attachment %s left out: %v", rel, err)
		}
	}
	if err := zw.Close(); err != nil {
		log.Printf("backup download: %v", err)
	}
}
