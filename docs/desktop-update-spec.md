# Desktop auto-update

This is the current-state contract for Grok Build Desktop updates. Phase 1
(notice-only) shipped first. Phase 2 adds a real `electron-updater` download
on macOS, Windows and Linux under the same rail affordance. Rules from phase 1 carry
unless a later section overrides them.

The feed is **not** GitHub Releases. A vsix-only tag becomes GitHub's
"latest" and would stall a GitHub-provider updater. The relay serves the
newest release that actually carries desktop installers.

## Phase 1 — notice (still the fallback)

The main process checks on first paint (4 s delay) and every 12 hours
(`DESKTOP_UPDATE_CHECK_INTERVAL_MS`). Failure is silence: offline, 404,
rate-limit, or a malformed body never raise a dialog.

The check lists GitHub Releases (`DESKTOP_RELEASES_API_URL`) and
`noticeIfUpdateAvailable` picks the newest non-draft release that carries a
desktop installer (`isDesktopInstallerAsset`: anchored
`-mac-arm64.dmg` / `-mac-x64.dmg` / `-mac-arm64.zip` / `-mac-x64.zip` /
`-win-x64.exe` / `-linux-x86_64.AppImage` / `-linux-amd64.deb`; `.blockmap` and `.vsix` do not count). Pre-releases count.
The running version is compared with `isNewerVersion` (numeric semver, not
string order).

When newer, the host posts a host-local `updateAvailable` frame
`{ version, url }`. The URL is always `desktopUpdatePageUrl(current)` —
`https://afkpilot.com/desktop-update?from=<version>` — never the GitHub
release page. The rail button says **Update available**; the panel opens
that page (`openUpdateRelease`, host-local inbound).

No persistent state beyond an in-memory pending notice re-posted after a
document reload. VS Code never sends the frame.

## Phase 2 — in-app download

Packaged Windows, macOS and Linux builds download in the background through
`electron-updater` and install on quit or when the user clicks the same
rail button, now labelled **Restart to update**.

### Client feed (generic provider)

Do **not** use the GitHub provider. Point `electron-updater` at:

| Platform | Generic `url` (directory, trailing slash) | File the updater GETs |
|---|---|---|
| Windows (`win32`) | `https://afkpilot.com/update/win/` | `https://afkpilot.com/update/win/latest.yml` |
| macOS (`darwin`) | `https://afkpilot.com/update/mac/` | `https://afkpilot.com/update/mac/latest-mac.yml` |
| Linux (`linux`) | `https://afkpilot.com/update/linux/` | `https://afkpilot.com/update/linux/latest-linux.yml` |

Those paths are `desktopUpdateFeedBase` / `desktopUpdateFeedConfig` in
`src/desktop/app-update.ts`.

**Linux shares the cloud host's AppImage, and that is safe without a check.**
One AppImage is attached per release; cloud machines extract it and exec
`squashfs-root`, desks run the file. `AppImageUpdater.isUpdaterActive()`
returns false when `process.env.APPIMAGE` is unset, which is exactly the
extracted case, so a cloud machine's `checkForUpdates()` resolves null with a
log line, emits no error and posts no notice, and cannot self-update out from
under the relay's `refresh-sprite-hosts.mjs`. Only a desk run of the AppImage
reaches the feed.

A `.deb` is attached as well. electron-builder writes `resources/package-type`
with the contents `deb` into that package only, and only after the AppImage
has already been sealed (`FpmTarget` is a sync target, the AppImage target is
async, and `linux.target` lists AppImage first). electron-updater on Linux
reads that file and selects `DebUpdater`, which downloads the `.deb` from
`files[]` and installs it with `dpkg -i`. An AppImage has no `package-type`
file, so it stays on `AppImageUpdater` and ignores the deb entry. Both
updaters filter `latest-linux.yml` by extension.

Before the Linux channel existed the client fell back to the phase-1 notice,
which fired anyway — `pickLatestDesktopRelease` matches the mac and Windows
assets on the same release — and sent people to a download page that did not
recognise their OS. That is what this channel replaced.

`allowPrerelease` is irrelevant: the relay chooses which release's yml to
serve. The client does not filter channels.

### Relay contract

The relay (separate repo) must serve the three GETs above as
`application/x-yaml` (or `text/yaml` / `text/plain`). Each response is the
`electron-builder` `latest.yml` / `latest-mac.yml` of the **newest GitHub
Release that has desktop installer assets**, rewritten as follows.

