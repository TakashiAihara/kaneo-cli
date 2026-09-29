// Package api talks to a Kaneo server.
//
// Requests and response types come from the client generated out of the
// server's OpenAPI document (package gen), so a request that drifts from what
// the server expects fails to compile instead of failing at the server. This
// package keeps what the document cannot say: where the key may be sent, how a
// failure is reported, and the CLI's own view of workspaces, projects and
// tasks.
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

	"github.com/TakashiAihara/kaneo-cli/internal/api/gen"
	"github.com/doordash-oss/oapi-codegen-dd/v3/pkg/runtime"
)

// DefaultTimeout bounds a single request.
const DefaultTimeout = 10 * time.Second

// Client is a Kaneo API client.
type Client struct {
	BaseURL string // always ends in /api
	APIKey  string
	HTTP    *http.Client

	gen *gen.Client
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
	c := &Client{
		BaseURL: NormalizeBaseURL(baseURL),
		APIKey:  apiKey,
		HTTP: &http.Client{
			Timeout:       timeout,
			CheckRedirect: dropCredentialOnDowngrade,
		},
	}
	// NewAPIClient only fails on an option error, and the one option passed
	// here cannot fail.
	apiClient, _ := runtime.NewAPIClient(c.BaseURL, runtime.WithHTTPClient(doer{c}))
	c.gen = gen.NewClient(apiClient)
	return c
}

// doer is the transport under the generated client. Every generated call goes
// through send, so the key is checked, attached and reported on the same way
// as a hand-built request.
type doer struct{ c *Client }

func (d doer) Do(_ context.Context, req *http.Request) (*http.Response, error) {
	resp, raw, err := d.c.send(req)
	if err != nil {
		return nil, &sendError{err}
	}
	// The generated parsers accept only the 200 the document declares, and
	// send has already judged the call a success. A 201 or 204 would otherwise
	// report a write that happened as a failure, inviting a retry that
	// duplicates it.
	resp.StatusCode, resp.Status = http.StatusOK, "200 OK"
	resp.Body = io.NopCloser(bytes.NewReader(raw))
	return resp, nil
}

// sendError marks an error that send produced, so unwrap can hand it back
// without the generated client's "error executing request:" prefixes.
type sendError struct{ err error }

func (e *sendError) Error() string { return e.err.Error() }
func (e *sendError) Unwrap() error { return e.err }

// unwrap returns the error send reported, if that is what failed, so callers
// see *Error and ErrInsecureCredential exactly as a direct call returns them.
func unwrap(err error) error {
	var se *sendError
	if errors.As(err, &se) {
		return se.err
	}
	return err
}

// esc escapes a path parameter. The generated client substitutes values into
// the path as they are, so an id holding "/" or "?" would change the route.
func esc(s string) string { return url.PathEscape(s) }

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

// Do issues a request the generated client does not cover and decodes the body
// into out, which may be nil. Only the OpenAPI document itself is fetched this
// way.
func (c *Client) Do(ctx context.Context, method, path string, query url.Values, body, out any) error {
	if c.BaseURL == "" {
		return fmt.Errorf("no API URL configured")
	}

	endpoint := c.BaseURL + path
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
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
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	_, raw, err := c.send(req)
	if err != nil {
		return err
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

// send attaches the key, performs req and returns the body. A non-2xx status
// and a 2xx carrying success:false both come back as *Error; the server
// reports validation problems the second way, so status alone is not enough.
// The response's body is consumed; the bytes are returned instead.
//
// Errors name the request by its full path, /api included, so the path in a
// message can be pasted into curl as it is.
func (c *Client) send(req *http.Request) (*http.Response, []byte, error) {
	method, path := req.Method, req.URL.Path

	if c.APIKey != "" {
		if !isSecure(req.URL) {
			return nil, nil, fmt.Errorf("%s: %w", req.URL.Scheme+"://"+req.URL.Host, ErrInsecureCredential)
		}
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, nil, fmt.Errorf("%s %s: read body: %w", method, path, err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, nil, newAPIError(method, path, resp.StatusCode, raw)
	}
	if env, ok := decodeErrorEnvelope(raw); ok {
		return nil, nil, newAPIErrorFromEnvelope(method, path, resp.StatusCode, raw, env)
	}
	return resp, raw, nil
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
