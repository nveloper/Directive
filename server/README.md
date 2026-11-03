# Directive — server

Single static Linux binary. No runtime dependencies (Go + a pure-Go SQLite
driver, `CGO_ENABLED=0`) — the frontend is embedded in the binary too, so
there is nothing else to copy to the server.

## Run

```bash
chmod +x directive
./directive -addr :8080 -db directive.db
```

Then open `http://<server>:8080`. The **first account you register becomes
the administrator**; everyone who registers after that is created *pending* and
cannot sign in until an administrator approves them and puts them in a
department. A member may add and change work in their own department (and
anything nested under it); departments, accounts and app settings are
administrator-only.

The SQLite file is created automatically on first run and holds everything
(users, departments, tasks, comments, activity, settings) — back it up like any file.

The app's displayed name (shown in the header and browser tab, "Directive" by
default) can be renamed by an administrator under Settings → Workspace — the new
name applies for every user.

Flags:
- `-addr` — listen address, e.g. `:8080` or `0.0.0.0:8080` (default `:8080`)
- `-db` — path to the SQLite database file (default `directive.db`; an existing
  `taskcontrolcenter.db` from an older build is picked up automatically)
- `-backup <path>` — write a consistent copy of the database to `<path>` and
  exit. Safe to run while the server is serving: it takes its own read
  transaction, unlike copying the file, which can catch a write half-done and
  misses the WAL. It refuses to overwrite an existing file.
- `-reset-admin <username>` — for a forgotten administrator password (the app
  cannot reset your own, and a locked-out account cannot ask another
  administrator): sets a random temporary password on that account, prints it
  and exits. Run it with the server stopped, e.g.
  `./directive -db /srv/directive/directive.db -reset-admin alice`. The
  account's other sessions are ended and the app asks for a new password at
  the next sign-in.
