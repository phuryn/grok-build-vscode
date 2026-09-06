# Documentation

Product documentation lives here. System-level engineering documentation — the
architecture across the extension and its relay, the remote-control wire
protocol, authentication, the cross-repo test matrix and how releases ship —
lives in the companion **[afkpilot](https://github.com/phuryn/afkpilot)**
repository; start with its
[docs index](https://github.com/phuryn/afkpilot/tree/main/docs).

## Using it

- [Install](INSTALL.md) — manual, build-from-source and multi-IDE paths.
- [Grok Build Desktop](desktop.md) — the standalone app: download, install warnings, packaging.
- [Slash commands](SLASH-COMMANDS.md) — what the running CLI exposes and how commands dispatch.
- [Projects](projects.md) — the three ways to add one, where new folders go, and cloning from GitHub.
- [Tips on the empty screen](empty-state-tips.md) — what the welcome screen suggests, and the rules it follows.
- [Signing agents in](provider-login.md) — how Grok, Codex and Claude authenticate, including the headless paths for a machine you only reach remotely.
- [Running in a cloud environment](cloud-environments.md) — what the host does differently when the machine is one we run: waking for routines, hidden connectors, and what stays exactly the same.
- [Voice setup](voice-setup.md) — dictation, transcription and the hands-free send phrase.
- [Privacy](privacy.md) — what leaves your machine, and what never does.
- [Attribution](attribution.md) — licence and third-party notices.
- [Changelog archive](CHANGELOG-ARCHIVE.md) — releases before 2.0.0.

## Working on it

- [Development](development.md) — build, test and repo conventions for this repository.
- [Architecture](architecture.md) — how the VS Code and desktop clients are put together.
- [Google Antigravity & Gemini integration](ANTIGRAVITY_INTEGRATION_COMPLETE_DOCUMENTATION.md) — complete bridge architecture, models, session lifecycle, and quota analysis.
- [Desktop update spec](desktop-update-spec.md) — the current-state update and feed contract.

## Maintainer and upstream notes

`internal/` documents our relationship with the grok CLI and the release
machinery rather than the product. Public, but not written for users.

- [ACP feedback](internal/ACP-feedback.md) — open CLI/ACP friction, sent upstream.
- [ACP feedback archive](internal/ACP-feedback-through-0.2.112.md) — the 0.2.x record.
- [ACP next steps](internal/ACP-next-steps.md) — what re-verification unlocks.
- [macOS code signing](internal/macos-code-signing.md) — certificate and notarisation wiring.
