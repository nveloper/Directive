package main

import (
	"archive/zip"
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// These run the real routes against a scratch database, with no server
// process: each test gets its own file and its own mux.

type apiClient struct {
	t    *testing.T
	base string
	http *http.Client
}

func newTestServer(t *testing.T) (string, func() *apiClient) {
	t.Helper()
	_, base, client := newTestServerDB(t)
	return base, client
}

// newTestServerDB also hands back the database, for what the server does on
// its own schedule rather than in answer to a request.
func newTestServerDB(t *testing.T) (*sql.DB, string, func() *apiClient) {
	t.Helper()
	db := openDB(filepath.Join(t.TempDir(), "test.db"))
	t.Cleanup(func() { db.Close() })
	backupDir = t.TempDir()
	attachmentsDir = t.TempDir()
	srv := httptest.NewServer(newMux(db))
	t.Cleanup(srv.Close)
	return db, srv.URL, func() *apiClient {
		jar, _ := cookiejar.New(nil)
		return &apiClient{t: t, base: srv.URL, http: &http.Client{Jar: jar}}
	}
}

func (c *apiClient) do(method, path string, body interface{}, headers map[string]string) (int, []byte, http.Header) {
	c.t.Helper()
	var rd io.Reader
	switch b := body.(type) {
	case nil:
	case []byte:
		rd = bytes.NewReader(b)
	default:
		raw, _ := json.Marshal(b)
		rd = bytes.NewReader(raw)
		if headers == nil {
			headers = map[string]string{}
		}
		headers["Content-Type"] = "application/json"
	}
	req, _ := http.NewRequest(method, c.base+path, rd)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := c.http.Do(req)
	if err != nil {
		c.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	return res.StatusCode, out, res.Header
}

func (c *apiClient) json(method, path string, body interface{}, into interface{}) int {
	c.t.Helper()
	status, out, _ := c.do(method, path, body, nil)
	if into != nil && len(out) > 0 {
		json.Unmarshal(out, into)
	}
	return status
}

func expect(t *testing.T, what string, got, want int) {
	t.Helper()
	if got != want {
		t.Fatalf("%s: status %d, want %d", what, got, want)
	}
}

// A 1x1 PNG.
var tinyPNG, _ = base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")

// setupTeam makes an administrator, a department, and a member in it.
func setupTeam(t *testing.T, client func() *apiClient) (admin, member *apiClient, memberID int64) {
	admin, member = client(), client()
	expect(t, "register admin", admin.json("POST", "/api/register", map[string]string{"username": "ada", "password": "adapass123", "displayName": "Ada"}, nil), 201)
	expect(t, "create dept", admin.json("POST", "/api/departments", map[string]string{"name": "Ops"}, nil), 201)
	expect(t, "create dept 2", admin.json("POST", "/api/departments", map[string]string{"name": "Sales"}, nil), 201)
	expect(t, "register member", member.json("POST", "/api/register", map[string]string{"username": "bob", "password": "bobpass123", "displayName": "Bob"}, nil), 202)
	var users []AccountSummary
	admin.json("GET", "/api/users", nil, &users)
	for _, u := range users {
		if u.Username == "bob" {
			memberID = u.ID
		}
	}
	admin.json("PUT", "/api/users/"+itoa(memberID), map[string]string{"deptId": "ops", "status": "active"}, nil)
	expect(t, "member login", member.json("POST", "/api/login", map[string]string{"username": "bob", "password": "bobpass123"}, nil), 200)
	return admin, member, memberID
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func TestAttachmentsAndIcons(t *testing.T) {
	_, client := newTestServer(t)
	admin, member, _ := setupTeam(t, client)

	var task Task
	expect(t, "create task", admin.json("POST", "/api/tasks", map[string]interface{}{
		"title": "Weekly report", "deptId": "ops", "dueDate": today(), "recurrence": "FREQ=WEEKLY"}, &task), 201)
	var other Task
	admin.json("POST", "/api/tasks", map[string]interface{}{"title": "Sales plan", "deptId": "sales"}, &other)
	id := itoa(task.ID)

	// A picture is recognised by its bytes and shown inline.
	st, out, _ := member.do("POST", "/api/tasks/"+id+"/attachments", tinyPNG, map[string]string{"Content-Type": "image/png", "X-Filename": "shot%20one.png"})
	expect(t, "upload png", st, 201)
	var png Attachment
	json.Unmarshal(out, &png)
	if !png.IsImage || png.Name != "shot one.png" || png.Mime != "image/png" {
		t.Fatalf("png stored as %+v", png)
	}
	// A path in the name is dropped; SVG is never shown inline.
	st, out, _ = member.do("POST", "/api/tasks/"+id+"/attachments", []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`),
		map[string]string{"Content-Type": "image/svg+xml", "X-Filename": "..%2F..%2Fevil.svg"})
	expect(t, "upload svg", st, 201)
	var svg Attachment
	json.Unmarshal(out, &svg)
	if svg.IsImage || svg.Name != "evil.svg" {
		t.Fatalf("svg stored as %+v", svg)
	}
	// Bytes that are not a picture do not become one because the browser said so.
	st, out, _ = member.do("POST", "/api/tasks/"+id+"/attachments", []byte("just text"), map[string]string{"Content-Type": "image/png", "X-Filename": "fake.png"})
	var fake Attachment
	json.Unmarshal(out, &fake)
	if st != 201 || fake.IsImage {
		t.Fatalf("fake png: %d %+v", st, fake)
	}

	st, body, h := member.do("GET", "/api/attachments/"+itoa(png.ID), nil, nil)
	if st != 200 || h.Get("Content-Type") != "image/png" || !strings.HasPrefix(h.Get("Content-Disposition"), "inline") || !bytes.Equal(body, tinyPNG) {
		t.Fatalf("png served as %d %v", st, h)
	}
	st, _, h = member.do("GET", "/api/attachments/"+itoa(svg.ID), nil, nil)
	if st != 200 || h.Get("Content-Type") != "application/octet-stream" || !strings.HasPrefix(h.Get("Content-Disposition"), "attachment") ||
		h.Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(h.Get("Content-Security-Policy"), "sandbox") {
		t.Fatalf("svg served as %d %v", st, h)
	}

	// Too big, and another department's task.
	st, _, _ = member.do("POST", "/api/tasks/"+id+"/attachments", make([]byte, maxAttachmentBytes+1), map[string]string{"X-Filename": "big.bin"})
	expect(t, "oversize upload", st, 413)
	st, _, _ = member.do("POST", "/api/tasks/"+itoa(other.ID)+"/attachments", tinyPNG, map[string]string{"X-Filename": "x.png"})
	expect(t, "upload to another department", st, 403)

	var got Task
	member.json("GET", "/api/tasks/"+id, nil, &got)
	if got.AttachmentCount != 3 {
		t.Fatalf("attachmentCount = %d, want 3", got.AttachmentCount)
	}
	expect(t, "delete attachment", member.json("DELETE", "/api/attachments/"+itoa(fake.ID), nil, nil), 204)

	// Icons: an emoji, not text; then a picture.
	expect(t, "text as icon", member.json("PUT", "/api/tasks/"+id+"/icon", map[string]string{"emoji": "abc"}, nil), 400)
	expect(t, "emoji icon", member.json("PUT", "/api/tasks/"+id+"/icon", map[string]string{"emoji": "🚀"}, nil), 200)
	member.json("GET", "/api/tasks/"+id, nil, &got)
	if got.Icon != "🚀" {
		t.Fatalf("icon = %q", got.Icon)
	}
	expect(t, "image icon", member.json("PUT", "/api/tasks/"+id+"/icon", map[string]string{"mime": "image/png", "data": base64.StdEncoding.EncodeToString(tinyPNG)}, nil), 200)
	st, _, _ = member.do("GET", "/api/tasks/"+id+"/icon", nil, nil)
	expect(t, "fetch icon", st, 200)

	// Finishing the repeating task: the next one keeps the icon, not the files.
	var res struct {
		NextID int64 `json:"nextId"`
	}
	member.json("PUT", "/api/tasks/"+id+"/status", map[string]string{"status": "done"}, &res)
	var next Task
	member.json("GET", "/api/tasks/"+itoa(res.NextID), nil, &next)
	if next.Icon != "image" || next.AttachmentCount != 0 {
		t.Fatalf("next occurrence: icon %q, %d attachments", next.Icon, next.AttachmentCount)
	}
	st, _, _ = member.do("GET", "/api/tasks/"+itoa(res.NextID)+"/icon", nil, nil)
	expect(t, "next occurrence icon picture", st, 200)

	// Purging a task takes its files and its icon picture with it.
	member.json("DELETE", "/api/tasks/"+id, nil, nil)
	st, _, _ = member.do("GET", "/api/attachments/"+itoa(png.ID), nil, nil)
	expect(t, "trashed task's file still readable", st, 200)
	member.json("DELETE", "/api/trash/"+id, nil, nil)
	st, _, _ = member.do("GET", "/api/attachments/"+itoa(png.ID), nil, nil)
	expect(t, "purged task's file gone", st, 404)
	st, _, _ = member.do("GET", "/api/tasks/"+id+"/icon", nil, nil)
	expect(t, "purged task's icon gone", st, 404)
}

func TestPasswords(t *testing.T) {
	_, client := newTestServer(t)
	admin, member, memberID := setupTeam(t, client)

	// Changing your own: the current one is required, and other sessions end.
	second := client()
	expect(t, "second admin session", second.json("POST", "/api/login", map[string]string{"username": "ada", "password": "adapass123"}, nil), 200)
	expect(t, "wrong current", admin.json("PUT", "/api/me/password", map[string]string{"current": "nope", "new": "brand-new-pass"}, nil), 403)
	expect(t, "short new", admin.json("PUT", "/api/me/password", map[string]string{"current": "adapass123", "new": "short"}, nil), 400)
	expect(t, "change", admin.json("PUT", "/api/me/password", map[string]string{"current": "adapass123", "new": "brand-new-pass"}, nil), 204)
	expect(t, "this session survives", admin.json("GET", "/api/me", nil, nil), 200)
	expect(t, "other session ends", second.json("GET", "/api/me", nil, nil), 401)

	// A phone with an app password keeps working through a reset.
	var ap AppPassword
	member.json("POST", "/api/me/app-passwords", map[string]string{"name": "phone"}, &ap)
	dav := func(user, pw string) int {
		req, _ := http.NewRequest("PROPFIND", member.base+"/caldav/"+user+"/calendars/", nil)
		req.SetBasicAuth(user, pw)
		req.Header.Set("Depth", "1")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}

	expect(t, "reset yourself", admin.json("POST", "/api/users/"+itoa(1)+"/reset-password", nil, nil), 409)
	var reset struct {
		Temp string `json:"temporaryPassword"`
	}
	expect(t, "reset member", admin.json("POST", "/api/users/"+itoa(memberID)+"/reset-password", nil, &reset), 200)
	if len(reset.Temp) != 14 {
		t.Fatalf("temporary password %q", reset.Temp)
	}
	expect(t, "member signed out", member.json("GET", "/api/me", nil, nil), 401)
	expect(t, "old password gone", member.json("POST", "/api/login", map[string]string{"username": "bob", "password": "bobpass123"}, nil), 401)

	var me map[string]interface{}
	expect(t, "login with temporary", member.json("POST", "/api/login", map[string]string{"username": "bob", "password": reset.Temp}, &me), 200)
	if me["mustChangePassword"] != true {
		t.Fatalf("login response %v", me)
	}
	expect(t, "flagged account cannot read tasks", member.json("GET", "/api/tasks", nil, nil), 403)
	expect(t, "flagged account can read itself", member.json("GET", "/api/me", nil, nil), 200)
	expect(t, "temporary password is not for phones", dav("bob", reset.Temp), 401)
	expect(t, "app password survives the reset", dav("bob", ap.Token), 207)

	var users []AccountSummary
	admin.json("GET", "/api/users", nil, &users)
	for _, u := range users {
		if u.ID == memberID && !u.MustChangePassword {
			t.Fatalf("administrator should see the pending change")
		}
	}

	expect(t, "set own password", member.json("PUT", "/api/me/password", map[string]string{"current": reset.Temp, "new": "bob-new-pass"}, nil), 204)
	expect(t, "tasks readable again", member.json("GET", "/api/tasks", nil, nil), 200)
	expect(t, "new password works for phones", dav("bob", "bob-new-pass"), 207)
}

func TestDueReminders(t *testing.T) {
	db, _, client := newTestServerDB(t)
	admin, member, memberID := setupTeam(t, client)
	now := time.Date(2026, 3, 10, 9, 0, 0, 0, time.Local)
	for _, task := range []map[string]interface{}{
		{"title": "Due today", "dueDate": "2026-03-10"},
		{"title": "Due tomorrow", "dueDate": "2026-03-11"},
		{"title": "Due later", "dueDate": "2026-03-12"},
		{"title": "Done already", "dueDate": "2026-03-10", "status": "done"},
	} {
		task["deptId"] = "ops"
		task["assigneeId"] = memberID
		task["priority"] = "Medium"
		expect(t, "create "+task["title"].(string), admin.json("POST", "/api/tasks", task, nil), 201)
	}
	// Nobody to tell about this one.
	admin.json("POST", "/api/tasks", map[string]interface{}{"title": "Unassigned", "deptId": "ops", "dueDate": "2026-03-10"}, nil)
	// A task created as done may be stored as todo by the API; make sure.
	db.Exec(`UPDATE tasks SET status = 'done' WHERE title = 'Done already'`)
	db.Exec(`DELETE FROM notifications`)

	if n := sendDueReminders(db, now); n != 2 {
		t.Fatalf("sent %d reminders, want 2", n)
	}
	var list struct {
		Items []Notification `json:"items"`
	}
	member.json("GET", "/api/notifications", nil, &list)
	kinds := map[string]string{}
	for _, n := range list.Items {
		kinds[n.TaskTitle] = n.Kind
	}
	if kinds["Due today"] != notifyDueToday || kinds["Due tomorrow"] != notifyDueTomorrow || len(kinds) != 2 {
		t.Fatalf("reminders %v", kinds)
	}

	// Settings: on at 09:00 unless changed, and only an administrator sees them.
	var st map[string]interface{}
	expect(t, "get reminders", admin.json("GET", "/api/reminders", nil, &st), 200)
	if st["enabled"] != true || st["time"] != "09:00" {
		t.Fatalf("defaults %v", st)
	}
	expect(t, "member cannot", member.json("GET", "/api/reminders", nil, nil), 403)
	expect(t, "bad time", admin.json("PUT", "/api/reminders", map[string]interface{}{"enabled": true, "time": "25:00"}, nil), 400)
	expect(t, "turn off", admin.json("PUT", "/api/reminders", map[string]interface{}{"enabled": false, "time": "07:30"}, &st), 200)
	if st["enabled"] != false || st["time"] != "07:30" {
		t.Fatalf("saved %v", st)
	}
}

func TestTaskSortAndAssigneeFilter(t *testing.T) {
	_, client := newTestServer(t)
	admin, _, memberID := setupTeam(t, client)
	for _, task := range []map[string]interface{}{
		{"title": "b later", "dueDate": "2026-05-02", "priority": "Low", "assigneeId": memberID},
		{"title": "A no date", "priority": "High"},
		{"title": "c sooner", "dueDate": "2026-05-01", "priority": "Medium", "assigneeId": memberID},
	} {
		task["deptId"] = "ops"
		expect(t, "create", admin.json("POST", "/api/tasks", task, nil), 201)
	}
	titles := func(query string) string {
		var res taskListResponse
		expect(t, query, admin.json("GET", "/api/tasks?scope=all&"+query, nil, &res), 200)
		var out []string
		for _, x := range res.Tasks {
			out = append(out, x.Title)
		}
		return strings.Join(out, ", ")
	}
	for query, want := range map[string]string{
		"":                           "b later, A no date, c sooner",
		"sort=due":                   "c sooner, b later, A no date",
		"sort=priority":              "A no date, c sooner, b later",
		"sort=title":                 "A no date, b later, c sooner",
		"sort=bogus":                 "b later, A no date, c sooner",
		"assignee=" + itoa(memberID): "b later, c sooner",
		"assignee=none":              "A no date",
		"assignee=none&sort=due":     "A no date",
		"assignee=" + itoa(memberID) + "&sort=due": "c sooner, b later",
		"assignee=x": "",
	} {
		if got := titles(query); got != want {
			t.Errorf("%q: got %q, want %q", query, got, want)
		}
	}
}

func TestSearchInsideTasks(t *testing.T) {
	_, client := newTestServer(t)
	admin, _, _ := setupTeam(t, client)
	make := func(title, desc string) string {
		var task Task
		expect(t, "create "+title, admin.json("POST", "/api/tasks", map[string]interface{}{"title": title, "description": desc, "deptId": "ops", "priority": "Low"}, &task), 201)
		return itoa(task.ID)
	}
	make("Plain", "")
	make("Described", "Long text first. Then the 50% Zebra mention appears here.")
	listID := make("Listed", "")
	commentID := make("Talked about", "")
	fileID := make("Filed", "")
	expect(t, "checklist", admin.json("POST", "/api/tasks/"+listID+"/checklist", map[string]string{"body": "Feed the okapi"}, nil), 201)
	expect(t, "comment", admin.json("POST", "/api/tasks/"+commentID+"/comments", map[string]string{"body": "Ask about the Quokka budget"}, nil), 201)
	st, _, _ := admin.do("POST", "/api/tasks/"+fileID+"/attachments", []byte("x"), map[string]string{"Content-Type": "text/plain", "X-Filename": "narwhal-notes.txt"})
	expect(t, "attach", st, 201)

	search := func(q string) []Task {
		var res taskListResponse
		expect(t, "search "+q, admin.json("GET", "/api/tasks?scope=all&q="+q, nil, &res), 200)
		return res.Tasks
	}
	for q, want := range map[string]string{"zebra": "description", "OKAPI": "checklist", "quokka": "comment", "narwhal": "file"} {
		got := search(q)
		if len(got) != 1 || got[0].Match == nil || got[0].Match.In != want {
			t.Fatalf("%s: %+v", q, got)
		}
	}
	if m := search("zebra")[0].Match; m.Snippet != "Long text first. Then the 50% Zebra mention appears here." {
		t.Fatalf("snippet %q", m.Snippet)
	}
	if m := search("quokka")[0].Match; m.Author != "Ada" {
		t.Fatalf("author %q", m.Author)
	}
	// The title matched: the row shows why, so no match is attached.
	if got := search("plain"); len(got) != 1 || got[0].Match != nil {
		t.Fatalf("title search %+v", got)
	}
	// A literal percent sign is not a wildcard.
	if got := search("50%25"); len(got) != 1 {
		t.Fatalf("percent search found %d", len(got))
	}
	if s := snippetAround(strings.Repeat("a ", 60)+"needle"+strings.Repeat(" b", 60), "needle"); !strings.HasPrefix(s, "…") || !strings.HasSuffix(s, "…") || !strings.Contains(s, "needle") {
		t.Fatalf("long snippet %q", s)
	}
}

func TestProxyHeaders(t *testing.T) {
	defer func(saved []*net.IPNet) { trustedProxies = saved }(trustedProxies)
	var err error
	if trustedProxies, err = parseProxies("10.0.0.5, 172.16.0.0/12"); err != nil {
		t.Fatal(err)
	}
	if _, err := parseProxies("not-an-ip"); err == nil {
		t.Fatal("a bad address should be refused")
	}
	req := func(remote, fwd, proto string) *http.Request {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = remote + ":5000"
		if fwd != "" {
			r.Header.Set("X-Forwarded-For", fwd)
		}
		if proto != "" {
			r.Header.Set("X-Forwarded-Proto", proto)
		}
		return r
	}
	for _, c := range []struct {
		remote, fwd, proto, ip string
		https                  bool
	}{
		// Straight from a browser: its headers are ignored.
		{"192.168.1.20", "1.2.3.4", "https", "192.168.1.20", false},
		// Through the proxy.
		{"10.0.0.5", "192.168.1.20", "https", "192.168.1.20", true},
		// A browser that forges an address before the proxy appends the real one.
		{"10.0.0.5", "6.6.6.6, 192.168.1.20", "http", "192.168.1.20", false},
		// Two proxies in a row, both trusted.
		{"172.17.0.2", "192.168.1.20, 10.0.0.5", "https", "192.168.1.20", true},
		// A proxy that sends nothing forwarded.
		{"10.0.0.5", "", "", "10.0.0.5", false},
	} {
		r := req(c.remote, c.fwd, c.proto)
		if got := clientIP(r); got != c.ip {
			t.Errorf("%+v: clientIP %s", c, got)
		}
		if got := requestIsHTTPS(r); got != c.https {
			t.Errorf("%+v: https %v", c, got)
		}
	}
}

func TestAttachmentFilesOnDisk(t *testing.T) {
	db, _, client := newTestServerDB(t)
	admin, _, _ := setupTeam(t, client)
	var task Task
	expect(t, "create", admin.json("POST", "/api/tasks", map[string]interface{}{"title": "Files", "deptId": "ops", "priority": "Low"}, &task), 201)
	id := itoa(task.ID)
	upload := func(body string) (Attachment, string) {
		var a Attachment
		st, out, _ := admin.do("POST", "/api/tasks/"+id+"/attachments", []byte(body), map[string]string{"Content-Type": "text/plain", "X-Filename": "notes.txt"})
		expect(t, "upload", st, 201)
		json.Unmarshal(out, &a)
		var rel string
		var blob []byte
		db.QueryRow(`SELECT path, data FROM attachments WHERE id = ?`, a.ID).Scan(&rel, &blob)
		if !validStoredPath(rel) || len(blob) != 0 {
			t.Fatalf("stored as %q with %d bytes inline", rel, len(blob))
		}
		if got, _ := os.ReadFile(attachmentFile(rel)); string(got) != body {
			t.Fatalf("file holds %q", got)
		}
		return a, rel
	}
	first, firstRel := upload("hello attachment")
	st, out, _ := admin.do("GET", "/api/attachments/"+itoa(first.ID), nil, map[string]string{"Range": "bytes=6-"})
	if st != http.StatusPartialContent || string(out) != "attachment" {
		t.Fatalf("range read: %d %q", st, out)
	}

	// A backup carries the file, and downloads as a zip with it.
	var b map[string]interface{}
	expect(t, "backup", admin.json("POST", "/api/backups/run", nil, &b), 200)
	backedUp := filepath.Join(backupFilesDir(), filepath.FromSlash(firstRel))
	if _, err := os.Stat(backedUp); err != nil {
		t.Fatalf("backup copy: %v", err)
	}
	name := b["lastFile"].(string)
	st, out, hdr := admin.do("GET", "/api/backups/"+name, nil, nil)
	if st != 200 || hdr.Get("Content-Type") != "application/zip" {
		t.Fatalf("download: %d %s", st, hdr.Get("Content-Type"))
	}
	zr, err := zip.NewReader(bytes.NewReader(out), int64(len(out)))
	if err != nil {
		t.Fatal(err)
	}
	entries := map[string]bool{}
	for _, f := range zr.File {
		entries[f.Name] = true
	}
	if !entries[name] || !entries["attachments/"+firstRel] {
		t.Fatalf("zip holds %v", entries)
	}

	// Removing it deletes the live file; the backup keeps its copy.
	expect(t, "delete", admin.json("DELETE", "/api/attachments/"+itoa(first.ID), nil, nil), 204)
	if _, err := os.Stat(attachmentFile(firstRel)); !os.IsNotExist(err) {
		t.Fatalf("live file still there: %v", err)
	}
	if _, err := os.Stat(backedUp); err != nil {
		t.Fatalf("backup copy went too: %v", err)
	}

	// A purged task's files go by cascade.
	_, secondRel := upload("second")
	expect(t, "trash", admin.json("DELETE", "/api/tasks/"+id, nil, nil), 204)
	if _, err := os.Stat(attachmentFile(secondRel)); err != nil {
		t.Fatalf("trashed task lost its file: %v", err)
	}
	expect(t, "purge", admin.json("DELETE", "/api/trash/"+id, nil, nil), 204)
	if _, err := os.Stat(attachmentFile(secondRel)); !os.IsNotExist(err) {
		t.Fatalf("purged task's file still there: %v", err)
	}

	// Keeping one backup, made after the file was deleted, lets its copy go.
	expect(t, "backup 2", admin.json("POST", "/api/backups/run", nil, nil), 200)
	expect(t, "keep one", admin.json("PUT", "/api/backups", map[string]interface{}{"enabled": false, "time": "03:00", "keep": 1}, nil), 200)
	if _, err := os.Stat(backedUp); !os.IsNotExist(err) {
		t.Fatalf("pruned backup's file still kept: %v", err)
	}
	entriesLeft, _ := os.ReadDir(backupDir)
	for _, e := range entriesLeft {
		if strings.HasSuffix(e.Name(), "-wal") || strings.HasSuffix(e.Name(), "-shm") || strings.HasSuffix(e.Name(), "-journal") {
			t.Fatalf("reading backups left %s behind", e.Name())
		}
	}

	// A file an older version kept inside the database is moved out.
	var other Task
	admin.json("POST", "/api/tasks", map[string]interface{}{"title": "Old", "deptId": "ops", "priority": "Low"}, &other)
	res, _ := db.Exec(`INSERT INTO attachments (task_id, name, mime, size, data, uploader_name, created_at)
		VALUES (?, 'old.txt', 'text/plain', 3, x'6f6c64', 'Ada', '2026-01-01T00:00:00Z')`, other.ID)
	oldID, _ := res.LastInsertId()
	migrateAttachmentsToFiles(db)
	st, out, _ = admin.do("GET", "/api/attachments/"+itoa(oldID), nil, nil)
	if st != 200 || string(out) != "old" {
		t.Fatalf("migrated file: %d %q", st, out)
	}
}
