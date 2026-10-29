#!/usr/bin/env bash
# Invoked by build-verify-linux.ps1 in node:20-bookworm. Source is read-only;
# dependencies and compilation stay on the container's Linux filesystem.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends squashfs-tools desktop-file-utils
mkdir /work
cd /work
cp -a /source/{src,adapters,media,resources,packaging,scripts,package.json,package-lock.json,tsconfig.json,tsconfig.muse-adapter.json,electron-builder.yml,LICENSE} .
npm ci
npm run dist:linux
deb=(dist-desktop/*-linux-amd64.deb)
test "${#deb[@]}" -eq 1
version=$(dpkg-deb -f "${deb[0]}" Version)
mkdir -p /artifacts/lifecycle
dpkg-deb -R "${deb[0]}" /work/previous
sed -i "s/^Version:.*/Version: $version~deb-smoke/" /work/previous/DEBIAN/control
dpkg-deb --root-owner-group -b /work/previous /artifacts/lifecycle/previous.deb >/dev/null
cp dist-desktop/*.AppImage dist-desktop/*.deb dist-desktop/latest-linux.yml /artifacts/
echo 'PASS Linux build and artifact inspection; ready for lifecycle containers'
