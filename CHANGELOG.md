# Changelog

## 0.1.0

- Add explicit `gh_bot` tool for GitHub issue/PR comments, review replies, and other visible GitHub actions that should come from the bot account.
- Add automatic prompt guidance and bash guard to route visible GitHub comment/review commands through `gh_bot`.
- Keep normal Pi shell `gh`/`git` behavior as the user's existing identity; bot auth is used only by `gh_bot` and auth/status commands.
- Add `/gh-bot-status` command.
- Add `/gh-bot-auth` browser OAuth flow with visible device code and bot-account warning.
- Add `PI_GH_BOT_EXPECTED_LOGIN` fail-closed account enforcement.
- Clear auth widget after auth failure/cancel and hard-kill stuck `gh auth` after timeout grace.
- Add unit tests for env stripping, auth parsing, expected-login mismatch, and widget cleanup.
