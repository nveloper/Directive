package main

import (
	"crypto/rand"
	"database/sql"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"os"
	"strconv"
	"strings"
)

// Changing and resetting passwords. Until now a password, once chosen, could
// not be changed by anyone, and a forgotten one meant a new account.
//
// Changing your own needs the current one. Changing it signs out every other
// session and forgets any cached phone sign-in with the old password, so a
// password someone else learned stops working everywhere at once. App
// passwords are separate credentials and keep working; revoke them under
// Phone sync.
//
// An administrator cannot see or choose anyone's password. Resetting one
// issues a random temporary password, shown to the administrator once, and
// flags the account: the temporary password signs in, and the app asks for a
// new password before anything else. It does not work for phone sync.

const minPasswordLen = 8

// newTemporaryPassword is twelve characters in groups of four, from the
// same unambiguous alphabet as app passwords, so it can be read out loud.
func newTemporaryPassword() string {
	var b strings.Builder
	max := big.NewInt(int64(len(appPasswordAlphabet)))
	for i := 0; i < 12; i++ {
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

type changePasswordReq struct {
	Current string `json:"current"`
	New     string `json:"new"`
}

func handleChangePassword(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromContext(r)
		var req changePasswordReq
		if err := readJSON(r, &req); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		var hash string
		if err := db.QueryRow(`SELECT password_hash FROM users WHERE id = ?`, u.ID).Scan(&hash); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not read the account")
			return
		}
		if !checkPassword(hash, req.Current) {
			writeJSONError(w, http.StatusForbidden, "the current password is not right")
			return
		}
		if len(req.New) < minPasswordLen {
			writeJSONError(w, http.StatusBadRequest, "the new password needs at least 8 characters")
			return
		}
		if req.New == req.Current {
			writeJSONError(w, http.StatusBadRequest, "the new password has to be different from the current one")
			return
		}
		newHash, err := hashPassword(req.New)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not process password")
			return
		}
		if _, err := db.Exec(`UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?`, newHash, u.ID); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not save the password")
			return
		}
		// Every other session ends; this one carries on.
		keep := ""
		if c, err := r.Cookie(sessionCookieName); err == nil {
			keep = c.Value
		}
		db.Exec(`DELETE FROM sessions WHERE user_id = ? AND token <> ?`, u.ID, keep)
		caldavCreds.forgetUser(u.ID)
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleResetPassword(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actor := userFromContext(r)
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid user id")
			return
		}
		if id == actor.ID {
			writeJSONError(w, http.StatusConflict, "change your own password from your account menu instead")
			return
		}
		var name string
		if err := db.QueryRow(`SELECT display_name FROM users WHERE id = ?`, id).Scan(&name); err != nil {
			writeJSONError(w, http.StatusNotFound, "no such account")
			return
		}
		temp := newTemporaryPassword()
		hash, err := hashPassword(temp)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not process password")
			return
		}
		if _, err := db.Exec(`UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?`, hash, id); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not reset the password")
			return
		}
		db.Exec(`DELETE FROM sessions WHERE user_id = ?`, id)
		caldavCreds.forgetUser(id)
		logActivityID(db, r, "reset the password of", "account", id, name)
		publishFor(r, "users")
		writeJSON(w, http.StatusOK, map[string]string{"temporaryPassword": temp})
	}
}

// runResetAdmin is the way back in when the only administrator has forgotten
// their password: the app refuses to reset your own, and an account that
// cannot sign in cannot ask another administrator. It works on the database
// file, so it needs the same access as the data itself. Stop the server first
// so its in-memory sign-ins for the old password are dropped too.
func runResetAdmin(dbFile, username string) {
	if _, err := os.Stat(dbFile); err != nil {
		log.Fatalf("reset-admin: no database at %s - pass -db with its path", dbFile)
	}
	db := openDB(dbFile)
	defer db.Close()

	username = strings.TrimSpace(username)
	var id int64
	var role, status string
	if err := db.QueryRow(`SELECT id, role, status FROM users WHERE username = ?`, username).Scan(&id, &role, &status); err != nil {
		var admins []string
		if rows, qerr := db.Query(`SELECT username FROM users WHERE role = 'admin' ORDER BY id`); qerr == nil {
			for rows.Next() {
				var n string
				if rows.Scan(&n) == nil {
					admins = append(admins, n)
				}
			}
			rows.Close()
		}
		log.Fatalf("reset-admin: no account named %q (administrators here: %s)", username, strings.Join(admins, ", "))
	}

	temp := newTemporaryPassword()
	hash, err := hashPassword(temp)
	if err != nil {
		log.Fatalf("reset-admin: %v", err)
	}
	if _, err := db.Exec(`UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?`, hash, id); err != nil {
		log.Fatalf("reset-admin: %v", err)
	}
	db.Exec(`DELETE FROM sessions WHERE user_id = ?`, id)

	fmt.Printf("Temporary password for %s: %s\n", username, temp)
	fmt.Println("Sign in with it; the app asks for a new password straight away.")
	if status != statusActive {
		fmt.Printf("Note: this account is %s, so it cannot sign in until an administrator makes it active.\n", status)
	}
	if role != "admin" {
		fmt.Printf("Note: %s is not an administrator.\n", username)
	}
}

// passwordChangeAllowed lists what an account flagged for a new password may
// still reach: enough to see who it is, set the password, and leave.
func passwordChangeAllowed(r *http.Request) bool {
	switch r.URL.Path {
	case "/api/me", "/api/me/password", "/api/settings":
		return true
	}
	return false
}
