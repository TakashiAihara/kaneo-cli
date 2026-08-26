package cli

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/TakashiAihara/kaneo-cli/internal/api"
)

// resolveTask turns a user-supplied reference into a task.
//
// A reference is either a task id or a number, with or without a leading '#'.
// Numbers are what a person reads off the board, so they have to work wherever
// an id does.
func resolveTask(ctx context.Context, client *api.Client, projectID, ref string) (*api.Task, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return nil, fmt.Errorf("no task given")
	}

	if number, err := strconv.Atoi(strings.TrimPrefix(ref, "#")); err == nil {
		if projectID == "" {
			return nil, fmt.Errorf("task #%d needs a project: pass --project or set KANEO_PROJECT", number)
		}
		board, err := client.GetBoard(ctx, projectID)
		if err != nil {
			return nil, err
		}
		for _, t := range board.Tasks() {
			if t.Number == number {
				task := t
				return &task, nil
			}
		}
		return nil, fmt.Errorf("no task #%d in this project", number)
	}

	return client.GetTask(ctx, ref)
}
