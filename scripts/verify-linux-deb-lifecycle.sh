#!/usr/bin/env bash
# Runs INSIDE a disposable Debian/Ubuntu container, as root. No GUI claims.
set -euo pipefail
previous=${1:?previous deb}
current=${2:?current deb}
expect_previous=$(dpkg-deb -f "$previous" Version)
expect_version=$(dpkg-deb -f "$current" Version)
dpkg --compare-versions "$expect_previous" lt "$expect_version"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends "$previous" desktop-file-utils
check_install() {
    test "$(dpkg-query -W -f='${Version}' grok-build-desktop)" = "$1"
    test "$(readlink -f /usr/bin/grok-build-desktop)" = '/opt/grok-build-desktop/grok-build-desktop'
    test -x /usr/bin/grok-build-desktop
    desktop-file-validate /usr/share/applications/grok-build-desktop.desktop
    test -f /usr/share/icons/hicolor/512x512/apps/grok-build-desktop.png
    test "$(cat '/opt/grok-build-desktop/resources/package-type')" = deb
    test "$(stat -c '%u:%g:%a' '/opt/grok-build-desktop/chrome-sandbox')" = 0:0:4755
    test "$(stat -c '%u:%g:%a' '/opt/grok-build-desktop')" = 0:0:755
    # ldd needs the real path so $ORIGIN resolves beside Electron's libraries.
    ldd '/opt/grok-build-desktop/grok-build-desktop' > /tmp/ldd.log
    if grep 'not found' /tmp/ldd.log; then exit 1; fi
    update-alternatives --query grok-build-desktop
    stat -c '%U:%G %a %n' '/opt/grok-build-desktop/chrome-sandbox'
}
check_install "$expect_previous"
echo "PASS install $expect_previous"
# Reproduce the old hook's helper mode; the upgrade must repair it.
chmod 0755 '/opt/grok-build-desktop/chrome-sandbox'
apt-get install -y --no-install-recommends "$current"
check_install "$expect_version"
echo "PASS upgrade to $expect_version (0755 repaired to 4755)"
apt-get remove -y grok-build-desktop
for entry in /usr/bin/grok-build-desktop /etc/alternatives/grok-build-desktop \
    /usr/share/applications/grok-build-desktop.desktop '/opt/grok-build-desktop' \
    /usr/share/icons/hicolor/512x512/apps/grok-build-desktop.png; do
    test ! -e "$entry" && test ! -L "$entry"
done
if update-alternatives --query grok-build-desktop; then exit 1; fi
echo 'PASS remove: binary, helper, links, desktop entry, icon and alternatives gone'
apt-get purge -y grok-build-desktop
test -z "$(dpkg-query -W -f='${db:Status-Abbrev}' grok-build-desktop 2>/dev/null || true)"
echo 'PASS purge'
