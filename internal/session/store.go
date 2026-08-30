package session

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Attachment records which task the current session took, so that closing it
// later does not need the task named again.
type Attachment struct {
	TaskID     string `json:"taskId"`
	TaskNumber int    `json:"number"`
	Title      string `json:"title"`
}

// Store persists attachments per session id.
type Store struct {
	// Dir is where this implementation writes.
	Dir string
	// LegacyDirs are read when Dir has no record. The Python implementation
	// keeps its state elsewhere, so a session it attached can still be closed
	// from here during the changeover.
	LegacyDirs []string
}

// DefaultStore returns the store rooted at the user's config directory.
func DefaultStore(home string, env func(string) string) *Store {
	configHome := env("XDG_CONFIG_HOME")
	if configHome == "" {
		configHome = filepath.Join(home, ".config")
	}
	return &Store{
		Dir:        filepath.Join(configHome, "kaneo", "sessions"),
		LegacyDirs: []string{filepath.Join(configHome, "kn", "sessions")},
	}
}

// CurrentID reports the session this process belongs to.
//
// KANEO_SESSION_ID comes first so the CLI is usable outside Claude Code; the
// agent-specific variable is the fallback.
func CurrentID(env func(string) string) string {
	if id := strings.TrimSpace(env("KANEO_SESSION_ID")); id != "" {
		return id
	}
	return strings.TrimSpace(env("CLAUDE_CODE_SESSION_ID"))
}

// ErrBadSessionID is returned for a session id that cannot safely name a file.
var ErrBadSessionID = errors.New("session id may not contain a path separator or a path element of . or ..")

// validSessionID rejects anything that could escape the store.
//
// The id arrives from the environment, so it is not this program's to trust.
// filepath.Join resolves ".." rather than refusing it, which would let an id
// like "../../x" read, overwrite and delete files anywhere the process can
// reach.
func validSessionID(id string) bool {
	if id == "" || id == "." || id == ".." {
		return false
	}
	if strings.ContainsAny(id, `/\`) || strings.ContainsRune(id, os.PathSeparator) {
		return false
	}
	// Rejected outright rather than sanitised: a silently rewritten id would
	// point at a different session's file.
	return !strings.Contains(id, "..")
}

func (s *Store) path(dir, sessionID string) string {
	return filepath.Join(dir, sessionID+".json")
}

// Save records an attachment for a session.
func (s *Store) Save(sessionID string, a Attachment) error {
	if sessionID == "" {
		return errors.New("no session id")
	}
	if !validSessionID(sessionID) {
		return ErrBadSessionID
	}
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return err
	}
	b, err := json.Marshal(a)
	if err != nil {
		return err
	}
	return os.WriteFile(s.path(s.Dir, sessionID), b, 0o600)
}

// Load returns the attachment for a session, looking in the legacy locations
// when this implementation has nothing recorded.
func (s *Store) Load(sessionID string) (Attachment, bool) {
	if !validSessionID(sessionID) {
		return Attachment{}, false
	}
	for _, dir := range append([]string{s.Dir}, s.LegacyDirs...) {
		b, err := os.ReadFile(s.path(dir, sessionID))
		if err != nil {
			continue
		}
		var a Attachment
		if err := json.Unmarshal(b, &a); err != nil {
			continue
		}
		return a, true
	}
	return Attachment{}, false
}

// Clear removes the attachment from every location it may live in.
func (s *Store) Clear(sessionID string) {
	if !validSessionID(sessionID) {
		return
	}
	for _, dir := range append([]string{s.Dir}, s.LegacyDirs...) {
		_ = os.Remove(s.path(dir, sessionID))
	}
}

// Describe builds a marker for the current process: its session, host, working
// directory and branch.
func Describe(env func(string) string, dir string, state State) Marker {
	host, _ := os.Hostname()
	return Marker{
		SessionID: CurrentID(env),
		Host:      host,
		Cwd:       dir,
		Branch:    currentBranch(dir),
		State:     state,
	}
}

func currentBranch(dir string) string {
	cmd := exec.Command("git", "branch", "--show-current")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