Keep every field `electron-builder` emitted except URL rewriting:

- `version` — `X.Y.Z`, no `v` prefix.
- `releaseDate` — ISO timestamp, unchanged.
- `files[]` — one entry per updater artifact. **Preserve `sha512` and
  `size` byte-for-byte.** Rewrite `files[].url` from the builder's
  relative artifact name to the **absolute GitHub asset download URL**:

  `https://github.com/phuryn/grok-build-vscode/releases/download/<tag>/<filename>`

  `<tag>` is the release tag (`v3.7.0`). `<filename>` is the asset name
  (`Grok-Build-Desktop-3.7.0-win-x64.exe`). `new URL(absolute, base)` in
  electron-updater then downloads from GitHub, not from the relay.

- Legacy top-level `path` / `sha512` (only if the builder emitted them):
  if `path` is a relative artifact name, rewrite it the same way; keep
  `sha512`. Modern clients read `files[]` first.

- Do **not** invent blockmap entries. electron-updater derives
  `{fileUrl}.blockmap` from the rewritten installer URL. Those assets
  already sit on the same GitHub release.

Windows `latest.yml` must list the NSIS installer
(`Grok-Build-Desktop-<version>-win-x64.exe`). macOS `latest-mac.yml` must
list **both** zip archives (`…-mac-arm64.zip` and `…-mac-x64.zip`).
Squirrel.Mac updates from the zip, not the dmg. A yml that only has one
arch is a failed build, not a feed the relay should publish. Linux
`latest-linux.yml` must list `Grok-Build-Desktop-<version>-linux-x86_64.AppImage`
as `path` (note `x86_64`, not the `x64` every other target uses) and must also
list `Grok-Build-Desktop-<version>-linux-amd64.deb` in `files`. The legacy
`path` field stays the AppImage so a client that does not filter by extension
does not install the deb as if it were the AppImage. Rewrite every `files[]`
URL, including the deb. An AppImage embeds its own block map, so there is no
sibling `.blockmap` to require or exclude. The deb has none either.

A vsix-only release is not a desktop latest. Keep serving the previous
installer-bearing yml until a new desktop build is attached.

404, empty body, or unparseable YAML: the client logs and falls back to
the phase-1 notice. Do not serve HTML error pages with status 200.

### Feed service

The relay fetches the GitHub Releases API on demand and caches the rewritten
yml in memory (~10–15 min TTL, positive and negative). There is deliberately
no stale-serve: past the TTL a failed refresh is a real error status (with a
short backoff), so deleting the yml assets from a release — the operator
kill-switch for a bad unsigned update — takes effect within one TTL, and no
copy older than that is ever served. Each platform feed is
selected independently: the newest non-draft
release that carries that platform's yml asset plus its required artifacts.
A half-failed release matrix therefore leaves one platform on the older
version — correct, not an error. A release with installers but no yml
asset is skipped. The workflow prunes ymls only from releases older than
the last three installer-bearing tags, which the newest-selection never
serves.

Any check or download failure (not just 404) falls back to the phase-1
notice. The rewritten `files[].url` values 302 to
`objects.githubusercontent.com`; electron-updater follows those redirects.

With Windows signature verification off, the relay feed and the GitHub
release account are the trust boundary for what gets installed on quit.

### What this repo emits

`electron-builder.yml` has a generic `publish` block **only so the yml
files are generated**. Every `dist*` script still passes `--publish never`.
GitHub upload stays in `.github/workflows/desktop-release.yml`, which
attaches `dist-desktop/latest.yml`, `dist-desktop/latest-mac.yml` and
`dist-desktop/latest-linux.yml`
alongside the installers.

