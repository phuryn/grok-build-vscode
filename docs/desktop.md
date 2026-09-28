# Grok Build Desktop

Standalone Electron host for the same Grok Build agent UI that the VS Code
extension uses. It speaks ACP over `grok agent stdio`, stores nothing private
beyond what the extension already does, and is published from this public repo.

Not affiliated with or endorsed by SpaceXAI (formerly xAI).

## Download (installers)

Installers are attached to [GitHub Releases](https://github.com/phuryn/grok-build-vscode/releases).
Asset names are stable so a landing page can link them by version:

| Platform | Architecture | File pattern |
|---|---|---|
| macOS | Apple Silicon (arm64) | `Grok-Build-Desktop-<version>-mac-arm64.dmg` |
| macOS | Intel (x64) | `Grok-Build-Desktop-<version>-mac-x64.dmg` |
| macOS | arm64 / x64 (archive) | `Grok-Build-Desktop-<version>-mac-arm64.zip` / `…-mac-x64.zip` |
| Windows | x64 | `Grok-Build-Desktop-<version>-win-x64.exe` |
| Linux | x86_64 (AppImage) | `Grok-Build-Desktop-<version>-linux-x86_64.AppImage` |

Example for version `3.1.0`:

- `Grok-Build-Desktop-3.1.0-mac-arm64.dmg`
- `Grok-Build-Desktop-3.1.0-mac-x64.dmg`
- `Grok-Build-Desktop-3.1.0-win-x64.exe`
- `Grok-Build-Desktop-3.1.0-linux-x86_64.AppImage`

**Note the Linux arch spelling.** electron-builder writes `x86_64` for AppImage
targets and `x64` for every other one, so anything matching installer names by
pattern needs both spellings. There is exactly one AppImage per release — see
[Running in a cloud environment](cloud-environments.md) for why adding a second
would break the fleet tooling.

## Closing the window

On **Windows and Linux** the app hides to a tray icon instead of quitting, so
the agent — and any phone linked to this machine — keeps working after the
window is gone. **Quit** in the tray menu ends the process; Settings → General
turns the behaviour off (`grok.desktop.tray`). If the tray icon cannot be
created at all — a Linux session with no StatusNotifier host, say — closing
quits, because hiding a window nothing can bring back is worse than the problem
it solves.

**macOS is not covered yet.** There is no tray icon there, and closing the
window still quits the app. The answer on macOS is its own convention — the app
outliving its last window, with the dock icon bringing it back — rather than a
menu-bar item, and that is a separate change this release does not make.

## Build commands

```bash
npm install
npm run compile          # required; electron-builder packs out/ + media/ + resources/

npm run dist:win         # Windows x64 NSIS installer → dist-desktop/
npm run dist:linux       # Linux x86_64 AppImage (must run on Linux)
npm run dist:mac         # macOS arm64 + x64 dmg + zip (must run on macOS)
npm run dist             # current host's default targets
npm run dist:dir         # unpacked dir only (fast layout check; no installer)
```

Artifacts land in `dist-desktop/` (gitignored). The VS Code VSIX path is unchanged:
`npm run package` still produces `grok-vscode-phuryn-<version>.vsix` and still
excludes all desktop sources via `.vscodeignore`.

**If `dist:win` fails on `Cannot create symbolic link` (local Windows only):**
electron-builder downloads its `winCodeSign` bundle for `rcedit` / `signtool`,
and that archive contains macOS symlinks a normal Windows account may not create
— it retries four times and gives up. CI is unaffected (the runner can). Extract
it once, without the macOS half, and every later build finds it cached:

```bash
CACHE="$LOCALAPPDATA/electron-builder/Cache/winCodeSign"
node_modules/7zip-bin/win/x64/7za.exe x -snld -y "$CACHE"/*.7z \
  "-o$CACHE/winCodeSign-2.6.0" -x'!darwin'
rm -rf "$CACHE"/[0-9]*        # the abandoned retry directories
```

Enabling Windows Developer Mode is the other fix; it grants the symlink
privilege so the normal download path works.

### Cross-build limits

| From → produces | Windows installer | macOS installers | Linux AppImage |
|---|---|---|---|
| **Windows** | yes (`dist:win`) | **no** | **no** |
| **macOS** | possible* | yes (`dist:mac`, both archs) | possible* |
| **Linux** | possible* | **no** | yes (`dist:linux`) |

\* electron-builder can cross-build some Windows targets from macOS/Linux; macOS
targets **require a Mac** (Apple tooling / dmg). This repo's documented path is:
build Windows installers on Windows, macOS installers on macOS.

Dev run without packaging: `npm run desktop` (compile tree + local Electron).

## Install warnings — what users see

**macOS is signed and notarised from 3.2.7 onward; Windows is still unsigned.**
Only the Windows half remains install-conversion friction.

### macOS — no warning

Builds are signed with a Developer ID, notarised by Apple and stapled
(`desktop-release.yml`, using `CSC_LINK` / `CSC_KEY_PASSWORD` plus an App Store
Connect API key for `notarytool`). The app opens straight from the `.dmg`: no
Gatekeeper block, nothing to allow through in System Settings, and no quarantine
flag for anyone to clear.

Keep this in step with `/desktop` and `/desktop-update` on the relay — those are
the other two places a user reads it, and steps for a dialog that never appears
read as "you did it wrong" rather than "we are out of date".

<details>
<summary>History — what users saw before 3.2.7, and why <code>adhoc-sign-mac.cjs</code> still runs</summary>

Unsigned downloads were blocked with “cannot be opened because it is from an
unidentified developer”, and macOS 15 had already removed the right-click → Open
shortcut, so the only overrides were System Settings → **Privacy & Security** →
**Open Anyway** (offered for roughly an hour after the blocked launch) or
`xattr -dr com.apple.quarantine "/Applications/Grok Build Desktop.app"`.

**The failure mode one step worse than that**, and what 3.2.2 shipped:

> “Grok Build Desktop” is damaged and can’t be opened. You should move it to the Trash.

That is not a corrupt download and neither workaround above clears it. Repackaging
Electron invalidates the signature it ships with, and on Apple silicon a bundle
with **no** valid signature is refused outright rather than merely distrusted —
so there is no right-click → Open escape to offer. `afterPack`
(`scripts/adhoc-sign-mac.cjs`) now ad-hoc signs the bundle, which makes it
loadable and puts users back on the ordinary prompt above. An ad-hoc signature
confers no trust; it is a floor, not a destination.

A user already holding a 3.2.2 download can recover it by dropping the quarantine
flag: `xattr -dr com.apple.quarantine "/Applications/Grok Build Desktop.app"`.

**That is what 3.2.7 finally did:** Apple Developer Program membership and a
Developer ID Application certificate, codesigning with the hardened runtime,
then `notarytool` and a stapled ticket — wired through electron-builder's
`mac.identity`, `CSC_LINK` / `CSC_KEY_PASSWORD` and notarize hooks. The ad-hoc
`afterPack` signing stays regardless: it is what keeps a repackaged bundle
loadable at all.

</details>

### Windows (SmartScreen)

On first run of an unsigned `.exe`, Microsoft Defender SmartScreen often shows:

> Windows protected your PC  
> Microsoft Defender SmartScreen prevented an unrecognized app from starting.

**Workaround for users:** **More info** → **Run anyway**.

Reputation improves slowly for a given Authenticode identity after many
downloads; until then SmartScreen will keep warning.

**To remove the warning for real:** purchase an **Authenticode** code-signing
certificate (OV or EV; EV usually gets reputation faster), configure
electron-builder `win.certificateFile` / Azure Trusted Signing / similar, and
sign the installer and the embedded executable. Set
`signAndEditExecutable: true` (or remove the current unsigned override) once a
cert is available.

## Auto-update

Packaged Windows, macOS and Linux builds check a relay-served generic feed
(`https://afkpilot.com/update/win/latest.yml`, `…/mac/latest-mac.yml` and
`…/linux/latest-linux.yml`) on start and every 12 hours, download in the
background, and install on quit or when the rail button says **Restart to
update**. Check or download failure is silent and falls back to the
**Update available** notice (opens `https://afkpilot.com/desktop-update`).
No GitHub provider — a vsix-only release would stall that feed.

**Linux serves the same AppImage the cloud machines install, and needs no cloud
check to stay safe.** `AppImageUpdater.isUpdaterActive()` returns false unless
`process.env.APPIMAGE` is set, and a cloud machine execs the extracted
`squashfs-root` rather than the AppImage — so it asks the feed nothing and
`checkForUpdates()` resolves null with a log line, no error event and no
notice. A desk user who ran the file normally gets a real in-place update.
Keep that structural: a cloud check here would be one more thing to keep true.

**A desk user can land in the same state, and still hears about updates.**
`APPIMAGE` is unset whenever the AppImage was extracted rather than run — which
is what somebody does when their distro has no `libfuse2`. The check treats a
null result like a failed one and falls back to the **Update available**
notice, so they are told a new version exists even though nothing can install
itself. That is one branch, not a platform check, and it is why a cloud
machine needs no exemption from it.

`electron-builder.yml` has a generic `publish` block per platform so
`latest.yml` / `latest-mac.yml` / `latest-linux.yml` are generated; `dist*`
still uses `--publish never` and
the workflow attaches those yml files to the GitHub Release. Windows
signature verification is off until an Authenticode cert lands.

Full contract (relay rewrite rules, dual-arch `latest-mac.yml`, local
`dev-app-update.yml` test): [desktop-update-spec.md](desktop-update-spec.md).

## Packaged layout and `paths.ts`

electron-builder packs (into `app.asar` by default):

```
package.json          # main → out/desktop/main.js; grokExtensionName (extraMetadata)
out/**                # including out/desktop/*
media/**              # chat.js, CSS, MathJax, Mermaid, …
resources/**          # icon
LICENSE
node_modules/ws
node_modules/jpeg-js
node_modules/qrcode-generator                 # package.json + dist/qrcode.js
node_modules/electron-updater                 # + its hoisted tree; production
                                              # dep, packed automatically
node_modules/@agentclientprotocol/codex-acp   # package.json + dist + LICENSE only
node_modules/<hoisted adapter transitives>    # zod, vscode-jsonrpc, open's helpers, … —
                                              # small and unused (dist is a bundle).
                                              # @openai/codex's ~350 MB platform binary
                                              # and the adapter's nested node_modules are
                                              # kept OUT by explicit excludes in
                                              # electron-builder.yml (load-bearing)
```

`resolveExtensionRoot()` / `resolveExtensionRootFrom()` look for
`media/chat.js` at:

1. `path.resolve(moduleDir, "..", "..")` — works for the compile tree **and**
   the packaged asar layout (`…/app.asar/out/desktop` → `…/app.asar`)
2. `app.getAppPath()` if needed
3. `process.resourcesPath` / `…/app` if media were ever shipped as extraResources

**Verified against a real Windows package** (`dist-desktop/win-unpacked`): the live
log line is `extension root: …\resources\app.asar`, and `media/chat.js` loads
from that asar root. Unit tests cover the same layout in
`test/desktop-paths.test.ts`.

`npm run dist:dir` is the quick way to inspect that layout without building an
installer.

### Automation flags on a packaged `.exe`

Double-click / Start Menu launches need no flags. For scripted smoke tests:

- Prefer env vars: `GROK_DESKTOP_WORKSPACE`, `GROK_DESKTOP_USER_DATA`,
  `GROK_DESKTOP_CONFIG_JSON` (already supported by `main.ts`).
- Or pass args after a bare `--` so Electron does not treat them as Chromium
  switches: `Grok Build Desktop.exe -- --workspace=C:\proj`.
- Dev `npm run desktop` still takes `--workspace=…` after the main script path
  (Electron only applies switch validation to pre-script argv).

## Relationship to the VS Code extension

| | Extension | Desktop |
|---|---|---|
| Entry | `out/extension.js` | `out/desktop/main.js` |
| Host | VS Code `Host` | Electron `Host` |
| Package | `.vsix` via `npm run package` | installers via `npm run dist:*` |
| Store listing | `README.marketplace.md` only | GitHub Releases + root `README.md` |

They share pure modules, the webview (`media/chat.js`), and the ACP client.
Desktop sources under `src/desktop/` never enter the VSIX (see `.vscodeignore`
and `test/packaging-policy.test.ts`).
