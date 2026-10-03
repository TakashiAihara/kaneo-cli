package api

import (
	"context"
	"net/http"
	"sort"
)

// CheckResult is the comparison between this client and a server.
type CheckResult struct {
	ServerOperations int         `json:"serverOperations"`
	ClientOperations int         `json:"clientOperations"`
	Covered          []Operation `json:"covered"`
	// Missing is what this client calls but the server does not offer. Each
	// entry is a command that will fail against this server.
	Missing []Operation `json:"missing"`
	// NewOnServer is what the server offers and this client does not use yet.
	NewOnServer []string `json:"newOnServer"`
}

// OK reports whether every operation this client uses exists on the server.
func (r CheckResult) OK() bool { return len(r.Missing) == 0 }

type openAPIDocument struct {
	Paths map[string]map[string]struct {
		OperationID string `json:"operationId"`
	} `json:"paths"`
}

// FetchOperationIDs reads the server's OpenAPI document.
//
// The document is served without authentication, so this works before any key
// is configured. It is fetched through the normal client so that it lands
// under /api like every other call: the site root answers 200 with the web
// app's HTML for any path, and parsing that as JSON would fail confusingly.
func (c *Client) FetchOperationIDs(ctx context.Context) ([]string, error) {
	var doc openAPIDocument
	if err := c.Do(ctx, http.MethodGet, "/openapi", nil, nil, &doc); err != nil {
		return nil, err
	}

	seen := map[string]bool{}
	var ids []string
	for _, methods := range doc.Paths {
		for _, op := range methods {
			if op.OperationID == "" || seen[op.OperationID] {
				continue
			}
			seen[op.OperationID] = true
			ids = append(ids, op.OperationID)
		}
	}
	sort.Strings(ids)
	return ids, nil
}

// Check compares the registry against the server.
func (c *Client) Check(ctx context.Context) (*CheckResult, error) {
	ids, err := c.FetchOperationIDs(ctx)
	if err != nil {
		return nil, err
	}
	return compare(Operations, ids), nil
}

func compare(client []Operation, serverIDs []string) *CheckResult {
	onServer := make(map[string]bool, len(serverIDs))
	for _, id := range serverIDs {
		onServer[id] = true
	}

	result := &CheckResult{
		ServerOperations: len(serverIDs),
		ClientOperations: len(client),
		Covered:          []Operation{},
		Missing:          []Operation{},
		NewOnServer:      []string{},
	}

	used := map[string]bool{}
	for _, op := range client {
		used[op.ID] = true
		if onServer[op.ID] {
			result.Covered = append(result.Covered, op)
		} else {
			result.Missing = append(result.Missing, op)
		}
	}
	for _, id := range serverIDs {
		if !used[id] {
			result.NewOnServer = append(result.NewOnServer, id)
		}
	}
	return result
}
