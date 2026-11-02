package main

import (
	"database/sql"
	"strings"
)

// SearchMatch is the piece of a task a search hit, for a list row to show
// under the title: where it was found and the words around it.
type SearchMatch struct {
	In      string `json:"in"` // description | checklist | comment | file
	Snippet string `json:"snippet"`
	Author  string `json:"author,omitempty"`
}

// searchMatch finds why a task was in the results. Nothing is returned when
// the title or assignee matched, since the row already shows those. It runs
// for one page of results at a time.
func searchMatch(db *sql.DB, t *Task, search string) *SearchMatch {
	needle := strings.ToLower(search)
	if strings.Contains(strings.ToLower(t.Title), needle) || strings.Contains(strings.ToLower(t.Assignee), needle) {
		return nil
	}
	if strings.Contains(strings.ToLower(t.Description), needle) {
		return &SearchMatch{In: "description", Snippet: snippetAround(t.Description, needle)}
	}
	term := likeEscape(search)
	var body, author string
	if db.QueryRow(`SELECT body FROM checklist_items WHERE task_id = ? AND LOWER(body) LIKE ? ESCAPE '\'
			ORDER BY position, id LIMIT 1`, t.ID, term).Scan(&body) == nil {
		return &SearchMatch{In: "checklist", Snippet: snippetAround(body, needle)}
	}
	if db.QueryRow(`SELECT c.body, COALESCE(NULLIF(u.display_name, ''), c.author_name) FROM comments c
			LEFT JOIN users u ON u.id = c.user_id
			WHERE c.task_id = ? AND LOWER(c.body) LIKE ? ESCAPE '\' ORDER BY c.id DESC LIMIT 1`,
		t.ID, term).Scan(&body, &author) == nil {
		return &SearchMatch{In: "comment", Snippet: snippetAround(body, needle), Author: author}
	}
	if db.QueryRow(`SELECT name FROM attachments WHERE task_id = ? AND LOWER(name) LIKE ? ESCAPE '\'
			ORDER BY id LIMIT 1`, t.ID, term).Scan(&body) == nil {
		return &SearchMatch{In: "file", Snippet: body}
	}
	// The department's name matched; the row shows that too.
	return nil
}

// snippetAround cuts text down to the found words and a little either side,
// on one line.
func snippetAround(text, needle string) string {
	const before, after = 30, 70
	flat := []rune(strings.Join(strings.Fields(text), " "))
	lower := strings.ToLower(string(flat))
	start := 0
	// Lower-casing can change a string's length in rare scripts; then the
	// offset would not carry over, and the start of the text is shown.
	if at := strings.Index(lower, needle); at >= 0 && len([]rune(lower)) == len(flat) {
		start = len([]rune(lower[:at]))
	}
	from, to := start-before, start+len([]rune(needle))+after
	prefix, suffix := "…", "…"
	if from <= 0 {
		from, prefix = 0, ""
	}
	if to >= len(flat) {
		to, suffix = len(flat), ""
	}
	return prefix + string(flat[from:to]) + suffix
}
