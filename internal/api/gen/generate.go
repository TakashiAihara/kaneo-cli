// Package gen is the Kaneo API client generated from the server's OpenAPI
// document. openapi.json is the document shipped in the Kaneo release named in
// the Makefile's KANEO_VERSION; refresh it with `make spec` and regenerate with
// `go generate ./...`.
package gen

//go:generate go tool oapi-codegen --config cfg.yaml openapi.json
