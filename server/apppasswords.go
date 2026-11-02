package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// An app password is a separate credential for one device's reminders app.
// A phone keeps the password it syncs with forever, so handing it the real
// account password means a lost phone is a lost password. With one per
// device, a lost phone is one line to revoke, and the account password never
// leaves the person's head.
//
// The token is random and long, so a plain SHA-256 is enough to store it:
// there is nothing to brute-force the way there is with a chosen password,
// and a fast hash can be looked up directly instead of compared one by one.

const maxAppPasswordsPerUser = 20

// No 0/o, 1/l/i: this gets typed on a phone keyboard.
const appPasswordAlphabet = "abcdefghjkmnpqrstuvwxyz23456789"

func newAppPasswordToken() string {
	var b strings.Builder
	max := big.NewInt(int64(len(appPasswordAlphabet)))
	for i := 0; i < 16; i++ {
		if i > 0 && i%4 == 0 {
			b.WriteByte('-')
		}
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			panic(err)
		}
		b.WriteByte(appPasswordAlphabet[n.Int64()])
	}
	return b.String()
}

// hashAppPassword ignores case, dashes and spaces, so "ABCD EFGH..." typed
// on a phone matches "abcd-efgh-...".
func hashAppPassword(token string) string {
	t := strings.ToLower(token)
	t = strings.NewReplacer("-", "", " ", "").Replace(t)
	sum := sha256.Sum256([]byte(t))
	return hex.EncodeToString(sum[:])
}

// looksLikeAppPassword avoids hashing and querying for every ordinary
// password: an app password is exactly 16 characters from the alphabet once
// the separators are gone.
func looksLikeAppPassword(pw string) bool {
	t := strings.NewReplacer("-", "", " ", "").Replace(strings.ToLower(pw))
	if len(t) != 16 {
		return false
	}
	for _, r := range t {
		if !strings.ContainsRune(appPasswordAlphabet, r) {
			return false
		}
	}
	return true
}

// checkAppPassword reports whether pw is one of userID's app passwords, and
// records that it was used.
func checkAppPassword(db *sql.DB, userID int64, pw string) bool {
	if !looksLikeAppPassword(pw) {
		return false
	}
	want := hashAppPassword(pw)
	var id int64
	var stored string
	if err := db.QueryRow(`SELECT id, token_hash FROM app_passwords WHERE user_id = ? AND token_hash = ?`, userID, want).
		Scan(&id, &stored); err != nil {
		return false
	}
	if subtle.ConstantTimeCompare([]byte(stored), []byte(want)) != 1 {
		return false
	}
	db.Exec(`UPDATE app_passwords SET last_used_at = ? WHERE id = ?`, time.Now().UTC().Format(time.RFC3339), id)
	return true
}

type AppPassword struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	CreatedAt  string `json:"createdAt"`
	LastUsedAt string `json:"lastUsedAt"`
	// Token is only ever filled in on the response that creates it.
	Token string `json:"token,omitempty"`
}

func handleListAppPasswords(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromContext(r)
		rows, err := db.Query(`SELECT id, name, created_at, last_used_at FROM app_passwords WHERE user_id = ? ORDER BY id DESC`, u.ID)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not load app passwords")
			return
		}
		defer rows.Close()
		out := []AppPassword{}
		for rows.Next() {
			var p AppPassword
			if err := rows.Scan(&p.ID, &p.Name, &p.CreatedAt, &p.LastUsedAt); err != nil {
				writeJSONError(w, http.StatusInternalServerError, "could not read app passwords")
				return
			}
			out = append(out, p)
		}
		writeJSON(w, http.StatusOK, out)
	}
}

type createAppPasswordReq struct {
	Name string `json:"name"`
}

func handleCreateAppPassword(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromContext(r)
		var req createAppPasswordReq
		if err := readJSON(r, &req); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		name := strings.TrimSpace(req.Name)
		if name == "" || len([]rune(name)) > 60 {
			writeJSONError(w, http.StatusBadRequest, "give the device a name of 1-60 characters")
			return
		}
		var count int
		db.QueryRow(`SELECT COUNT(*) FROM app_passwords WHERE user_id = ?`, u.ID).Scan(&count)
		if count >= maxAppPasswordsPerUser {
			writeJSONError(w, http.StatusConflict, "you already have 20 app passwords - revoke one you no longer use first")
			return
		}
		token := newAppPasswordToken()
		now := time.Now().UTC().Format(time.RFC3339)
		res, err := db.Exec(`INSERT INTO app_passwords (user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)`,
			u.ID, name, hashAppPassword(token), now)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not create the app password")
			return
		}
		id, _ := res.LastInsertId()
		logActivityID(db, r, "created an app password", "for", id, name)
		writeJSON(w, http.StatusCreated, AppPassword{ID: id, Name: name, CreatedAt: now, Token: token})
	}
}

func handleDeleteAppPassword(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromContext(r)
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid id")
			return
		}
		var name string
		if err := db.QueryRow(`SELECT name FROM app_passwords WHERE id = ? AND user_id = ?`, id, u.ID).Scan(&name); err != nil {
			writeJSONError(w, http.StatusNotFound, "no such app password")
			return
		}
		if _, err := db.Exec(`DELETE FROM app_passwords WHERE id = ? AND user_id = ?`, id, u.ID); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not revoke it")
			return
		}
		// A device that signed in within the last few minutes is remembered
		// by the credential cache; revoking has to cut it off now.
		caldavCreds.forgetUser(u.ID)
		logActivityID(db, r, "revoked an app password", "for", id, name)
		w.WriteHeader(http.StatusNoContent)
	}
}
