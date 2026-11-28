# Advanced install

The quickest path is in the [README](../README.md#install): install the extension from the Extensions view, then let the sidebar's onboarding install the `grok` CLI and sign you in. This file covers the manual, build-from-source, and multi-IDE paths.

For the **standalone desktop app, AFK Pilot** (installers, code-signing and SmartScreen notes, packaging commands), see **[desktop.md](desktop.md)**.

## Install the CLI yourself (optional)

The extension's onboarding installs the CLI and signs you in for you — but if you'd rather use the terminal:

macOS / Linux / WSL:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok login
```

Windows (PowerShell):

```powershell
irm https://x.ai/cli/install.ps1 | iex
grok login
```

`grok login` opens a browser and completes OAuth in one step. Prefer an API key? Get one at [console.x.ai](https://console.x.ai) and set `XAI_API_KEY` in your shell or a workspace `.env` (the extension auto-loads it).

## Install the extension from the command line

```bash
code --install-extension PawelHuryn.grok-vscode-phuryn
```

## Build from source

```bash
git clone https://github.com/phuryn/grok-build-vscode.git
cd grok-build-vscode
npm install
./scripts/install.sh        # Windows: pwsh scripts\install.ps1
```

The install script auto-detects your IDE's CLI (`code` → `code-insiders` → `cursor` → Antigravity's `antigravity-ide`/`antigravity`). To target a specific code-compatible IDE, pass its CLI name or path — `./scripts/install.sh cursor` (Windows: `pwsh scripts\install.ps1 -Cli cursor`) — or set `CODE_CLI=…`. To install into **every** detected IDE in one run, pass `--all` (Windows: `-All`).

## Uninstall

Remove it from the Extensions view, or:

```bash
./scripts/uninstall.sh [cli]          # Windows: pwsh scripts\uninstall.ps1 [-Cli name]
code --uninstall-extension PawelHuryn.grok-vscode-phuryn
```

The uninstall scripts take the same optional CLI argument as install.
