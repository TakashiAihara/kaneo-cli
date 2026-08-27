#!/bin/sh
# Install the kaneo CLI.
#
#   curl -fsSL https://raw.githubusercontent.com/TakashiAihara/kaneo-cli/main/install.sh | sh
#
# Environment:
#   KANEO_VERSION       tag to install (default: the latest release)
#   KANEO_INSTALL_DIR   where to put the binary (default: $HOME/.local/bin)
#   KANEO_RELEASE_BASE  where to fetch archives from, for a mirror
set -eu

REPO=TakashiAihara/kaneo-cli
INSTALL_DIR=${KANEO_INSTALL_DIR:-$HOME/.local/bin}
RELEASE_BASE=${KANEO_RELEASE_BASE:-https://github.com/$REPO/releases/download}

die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

detect_os() {
    case $(uname -s) in
        Linux) echo linux ;;
        Darwin) echo darwin ;;
        *) die "unsupported OS: $(uname -s)" ;;
    esac
}

detect_arch() {
    case $(uname -m) in
        x86_64 | amd64) echo amd64 ;;
        aarch64 | arm64) echo arm64 ;;
        *) die "unsupported architecture: $(uname -m)" ;;
    esac
}

latest_version() {
    have curl || die "curl is required to look up the latest release"
    curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
        | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
        | head -n 1
}

download() {
    url=$1
    dest=$2
    if have curl; then
        curl -fsSL "$url" -o "$dest" || die "download failed: $url"
    elif have wget; then
        wget -qO "$dest" "$url" || die "download failed: $url"
    else
        die "neither curl nor wget is available"
    fi
}

verify_checksum() {
    archive=$1
    sums=$2
    name=$3

    expected=$(awk -v n="$name" '$2 == n { print $1 }' "$sums")
    [ -n "$expected" ] || die "$name is not listed in checksums.txt"

    if have sha256sum; then
        actual=$(sha256sum "$archive" | awk '{print $1}')
    elif have shasum; then
        actual=$(shasum -a 256 "$archive" | awk '{print $1}')
    else
        die "no sha256 tool available; refusing to install unverified"
    fi

    [ "$expected" = "$actual" ] || die "checksum mismatch for $name: expected $expected, got $actual"
}

main() {
    os=$(detect_os)
    arch=$(detect_arch)

    version=${KANEO_VERSION:-$(latest_version)}
    [ -n "$version" ] || die "could not determine the latest release; set KANEO_VERSION"

    name="kaneo_${os}_${arch}.tar.gz"
    tmp=$(mktemp -d)
    # shellcheck disable=SC2064
    trap "rm -rf '$tmp'" EXIT INT TERM

    printf 'downloading %s %s\n' "$name" "$version" >&2
    download "$RELEASE_BASE/$version/$name" "$tmp/$name"
    download "$RELEASE_BASE/$version/checksums.txt" "$tmp/checksums.txt"
    verify_checksum "$tmp/$name" "$tmp/checksums.txt" "$name"

    tar -xzf "$tmp/$name" -C "$tmp" || die "could not unpack $name"
    [ -f "$tmp/kaneo" ] || die "the archive did not contain a kaneo binary"

    mkdir -p "$INSTALL_DIR"
    install -m 0755 "$tmp/kaneo" "$INSTALL_DIR/kaneo" 2>/dev/null \
        || { cp "$tmp/kaneo" "$INSTALL_DIR/kaneo" && chmod 0755 "$INSTALL_DIR/kaneo"; } \
        || die "could not write to $INSTALL_DIR"

    # Run what was just installed. Reporting success without this is how an
    # install ends up claiming to have worked while placing nothing.
    "$INSTALL_DIR/kaneo" --version >/dev/null 2>&1 \
        || die "installed $INSTALL_DIR/kaneo but it does not run"

    printf 'installed %s to %s\n' "$("$INSTALL_DIR/kaneo" --version)" "$INSTALL_DIR/kaneo" >&2

    case ":$PATH:" in
        *":$INSTALL_DIR:"*) ;;
        *) printf '\n%s is not on your PATH. Add it:\n  export PATH="%s:$PATH"\n' "$INSTALL_DIR" "$INSTALL_DIR" >&2 ;;
    esac
}

main "$@"