macOS builds both arches in **one** `electron-builder --mac` invocation
(`dist:mac`). The workflow then asserts `latest-mac.yml` contains both
zip names. Do not split mac arches across jobs: the second write would
drop the first arch (electron-builder issue #5592).

### Client behaviour

1. Packaged win32/darwin/linux: configure the generic feed, `autoDownload = true`,
   `autoInstallOnAppQuit = true`. Check after first paint and every 12 h.
2. Update found: download in the background. **No dialog. No button yet.**
   The agent may be mid-turn.
3. Download finished: post host-local `updateReady { version }`. The rail
   button the notice taught users now says **Restart to update**. Click
   posts host-local `restartToUpdate`; the host calls `quitAndInstall`.
   Ordinary quit also installs.
4. Check or download fails (offline, 404, malformed yml, hash mismatch,
   network drop): log only, then run the phase-1 GitHub notice. The rail
   shows **Update available** and opens the download page.
5. Unpackaged `npm run desktop`, a missing feed, or an updater that declines
   to act: phase-1 notice only. The third case is Linux-specific and is NOT an
   error — `checkForUpdates()` resolves null without throwing when
   `process.env.APPIMAGE` is unset, so the check path treats a null result the
   same as a thrown one. That covers a desk user who ran
   `--appimage-extract` instead of the file (the usual workaround where
   `libfuse2` is missing), who would otherwise be told nothing at all, having
   been told before the Linux channel existed. It also covers a cloud machine,
   harmlessly: `updateAvailable` is host-local outbound and every client there
   is a remote, so the notice reaches nobody.
6. No new persistent state beyond what electron-updater writes itself
   (its cache under userData).

`updateAvailable` and `updateReady` are host-local outbound. A remote
never sees the button. `openUpdateRelease` and `restartToUpdate` are
host-local inbound.

### Windows signatures

The app is unsigned until an Authenticode cert lands. **Do not set
`publisherName`.** `win.verifyUpdateCodeSignature: false` in
`electron-builder.yml` is the operative switch: it keeps `publisherName`
out of the baked `app-update.yml`. A runtime assignment is a no-op
(NsisUpdater's setter ignores falsy) and is not used. Unsigned → signed
updates in place are fine later — but verification does NOT turn on by
itself: when the cert lands, REMOVE `win.verifyUpdateCodeSignature: false`
so electron-builder bakes `publisherName` and the updater verifies.

Per-user NSIS (the default) needs no elevation. Users who installed under
Program Files via `allowToChangeInstallationDirectory` get a UAC "unknown
publisher" prompt per update — owner-approved.

macOS builds are signed and notarised (Developer ID, Team L6TFKRX6QQ);
Squirrel.Mac's signature requirement is satisfied. Zip targets already
ship for both arches.

### Manual test (unpackaged only)

A packaged build never reads `dev-app-update.yml`. `setFeedURL` of the
production feed would override that file even with `forceDevUpdateConfig`
set, so the documented local-feed path is unpackaged-only: when
`GROK_DESKTOP_UPDATE_DEV=1` and the app is not packaged, the client sets
`forceDevUpdateConfig` and does **not** call `setFeedURL`. electron-updater
then reads `dev-app-update.yml` from the app path.

electron-updater is not unit-testable. To exercise a real download:

1. Serve a local generic feed. Example layout:

   ```
   http://127.0.0.1:8765/update/win/latest.yml
   http://127.0.0.1:8765/update/mac/latest-mac.yml
   ```

   `files[].url` may be absolute `http://127.0.0.1:8765/…` installer URLs.
   Keep a valid `sha512` of the file you serve.

2. Put `dev-app-update.yml` in **`out/desktop/`** (NOT the repo root):

   ```yaml
   provider: generic
   url: http://127.0.0.1:8765/update/win/
   ```

   Use `/update/mac/` on a Mac. electron-updater reads the file from
   `app.getAppPath()`, and this repo launches `electron out/desktop/main.js`,
   so `getAppPath()` is `out/desktop`. `tsc` does not copy the file — create
   it there after compiling (it is inside gitignored `out/`; the root-level
   `dev-app-update.yml` gitignore entry is belt for a misplaced copy).

3. Launch unpackaged (`npm run desktop`) with `GROK_DESKTOP_UPDATE_DEV=1`.
   Set the feed's `version` above **Electron's own version** (unpackaged
   `app.getVersion()` is Electron's, e.g. `33.2.1` — not `package.json`'s;
   use e.g. `99.0.0`). Confirm: log line on check, silent download, rail
   **Restart to update**, click restarts into the new build. Then kill the
   server and confirm a later check stays silent. Do NOT expect the GitHub
   notice unpackaged: it compares against the same Electron `currentVersion`,
   and no `3.x` release is newer than `33.2.1` — the notice fallback is only
   observable in a packaged build.

Do not enable `forceDevUpdateConfig` in a packaged build.
