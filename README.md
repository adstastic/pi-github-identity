# Pi GitHub Bot Extension

Run GitHub CLI commands from Pi through a separate bot identity while leaving your normal terminal `gh` login untouched.

## What it does

On load, the extension:

- Sets `GH_CONFIG_DIR` to `~/.config/gh-bot` by default.
- Supports `PI_GH_BOT_CONFIG_DIR=/path/to/config` override.
- Sets `GH_PROMPT_DISABLED=1` for non-auth `gh` calls.
- Removes token env vars that would bypass `GH_CONFIG_DIR`:
  - `GH_TOKEN`
  - `GITHUB_TOKEN`
  - `GH_ENTERPRISE_TOKEN`
  - `GITHUB_ENTERPRISE_TOKEN`
- Checks the active bot account with `gh api user --jq .login`.
- Shows Pi footer status:
  - `gh:<login>` when authenticated
  - `gh:auth-missing` when auth is missing

## Commands

### `/gh-bot-status`

Shows active GitHub login and `GH_CONFIG_DIR`. If auth is missing, offers to start browser auth.

### `/gh-bot-auth`

Starts GitHub CLI browser/device auth for the bot config dir:

```bash
gh auth login --hostname github.com --web --clipboard --git-protocol https --skip-ssh-key
```

Pi shows the one-time code and auth URL above the editor while `gh` waits for completion.

> Important: `GH_CONFIG_DIR` controls where the CLI token is stored. The browser still decides which GitHub account authorizes that token. Use the bot GitHub account. If GitHub opens as your personal account, switch accounts or use an incognito/private window logged in as the bot before entering the code.

## Install

From npm, after publish:

```bash
pi install npm:pi-gh-bot-extension
```

From GitHub:

```bash
pi install git:github.com/adstastic/pi-gh-bot-extension
```

From local checkout:

```bash
pi install /Users/adi/code/pi-gh-bot-extension
```

Development symlink:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s /Users/adi/code/pi-gh-bot-extension/src/index.ts ~/.pi/agent/extensions/github-bot-gh.ts
```

Restart Pi, or run:

```text
/reload
```

## Usage

Authenticate bot:

```text
/gh-bot-auth
```

Check status:

```text
/gh-bot-status
```

Verify `gh` inside Pi uses bot:

```bash
gh api user --jq .login
```

Verify normal terminal still uses your account:

```bash
unset GH_CONFIG_DIR
gh api user --jq .login
```

## Custom bot config dir

```bash
PI_GH_BOT_CONFIG_DIR=/path/to/gh-bot pi
```

## Manual auth equivalent

```bash
mkdir -p ~/.config/gh-bot
env \
  -u GH_TOKEN \
  -u GITHUB_TOKEN \
  -u GH_ENTERPRISE_TOKEN \
  -u GITHUB_ENTERPRISE_TOKEN \
  -u GH_PROMPT_DISABLED \
  GH_CONFIG_DIR="$HOME/.config/gh-bot" \
  gh auth login --hostname github.com --web --clipboard --git-protocol https --skip-ssh-key

env \
  -u GH_TOKEN \
  -u GITHUB_TOKEN \
  -u GH_ENTERPRISE_TOKEN \
  -u GITHUB_ENTERPRISE_TOKEN \
  GH_CONFIG_DIR="$HOME/.config/gh-bot" \
  gh api user --jq .login
```

## Safety notes

- Normal terminal `gh` config is unchanged.
- Pi process and Pi child tool calls inherit bot `GH_CONFIG_DIR`.
- Bot auth missing becomes explicit `gh:auth-missing`; extension does not silently fall back to user `gh` config.
- Commands that explicitly set `GH_TOKEN=... gh ...` can still override this. Future guard can block or rewrite those commands.

## Development

```bash
npm install
npm run check
npm run pack:dry-run
```

## Publish checklist

```bash
npm login
npm publish --access public
```

Pi package discovery uses the `pi-package` keyword and `pi.extensions` manifest in `package.json`.
