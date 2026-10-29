#!/usr/bin/env bash
# Native, disposable Ubuntu 24.04 host ONLY. Docker/WSL cannot prove AppArmor.
# bash scripts/verify-linux-sandbox.sh dist-desktop/*-linux-amd64.deb
set -euo pipefail
[ "$#" -eq 1 ] || { echo 'expected exactly one deb' >&2; exit 1; }
. /etc/os-release
[ "$ID:$VERSION_ID" = ubuntu:24.04 ]
test "$(cat /sys/module/apparmor/parameters/enabled)" = Y
sudo aa-status --enabled
deb=$(readlink -f "$1")
version=$(dpkg-deb -f "$deb" Version)
appimage="$(dirname "$deb")/Grok-Build-Desktop-$version-linux-x86_64.AppImage"
test -f "$appimage"
script_dir=$(cd "$(dirname "$0")" && pwd)
logs="$(dirname "$deb")/linux-sandbox-logs"
mkdir -p "$logs"
smoke_user=grok-sandbox-smoke
if id "$smoke_user" >/dev/null 2>&1; then echo 'smoke user already exists' >&2; exit 1; fi
old_restriction=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns)
scratch=$(mktemp -d)
cleanup() {
    sudo pkill -KILL -u "$smoke_user" 2>/dev/null || true
    # The runner cannot traverse the smoke user's 0700 scratch directory.
    sudo bash -c 'cp -- "$1"/*.log "$2/"' bash "$scratch" "$logs" 2>/dev/null || true
    sudo chown -R "$(id -u):$(id -g)" "$logs"
    sudo apt-get purge -y grok-build-desktop || true
    sudo userdel -r "$smoke_user" 2>/dev/null || true
    sudo sysctl -w "kernel.apparmor_restrict_unprivileged_userns=$old_restriction"
    sudo rm -rf "$scratch"
}
trap cleanup EXIT
sudo useradd --create-home --shell /bin/bash "$smoke_user"
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=1
test "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns)" = 1
uname -a
sudo apt-get install -y --no-install-recommends "$deb"
test "$(stat -c '%u:%g:%a' '/opt/grok-build-desktop/chrome-sandbox')" = 0:0:4755
stat -c '%U:%G %a %n' '/opt/grok-build-desktop/chrome-sandbox'
cp "$appimage" "$scratch/app.AppImage"
cp "$script_dir/linux-sandbox-smoke.py" "$scratch/smoke.py"
chmod +x "$scratch/app.AppImage"
mkdir "$scratch/workspace"
printf '%s\n' '{"grok.telemetry.enabled":false,"grok.desktop.tray":false}' > "$scratch/config.json"
sudo chown -R "$smoke_user:$smoke_user" "$scratch"

# Some runner images disable the sysctl; others give the runner's own login
# special privileges. We explicitly enable it and use a fresh unprivileged UID.
if sudo -u "$smoke_user" env LC_ALL=C bash -c \
    'exec unshare --user --map-root-user true > "$1" 2>&1' bash "$scratch/unshare.log"; then
    echo 'unprivileged userns unexpectedly succeeded: restriction is ineffective' >&2
    exit 1
else
    unshare_status=$?
fi
sudo cat "$scratch/unshare.log"
if [ "$unshare_status" -ne 1 ] || ! sudo grep -Eq '^unshare: .*Operation not permitted$' "$scratch/unshare.log"; then
    echo 'unshare did not fail with the expected user-namespace permission error' >&2
    exit 1
fi
for kind in appimage deb; do
    executable=/usr/bin/grok-build-desktop
    if [ "$kind" = appimage ]; then executable="$scratch/app.AppImage"; fi
    sudo -u "$smoke_user" env -i \
      HOME="/home/$smoke_user" USER="$smoke_user" LOGNAME="$smoke_user" PATH=/usr/bin:/bin \
      GROK_DESKTOP_WORKSPACE="$scratch/workspace" \
      GROK_DESKTOP_USER_DATA="$scratch/profile-$kind" \
      GROK_DESKTOP_CONFIG_JSON="$scratch/config.json" \
      xvfb-run -a python3 "$scratch/smoke.py" "$kind" "$executable" "$scratch/$kind.log"
    sudo cat "$scratch/$kind.log"
done
echo 'PASS Ubuntu 24.04 AppArmor=1: AppImage reproduces #213; installed deb launches sandboxed'
