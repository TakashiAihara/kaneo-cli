package cli

import (
	"errors"
	"testing"

	"github.com/spf13/cobra"
)

func TestFailOpenSwallowsOrdinaryFailures(t *testing.T) {
	strict := false
	run := failOpen(&App{}, &strict, func(*cobra.Command, []string) error {
		return errors.New("server unreachable")
	})
	if err := run(nil, nil); err != nil {
		t.Errorf("err = %v, want nil; a hook must not be broken by an unreachable server", err)
	}
}

// Fail-open exists so an unreachable server cannot break a session. It is not
// a licence to hide a failure that already changed something elsewhere.
func TestFailOpenSurfacesHardFailures(t *testing.T) {
	strict := false
	run := failOpen(&App{}, &strict, func(*cobra.Command, []string) error {
		return hard("wrote the comment but could not record it: %w", errors.New("disk full"))
	})
	err := run(nil, nil)
	if err == nil {
		t.Fatal("a hard failure was swallowed")
	}
	if !errors.Is(err, err) || err.Error() == "" {
		t.Errorf("unexpected error value: %v", err)
	}
}

func TestFailOpenUnwrapsToTheCause(t *testing.T) {
	cause := errors.New("disk full")
	strict := false
	run := failOpen(&App{}, &strict, func(*cobra.Command, []string) error {
		return hard("could not record it: %w", cause)
	})
	if err := run(nil, nil); !errors.Is(err, cause) {
		t.Errorf("errors.Is could not reach the cause through the wrapper: %v", err)
	}
}

func TestStrictSurfacesEverything(t *testing.T) {
	strict := true
	run := failOpen(&App{}, &strict, func(*cobra.Command, []string) error {
		return errors.New("server unreachable")
	})
	if err := run(nil, nil); err == nil {
		t.Error("--strict swallowed a failure")
	}
}
