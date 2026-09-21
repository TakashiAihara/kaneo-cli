// next-tag prints the tag the next automatic release gets: one release
// candidate past the highest v* tag in the repository.
//
//	vX.Y.Z-rc.N  ->  vX.Y.Z-rc.(N+1)
//	vX.Y.Z       ->  vX.Y.(Z+1)-rc.1
//
// Parsed here rather than left to `git tag --sort=v:refname`, which puts
// v0.1.0 below its own release candidates: the final version would read as the
// oldest and the next tag would reuse a number that already exists. Tags in
// neither shape are ignored. No tag at all is an error: the first version is a
// person's decision, not a default.
//
// It is run by the release workflow only and is not part of the shipped build.
package main

import (
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

var shape = regexp.MustCompile(`^v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$`)

// version is major, minor, patch, rc. A final version sorts above every
// release candidate of itself, so its rc is MaxInt.
type version [4]int

func parse(tag string) (version, bool) {
	m := shape.FindStringSubmatch(strings.TrimSpace(tag))
	if m == nil {
		return version{}, false
	}
	var v version
	for i := 0; i < 3; i++ {
		v[i], _ = strconv.Atoi(m[i+1])
	}
	v[3] = math.MaxInt
	if m[4] != "" {
		v[3], _ = strconv.Atoi(m[4])
	}
	return v, true
}

func less(a, b version) bool {
	for i := range a {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

func nextTag(tags []string) (string, error) {
	var top version
	found := false
	for _, t := range tags {
		if v, ok := parse(t); ok && (!found || less(top, v)) {
			top, found = v, true
		}
	}
	if !found {
		return "", errors.New("no vX.Y.Z or vX.Y.Z-rc.N tag to count from")
	}
	if top[3] == math.MaxInt {
		return fmt.Sprintf("v%d.%d.%d-rc.1", top[0], top[1], top[2]+1), nil
	}
	return fmt.Sprintf("v%d.%d.%d-rc.%d", top[0], top[1], top[2], top[3]+1), nil
}

func main() {
	out, err := exec.Command("git", "tag", "--list", "v*").Output()
	if err != nil {
		fmt.Fprintln(os.Stderr, "git tag:", err)
		os.Exit(1)
	}
	tag, err := nextTag(strings.Split(string(out), "\n"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(tag)
}
