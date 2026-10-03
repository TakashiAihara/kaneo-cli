package main

import "testing"

func TestNextTag(t *testing.T) {
	cases := []struct {
		tags []string
		want string
	}{
		{[]string{"v0.2.0", "v0.1.0"}, "v0.2.1-rc.1"},
		{[]string{"v0.2.0", "v0.2.1-rc.1", "v0.2.1-rc.2"}, "v0.2.1-rc.3"},
		// The final version sorts above its own candidates, not below.
		{[]string{"v0.3.0-rc.9", "v0.3.0", "v0.3.0-rc.10"}, "v0.3.1-rc.1"},
		// Numeric, not lexical: rc.10 is above rc.9 and minor 10 above minor 9.
		{[]string{"v0.9.0", "v0.10.0-rc.9", "v0.10.0-rc.10"}, "v0.10.0-rc.11"},
		{[]string{"v1.0.0", "latest", "v2", ""}, "v1.0.1-rc.1"},
	}
	for _, c := range cases {
		got, err := nextTag(c.tags)
		if err != nil || got != c.want {
			t.Errorf("nextTag(%q) = %q, %v; want %q", c.tags, got, err, c.want)
		}
	}
}

func TestNextTagWithoutAnyVersionIsAnError(t *testing.T) {
	if _, err := nextTag([]string{"latest", ""}); err == nil {
		t.Error("no version tag produced a tag instead of an error")
	}
}
