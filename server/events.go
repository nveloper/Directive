package main

import (
	"fmt"
	"net/http"
	"sync"
	"time"
)

// The server broadcasts "this collection changed" rather than the change
// itself, and clients refetch what they care about. At this scale a refetch
// costs nothing, and it keeps every client honest: there is one way to read
// the data, so a subscriber can never drift from a writer.
//
// events is a single process-wide hub. Threading it through every handler
// constructor would add a parameter to all of them for no benefit - this
// binary serves one database and one hub.
var events = newHub()

type hub struct {
	mu sync.Mutex
	// Each stream remembers whose it is, so something meant for one person -
	// their notifications - reaches only their tabs.
	subs map[chan string]int64
}

func newHub() *hub {
	return &hub{subs: map[chan string]int64{}}
}

func (h *hub) subscribe(userID int64) chan string {
	// Buffered so a slow reader cannot block a writer mid-request; a client
	// that falls this far behind is dropped rather than waited for.
	ch := make(chan string, 16)
	h.mu.Lock()
	h.subs[ch] = userID
	h.mu.Unlock()
	return ch
}

func (h *hub) unsubscribe(ch chan string) {
	h.mu.Lock()
	delete(h.subs, ch)
	h.mu.Unlock()
	close(ch)
}

// publish tells every subscriber that `topic` changed. origin is the id of the
// client that caused it, so that client can skip refetching what it already
// knows.
func (h *hub) publish(topic, origin string) {
	h.send(topic, origin, 0)
}

// publishUser tells only userID's open tabs that `topic` changed.
func (h *hub) publishUser(userID int64, topic, origin string) {
	h.send(topic, origin, userID)
}

func (h *hub) send(topic, origin string, onlyUser int64) {
	msg := fmt.Sprintf(`{"topic":%q,"origin":%q}`, topic, origin)
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch, uid := range h.subs {
		if onlyUser != 0 && uid != onlyUser {
			continue
		}
		select {
		case ch <- msg:
		default:
			// Subscriber is not keeping up. Dropping the message is fine:
			// every message says only "refetch", so the next one recovers it.
		}
	}
}

// clientID identifies the browser tab that made a request, so the event it
// causes can be ignored by that tab. It is a hint, not a credential.
func clientID(r *http.Request) string {
	return r.Header.Get("X-Client-Id")
}

// publishFor is the one-liner mutating handlers use.
func publishFor(r *http.Request, topics ...string) {
	origin := clientID(r)
	for _, t := range topics {
		events.publish(t, origin)
	}
}

func handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSONError(w, http.StatusInternalServerError, "streaming is not supported here")
		return
	}
	// The server sets a 60s write deadline for ordinary requests; a stream has
	// to opt out of it or it is cut off after a minute.
	rc := http.NewResponseController(w)
	rc.SetWriteDeadline(time.Time{})

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	// Tell nginx not to buffer this response; buffering makes a live stream
	// arrive in useless chunks.
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, "retry: 3000\n\n")
	flusher.Flush()

	ch := events.subscribe(userFromContext(r).ID)
	defer events.unsubscribe(ch)

	// A comment line every so often keeps idle proxies from closing the
	// connection, and surfaces a dead peer to us.
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case msg := <-ch:
			if _, err := fmt.Fprintf(w, "data: %s\n\n", msg); err != nil {
				return
			}
			flusher.Flush()
		case <-ping.C:
			if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
