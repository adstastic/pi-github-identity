# Pi GitHub Bot Extension Plan

## Goal

Make Pi use a separate GitHub CLI identity for agent-driven GitHub actions, while leaving the user's normal terminal `gh` authentication unchanged.

## Package layout

```text
pi-gh-bot-extension/
  package.json
  README.md
  PLAN.md
  src/
    index.ts
```

## Package metadata

`package.json` should define a Pi extension package:

```json
{
  "name": "pi-gh-bot-extension",
  "type": "module",
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

## Extension behavior

`src/index.ts` should:

1. Apply GitHub bot CLI environment on extension load:
   - `GH_CONFIG_DIR=<bot config dir>`
   - `GH_PROMPT_DISABLED=1`
2. Remove token variables that would override `GH_CONFIG_DIR` auth:
   - `GH_TOKEN`
   - `GITHUB_TOKEN`
   - `GH_ENTERPRISE_TOKEN`
   - `GITHUB_ENTERPRISE_TOKEN`
3. Use default bot config dir:
   - `~/.config/gh-bot`
4. Support override:
   - `PI_GH_BOT_CONFIG_DIR=/path/to/config`
5. Verify active account by running:
   - `gh api user --jq .login`
6. Show Pi UI status:
   - `gh:<login>` when authenticated
   - `gh:auth-missing` when not authenticated
7. Register command:
   - `/gh-bot-status`
   - Shows active GitHub login and `GH_CONFIG_DIR`.

## Install flow

Authenticate bot account separately:

```bash
mkdir -p ~/.config/gh-bot
env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR=~/.config/gh-bot gh auth login -h github.com
env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR=~/.config/gh-bot gh api user --jq .login
```

Install extension into Pi, either as package:

```bash
pi install git:file:///Users/adi/code/pi-gh-bot-extension
```

Or during development, symlink extension directly:

```bash
ln -s /Users/adi/code/pi-gh-bot-extension/src/index.ts ~/.pi/agent/extensions/github-bot-gh.ts
```

Then restart Pi or run:

```text
/reload
```

Verify inside Pi:

```text
/gh-bot-status
```

Or ask Pi to run:

```bash
gh api user --jq .login
```

## Safety properties

- Normal terminal `gh` remains user's account.
- Pi process and Pi child tool calls see bot `GH_CONFIG_DIR`.
- GitHub comments/replies made by Pi through `gh` come from bot account.
- If bot auth is missing, extension warns instead of silently relying on user's global `gh` config.
- Explicit per-command `GH_TOKEN=... gh ...` can still override this; optional future guard can block or rewrite such bash commands.

## Future enhancements

- Add bash tool guard that warns/blocks when command sets `GH_TOKEN` or `GITHUB_TOKEN` for `gh`.
- Add command to re-check account and refresh status.
- Add config file support for expected bot login and fail closed if active login differs.