- `-backup-dir <folder>` — where the automatic daily backups go (default: a
  `backups` folder beside the database). See [Backups](#backups).
- `-attachments-dir <folder>` — where attachment files are kept (default: an
  `attachments` folder beside the database). See
  [Attachment storage](#attachment-storage).
- `-trusted-proxy <list>` — addresses or CIDR ranges of the reverse proxies
  in front, comma-separated (default `127.0.0.1,::1`). See [HTTPS](#https).
- `-tls-cert <file>` / `-tls-key <file>` — serve HTTPS directly from PEM
  files instead of through a proxy.

For real deployment, put it behind a reverse proxy for TLS (see [HTTPS](#https)),
and run it as a systemd service so it restarts on boot/crash.

## HTTPS

Desktop notifications only work on an HTTPS page, and phone sync (CalDAV)
sends a password with every request, so serve the app over HTTPS. Either:

**Behind a reverse proxy** (Nginx Proxy Manager, Caddy, nginx) — the proxy
holds the certificate and forwards plain HTTP to Directive. The proxy reports
the browser's address in `X-Forwarded-For` and that it used HTTPS in
`X-Forwarded-Proto`; Directive believes those only from the addresses given
with `-trusted-proxy`, because anyone could send them otherwise. With them it
rate-limits sign-in by the real browser address rather than the proxy's, and
marks the session cookie `Secure`.

With **Nginx Proxy Manager**:

1. Add a Proxy Host: your domain, scheme `http`, forward to the Directive
   machine and port (e.g. `8080`).
2. SSL tab: request a certificate (or pick one), and turn on *Force SSL* and
   *HTTP/2 Support*. *HSTS* is up to you.
3. Advanced tab — attachments are up to 20 MB, and nginx's own limit is
   lower unless raised:

   ```nginx
   client_max_body_size 25m;
   ```

   Live updates use server-sent events; Directive already tells nginx not to
   buffer them (`X-Accel-Buffering: no`) and pings every 25 seconds, under
   nginx's 60-second read timeout, so nothing else is needed.
4. Start Directive trusting the proxy's address as Directive sees it. With
   NPM in Docker on the same machine that is the Docker network's gateway,
   so a range is simplest:

   ```bash
   ./directive -addr :8080 -db directive.db -trusted-proxy 172.16.0.0/12
   ```

   With NPM on another machine, give that machine's address instead
   (`-trusted-proxy 192.168.0.10`).
5. Keep port 8080 from being reached around the proxy — a firewall rule, or
   `-addr 127.0.0.1:8080` when the proxy can reach it there.

Phone sync then uses `https://<your-domain>/caldav/`.

**Directly** — `-tls-cert cert.pem -tls-key key.pem` serves HTTPS itself,
for a certificate you already have. Nothing renews it; a proxy is easier for
that.

## Calendar integration

There is no live iCloud/CalDAV account sync — that would need this server to
hold your calendar password/app-password and would fail from a browser
anyway (iCloud's CalDAV blocks cross-origin requests). Instead, every
department gets a standing, token-secured `.ics` URL
(`/calendar/<token>.ics`) shown in the schedule drawer — add that as a
**subscribed calendar** in Apple Calendar / Google Calendar / Outlook and its
due dates show up automatically, no manual export/import.

## Rebuilding from source

```bash
go test ./...                                                  # unit and API tests, no server needed
go build -o directive .                                        # native
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o directive .   # cross-compile for Linux from anywhere
```

## Due today

The schedule drawer (the calendar button in the top bar) lists unfinished
tasks due today or already late, soonest
first; ticking one completes the task. There used to be a separate reminders
list beside the tasks - it was folded into them, since in a phone's reminders
app the two looked the same anyway. On first start after that change every old
reminder is copied across as a task (text, department, done state and creation
time kept); the old `reminders` table is left in place untouched.

## Sorting and filtering

**Filter** above the list sorts it by creation order, due date (tasks without
one last), priority (then due date), last update, or title, and narrows it by
assignee (anyone, unassigned, or one person), priority and calendar
visibility. The sort is remembered per browser; filters reset on reload. The
API takes the same as `sort=` (`created`, `due`, `priority`, `updated`,
`title`) and `assignee=` (`none` or an account id) on `GET /api/tasks`.

The list's column headings (Task, Due date, Priority) sort it too; clicking
the active one goes back to creation order.

`GET /api/tasks` also takes `dueFrom=` and `dueTo=` (`YYYY-MM-DD`, inclusive),
which keep only tasks due in that span - the calendar view asks for one month
this way.

## Views and shortcuts

The list, the board (a column per status; drag a card to change its status)
and the month calendar are switched above the list or with `1`, `2`, `3`; the
choice is remembered per browser. `Ctrl/⌘ K` opens a command menu that runs
commands and searches tasks. Outside text fields: `C` new task, `/` search,
`J`/`K` move between rows, Enter open, `X` select, `Esc` clear the selection.
Selected tasks can have their status, priority or assignee changed, or be
moved to the trash, together.

Each department can have a colour (department settings, `#rrggbb`, stored in
`departments.color` and sent as `color` on `PUT /api/departments/{id}`); a
sub-department without one uses its parent's.

## Search

The search box matches titles, assignees and department names, and also the
inside of a task: its description, checklist items, comments and attachment
names. When the hit is somewhere the list does not show, the row says where
(description, checklist, whose comment, or file) with the words around it.

## Repeating tasks

A task can repeat daily, every weekday, weekly, monthly or yearly, every N of
those. The rule is stored as an RFC 5545 `RRULE` value anchored on the due
date, which is the same thing a reminders app sends, so a rule made on a phone
(say, "the last Friday of each month") survives the round trip even though the
web app has no preset for it - the editor shows it as a custom rule and keeps
it. A task has to have a due date to repeat.

Finishing a repeating task closes that occurrence (it stays under Done, with
its comments) and files the next one as a new task with the same title,
department, assignee and checklist, unticked. The next due date is the first
occurrence after the current one that is not already in the past, so a weekly
task finished three weeks late produces one task for this week, not three
overdue ones. `COUNT` and `UNTIL` end the series.

## Language

The interface follows the system (browser) language: Korean when it is
Korean, English otherwise. There is no setting for it. Strings are written in
English in `static/app.js` and looked up in `static/i18n.js`; a string missing
from the Korean table stays English. Error messages from the server are sent
in English and translated in the browser, and the activity feed is rebuilt in
Korean word order from the English verb the server stores, so existing
records read correctly too. Names people choose - the app, departments, tasks
- are never translated. What calendar apps receive (the `.ics` feed and
CalDAV) stays English, since the server cannot know the subscriber's
language.

## Task details, attachments and icons

Clicking a task opens its **details**: description (web addresses become
links), checklist, attachments and comments, with the status changeable in
place. Editing the fields is behind the gear button, which opens the editor and
comes back to the details afterwards.

**Attachments** are kept with the task, up to 20 MB per file and 30 per task,
as files beside the database (see [Attachment storage](#attachment-storage)). Files can be added with a button, dropped onto the details, or
pasted (a copied screenshot). PNG, JPEG, GIF and WebP - decided from the bytes,
not the name or the browser's claim - are shown inline; everything else,
including SVG, is only ever served as a download, with `nosniff` and a
sandboxing CSP. Adding or removing a file is scoped like editing the task;
reading follows reading the task. The backups dialog shows how much they take
in total. A repeating task's next
occurrence does not copy them.

A task can carry an **icon**: an emoji, or an uploaded picture (kept in
`images` as `task:<id>`), shown beside its title everywhere.

## Passwords

Anyone can change their own password (Settings → Password and sync); it
needs the current one, signs out every other session and clears cached phone
sign-ins, while app passwords keep working. An administrator can **reset**
someone's password from Settings → Accounts: that issues a random temporary password,
shown once, signs the person out everywhere, and flags the account so that it
can reach nothing but the password change until they choose their own. The
temporary password does not work for CalDAV. No one can see anyone's password.

## Task timeline

The detail panel shows a task's comments and its changes - created, edited,
done, reopened, files added or removed, trashed or restored - as one timeline.
It reads them from `GET /api/activity?task=<id>`. An edit is recorded as such,
not field by field.

## Checklists

A task can hold a list of steps, ticked one at a time; the list shows the
progress as 2/5. Changing a checklist is scoped like editing its task. It does
not travel over CalDAV - `VTODO` has no standard place for it.

## Notifications

The bell has two tabs. **For you** holds notifications for the signed-in
account: someone assigned you a task, mentioned you in a comment (`@Display
Name` or `@username`), or commented on a task assigned to you. They are stored
per account, so read/unread is the same on every device, and only that
account's open tabs are told when one arrives. **Activity** is the shared feed,
grouped by day, leaving out your own actions unless you tick *Include my own
actions*. Desktop alerts can be switched on for when the tab is in the
background; browsers only allow those on an HTTPS page.

### Due-date reminders

Once a day the server notifies each assignee of their unfinished tasks due
today and due tomorrow. An administrator turns this on or off and picks the
time under Settings → Reminders and backups → **Due-date reminders** (on at 09:00 by default, by the
server's clock). If the server was off at that time, the day's reminders go out
as soon as it starts; each day's run happens once, so moving the time later
does not send the same list twice. Unassigned tasks are left out.

## Trash

Deleting a task - in the web app or from a phone over CalDAV - moves it to the
trash with its comments and checklist intact. It can be restored from there (or
straight away from the Undo bar) and is removed for good after 10 days. Anyone
who could edit the task can restore it or delete it early.

## Reminders app sync (CalDAV)

Alongside the read-only `.ics` feed, the server speaks CalDAV, so a phone's
reminders app can hold these tasks and write back to them. Each department is
a calendar carrying `VTODO`; add the account and the tasks appear as to-dos.

```
Server:   https://<your-host>/caldav/
Username: your Directive username
Password: an app password (Settings → Password and sync → Phone sync)
```

`/.well-known/caldav` redirects, so most clients only need the host. Clients
authenticate with HTTP Basic against the same accounts and approval state as the
web app, so this needs the TLS the deployment notes already call for.

The password is best an **app password**: one per device, created under
*Phone sync*, shown once, and revocable on its own. A phone then never stores
the account password, and a lost phone is one line to revoke - it stops syncing
on its next request. The account password is still accepted, for devices set up
before app passwords existed. App passwords are random, so they are stored as a
SHA-256 digest rather than a bcrypt hash; disabling an account or revoking an
app password also clears the short-lived credential cache for that account.

Note this is the opposite of the iCloud sync ruled out above. There, Directive
would hold your Apple app-password and reach into your account; here the client
comes to us and signs in with the account it already has, so there is no
third-party credential to keep and no browser in the path to be blocked.

What travels, and what does not:

- Title, description, due date, priority and completion go both ways.
- Department, assignee, calendar visibility and comments are left alone by a
  write. A reminders app cannot see them, so a change coming back from one
  merges onto the existing row rather than replacing it.
- `review` has no equivalent in `VTODO`, so the exact state also rides in
  `X-DIRECTIVE-STATUS`. It only refines the standard `STATUS` when the two
  agree: most clients carry unknown properties back untouched, so a task ticked
  off on a phone arrives as `STATUS:COMPLETED` beside the old
  `X-DIRECTIVE-STATUS:todo`, and the tick wins.
- A repeating task carries `RRULE` (with `DTSTART` set to the due date) both
  ways. A client that advances the due date itself sends the task back
  unfinished; one that just marks it complete gets the next occurrence from
  the server.
- Deleting a to-do on the phone moves the task to the trash.
- Writing is scoped exactly as it is in the app: a member may change work in
  their own department, and gets 403 elsewhere.
- A stale `If-Match` returns 412 rather than overwriting someone else's edit.

Google Calendar and Outlook cannot speak CalDAV; the `.ics` feed above remains
the way in for them, read-only.

## Backups

An administrator can turn on a daily backup under Settings → Reminders
and backups → *Backups*, choosing the time (by the server's clock - the dialog shows what it
reads) and how many to keep. Files are named `directive-YYYY-MM-DD-HHMM.db` and
written to `-backup-dir`; only files named that way are listed, pruned or
offered for download, so anything else in the folder is left alone. If the
server was off at the set time, that day's backup runs as soon as it starts.
*Back up now* makes one on the spot, and each can be downloaded from the
dialog so a copy lives somewhere other than the server it protects. The folder
is a start-up flag rather than a setting so the web app cannot be used to write
files wherever the server process is allowed to.

A one-off copy from the command line still works:

```bash
./directive -db directive.db -backup /var/backups/directive-$(date +%F).db
```

Either way the result is an ordinary database file: point `-db` at it to
inspect a backup, or move it back into place to restore.

**Attachment files** are not inside the database (see
[Attachment storage](#attachment-storage)). Scheduled backups and *Back up
now* copy the files a backup needs into `attachments/` inside the backup
folder, once each - a file already there from an earlier backup is not
copied again, and hard links are used when both folders are on one disk. When
old backups are pruned, files that no remaining backup needs go too.
Downloading a backup from the dialog gives a zip of the `.db` file and an
`attachments/` folder with its files. To restore one: stop the server, put
the `.db` in place as the database, and copy the `attachments/` folder beside
it (merging with what is there is fine). The command-line `-backup` copies
only the database; copy the attachments folder alongside it yourself - its
files never change, so that is safe while the server runs.

## Attachment storage

Attachment files live in a folder beside the database (`attachments/` by
default, or `-attachments-dir <folder>`), under random names; the database
holds their names, types and sizes. Keeping them out of the database means an
upload or download no longer holds up everyone else's requests, since the
server uses a single database connection. A database from an older version,
with the files inside it, has them moved out on first start, and is then
compacted to give the space back.

A file is deleted when its attachment is removed or its task is purged from
the trash, and nothing else in the folder is ever deleted - starting the
server against the wrong database leaves another database's files alone.

## Source layout

- `main.go` — routing, embeds `static/` into the binary, starts the server
- `db.go` — SQLite schema
- `auth.go` — password hashing (bcrypt) + cookie sessions
- `api.go` — REST handlers for accounts, departments, settings + auth
- `tasks.go` — creating, editing, finishing and deleting tasks; the trash
- `attachments.go` — per-task files and task icons
- `passwords.go` — changing and resetting passwords
- `tasklist.go` — the task list query: scope, search, filters, sorting, paging, counts
- `search.go` — where a search hit inside a task, and the snippet shown for it
- `proxy.go` — which reverse proxies are believed about the client's address and HTTPS
- `files.go` — attachment files on disk: storing, deleting, moving old ones out of the database
- `backupfiles.go` — attachment files in backups: the shared copies, pruning, zip download
- `recurrence.go` — repeat rules and filing the next occurrence
- `checklist.go` — per-task checklists
- `comments.go` — per-task comment threads
- `notifications.go` — per-account notifications and @mention matching
- `apppasswords.go` — per-device passwords for CalDAV
- `backup.go` — the daily backup schedule, pruning and download
- `reminders.go` — the daily due-date reminders
- `activity.go` — the shared activity feed
- `events.go` — the server-sent event stream that keeps open tabs current
- `ratelimit.go` — per-IP throttle on the sign-in endpoints
- `ics.go` — the per-department `.ics` calendar feed
- `caldav.go` — the CalDAV server: tasks as VTODO, two-way
- `../demo/` — the static demo: `mock-api.js` stands in for this server
- `static/` — the frontend (`index.html`, `app.js`, `styles.css`, and the Pretendard font in `fonts/`, SIL Open Font License)
