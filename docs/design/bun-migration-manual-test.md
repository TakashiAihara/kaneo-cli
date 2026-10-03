# Manual check against a real Kaneo

The parity suite runs against a fake that follows the v2.29.2 document. This check runs the built binary against a real server, which may be older or newer than the document. Everything below is copy-paste once `KANEO_API_KEY` (a key for a user in the test workspace) and `KANEO_WORKSPACE` (the workspace id to test in) are exported.

## Setup

```bash
export KANEO_API_URL=https://kaneo.example.com
bun scripts/build.ts dev && tar -xzf "dist/kaneo_$(uname -s | tr A-Z a-z)_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" -C /tmp kaneo
K=/tmp/kaneo
```

## Read only

Run each and compare with the Go build (`kaneo` from the last Go release) given the same arguments. The output should be identical.

```bash
$K whoami
$K workspace ls
$K project ls
$K project ls --archived
$K api-check
KANEO_DEBUG=1 $K project ls --json > /dev/null
```

The last line prints every place the server's response differs from the document. Record what it prints: it is the list of fields an older server omits.

## Writes, in a project made for the check

`session attach` and `session close` run the hooks in your `~/.config/kaneo/config.json`. Point `XDG_CONFIG_HOME` at an empty directory for these steps if those hooks write somewhere you do not want a test session to appear.

```bash
P=$($K project create "cli check $(date +%Y%m%d%H%M)" --slug CHK --json | jq -r .id)
export KANEO_PROJECT=$P
$K task create "first" -d "body" --priority high
$K task create "second"
$K task ls
$K task status 1 in-progress
$K task priority 1 low
$K task link 1 2
$K task links 1
$K comment add 1 "hello"
$K comment ls 1
KANEO_SESSION_ID=manual-check $K session attach 1 "checking" --strict
$K board
KANEO_SESSION_ID=manual-check $K session close --strict
$K task rm 2 --yes
$K project archive "$P"
```

Expected: every command exits 0, `task ls` shows `#1` and `#2`, `board` lists the project with task 1 and the session's next step, and the project ends archived.
