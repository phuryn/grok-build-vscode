# Attribution

This project is licensed under the **Functional Source License, Version 1.1, MIT Future License (FSL-1.1-MIT)** — see [LICENSE](../LICENSE). Versions **up to and including 1.8.1** were published under plain MIT and remain MIT.

**What FSL-1.1-MIT means in practice:**

- You're free to **use, copy, modify, and redistribute** this software for any **Permitted Purpose** — your own use, non-commercial education and research, and professional services — for free, including at work.
- The one thing you may **not** do is a **Competing Use**: making this software (or a product or service with substantially similar functionality) available to others commercially — e.g. re-publishing a fork to a marketplace as your own competing extension, or selling a hosted service built from it.
- **Each release automatically becomes plain MIT two years after its publication** (the Future License grant in the LICENSE). From that date on, that version is ordinary MIT code.

**The notice condition still applies.** If you redistribute copies, modifications, or derivatives, you must include the [LICENSE](../LICENSE) (or a link to it) and keep the copyright notices **in all copies** — including **compiled, bundled, or packaged builds** (a `.vsix`, an installed extension, a binary), not just the source. Stripping the notice, or re-publishing this code as your own, is a license violation, not "open source freedom."

## How to attribute this project properly

If you reuse this code or a substantial part of it (for a Permitted Purpose), keep credit to:

- **Author:** Paweł Huryn
- **Original repository:** [phuryn/grok-build-vscode](https://github.com/phuryn/grok-build-vscode)

Concretely:

1. **Ship the [LICENSE](../LICENSE) file** (the copyright notice + FSL-1.1-MIT text) with your distribution — source *and* compiled. This is the part the license actually requires.
2. **Credit the source in your README** — a line like *"Based on [phuryn/grok-build-vscode](https://github.com/phuryn/grok-build-vscode) by Paweł Huryn, FSL-1.1-MIT."*
3. **If you publish anywhere public** (a marketplace, a store, a hosted service), say it's derived from this project in the listing description, don't present it as original work — and make sure what you publish isn't a Competing Use (see above).
4. **Surface it in-app** where practical — e.g. an About/Credits view.

Items 2–4 are good-faith etiquette built on top of the hard requirements. Do that, stay out of Competing Use, and you're welcome to build on this freely.

## Third-party assets

### qrcode-generator (host-generated phone handoff codes)

The host uses **[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)**,
pinned to **2.0.4**, to generate inline SVG QR codes. It has no runtime dependencies;
the encoder is bundled only into the host, never into the phone webview.

MIT License

Copyright (c) 2009 Kazuhiko Arase

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### Seti UI file icons (desktop file tree)

The desktop app's file-tree panel uses a curated subset of the **[Seti UI](https://github.com/jesseweed/seti-ui)** icons (the same family VS Code's default file-icon theme derives from).

| | |
|---|---|
| **Source** | [jesseweed/seti-ui](https://github.com/jesseweed/seti-ui) (`icons/*.svg`) |
| **License** | MIT — Copyright (c) 2014 Jesse Weed |
| **Vendored at** | [`media/file-icons/`](../media/file-icons/) |
| **License text** | [`media/file-icons/LICENSE-SETI.md`](../media/file-icons/LICENSE-SETI.md) |
| **Wiring** | [`src/desktop/file-icons.ts`](../src/desktop/file-icons.ts) maps extensions → icon ids; SVGs are inlined as `data:` URLs into the panel boot script (no runtime network fetch; CSP-safe). |

The MIT notice above is the hard requirement for redistribution of those SVGs. Do not replace this set with a non-redistributable icon pack without updating this section and the vendored license file.

### Connector vendor marks

Settings → Connectors → On this computer uses the vendors' marks (Airtable, Atlassian, Calendly, Canva, Cloudflare, GitHub, Linear, Notion, Sentry, Stripe) to identify those apps.

| | |
|---|---|
| **Vendored at** | [`media/connector-logos/`](../media/connector-logos/) |
| **Wiring** | `appendConnectorLogo` in [`media/settings.js`](../media/settings.js); sibling URLs of `settings.js`, same pattern as `file-icons/` |

Marks are trademarks of their owners. Inclusion is identification only and does not imply endorsement.
