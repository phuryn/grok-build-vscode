#!/usr/bin/env bash
# Install, upgrade, and remove the Linux .deb on Ubuntu and Debian.
#
# Usage:
#   scripts/verify-linux-deb.sh dist-desktop/Grok-Build-Desktop-<version>-linux-amd64.deb
#
# The sibling AppImage in the same directory is checked too: exactly one, and
# its squashfs must not contain resources/package-type (that file is what makes
# electron-updater select DebUpdater).
#
# Static checks always run. Container checks need docker and run ubuntu:24.04
# and debian:12. Set SKIP_DOCKER=1 to stop after the static checks.
set -euo pipefail

deb=${1:?path to the .deb}
deb=$(readlink -f "$deb")
[ -f "$deb" ] || { echo "not a file: $deb" >&2; exit 1; }

case $(basename "$deb") in
  Grok-Build-Desktop-*-linux-amd64.deb) ;;
  *) echo "unexpected deb name: $(basename "$deb")" >&2; exit 1 ;;
esac

control=$(dpkg-deb -I "$deb" control)
field() { printf '%s\n' "$control" | awk -F': ' -v k="$1" '$1==k { sub(/^[^:]*: /,""); print; exit }'; }

[ "$(field Package)" = "grok-build-desktop" ] || { echo "Package is not grok-build-desktop" >&2; exit 1; }
[ "$(field Architecture)" = "amd64" ] || { echo "Architecture is not amd64" >&2; exit 1; }
[ "$(field Priority)" = "optional" ] || { echo "Priority is not optional" >&2; exit 1; }
[ "$(field Section)" = "devel" ] || { echo "Section is not devel" >&2; exit 1; }
printf '%s\n' "$(field Maintainer)" | grep -q 'support@productcompass.pm' || {
  echo "Maintainer is missing support@productcompass.pm" >&2
  exit 1
}
version=$(field Version)
[ -n "$version" ] || { echo "Version is empty" >&2; exit 1; }

