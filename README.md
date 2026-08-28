# kaneo-cli

Command-line interface for [Kaneo](https://github.com/usekaneo/kaneo), the open source project management tool.

Works against any Kaneo instance (self-hosted or cloud) using an API key.

## Status

Early development. Currently implemented:

- `kaneo whoami` — verify authentication against an instance
- Global flags: `--url`, `--token`, `--profile`, `--json`

Planned: `task`, `project`, `workspace`, `comment`, `search`, `label`, `time-entry` commands and device-authorization login. See `docs/design/0001-cli-architecture.md`.

## Requirements

- [Bun](https://bun.sh) >= 1.1

## Install

```bash
git clone https://github.com/TakashiAihara/kaneo-cli
cd kaneo-cli
bun install
bun run install-bin   # symlinks ~/.local/bin/kaneo
```

## Configuration

Create an API key in Kaneo: account settings → Account tab → API Keys.

Three ways to point the CLI at your instance, most specific wins:

1. Flags: `kaneo --url https://kaneo.example.com --token <key> whoami`
2. Environment: `KANEO_URL`, `KANEO_TOKEN` (and `KANEO_PROFILE`)
3. Config file `~/.config/kaneo/config.json`:

```json
{
  "defaultProfile": "home",
  "profiles": {
    "home": { "url": "https://kaneo.example.com", "token": "your-api-key" },
    "work": { "url": "https://kaneo.work.example", "token": "another-key" }
  }
}
```

The URL may be given with or without the `/api` suffix.

## Output

Human-readable by default. `--json` prints the raw API response to stdout with nothing else mixed in (logs go to stderr), so it composes with `jq`.

Exit codes: `0` success, `1` configuration or API error, `2` usage error.

## Development

```bash
bun test            # test suite (mock server; no network)
bun run typecheck
bun run generate    # regenerate src/api/schema.d.ts from openapi.json
```

`openapi.json` is a committed snapshot of upstream `apps/docs/openapi.json`. To refresh it:

```bash
curl -sL https://raw.githubusercontent.com/usekaneo/kaneo/main/apps/docs/openapi.json -o openapi.json
bun run generate
```

Note: a self-hosted instance can run an older image than the committed spec. A 404 on a documented route usually means the instance lags upstream, not a CLI bug.
