# Pi GitHub Bot Extension

Run selected GitHub CLI actions from Pi through a separate bot identity, without taking over your normal `gh` or Git workflow.

## Philosophy

This package is for visible GitHub actions where attribution matters: issue comments, PR comments, review replies, bot-to-human dialogue, and future async workflows.

By default it does **not** force all Pi shell commands to use the bot. Your normal `bash`/`gh`/`git` usage can stay as you. The extension adds an explicit `gh_bot` tool that the agent should use when a GitHub action should appear from the bot account.

## What it does

- Keeps bot GitHub CLI auth in a separate config dir:
  - default: `~/.config/gh-bot`
  - override: `PI_GH_BOT_CONFIG_DIR=/path/to/config`
- Adds `gh_bot` tool for running `gh` with bot `GH_CONFIG_DIR`.
- Adds automatic prompt guidance so Pi uses `gh_bot` for visible GitHub dialogue actions.
- Adds a bash guard that blocks common `gh` comment/review commands and tells Pi to retry with `gh_bot`.
- Removes token env vars from `gh_bot` calls so `GH_CONFIG_DIR` auth wins:
  - `GH_TOKEN`
  - `GITHUB_TOKEN`
  - `GH_ENTERPRISE_TOKEN`
  - `GITHUB_ENTERPRISE_TOKEN`
- Supports `PI_GH_BOT_EXPECTED_LOGIN=bot-login` fail-closed identity enforcement.
- Shows Pi footer status for the bot account:
  - `gh: <login>` when bot auth is ready
  - `gh: auth-missing` when bot auth is missing
  - `gh: wrong-account` when authenticated account does not match `PI_GH_BOT_EXPECTED_LOGIN`

## Tool

### `gh_bot`

Runs GitHub CLI as the bot identity. Args are `gh` args without the leading `gh`.

Use cases:

- Create issue comments as bot.
- Reply to PR review comments as bot.
- Leave PR review comments as bot.
- Run visible GitHub actions where attribution should be bot, not you.

Examples of underlying commands the tool can run:

```bash
gh issue comment 123 --body "..."
gh pr comment 456 --body "..."
gh api repos/OWNER/REPO/pulls/PR/comments -f body="..." ...
```

Normal shell `gh` remains your existing identity unless you choose otherwise.

## Automatic routing

On install, the extension changes Pi behavior in three ways:

1. **Tool guidance**: `gh_bot` advertises itself as the right tool for issue comments, PR comments, review comments, and review replies.
2. **Per-turn prompt note**: every user turn gets a short routing rule: use `gh_bot` for visible GitHub dialogue; use normal tools for read-only lookups, local Git, commits, pushes, and ordinary coding.
3. **Bash guard**: if the model tries common visible write commands through `bash`, the extension blocks the call and tells the model to retry with `gh_bot`.

Guarded bash patterns include:

```bash
gh issue comment ...
gh pr comment ...
gh pr review ...
gh api .../comments ...
gh api .../reviews ...
```

This keeps synchronous coding ergonomic: commits, pushes, branch work, read-only `gh`, and shell usage stay as your normal identity. Bot identity is reserved for places where GitHub attribution helps readers distinguish bot dialogue from human dialogue.

If you explicitly want to comment/review as yourself, either ask Pi to use normal `gh` as you or disable the guard:

```bash
PI_GH_BOT_AUTO_GUARD=0 pi
```

## Commands

### `/gh-bot-status`

Shows bot GitHub login and `GH_CONFIG_DIR`. If bot auth is missing, offers to start browser auth.

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

Check bot status:

```text
/gh-bot-status
```

Ask Pi to comment as bot, for example:

```text
Reply to PR comment 123456 as the bot: "Fixed in latest patch."
```

The extension injects tool guidance and a per-turn routing note so Pi uses `gh_bot` for visible GitHub comments/replies.

## Configuration

Custom bot config dir:

```bash
PI_GH_BOT_CONFIG_DIR=/path/to/gh-bot pi
```

Expected bot login:

```bash
PI_GH_BOT_EXPECTED_LOGIN=my-bot pi
```

When `PI_GH_BOT_EXPECTED_LOGIN` is set, `gh_bot` refuses mismatched browser auth and reports `gh: wrong-account`.

Disable automatic bash guard:

```bash
PI_GH_BOT_AUTO_GUARD=0 pi
```

The guard only targets common visible GitHub write commands, such as `gh issue comment`, `gh pr comment`, `gh pr review`, and comment/review API calls. Normal read-only `gh`, shell commands, and Git commands are not blocked.

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
- Normal Pi shell `gh` and `git` remain your existing identity.
- Only the `gh_bot` tool and `/gh-bot-auth` use bot `GH_CONFIG_DIR`.
- Bot auth missing becomes explicit `gh: auth-missing`.
- Expected login mismatch becomes explicit `gh: wrong-account` and fails closed.
- Repository access still depends on the bot account permissions. If the bot is not a collaborator/member, it cannot comment in private repos.
- Set `PI_GH_BOT_AUTO_GUARD=0` if you intentionally want bash `gh` comments/reviews to use your personal identity.

## Development

```bash
npm install
npm test
npm run check
npm run pack:dry-run
```

## Publish checklist

```bash
npm login
npm publish --access public
```

Pi package discovery uses the `pi-package` keyword and `pi.extensions` manifest in `package.json`.
