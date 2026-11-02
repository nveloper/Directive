package main

import (
	"bytes"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// Attachment files live on disk, in a folder beside the database, not in it.
// The server has one database connection, so a 20 MB file read or written
// through it made every other request wait; a file on disk is streamed with
// no lock held. The database keeps the name, type, size and where the file
// is. Files are never changed once written, which keeps backing them up
// simple (see backup.go).
//
// A row can go without the code that deletes it knowing - a purged task takes
// its attachments with it by cascade - so a trigger notes every stored path
// whose row is deleted, and sweepAttachmentFiles removes those files. Nothing
// else is ever deleted from the folder: pointing the server at the wrong
// database cannot empty it.

// attachmentsDir is set once at start from -attachments-dir.
var attachmentsDir string

// A stored path is two hex characters, a slash, and 32 hex characters.
func validStoredPath(rel string) bool {
	if len(rel) != 35 || rel[2] != '/' || rel[3:5] != rel[:2] {
		return false
	}
	_, err := hex.DecodeString(rel[:2] + rel[3:])
	return err == nil
}

func attachmentFile(rel string) string {
	return filepath.Join(attachmentsDir, filepath.FromSlash(rel))
}

// headWriter keeps the first bytes that pass through, for sniffing the type.
type headWriter struct{ buf []byte }

func (h *headWriter) Write(p []byte) (int, error) {
	if room := 512 - len(h.buf); room > 0 {
		if room > len(p) {
			room = len(p)
		}
		h.buf = append(h.buf, p[:room]...)
	}
	return len(p), nil
}

// storeAttachment streams body into a new file and returns its stored path,
// its size and its first bytes. The file is written under a temporary name
// and renamed, so a failed upload never leaves a half file under a real one.
func storeAttachment(body io.Reader) (rel string, size int64, head []byte, err error) {
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return "", 0, nil, err
	}
	name := hex.EncodeToString(id)
	rel = name[:2] + "/" + name
	final := attachmentFile(rel)
	if err := os.MkdirAll(filepath.Dir(final), 0o700); err != nil {
		return "", 0, nil, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(final), ".upload-*")
	if err != nil {
		return "", 0, nil, err
	}
	defer func() {
		if err != nil {
			tmp.Close()
			os.Remove(tmp.Name())
		}
	}()
	hw := &headWriter{}
	size, err = io.Copy(io.MultiWriter(tmp, hw), body)
	if err != nil {
		return "", 0, nil, err
	}
	if err = tmp.Sync(); err != nil {
		return "", 0, nil, err
	}
	if err = tmp.Close(); err != nil {
		return "", 0, nil, err
	}
	if err = os.Rename(tmp.Name(), final); err != nil {
		return "", 0, nil, err
	}
	return rel, size, hw.buf, nil
}

// removeAttachmentFile deletes one stored file, and its two-letter folder if
// that is left empty.
func removeAttachmentFile(rel string) error {
	if !validStoredPath(rel) {
		return fmt.Errorf("not a stored attachment path: %q", rel)
	}
	if err := os.Remove(attachmentFile(rel)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	os.Remove(filepath.Dir(attachmentFile(rel)))
	return nil
}

// sweepAttachmentFiles removes the files whose rows the trigger saw deleted.
func sweepAttachmentFiles(db *sql.DB) {
	rows, err := db.Query(`SELECT path FROM attachment_files_gone`)
	if err != nil {
		return
	}
	var gone []string
	for rows.Next() {
		var p string
		if rows.Scan(&p) == nil {
			gone = append(gone, p)
		}
	}
	rows.Close()
	for _, p := range gone {
		var still int
		db.QueryRow(`SELECT COUNT(*) FROM attachments WHERE path = ?`, p).Scan(&still)
		if still == 0 {
			if err := removeAttachmentFile(p); err != nil {
				log.Printf("attachments: could not remove %s: %v", p, err)
				continue
			}
		}
		db.Exec(`DELETE FROM attachment_files_gone WHERE path = ?`, p)
	}
}

// migrateAttachmentsToFiles moves files an older version kept inside the
// database out to the folder, one at a time, then gives the space back.
func migrateAttachmentsToFiles(db *sql.DB) {
	rows, err := db.Query(`SELECT id FROM attachments WHERE path = ''`)
	if err != nil {
		log.Fatalf("attachments: %v", err)
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	if len(ids) == 0 {
		return
	}
	log.Printf("migration: moving %d attachment(s) out of the database into %s", len(ids), attachmentsDir)
	for _, id := range ids {
		var data []byte
		if err := db.QueryRow(`SELECT data FROM attachments WHERE id = ?`, id).Scan(&data); err != nil {
			log.Fatalf("attachments: read %d: %v", id, err)
		}
		rel, _, _, err := storeAttachment(bytes.NewReader(data))
		if err != nil {
			log.Fatalf("attachments: write %d: %v", id, err)
		}
		if _, err := db.Exec(`UPDATE attachments SET path = ?, data = x'' WHERE id = ?`, rel, id); err != nil {
			removeAttachmentFile(rel)
			log.Fatalf("attachments: record %d: %v", id, err)
		}
	}
	// The pages the files took are free now but still part of the file.
	if _, err := db.Exec(`VACUUM`); err != nil {
		log.Printf("migration: attachments moved; VACUUM to shrink the database failed: %v", err)
		return
	}
	log.Printf("migration: attachments moved and the database shrunk")
}

// cleanStoredPaths keeps only well-formed paths. It guards paths read from a backup's database, which
// are only ever used to find files under the backup folder.
func cleanStoredPaths(paths []string) []string {
	out := paths[:0]
	for _, p := range paths {
		if validStoredPath(strings.TrimSpace(p)) {
			out = append(out, strings.TrimSpace(p))
		}
	}
	return out
}
