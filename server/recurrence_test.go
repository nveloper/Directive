package main

import (
	"sort"
	"strings"
	"testing"
)

func TestNextOccurrence(t *testing.T) {
	cases := []struct {
		name, rule, due, today string
		wantRule, wantDue      string
		wantOK                 bool
	}{
		{"daily, done on time", "FREQ=DAILY", "2026-09-24", "2026-09-24", "FREQ=DAILY", "2026-09-25", true},
		{"daily, done early", "FREQ=DAILY", "2026-09-26", "2026-09-24", "FREQ=DAILY", "2026-09-27", true},
		// Three weeks late gives this week's occurrence, not three overdue ones.
		{"weekly, caught up", "FREQ=WEEKLY", "2026-09-03", "2026-09-24", "FREQ=WEEKLY", "2026-09-24", true},
		{"weekdays over a weekend", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "2026-09-25", "2026-09-25", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "2026-09-28", true},
		{"every 2 weeks", "FREQ=WEEKLY;INTERVAL=2", "2026-09-24", "2026-09-24", "FREQ=WEEKLY;INTERVAL=2", "2026-10-08", true},
		{"monthly", "FREQ=MONTHLY", "2026-01-15", "2026-01-15", "FREQ=MONTHLY", "2026-02-15", true},
		{"count counts down", "FREQ=DAILY;COUNT=3", "2026-09-24", "2026-09-24", "FREQ=DAILY;COUNT=2", "2026-09-25", true},
		{"count used up", "FREQ=DAILY;COUNT=1", "2026-09-24", "2026-09-24", "", "", false},
		{"until passed", "FREQ=DAILY;UNTIL=20260924T000000Z", "2026-09-24", "2026-09-24", "", "", false},
		{"no due date", "FREQ=DAILY", "", "2026-09-24", "", "", false},
	}
	for _, c := range cases {
		rule, due, ok := nextOccurrence(c.rule, c.due, c.today)
		if ok != c.wantOK || rule != c.wantRule || due != c.wantDue {
			t.Errorf("%s: got (%q, %q, %v), want (%q, %q, %v)", c.name, rule, due, ok, c.wantRule, c.wantDue, c.wantOK)
		}
	}
}

func TestNormalizeRecurrence(t *testing.T) {
	good := map[string]string{
		"":                             "",
		"RRULE:FREQ=WEEKLY":            "FREQ=WEEKLY",
		"  FREQ=MONTHLY;BYMONTHDAY=1 ": "FREQ=MONTHLY;BYMONTHDAY=1",
	}
	for in, want := range good {
		got, err := normalizeRecurrence(in)
		if err != nil || got != want {
			t.Errorf("normalizeRecurrence(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"FREQ=HOURLY", "BYDAY=MO", "FREQ=DAILY\nFREQ=DAILY", "nonsense"} {
		if _, err := normalizeRecurrence(bad); err == nil {
			t.Errorf("normalizeRecurrence(%q) accepted a rule it should refuse", bad)
		}
	}
}

func TestICalToStatus(t *testing.T) {
	cases := []struct{ ical, exact, want string }{
		{"COMPLETED", "todo", "done"},        // ticked on a phone that kept the X- prop
		{"IN-PROCESS", "review", "review"},   // the exact state refines a matching STATUS
		{"NEEDS-ACTION", "done", "todo"},     // unticked on a phone
		{"NEEDS-ACTION", "", "todo"},         // a client that never saw the X- prop
		{"", "inprogress", "inprogress"},     // STATUS dropped entirely
		{"IN-PROCESS", "todo", "inprogress"}, // started on a phone
		{"COMPLETED", "done", "done"},
	}
	for _, c := range cases {
		if got := icalToStatus(c.ical, c.exact); got != c.want {
			t.Errorf("icalToStatus(%q, %q) = %q, want %q", c.ical, c.exact, got, c.want)
		}
	}
}

func TestBackupOrder(t *testing.T) {
	names := []string{"directive-2026-09-24-1050.db", "directive-2026-09-24-1050-3.db", "directive-2026-09-23-0300.db", "directive-2026-09-24-1050-2.db"}
	sort.Slice(names, func(i, j int) bool { return backupNewer(names[i], names[j]) })
	want := []string{"directive-2026-09-24-1050-3.db", "directive-2026-09-24-1050-2.db", "directive-2026-09-24-1050.db", "directive-2026-09-23-0300.db"}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("backup order = %v, want %v", names, want)
		}
	}
}

func TestAppPasswordShape(t *testing.T) {
	tok := newAppPasswordToken()
	if len(tok) != 19 || !looksLikeAppPassword(tok) {
		t.Fatalf("token %q does not look like an app password", tok)
	}
	typed := strings.ToUpper(strings.ReplaceAll(tok, "-", " "))
	if hashAppPassword(tok) != hashAppPassword(typed) {
		t.Fatalf("%q typed as %q should match", tok, typed)
	}
	if looksLikeAppPassword("correct horse battery") {
		t.Fatalf("an ordinary password was taken for an app password")
	}
}
