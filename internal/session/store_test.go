package session

import (
	"os"
	"path/filepath"
	"testing"
)

// The session id comes from the environment, so it is not this program's to
// trust. filepath.Join resolves ".." rather than refusing it, which would let
// an id reach any file the process can.
func TestStoreRejectsSessionIDsThatEscape(t *testing.T) {
	root := t.TempDir()
	store := &Store{Dir: filepath.Join(root, "store")}
	victim := filepath.Join(root, "victim.json")
	original := `{"taskId":"do-not-touch"}`
	if err := os.WriteFile(victim, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}

	for _, id := range []string{"../victim", "../../victim", "a/../../victim", "sub/victim", `sub\victim`, "..", ".", ""} {
		if err := store.Save(id, Attachment{TaskID: "OVERWRITTEN"}); err == nil {
			t.Errorf("Save(%q) was accepted", id)
		}
		if _, ok := store.Load(id); ok {
			t.Errorf("Load(%q) was accepted", id)
		}
		store.Clear(id)
	}

	b, err := os.ReadFile(victim)
	if err != nil {
		t.Fatalf("the file outside the store was removed: %v", err)
	}
	if string(b) != original {
		t.Errorf("the file outside the store was rewritten: %s", b)
	}
}

// The check must not reject the ids actually in use.
func TestStoreAcceptsOrdinarySessionIDs(t *testing.T) {
	store := &Store{Dir: t.TempDir()}
	for _, id := range []string{
		"54c76464-299c-460e-9e3f-77556f55a02b",
		"01M0Y1VTEME00B",
		"plain",
	} {
		if err := store.Save(id, Attachment{TaskID: "t", TaskNumber: 1, Title: "x"}); err != nil {
			t.Errorf("Save(%q) = %v, want nil", id, err)
			continue
		}
		got, ok := store.Load(id)
		if !ok || got.TaskID != "t" {
			t.Errorf("Load(%q) = %+v, %v", id, got, ok)
		}
		store.Clear(id)
		if _, ok := store.Load(id); ok {
			t.Errorf("Clear(%q) did not remove the record", id)
		}
	}
}

func TestStoreFilePermissions(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "store")
	store := &Store{Dir: dir}
	if err := store.Save("s1", Attachment{TaskID: "t"}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(dir, "s1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("mode = %o, want 600", perm)
	}
}
