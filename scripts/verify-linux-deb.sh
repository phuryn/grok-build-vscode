#!/usr/bin/env bash
# bash scripts/verify-linux-deb.sh [--static] dist-desktop/*-linux-amd64.deb
# Static artifact checks always run; the default also exercises dpkg in Docker.
# Containers prove package lifecycle, NOT Ubuntu's AppArmor sandbox policy.
set -euo pipefail
script_dir=$(cd "$(dirname "$0")" && pwd)
static=0
if [ "${1:-}" = --static ]; then static=1; shift; fi
[ "$#" -eq 1 ] || { echo 'expected exactly one deb path' >&2; exit 1; }
deb=$(readlink -f "$1")
test -f "$deb"
version=$(dpkg-deb -f "$deb" Version)
test "$(basename "$deb")" = "Grok-Build-Desktop-$version-linux-amd64.deb"
test "$(dpkg-deb -f "$deb" Package)" = grok-build-desktop
test "$(dpkg-deb -f "$deb" Architecture)" = amd64
test "$(dpkg-deb -f "$deb" Priority)" = optional
test "$(dpkg-deb -f "$deb" Section)" = devel
grep -F 'support@productcompass.pm' <<< "$(dpkg-deb -f "$deb" Maintainer)"
depends=$(dpkg-deb -f "$deb" Depends)
for needle in 'libgtk-3-0 | libgtk-3-0t64' 'libglib2.0-0 | libglib2.0-0t64' \
    'libasound2 | libasound2t64' libnss3 libgbm1 xdg-utils; do
    grep -F "$needle" <<< "$depends" >/dev/null
done

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
dpkg-deb -R "$deb" "$scratch/package"
app="$scratch/package/opt/grok-build-desktop"
test -x "$app/grok-build-desktop"
test -f "$app/chrome-sandbox"
test "$(cat "$app/resources/package-type")" = deb
desktop="$scratch/package/usr/share/applications/grok-build-desktop.desktop"
grep -Fx 'Name=Grok Build Desktop' "$desktop"
grep -Fx 'Exec=/opt/grok-build-desktop/grok-build-desktop %U' "$desktop"
grep -Fx 'Icon=grok-build-desktop' "$desktop"
grep -Fx 'StartupWMClass=Grok Build Desktop (Community)' "$desktop"
grep -Fx 'Categories=Development;' "$desktop"
desktop-file-validate "$desktop"
test -f "$scratch/package/usr/share/icons/hicolor/512x512/apps/grok-build-desktop.png"
bash -n "$scratch/package/DEBIAN/postinst"
bash -n "$scratch/package/DEBIAN/postrm"

artifact_dir=$(dirname "$deb")
appimage="$artifact_dir/Grok-Build-Desktop-$version-linux-x86_64.AppImage"
test -f "$appimage"
chmod +x "$appimage"
offset=$("$appimage" --appimage-offset)
unsquashfs -o "$offset" -ll "$appimage" > "$scratch/appimage.list"
if grep -E '(^|/)resources/package-type$' "$scratch/appimage.list"; then
    echo 'FAIL: AppImage contains resources/package-type (would select DebUpdater)' >&2
    exit 1
fi
grep '/AppRun$' "$scratch/appimage.list"
unsquashfs -o "$offset" -d "$scratch/appimage" "$appimage" resources/app.asar >/dev/null
node - "$script_dir/.." "$app/resources/app.asar" "$scratch/appimage/resources/app.asar" <<'JS'
const [root, ...archives] = process.argv.slice(2);
const assert = require('node:assert/strict');
const asar = require(require.resolve('@electron/asar', { paths: [root] }));
const metadata = [];
for (const archive of archives) {
    const meta = JSON.parse(asar.extractFile(archive, 'package.json'));
    if (![true, 'true'].includes(meta.grokCloudBuild)) throw Error(`cloud flag missing: ${archive}`);
    metadata.push(meta);
}
assert.deepEqual(metadata[0], metadata[1], 'deb productName override must not change packaged package.json');
console.log('Both packaged asars retain grokCloudBuild');
console.log('Deb and AppImage packaged package.json match');
JS
node "$script_dir/build-linux.cjs" --verify-feed "$artifact_dir" "$version"
echo "PASS package files: $(basename "$deb") ($version)"
echo "PASS AppImage has no resources/package-type: $(basename "$appimage")"
if [ "$static" -eq 1 ]; then exit 0; fi

# No privilege fallback: if Docker is unavailable, stop and let the caller run
# this on a machine with access. The lifecycle script is mounted explicitly.
docker info >/dev/null

# There was no published deb before this feature. Make a clearly labelled
# predecessor from this payload, then upgrade TO the exact release artifact.
previous="$version~deb-smoke"
dpkg --compare-versions "$previous" lt "$version"
sed -i "s/^Version:.*/Version: $previous/" "$scratch/package/DEBIAN/control"
dpkg-deb --root-owner-group -b "$scratch/package" "$scratch/previous.deb" >/dev/null

for distro in ubuntu:24.04 debian:12; do
    echo "Lifecycle: $distro; synthetic predecessor $previous -> $version"
    docker run --rm \
      -v "$deb:/pkg/current.deb:ro" \
      -v "$scratch/previous.deb:/pkg/previous.deb:ro" \
      -v "$script_dir/verify-linux-deb-lifecycle.sh:/verify.sh:ro" \
      "$distro" bash /verify.sh /pkg/previous.deb /pkg/current.deb
done
echo 'PASS deb lifecycle on ubuntu:24.04 and debian:12'