depends=$(printf '%s\n' "$control" | awk '
  $1=="Depends:" { collecting=1; sub(/^Depends: /,""); line=$0; next }
  collecting && /^ / { sub(/^ /,""); line=line " " $0; next }
  collecting { exit }
  END { print line }
')
for needle in \
  'libgtk-3-0 | libgtk-3-0t64' \
  'libglib2.0-0 | libglib2.0-0t64' \
  'libasound2 | libasound2t64' \
  'libnss3' \
  'libgbm1' \
  'xdg-utils'
do
  printf '%s\n' "$depends" | grep -Fq "$needle" || {
    echo "Depends is missing: $needle" >&2
    echo "$depends" >&2
    exit 1
  }
done

listing=$(dpkg-deb -c "$deb")
printf '%s\n' "$listing" | grep -Fq './usr/share/applications/grok-build-desktop.desktop' || {
  echo "desktop entry missing from the deb" >&2
  exit 1
}
printf '%s\n' "$listing" | grep -Eq '\./usr/share/icons/hicolor/.*/apps/grok-build-desktop\.png$' || {
  echo "hicolor icon missing from the deb" >&2
  exit 1
}
printf '%s\n' "$listing" | grep -Fq './opt/Grok Build Desktop/grok-build-desktop' || {
  echo "binary missing from the deb" >&2
  exit 1
}
printf '%s\n' "$listing" | grep -Fq './opt/Grok Build Desktop/resources/package-type' || {
  echo "package-type missing from the deb" >&2
  exit 1
}

meta=$(mktemp -d)
trap 'rm -rf "$meta"' EXIT
dpkg-deb -R "$deb" "$meta/root" >/dev/null
desktop=$meta/root/usr/share/applications/grok-build-desktop.desktop
grep -q '^Name=Grok Build Desktop$' "$desktop"
grep -q '^Exec="/opt/Grok Build Desktop/grok-build-desktop" %U$' "$desktop" || grep -q '^Exec=/opt/Grok Build Desktop/grok-build-desktop %U$' "$desktop"
grep -q '^Icon=grok-build-desktop$' "$desktop"
grep -q '^StartupWMClass=Grok Build Desktop (Community)$' "$desktop"
grep -q '^Categories=Development;$' "$desktop"
[ "$(tr -d '\n' < "$meta/root/opt/Grok Build Desktop/resources/package-type")" = "deb" ]

appimage_dir=$(dirname "$deb")
shopt -s nullglob
appimages=("$appimage_dir"/Grok-Build-Desktop-*-linux-x86_64.AppImage)
[ "${#appimages[@]}" -eq 1 ] || {
  echo "expected exactly one sibling AppImage, got ${#appimages[@]}" >&2
  exit 1
}
appimage=${appimages[0]}
[ -x "$appimage" ] || chmod +x "$appimage"

if ! command -v unsquashfs >/dev/null 2>&1; then
  echo "unsquashfs is required to prove the AppImage has no package-type file" >&2
  exit 1
fi
# The AppImage runtime contains a byte sequence that looks like squashfs
# magic. The real superblock is a later hsqs that unsquashfs accepts.
offset=$(python3 - "$appimage" <<'PY'
import subprocess, sys
path = sys.argv[1]
data = open(path, "rb").read()
idx = 0
candidates = []
while True:
    i = data.find(b"hsqs", idx)
    if i < 0:
        break
    candidates.append(i)
    idx = i + 1
if not candidates:
    raise SystemExit("squashfs magic not found")
for off in candidates:
    probe = subprocess.run(
        ["unsquashfs", "-o", str(off), "-s", path],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if probe.returncode == 0:
        print(off)
        raise SystemExit(0)
raise SystemExit("no hsqs offset is a squashfs superblock")
PY
)
listing=$(unsquashfs -o "$offset" -ll "$appimage")
if printf '%s\n' "$listing" | grep -q 'resources/package-type$'; then
  echo "AppImage contains resources/package-type; DebUpdater would run for AppImage users" >&2
  exit 1
fi
printf '%s\n' "$listing" | grep -q '/AppRun$' || {
  echo "AppImage is missing AppRun" >&2
  exit 1
}

yml="$appimage_dir/latest-linux.yml"
if [ -f "$yml" ]; then
  grep -Eq '^path: .*linux-x86_64\.AppImage\r?$' "$yml" || {
    echo "latest-linux.yml path is not the AppImage" >&2
    exit 1
  }
  grep -Eq 'linux-amd64\.deb\r?$' "$yml" || {
    echo "latest-linux.yml is missing the deb" >&2
    exit 1
  }
fi

echo "static checks passed for $(basename "$deb") version $version"
echo "AppImage has no package-type: $(basename "$appimage")"

if [ "${SKIP_DOCKER:-0}" = "1" ]; then
  echo "SKIP_DOCKER=1, not running install/upgrade/remove"
  exit 0
fi

docker_bin=docker
if ! docker info >/dev/null 2>&1; then
  if sudo -n docker info >/dev/null 2>&1; then
    docker_bin="sudo -n docker"
  else
    echo "docker is not usable" >&2
    exit 1
  fi
fi

next_version=$(python3 - "$version" <<'PY'
import sys
parts = sys.argv[1].split(".")
if len(parts) < 3 or not all(p.isdigit() for p in parts[:3]):
    raise SystemExit(f"cannot bump {sys.argv[1]}")
parts[2] = str(int(parts[2]) + 1)
print(".".join(parts[:3] + parts[3:]))
PY
)
dpkg --compare-versions "$next_version" gt "$version"

next_tree=$(mktemp -d)
dpkg-deb -R "$deb" "$next_tree/root" >/dev/null
python3 - "$next_tree/root/DEBIAN/control" "$next_version" <<'PY'
import pathlib, sys
path, version = sys.argv[1], sys.argv[2]
lines = pathlib.Path(path).read_text().splitlines(keepends=True)
out = []
seen = False
for line in lines:
    if line.startswith("Version:"):
        out.append(f"Version: {version}\n")
        seen = True
    else:
        out.append(line)
if not seen:
    raise SystemExit("control has no Version")
pathlib.Path(path).write_text("".join(out))
PY
next_deb=$next_tree/next.deb
dpkg-deb --root-owner-group -b "$next_tree/root" "$next_deb" >/dev/null

run_image() {
  local image=$1
  echo "lifecycle on $image"
  $docker_bin run --rm \
    -v "$deb:/pkg/app.deb:ro" \
    -v "$next_deb:/pkg/next.deb:ro" \
    -e "EXPECT_VERSION=$version" \
    -e "EXPECT_NEXT=$next_version" \
    "$image" \
    bash -s <<'EOS'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y /pkg/app.deb desktop-file-utils xvfb ca-certificates
dpkg -s grok-build-desktop | grep -Fxq "Version: $EXPECT_VERSION"
test -x "/opt/Grok Build Desktop/grok-build-desktop"
test -L /usr/bin/grok-build-desktop || test -x /usr/bin/grok-build-desktop
test -f /usr/share/applications/grok-build-desktop.desktop
desktop-file-validate /usr/share/applications/grok-build-desktop.desktop
test "$(tr -d '\n' < "/opt/Grok Build Desktop/resources/package-type")" = "deb"
if ldd "/opt/Grok Build Desktop/grok-build-desktop" | grep -q 'not found'; then
  ldd "/opt/Grok Build Desktop/grok-build-desktop" >&2
  echo "binary is missing shared libraries" >&2
  exit 1
fi
set +e
xvfb-run -a timeout 25 /usr/bin/grok-build-desktop --no-sandbox --disable-gpu >/tmp/grok-launch.log 2>&1
code=$?
set -e
if [ "$code" -ne 0 ] && [ "$code" -ne 124 ]; then
  echo "first launch failed with $code" >&2
  cat /tmp/grok-launch.log >&2
  exit 1
fi

apt-get install -y /pkg/next.deb
dpkg -s grok-build-desktop | grep -Fxq "Version: $EXPECT_NEXT"
test -x "/opt/Grok Build Desktop/grok-build-desktop"
test -f /usr/share/applications/grok-build-desktop.desktop
set +e
xvfb-run -a timeout 25 /usr/bin/grok-build-desktop --no-sandbox --disable-gpu >/tmp/grok-launch2.log 2>&1
code=$?
set -e
if [ "$code" -ne 0 ] && [ "$code" -ne 124 ]; then
  echo "launch after upgrade failed with $code" >&2
  cat /tmp/grok-launch2.log >&2
  exit 1
fi

apt-get purge -y grok-build-desktop
if dpkg -s grok-build-desktop >/dev/null 2>&1; then
  echo "package still installed after purge" >&2
  exit 1
fi
test ! -e /usr/bin/grok-build-desktop
test ! -e /usr/share/applications/grok-build-desktop.desktop
test ! -e "/opt/Grok Build Desktop"
test ! -e /usr/share/icons/hicolor/512x512/apps/grok-build-desktop.png
echo "install, upgrade, and purge passed"
EOS
}

run_image ubuntu:24.04
run_image debian:12
rm -rf "$next_tree"
echo "deb lifecycle passed on ubuntu:24.04 and debian:12"
