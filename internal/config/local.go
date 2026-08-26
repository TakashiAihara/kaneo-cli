package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// LocalFileName is the per-directory config a repo may carry.
const LocalFileName = ".kaneo.json"

// Local is the whole content of a .kaneo.json.
//
// It deliberately holds no credentials: the file is expected to be committed,
// so anything secret would leak with the repo.
type Local struct {
	Workspace string `json:"workspace,omitempty"`
	Project   string `json:"project,omitempty"`

	// Path records where this instance was read from, for `kaneo context`.
	Path string `json:"-"`
}

// FindLocals walks from dir towards the filesystem root, collecting every
// .kaneo.json it passes. The result is ordered nearest-first.
//
// stopAt bounds the walk (normally $HOME). The directory named by stopAt is
// itself inspected, then the walk ends. An unreadable or malformed file is
// skipped rather than failing the walk: a broken config should not stop a
// session, and the layer below it is still a valid answer.
func FindLocals(dir, stopAt string) []Local {
	var found []Local

	dir = filepath.Clean(dir)
	stopAt = filepath.Clean(stopAt)

	for {
		if l, ok := readLocal(filepath.Join(dir, LocalFileName)); ok {
			found = append(found, l)
		}
		if dir == stopAt {
			break
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return found
}

func readLocal(path string) (Local, bool) {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return Local{}, false
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return Local{}, false
	}
	var l Local
	if err := json.Unmarshal(b, &l); err != nil {
		return Local{}, false
	}
	l.Path = path
	return l, true
}

// MergeLocals folds a nearest-first list into one value, letting the nearest
// definition of each field win. A parent can therefore fill a gap the child
// left, which is what makes this useful in a monorepo.
func MergeLocals(locals []Local) Local {
	var out Local
	for _, l := range locals {
		if out.Workspace == "" && l.Workspace != "" {
			out.Workspace = l.Workspace
			out.Path = l.Path
		}
		if out.Project == "" && l.Project != "" {
			out.Project = l.Project
			if out.Path == "" {
				out.Path = l.Path
			}
		}
	}
	return out
}
