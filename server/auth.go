package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"log"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// Renamed along with the binary. An old tcc_session cookie no longer matches,
// so everyone signs in once more after the upgrade.
const sessionCookieName = "directive_session"
const sessionTTL = 30 * 24 * time.Hour

type ctxKey string

const userCtxKey ctxKey = "user"

// Account states. A self-registered account waits as `pending` until an
// administrator approves it, so reaching the server is not the same as
// getting to read the organisation's tasks.
const (
	statusPending  = "pending"
	statusActive   = "active"
	statusDisabled = "disabled"
)

type User struct {
	ID          int64
	Username    string
	DisplayName string
	Role        string
	Status      string
	DeptID      string
	// Set after an administrator resets the password: until a new one is
	// chosen, the account can reach nothing but the password change.
	MustChangePassword bool
}

func (u *User) isAdmin() bool { return u.Role == "admin" }

// canWriteDept reports whether the user may create, edit or delete things
// filed under deptID. Admins may touch anything; a member may touch their own
// department and anything nested under it. A member with no department yet
// (freshly approved) can read but not write, and tasks filed under no
// department at all are administrator-only.
func (u *User) canWriteDept(deptID string) bool {
	if u.isAdmin() {
		return true
	}
	if u.DeptID == "" || deptID == "" {
		return false
	}
	return deptID == u.DeptID || strings.HasPrefix(deptID, u.DeptID+"/")
}

func randomToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func hashPassword(pw string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.DefaultCost)
	return string(b), err
}

func checkPassword(hash, pw string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(pw)) == nil
}

// dummyHash is compared against when the username doesn't exist, so a failed
// login costs the same time whether or not the account is real. Without it the
// response time tells an attacker which usernames are worth guessing at.
var dummyHash = func() []byte {
	h, _ := bcrypt.GenerateFromPassword([]byte("not-a-real-password"), bcrypt.DefaultCost)
	return h
}()

func burnPasswordTime() {
	bcrypt.CompareHashAndPassword(dummyHash, []byte("not-a-real-password-either"))
}

func createSession(db *sql.DB, userID int64) (string, error) {
	token := randomToken()
	now := time.Now().UTC()
	_, err := db.Exec(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
		token, userID, now.Format(time.RFC3339), now.Add(sessionTTL).Format(time.RFC3339))
	return token, err
}

func destroySession(db *sql.DB, token string) {
	db.Exec(`DELETE FROM sessions WHERE token = ?`, token)
}

// purgeExpiredSessions runs at start and then hourly. Without it the sessions
// table only ever grows — nothing deleted a row once it expired.
func purgeExpiredSessions(db *sql.DB) {
	clean := func() {
		res, err := db.Exec(`DELETE FROM sessions WHERE expires_at <= ?`, time.Now().UTC().Format(time.RFC3339))
		if err != nil {
			log.Printf("session cleanup: %v", err)
			return
		}
		if n, _ := res.RowsAffected(); n > 0 {
			log.Printf("session cleanup: removed %d expired session(s)", n)
		}
	}
	clean()
	go func() {
		for range time.Tick(time.Hour) {
			clean()
		}
	}()
}

func userFromSession(db *sql.DB, token string) *User {
	if token == "" {
		return nil
	}
	row := db.QueryRow(`
		SELECT u.id, u.username, u.display_name, u.role, u.status, COALESCE(u.dept_id, ''), u.must_change_password
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.token = ? AND s.expires_at > ?`, token, time.Now().UTC().Format(time.RFC3339))
	var u User
	if err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.Role, &u.Status, &u.DeptID, &u.MustChangePassword); err != nil {
		return nil
	}
	return &u
}

func setSessionCookie(w http.ResponseWriter, r *http.Request, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   requestIsHTTPS(r),
		SameSite: http.SameSiteLaxMode,
		Expires:  time.Now().Add(sessionTTL),
	})
}

func clearSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   requestIsHTTPS(r),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

// requireAuth wraps a handler so it only runs for a signed-in, approved user.
// The authenticated user is attached to the request context.
func requireAuth(db *sql.DB, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(sessionCookieName)
		if err != nil {
			writeJSONError(w, http.StatusUnauthorized, "not signed in")
			return
		}
		user := userFromSession(db, cookie.Value)
		if user == nil {
			writeJSONError(w, http.StatusUnauthorized, "session expired")
			return
		}
		switch user.Status {
		case statusPending:
			writeJSONError(w, http.StatusForbidden, "your account is waiting for an administrator to approve it")
			return
		case statusDisabled:
			writeJSONError(w, http.StatusForbidden, "this account has been disabled")
			return
		}
		if user.MustChangePassword && !passwordChangeAllowed(r) {
			writeJSONError(w, http.StatusForbidden, "choose a new password first")
			return
		}
		ctx := context.WithValue(r.Context(), userCtxKey, user)
		next(w, r.WithContext(ctx))
	}
}

// requireAdmin is requireAuth plus an administrator check.
func requireAdmin(db *sql.DB, next http.HandlerFunc) http.HandlerFunc {
	return requireAuth(db, func(w http.ResponseWriter, r *http.Request) {
		if !userFromContext(r).isAdmin() {
			writeJSONError(w, http.StatusForbidden, "only an administrator can do that")
			return
		}
		next(w, r)
	})
}

func userFromContext(r *http.Request) *User {
	u, _ := r.Context().Value(userCtxKey).(*User)
	return u
}
