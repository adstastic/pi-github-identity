# Changelog

## 0.1.0

- Add Pi extension that isolates GitHub CLI auth through bot `GH_CONFIG_DIR`.
- Add `/gh-bot-status` command.
- Add `/gh-bot-auth` browser OAuth flow with visible device code and bot-account warning.
- Add `PI_GH_BOT_EXPECTED_LOGIN` fail-closed account enforcement.
- Clear auth widget after auth failure/cancel and hard-kill stuck `gh auth` after timeout grace.
- Add unit tests for env stripping, auth parsing, expected-login mismatch, and widget cleanup.
