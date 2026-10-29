#!/bin/bash
set -e

# dpkg calls postinst as root: a successful root unshare says nothing about
# Ubuntu's restriction on UNPRIVILEGED user namespaces. Always keep Chromium's
# setuid fallback usable. chown first (it clears setuid), and fail installation
# if either operation fails rather than installing an app that cannot start.
chown root:root '/opt/${sanitizedProductName}/chrome-sandbox'
chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox'

if command -v update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' ] && [ "$(readlink '/usr/bin/${executable}')" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

if hash gtk-update-icon-cache 2>/dev/null; then
    gtk-update-icon-cache -f /usr/share/icons/hicolor || true
fi
