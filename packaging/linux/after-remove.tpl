#!/bin/bash
set -e

# The old postrm also runs during upgrades, after the new payload is unpacked.
# Leave the registration alone until a real remove/purge.
case "$1" in
    remove|purge) ;;
    *) exit 0 ;;
esac

# Delete the link to the binary
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi
# Installation can fall back to a direct symlink if alternatives is unusable.
if [ -L '/usr/bin/${executable}' ] && [ "$(readlink '/usr/bin/${executable}')" = '/opt/${sanitizedProductName}/${executable}' ]; then
    rm -f '/usr/bin/${executable}'
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

if hash gtk-update-icon-cache 2>/dev/null; then
    gtk-update-icon-cache -f /usr/share/icons/hicolor || true
fi
