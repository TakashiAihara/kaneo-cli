BINARY := kaneo
PKG    := ./cmd/kaneo
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: build test vet fmt check clean cross

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

clean:
	rm -rf dist $(BINARY)
