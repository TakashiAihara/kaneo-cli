BINARY := kaneo
PKG    := ./cmd/kaneo
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

# The Kaneo release whose OpenAPI document the API client is generated from.
KANEO_VERSION := 2.29.2

.PHONY: build test vet fmt check clean cross snapshot spec generate

build:
	go build -ldflags '$(LDFLAGS)' -o $(BINARY) $(PKG)

test:
	go test ./...

vet:
	go vet ./...

fmt:
	gofmt -l -w .

check: vet test

# The remote hosts are aarch64 and carry no Go toolchain, so every release has
# to ship a linux/arm64 binary built here. CGO is off so the result is static.
cross:
	@mkdir -p dist
	@for target in linux/amd64 linux/arm64 darwin/arm64 darwin/amd64; do \
		os=$${target%/*}; arch=$${target#*/}; \
		echo "building $$os/$$arch"; \
		CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch \
			go build -ldflags '$(LDFLAGS)' -o dist/$(BINARY)-$$os-$$arch $(PKG) || exit 1; \
	done
	@ls -la dist

# Build every release archive locally, exactly as the release job would.
snapshot:
	goreleaser release --snapshot --clean --skip=publish

spec:
	curl -fsSL https://raw.githubusercontent.com/usekaneo/kaneo/v$(KANEO_VERSION)/apps/docs/openapi.json -o internal/api/gen/openapi.json
	go generate ./internal/api/gen/
	git diff --stat -- internal/api/gen/

generate:
	go generate ./internal/api/gen/

clean:
	rm -rf dist $(BINARY)
