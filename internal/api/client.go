// Package api talks to a Kaneo server.
//
// The client is hand-written rather than generated because the server's
// responses are not uniformly shaped: some operations return a bare array,
// others wrap the payload in a "data" key, and the task listing nests tasks
// inside columns. Absorbing that in generated code costs more than it saves.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// DefaultTimeout bounds a single request.
const DefaultTimeout = 10 * time.Second

// Client is a Kaneo API client.
type Client struct {
	BaseURL string // always ends in /api
	APIKey  string
	HTTP    *http.Client
}

// NormalizeBaseURL turns whatever the user configured into an API root.
//
// The site root serves the web app and answers 200 with HTML for *any* path,
// so a request that misses /api looks successful and returns markup. Appending
// it here means no call site can make that mistake.
func NormalizeBaseURL(raw string) string {
	s := strings.TrimRight(strings.TrimSpace(raw), "/")
	if s == "" {
		return ""
	}
	if strings.HasSuffix(s, "/api") {
		return s
	}
	return s + "/api"
}

// New builds a client. A zero timeout means DefaultTimeout.
func New(baseURL, apiKey string, timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	return &Client{
		BaseURL: NormalizeBaseURL(baseURL),
		APIKey:  apiKey,
		HTTP: &http.Client{
			Timeout:       timeout,
			CheckRedirect: dropCredentialOnDowngrade,
		},
	}
}

// dropCredentialOnDowngrade removes the API key from a redirected request that
// is no longer protected by TLS.
//
// Go strips sensitive headers when a redirect changes hostname, but not when
// it only changes scheme, so an https endpoint redirecting to http on the same
// host would put the key on the wire in the clear. Verified rather than
// assumed: a redirect between two URLs sharing a hostname forwards
// Authorization, and one that changes the hostname does not.
func dropCredentialOnDowngrade(req *http.Request, via []*http.Request) error {
	if len(via) >= 10 {
		return errors.New("stopped after 10 redirects")
	}
	if !isSecure(req.URL) {
		req.Header.Del("Authorization")
	}
	return nil
}

// isSecure reports whether a URL protects what is sent over it. Loopback is
// treated as secure: a self-hosted instance on localhost has no network to
// expose the key to, and requiring TLS there would make local use impossible.
func isSecure(u *url.URL) bool {
	if u.Scheme == "https" {
		return true
	}
	return isLoopback(u.Hostname())
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

// ErrInsecureCredential is returned rather than sending a key in the clear.
var ErrInsecureCredential = errors.New(
	"refusing to send the API key over plain HTTP; use https, or a loopback address for a local instance")

// Error is a failed API call.
type Error struct {
	StatusCode int
	Method     string
	Path       string
	Messages   []string
	Body       string
}

func (e *Error) Error() string {
	if len(e.Messages) > 0 {
		return fmt.Sprintf("%s %s: %d: %s", e.Method, e.Path, e.StatusCode, strings.Join(e.Messages, "; "))
	}
	body := e.Body
	if len(body) > 200 {
		body = body[:200] + "..."
	}
	if body == "" {
		return fmt.Sprintf("%s %s: %d", e.Method, e.Path, e.StatusCode)
	}
	return fmt.Sprintf("%s %s: %d: %s", e.Method, e.Path, e.StatusCode, body)
}

// Unauthorized reports whether the call failed because the key was rejected.
func (e *Error) Unauthorized() bool {
	return e.StatusCode == http.StatusUnauthorized || e.StatusCode == http.StatusForbidden
}

// errorEnvelope is the server's failure shape.
//
// Error is held as raw JSON because the shape it arrives in is the server's
// choice, not this client's. Declaring it as an array means a failure reported
// any other way fails to decode, and the server's message is lost behind a
// complaint about types.
type errorEnvelope struct {
	Success *bool           `json:"success"`
	Error   json.RawMessage `json:"error"`
}

// messages pulls whatever human-readable text the envelope carries, whichever
// shape it came in.
func (e errorEnvelope) messages() []string {
	if len(e.Error) == 0 {
		return nil
	}

	var list []struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(e.Error, &list); err == nil {
		out := make([]string, 0, len(list))
		for _, item := range list {
			if item.Message != "" {
				out = append(out, item.Message)
			}
		}
		return out
	}

	var single struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(e.Error, &single); err == nil && single.Message != "" {
		return []string{single.Message}
	}

	var text string
	if err := json.Unmarshal(e.Error, &text); err == nil && text != "" {
		return []string{text}
	}
	return nil
}

// Do issues a request and decodes the body into out, which may be nil.
func (c *Client) Do(ctx context.Context, method, path string, query url.Values, body, out any) error {
	if c.BaseURL == "" {
		return fmt.Errorf("no API URL configured")
	}

	endpoint := c.BaseURL + path
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}

	if c.APIKey != "" {
		parsed, err := url.Parse(endpoint)
		if err != nil {
			return fmt.Errorf("%s %s: %w", method, path, err)
		}
		if !isSecure(parsed) {
			return fmt.Errorf("%s: %w", parsed.Scheme+"://"+parsed.Host, ErrInsecureCredential)
		}
	}

	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(b)
	}

	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return err
	}
	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("%s %s: read body: %w", method, path, err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return newAPIError(method, path, resp.StatusCode, raw)
	}

	// A 2xx carrying success:false is still a failure. The server reports
	// validation problems this way, so status alone is not enough.
	if env, ok := decodeErrorEnvelope(raw); ok {
		return newAPIErrorFromEnvelope(method, path, resp.StatusCode, raw, env)
	}

	if out == nil {
		return nil
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("%s %s: decode response: %w", method, path, err)
	}
	return nil
}

func decodeErrorEnvelope(raw []byte) (errorEnvelope, bool) {
	var env errorEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return env, false
	}
	if env.Success != nil && !*env.Success {
		return env, true
	}
	return env, false
}

func newAPIError(method, path string, status int, raw []byte) *Error {
	if env, ok := decodeErrorEnvelope(raw); ok {
		return newAPIErrorFromEnvelope(method, path, status, raw, env)
	}
	return &Error{StatusCode: status, Method: method, Path: path, Body: strings.TrimSpace(string(raw))}
}

func newAPIErrorFromEnvelope(method, path string, status int, raw []byte, env errorEnvelope) *Error {
	msgs := env.messages()
	return &Error{
		StatusCode: status,
		Method:     method,
		Path:       path,
		Messages:   msgs,
		Body:       strings.TrimSpace(string(raw)),
	}
}
