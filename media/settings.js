/**
 * Shared settings surface — a VIEW over existing gear prefs and actions.
 * No persistence of its own. Every control posts the same message the gear
 * already posts (or applies a client-owned pref the gear already applies).
 *
 * Loaded by the chat overlay (desktop / remote) and by the VS Code settings
 * tab. Snapshot-on-open is enough for the tab; changes still go host-ward
 * through the existing set* / open* messages so the sidebar cannot desync.
 */
(function (root) {
  const CATEGORIES = [
    { id: "general", title: "General", restore: true },
    { id: "voice", title: "Voice", restore: true },
    { id: "notifications", title: "Notifications", restore: true },
    { id: "providers", title: "Providers", restore: false },
    // Things you have SET UP, next to the other things you have set up —
    // apart from General/Voice/Notifications, which are preferences.
    { id: "routines", title: "Routines", restore: false },
    { id: "connectors", title: "Connectors", restore: false },
    // "Remote control" rather than "Account": the page is about driving this
    // desk from a phone or browser — linking, the device list, the AFK Pilot
    // sign-in that enables it. "Account" invited confusion with the agent
    // accounts (Grok / Codex / Claude), which live under Providers.
    { id: "account", title: "Remote control", restore: false },
    { id: "advanced", title: "Advanced", restore: false },
    { id: "about", title: "About", restore: false },
  ];

  // Lucide-style stroke icons — same language as chat.js ICON. Labels stay
  // visible; color comes from the nav-item theme tokens.
  /** Longest a repaint may wait on a focused nav select before flushing. */
  const DEFERRED_PAINT_MS = 1200;

  const NAV_ICONS = {
    general: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/></svg>',
    voice: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>',
    notifications: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
    providers: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>',
    connectors: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/></svg>',
    // Lucide "refresh-cw" — a cycle, which is what a routine is. Deliberately
    // not a clock: the page is about repetition, not time of day.
    routines: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>',
    // The lucide phone the top bar uses for Continue remotely (chat.js ICON
    // .smartphone). Same shape on both so the nav row and the button read as
    // one feature — which is the point of calling this page Remote control.
    account: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/></svg>',
    advanced: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
    about: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  };

  // Provider marks from Lobe Icons (MIT), adapted to inherit currentColor.
  // A third copy of the chat.js / projects-rail.js block, deliberately: the VS
  // Code settings TAB loads settings.css and settings.js and nothing else, so
  // this file cannot reach a shared helper. test/provider-logo.test.ts holds
  // all three copies to the same paths.
  const PROVIDER_LOGO_PATHS = {
    grok: "M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815",
    codex: "M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z",
    // Four-point sparkle — distinct from the Grok/Codex marks, currentColor.
    claude: "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z",
  };

  /**
   * Row marks for the About links. Lucide strokes like NAV_ICONS, plus the
   * GitHub octicon, which is a FILLED path rather than a stroke — hence its
   * own shape here instead of a line in the lucide set. Every one is
   * currentColor, so they inherit .settings-row-logo's --vscode-foreground
   * and dim with .is-disabled along with the copy beside them.
   *
   * The octicon ships with a 1024 viewBox but 0-16 coordinates (an export
   * artifact); drawn at 0 0 16 16, which is the space the path is actually in.
   */
  const ROW_ICONS = {
    bug: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/></svg>',
    lightbulb: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>',
    mail: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>',
    github: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8C0 11.54 2.29 14.53 5.47 15.59C5.87 15.66 6.02 15.42 6.02 15.21C6.02 15.02 6.01 14.39 6.01 13.72C4 14.09 3.48 13.23 3.32 12.78C3.23 12.55 2.84 11.84 2.5 11.65C2.22 11.5 1.82 11.13 2.49 11.12C3.12 11.11 3.57 11.7 3.72 11.94C4.44 13.15 5.59 12.81 6.05 12.6C6.12 12.08 6.33 11.73 6.56 11.53C4.78 11.33 2.92 10.64 2.92 7.58C2.92 6.71 3.23 5.99 3.74 5.43C3.66 5.23 3.38 4.41 3.82 3.31C3.82 3.31 4.49 3.1 6.02 4.13C6.66 3.95 7.34 3.86 8.02 3.86C8.7 3.86 9.38 3.95 10.02 4.13C11.55 3.09 12.22 3.31 12.22 3.31C12.66 4.41 12.38 5.23 12.3 5.43C12.81 5.99 13.12 6.7 13.12 7.58C13.12 10.65 11.25 11.33 9.47 11.53C9.76 11.78 10.01 12.26 10.01 13.01C10.01 14.08 10 14.94 10 15.21C10 15.42 10.15 15.67 10.55 15.59C13.71 14.53 16 11.53 16 8C16 3.58 12.42 0 8 0Z"></path></svg>',
  };

  function providerLogoMarkup(id) {
    const path = PROVIDER_LOGO_PATHS[id];
    if (!path) return "";
    return `<svg class="provider-logo" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${path}"></path></svg>`;
  }

  const GITHUB_REPO_URL = "https://github.com/phuryn/grok-build-vscode";
  const GROK_CONNECTORS_URL = "https://grok.com/connectors";
  const CONNECTOR_SECTION_HERE = "On this computer";
  // A phone is not the computer these live on. The desk-written heading
  // sitting directly above the remote-written blurb named two different
  // machines on one screen, which is most of why the section read as
  // confusing. "Workspace machine" is true of a laptop and of a cloud
  // machine, so one word covers both remote cases.
  const CONNECTOR_SECTION_HERE_REMOTE = "On the workspace machine";
  const CONNECTOR_SECTION_GROK = "Grok.com connectors";
  const CONNECTOR_SECTION_LOCAL = "Local Grok connectors";
  const CONNECTOR_BLURB_HERE =
    "These apps are available to Grok, Codex, and Claude. Most open a browser to sign in; GitHub takes a token you paste here. Credentials stay on this machine.";
  // Remote, and allowed to connect. The old copy put three referents in
  // two sentences — "the machine running this workspace", "this device",
  // "here" — so "approve access on this device" read as the host when it
  // means the phone. Sign-in genuinely opens in the browser you are
  // holding (openConnectorConsent calls window.open here); only the
  // credential travels.
  const CONNECTOR_BLURB_HERE_REMOTE_CONNECT =
    "These apps are available to Grok, Codex, and Claude on the machine running this workspace. Sign-in opens in this browser; GitHub takes a token you paste here. The credentials are saved on that machine, not on this one.";
  const CONNECTOR_BLURB_HERE_REMOTE =
    "These apps are connected on the machine running this workspace. Connecting and disconnecting are done there, not from this page.";
  const CONNECTOR_DISCONNECT_COPY =
    "Disconnect affects future conversations and reopened ones. Tools in already running sessions remain available. It does not revoke access at the vendor or clear saved OAuth sign-ins.";
  const CONNECTOR_BLURB_GROK =
    "These follow your Grok account, so they are shared across every Grok session on every machine.";
  const CONNECTOR_BLURB_LOCAL =
    "Declared in this machine's Grok config files. Grok only.";
  const CONNECTOR_BLURB_LOCAL_REMOTE =
    "Declared in this machine's Grok config files. Grok only. These are managed on the host machine only.";
  const ICON_EXTERNAL_LINK =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';
  // lucide `settings` — same path as chat.js ICON.gear. Local Open is config,
  // not a document, so the cog rather than a file-type glyph.
  const ICON_SETTINGS =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>';
  const CONNECTOR_LOGO_IDS = {
    airtable: true,
    atlassian: true,
    calendly: true,
    canva: true,
    cloudflare: true,
    github: true,
    linear: true,
    notion: true,
    sentry: true,
    stripe: true,
    zapier: true,
  };
  const GITHUB_ISSUE_BUG_URL = GITHUB_REPO_URL + "/issues/new?labels=bug";
  const GITHUB_ISSUE_FEATURE_URL = GITHUB_REPO_URL + "/issues/new?labels=enhancement";
  const SUPPORT_MAILTO = "mailto:support@productcompass.pm";
  const ABOUT_DISCLAIMER =
    "Unofficial · community-built · MIT | " +
    "A VS Code UI for SpaceXAI’s Grok Build CLI - not affiliated with or endorsed by SpaceXAI (formerly xAI). " +
    "Grok, Grok Build, and xAI are trademarks of xAI; this project uses those names only to describe what it’s compatible with.";

  const TELEMETRY_COPY =
    "Anonymous usage stats only: a single session-start event with an anonymous install id — never prompts, code, file paths or names, and no identity. The IP address is discarded, never stored.";

  const THUMBS_COPY =
    "Show thumbs on a finished Grok turn so you can send a rating to SpaceXAI. Off by default. On, thumbs appear only when this Grok session supports feedback — never on Codex or Claude.";

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function purposeOf(snapshot) {
    return snapshot && snapshot.appPurpose === "coding" ? "coding" : "knowledge";
  }

  function providerOf(snapshot, id) {
    const list = (snapshot && snapshot.providers) || [];
    return list.find((p) => p && p.id === id) || { id, connected: false };
  }

  /**
   * Whether a remote has nothing useful to do with this provider row.
   *
   * A remote may CONNECT a provider — `runGrokLogin` runs the CLI's headless
   * device-code flow and puts the URL and code in the transcript, opening no
   * terminal on the desk. It may NOT sign one out: `logout` is host-local
   * because it revokes a credential every surface on that machine shares.
   *
   * So the actionable row appears exactly when connecting is the useful thing,
   * and a healthy connected provider stays a status line.
   */
  /**
   * Whether this host can run an agent's headless sign-in for a remote.
   *
   * Field presence, never a version check. The relay serves the web client, so
   * the client is always as new as the deploy while the extension is whatever
   * the user installed — and every host built before `remoteAgentSignIn` shipped
   * classifies `runGrokLogin` as host-local and DROPS it silently. Offering
   * Connect there would be a button that does nothing, which is worse than the
   * read-only row it replaced. Same gate `chat.js` puts on the connect panel.
   */
  function canSignInFromRemote(env) {
    return !!(env && env.hostCaps && env.hostCaps.remoteAgentSignIn);
  }

  function remoteProviderIsSettled(snapshot, id) {
    const provider = providerOf(snapshot, id);
    return provider.connected === true && provider.needsLogin !== true;
  }

  /**
   * Whether a remote may sign an agent OUT here. Cloud environments only: the
   * remote is that host's only surface, so a credential it can grant and never
   * revoke is the worse answer. Everywhere else `logout` is host-local and the
   * row stays a status line. Field presence, never a version check.
   */
  function canSignOutFromRemote(env) {
    return !!(env && env.hostCaps && env.hostCaps.remoteAgentSignOut);
  }

  function githubOf(snapshot) {
    const g = snapshot && snapshot.githubState;
    return g && typeof g === "object" ? g : null;
  }

  function githubKnown(snapshot) {
    return !!githubOf(snapshot);
  }

  function githubConnectedNow(snapshot) {
    const g = githubOf(snapshot);
    return !!(g && g.connected && g.error !== true);
  }

  function githubDescribe(snapshot) {
    const g = githubOf(snapshot);
    if (!g) return "";
    const flow = g.loginFlow;
    if (flow && flow.status === "failed" && flow.message) return flow.message;
    if (flow && (flow.status === "starting" || flow.status === "waiting") && flow.message) {
      return flow.message;
    }
    if (g.message) return g.message;
    if (g.cliPresent === false) return "The GitHub CLI (gh) is not installed on this machine.";
    if (g.error && g.envTokenInForce) {
      return "A token in this machine's GH_TOKEN environment variable is in force, and it is not working.";
    }
    if (!g.connected) {
      return "Connect GitHub to clone private repositories and list the ones this account can see.";
    }
    const who = g.login ? "@" + g.login : "GitHub";
    if (g.error) {
      return "Signed in as " + who + ", but the credential is not working.";
    }
    return "Signed in as " + who + ".";
  }

  function githubAction(snapshot) {
    return githubConnectedNow(snapshot) ? "Sign out" : "Connect with GitHub CLI";
  }

  function githubTokenAvailable(snapshot, env) {
    // NOT canGithubSignInFromRemote: that capability promises the device-code
    // flow only. A host advertising it but predating `githubLoginWithToken`
    // takes the pasted credential across the relay and drops it in silence.
    return !!(githubKnown(snapshot) && !githubConnectedNow(snapshot)
      && (!env || !env.isRemote || canGithubTokenFromRemote(env)));
  }

  function githubCliLive(snapshot) {
    const flow = githubOf(snapshot) && githubOf(snapshot).loginFlow;
    return !!(flow && (flow.status === "starting" || flow.status === "waiting"));
  }

  function canGithubSignInFromRemote(env) {
    return !!(env && env.hostCaps && env.hostCaps.remoteGithubSignIn);
  }

  /** A pasted token AND `cancelDeviceLogin` with `provider: "github"` — the two
   *  affordances added after `remoteGithubSignIn`, which shipped together. */
  function canGithubTokenFromRemote(env) {
    return !!(env && env.hostCaps && env.hostCaps.remoteGithubToken);
  }

  /** Cancelling is only safe to send where `github` is understood: an older
   *  host maps any unrecognised provider to `grok`. */
  function canCancelGithubLogin(env) {
    return !env || !env.isRemote || canGithubTokenFromRemote(env);
  }

  function githubRemoteActionable(snapshot, env) {
    return githubConnectedNow(snapshot)
      ? canSignOutFromRemote(env)
      : canGithubSignInFromRemote(env);
  }

  function githubConnectMessage(snapshot) {
    return githubConnectedNow(snapshot)
      ? { type: "githubSignOut" }
      : { type: "setupGithubCli", action: "auth", surface: "settings" };
  }

  const GITHUB_FINE_GRAINED_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

  function fillGithubTokenHint(el) {
    const doc = el.ownerDocument;
    el.textContent = "";
    el.appendChild(doc.createTextNode("Paste a "));
    const a = doc.createElement("a");
    a.href = GITHUB_FINE_GRAINED_TOKEN_URL;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className = "settings-github-token-link";
    a.textContent = "fine-grained token";
    el.appendChild(a);
    el.appendChild(doc.createTextNode(
      " (one repository, Contents: Read, an expiry) or a classic PAT. It is sent once and never shown again.",
    ));
  }

  /**
   * Does this remote row have a button, or is it just a status line?
   *
   * Connected and healthy, the useful action is signing OUT; anything else, it
   * is connecting. Each is gated on its own capability, so a host that offers
   * one and not the other renders exactly what it can actually do.
   */
  /** The host advertises `remoteAgentSignOut` only when it is a hosted cloud
   *  machine (3.19.7) — capability detection doubling as environment truth,
   *  used here only to choose words. */
  function hostIsCloud(env) {
    return !!(env && env.isRemote && env.hostCaps && env.hostCaps.remoteAgentSignOut);
  }

  /** A device-code sign-in in flight for this provider, mirrored from the
   *  host's onboarding frames by the mounting page. */
  function deviceLoginFlow(env, id) {
    const flow = env && env.deviceLogin && env.deviceLogin[id];
    return flow && flow.status ? flow : undefined;
  }

  /** The ordinary row's description, with a settled flow's outcome folded in. */
  function providerRemoteDescribe(s, env, id) {
    const flow = deviceLoginFlow(env, id);
    if (flow && (flow.status === "failed" || flow.status === "unavailable") && flow.message) {
      return flow.message;
    }
    const provider = providerOf(s, id);
    const base = providerDescription(provider);
    // On a cloud machine the three agents are NOT equal offers — Grok is the
    // native one (owner, 2026-08-31).
    if (id === "grok" && hostIsCloud(env) && !(provider && provider.connected)) {
      return "Recommended. " + base;
    }
    return base;
  }

  /** The same test `message` uses to choose between logout and sign-in. */
  function providerConnectedNow(snapshot, id) {
    const provider = providerOf(snapshot, id);
    return !!(provider && provider.connected && provider.needsLogin !== true);
  }

  function remoteProviderActionable(snapshot, env, id) {
    return remoteProviderIsSettled(snapshot, id)
      ? canSignOutFromRemote(env)
      : canSignInFromRemote(env);
  }

  function providerAction(provider) {
    const connected = provider.connected === true;
    const needsLogin = connected && provider.needsLogin === true;
    if (needsLogin) return "Sign in again";
    return connected ? "Sign out" : "Connect";
  }

  function providerDescription(provider) {
    const connected = provider.connected === true;
    const needsLogin = connected && provider.needsLogin === true;
    if (needsLogin) return "This account is connected but needs to sign in again before it can be used.";
    if (connected) return "This account is connected on this machine.";
    return "Connect this account to use it for new conversations.";
  }

  function logsLabel(env) {
    return env && env.hostCaps && env.hostCaps.showOutput === false
      ? "Logs"
      : "Show extension logs";
  }

  function grokProvider(snapshot) {
    return ((snapshot && snapshot.providers) || []).find((p) => p && p.id === "grok" && p.connected);
  }

  function codexProvider(snapshot) {
    return ((snapshot && snapshot.providers) || []).find((p) => p && p.id === "codex" && p.connected);
  }

  function claudeProvider(snapshot) {
    return ((snapshot && snapshot.providers) || []).find((p) => p && p.id === "claude" && p.connected);
  }

  function legacyProviders(env) {
    return !env || env.providersKnown !== true;
  }

  function showGrokAbout(snapshot, env) {
    return legacyProviders(env) || !!grokProvider(snapshot);
  }

  function remoteAbout(snapshot, env) {
    return !!(env && env.isRemote && snapshot && snapshot.hostKind);
  }

  function grokUpdateOf(snapshot) {
    return (snapshot && snapshot.grokUpdate) || {};
  }

  function grokCliVersion(snapshot) {
    const u = grokUpdateOf(snapshot);
    const grok = grokProvider(snapshot);
    return (grok && grok.cliVersion) || (snapshot && snapshot.cliVersion) || u.current || "";
  }

  function hasReportedProviderVersions(snapshot) {
    return ((snapshot && snapshot.providers) || []).some((p) =>
      p && p.connected && (p.cliVersion || p.adapterVersion));
  }

  function grokUpdateBlocked(snapshot) {
    const policy = grokUpdateOf(snapshot).policy;
    return !!(policy && policy.allow === false);
  }

  function canUpdateGrok(snapshot) {
    const u = grokUpdateOf(snapshot);
    if (grokUpdateBlocked(snapshot)) return false;
    return !!(u.error || u.updateAvailable);
  }

  function webAppVersion() {
    const meta = typeof document !== "undefined" && document.querySelector('meta[name="grok-web-version"]');
    return (meta && meta.getAttribute("content")) || "";
  }

  function versionLabel(value) {
    return value ? "v" + value : "—";
  }

  function grokUpdateStatusText(snapshot) {
    const u = grokUpdateOf(snapshot);
    if (u.checking) return "Checking for updates";
    if (grokUpdateBlocked(snapshot)) return "On the supported version";
    if (u.error) return "Couldn’t check — try updating anyway";
    if (u.updateAvailable) return "Update available · v" + (u.latest || "");
    if (u.current || u.latest) return "CLI is up to date";
    return "—";
  }

  function cliUpdateRows(provider) {
    const name = provider === "codex" ? "Codex CLI" : "Claude Code CLI";
    const suffix = provider === "codex" ? "Codex" : "Claude";
    const entry = (s) => provider === "codex" ? codexProvider(s) : claudeProvider(s);
    const update = (s) => ((s.providers || []).find((p) => p.id === provider) || {}).cliUpdate;
    return [{
      // The id keeps its "about" prefix: it is what the DOM suite addresses and
      // it records where this row used to live.
      id: "aboutUpdate" + suffix,
      // Providers, not About. This is a fact about a provider's CLI, so it
      // belongs beside that provider's account rather than under the extension
      // version and the trademark notice.
      category: "providers",
      title: name,
      kind: "action",
      actionLabel: "Update " + name,
      keepOpen: true,
      // The version rides along, because a bare Update button on this page
      // would be asking someone to act with nothing to act on. `latestCliVersion`
      // is sent for Codex only, so Claude states the installed version and stops
      // rather than claiming an up-to-date it cannot know.
      describe: (s) => {
        const p = entry(s) || {};
        const newer = p.updateAvailable && p.latestCliVersion
          ? "v" + p.latestCliVersion + " is available. "
          : "";
        // Two bare version numbers side by side leave the reader to work out
        // which one is theirs -- rendered, "v0.152.1 · v0.153.4 is available"
        // can be read as a range. The label settles it. A middot rather than a
        // full stop between them for the same reason: "v0.152.1. v0.153.4 is
        // available" reads as one broken sentence.
        const installed = p.cliVersion
          ? "Installed v" + p.cliVersion + (newer ? " · " : ". ")
          : "";
        return installed + newer
          + "Runs its updater on the connected machine. This stops this provider’s "
          + "running sessions, then resumes visible conversations.";
      },
      // Presence advertises support: older remote hosts cannot handle these.
      visible: (s) => !!(entry(s) && entry(s).cliUpdate),
      enabled: (s) => !(s.providers || []).some((p) => p.cliUpdate && p.cliUpdate.status === "running"),
      message: () => ({ type: "update" + suffix }),
    }, {
      id: "about" + suffix + "UpdateStatus",
      category: "providers",
      title: name + " updates",
      kind: "status",
      visible: (s) => !!(update(s) && update(s).message),
      describe: (s) => update(s).message,
    }];
  }

  /** One sentence, one control. Visibility is decided separately. */
  const ROWS = [
    {
      id: "appPurpose",
      category: "general",
      title: "Use this app for",
      description: "Knowledge work hides worktrees, thinking traces, and tool details. Coding unlocks those controls, still off by default.",
      kind: "select",
      options: [
        { value: "knowledge", label: "Knowledge work" },
        { value: "coding", label: "Coding" },
      ],
      defaultValue: "knowledge",
      get: (s) => purposeOf(s),
      message: (value) => ({ type: "setAppPurpose", value }),
    },
    {
      id: "chatFontScale",
      category: "general",
      title: "Text size",
      description: "Chat text size on this device only. Keyboard zoom stays in sync with this slider.",
      kind: "range",
      min: 80,
      max: 160,
      step: 10,
      defaultValue: 100,
      visible: (s, env) => !!(env && env.clientOwnsFontScale),
      get: (s) => Math.round(((s && s.fontScale) || 1) * 100),
      localOnly: true,
    },
    {
      id: "openChatFontScale",
      category: "general",
      title: "Text size",
      description: "Chat zoom lives in VS Code settings so it can stay a user or workspace preference.",
      kind: "action",
      actionLabel: "Open VS Code settings",
      visible: (s, env) => !!(env && !env.isRemote && !env.clientOwnsFontScale && !env.isDesktop),
      message: () => ({ type: "openSettings", section: "grok.chatFontScale" }),
    },
    {
      id: "showThinking",
      category: "general",
      title: "Show thinking traces",
      description: "Show Grok's reasoning traces in chat, including on already-loaded sessions.",
      kind: "toggle",
      defaultValue: false,
      visible: (s) => purposeOf(s) === "coding",
      get: (s) => !!(s && s.showThinking),
      message: (value) => ({ type: "setShowThinking", value }),
    },
    {
      id: "expandCommandOutputs",
      category: "general",
      title: "Expand tool details",
      description: "Pre-open each command's IN/OUT block and each edit's inline diff instead of clicking a row to expand it.",
      kind: "toggle",
      defaultValue: false,
      visible: (s) => purposeOf(s) === "coding",
      get: (s) => !!(s && s.expandCommandOutputs),
      message: (value) => ({ type: "setExpandCommandOutputs", value }),
    },
    {
      id: "steerByDefault",
      category: "general",
      title: "Steer by default",
      description: "Send straight into the running turn instead of queueing until it finishes. Steering does not cancel work in progress.",
      kind: "toggle",
      defaultValue: false,
      visible: (s, env) => !env || env.steerSupported !== false,
      get: (s) => !!(s && s.steerByDefault),
      message: (value) => ({ type: "setSteerByDefault", value }),
    },
    {
      id: "telemetryDesktop",
      category: "general",
      title: "Anonymous usage stats",
      description: TELEMETRY_COPY,
      kind: "toggle",
      defaultValue: true,
      // A cloud remote is the machine's only surface, so the toggle belongs
      // there too; a desk remote still shows the read-only row below.
      visible: (s, env) => !!(env && ((env.isDesktop && !env.isRemote) || hostIsCloud(env))),
      get: (s) => !s || s.telemetryEnabled !== false,
      message: (value) => ({ type: "setTelemetryEnabled", value }),
    },
    {
      id: "telemetryVsCode",
      category: "general",
      title: "Anonymous usage stats",
      description: TELEMETRY_COPY,
      kind: "action",
      actionLabel: "Open VS Code settings",
      visible: (s, env) => !!(env && !env.isRemote && !env.isDesktop),
      message: () => ({ type: "openSettings", section: "grok.telemetry.enabled" }),
    },
    {
      id: "telemetryRemote",
      category: "general",
      title: "Anonymous usage stats",
      description: "",
      kind: "status",
      visible: (s, env) => !!(env && env.isRemote && !hostIsCloud(env)),
      describe: (s) => {
        const known = s && typeof s.telemetryEnabled === "boolean";
        const state = known ? (s.telemetryEnabled ? "On. " : "Off. ") : "";
        return state + TELEMETRY_COPY;
      },
    },
    {
      id: "thumbsFeedback",
      category: "general",
      title: "Thumbs feedback to SpaceXAI",
      description: THUMBS_COPY,
      kind: "toggle",
      defaultValue: false,
      visible: (s, env) => !env || !env.isRemote || hostIsCloud(env),
      get: (s) => !!(s && s.thumbsFeedback),
      message: (value) => ({ type: "setThumbsFeedback", value }),
    },
    {
      id: "thumbsFeedbackRemote",
      category: "general",
      title: "Thumbs feedback to SpaceXAI",
      description: "",
      kind: "status",
      visible: (s, env) => !!(env && env.isRemote && !hostIsCloud(env)),
      describe: (s) => {
        const known = s && typeof s.thumbsFeedback === "boolean";
        const state = known ? (s.thumbsFeedback ? "On. " : "Off. ") : "";
        return state + THUMBS_COPY;
      },
    },
    {
      id: "voiceSendPhrase",
      category: "voice",
      title: "Send phrase",
      description: "Spoken phrase that submits the message when it ends a transcription. Leave empty to disable hands-free send.",
      kind: "text",
      placeholder: "grok send",
      defaultValue: "grok send",
      get: (s) => (s && typeof s.voiceSendPhrase === "string") ? s.voiceSendPhrase : "grok send",
      message: (value) => ({ type: "setVoiceSendPhrase", value }),
    },
    {
      id: "voiceKeyterms",
      category: "voice",
      title: "Dictionary terms",
      description: "Words or phrases that help streaming recognition spell project vocabulary. Press Enter to add a term.",
      kind: "tags",
      placeholder: "Add a term",
      defaultValue: [],
      get: (s) => (s && Array.isArray(s.voiceKeyterms)) ? s.voiceKeyterms : [],
      message: (value) => ({ type: "setVoiceKeyterms", value }),
    },
    {
      id: "voiceConfigured",
      category: "voice",
      title: "Voice input",
      description: "",
      kind: "action",
      actionLabel: "Open voice settings",
      describe: (s) => (s && s.voiceConfigured)
        ? "Voice is ready on this machine."
        : "Voice needs a key or a signed-in Grok account before the mic can start.",
      visible: (s, env) => !!(env && !env.isRemote && !env.isDesktop),
      message: () => ({ type: "openSettings", section: "grok.voiceApiKey" }),
    },
    {
      id: "voiceConfiguredStatus",
      category: "voice",
      title: "Voice input",
      description: "",
      kind: "status",
      describe: (s) => (s && s.voiceConfigured)
        ? "Voice is ready on this machine."
        : "Voice is not configured on the machine hosting this session.",
      visible: (s, env) => !!(env && (env.isRemote || env.isDesktop)),
    },
    {
      id: "readRepliesAloud",
      category: "voice",
      title: "Read replies aloud",
      description: "Read completed replies aloud. Code blocks are skipped.",
      kind: "toggle",
      defaultValue: false,
      visible: (s, env) => !env || env.ttsAvailable !== false,
      get: (s) => !!(s && s.readRepliesAloud),
      message: (value) => ({ type: "setReadRepliesAloud", value }),
      localOnly: (s, env) => !!(env && env.isRemote),
    },
    {
      id: "summarizeRepliesAloud",
      category: "voice",
      title: "Read simplified summaries",
      description: "Use xAI to speak a brief summary of each reply. This costs an extra call and falls back to the full text on failure.",
      kind: "toggle",
      defaultValue: true,
      visible: (s, env) => !env || env.ttsAvailable !== false,
      enabled: (s) => !!(s && s.readRepliesAloud),
      get: (s) => !!(s && s.summarizeRepliesAloud),
      message: (value) => ({ type: "setSummarizeRepliesAloud", value }),
      localOnly: (s, env) => !!(env && env.isRemote),
    },
    {
      id: "ttsUnavailable",
      category: "voice",
      title: "Read replies aloud",
      description: "Speech synthesis is not supported in this client.",
      kind: "status",
      visible: (s, env) => !!(env && env.ttsAvailable === false),
    },
    {
      id: "soundNotifications",
      category: "notifications",
      title: "Sound notifications",
      description: "Play a short sound when a turn finishes or errors, only when the Grok panel is not focused.",
      kind: "toggle",
      defaultValue: false,
      get: (s) => !!(s && s.soundNotifications),
      message: (value) => ({ type: "setSoundNotifications", value }),
    },
    {
      id: "processingSound",
      category: "notifications",
      title: "Still-processing sound",
      description: "Play a quiet reminder while a turn is still working. It starts after seven seconds and repeats every eight seconds.",
      kind: "toggle",
      defaultValue: false,
      get: (s) => !!(s && s.processingSound),
      message: (value) => ({ type: "setProcessingSound", value }),
    },
    {
      id: "providerGrok",
      category: "providers",
      logo: "grok",
      provider: "grok",
      title: "Grok Build",
      vendor: "SpaceXAI",
      description: "",
      kind: "action",
      visible: (s, env) => !!(env && !env.isRemote && env.providersKnown),
      describe: (s) => providerDescription(providerOf(s, "grok")),
      actionLabel: (s) => providerAction(providerOf(s, "grok")),
      keepOpen: true,
      message: (s) => {
        const provider = providerOf(s, "grok");
        return provider.connected && provider.needsLogin !== true
          ? { type: "logout", provider: "grok" }
          : { type: "runGrokLogin", provider: "grok" };
      },
    },
    {
      id: "providerCodex",
      category: "providers",
      logo: "codex",
      provider: "codex",
      title: "Codex",
      vendor: "OpenAI",
      description: "",
      kind: "action",
      visible: (s, env) => !!(env && !env.isRemote && env.providersKnown),
      describe: (s) => providerDescription(providerOf(s, "codex")),
      actionLabel: (s) => providerAction(providerOf(s, "codex")),
      keepOpen: true,
      message: (s) => {
        const provider = providerOf(s, "codex");
        return provider.connected && provider.needsLogin !== true
          ? { type: "logout", provider: "codex" }
          : { type: "runGrokLogin", provider: "codex" };
      },
    },
    {
      id: "providerClaude",
      category: "providers",
      logo: "claude",
      provider: "claude",
      title: "Claude Code",
      vendor: "Anthropic",
      description: "",
      kind: "action",
      visible: (s, env) => !!(env && !env.isRemote && env.providersKnown),
      describe: (s) => providerDescription(providerOf(s, "claude")),
      actionLabel: (s) => providerAction(providerOf(s, "claude")),
      keepOpen: true,
      message: (s) => {
        const provider = providerOf(s, "claude");
        return provider.connected && provider.needsLogin !== true
          ? { type: "logout", provider: "claude" }
          : { type: "runGrokLogin", provider: "claude" };
      },
    },
    // Remote provider rows come in a PAIR, and which one shows is the point.
    // This page rendered status-only for a remote from 3.9.0, when a remote
    // genuinely could not sign a provider in. `0fa6661` gave it the device-code
    // flow and moved `runGrokLogin` to `full`, and this page was never told — so
    // the onboarding card in the transcript was the only way to connect an agent
    // from a phone or a cloud environment (owner, 2026-08-30).
    {
      id: "providerGrokStatus",
      category: "providers",
      logo: "grok",
      provider: "grok",
      title: "Grok Build",
      vendor: "SpaceXAI",
      description: "",
      kind: "status",
      visible: (s, env) => !!(env && env.isRemote && env.providersKnown
        && !remoteProviderActionable(s, env, "grok")),
      describe: (s, env) => providerRemoteDescribe(s, env, "grok"),
    },
    {
      id: "providerGrokRemote",
      category: "providers",
      logo: "grok",
      provider: "grok",
      title: "Grok Build",
      vendor: "SpaceXAI",
      description: "",
      kind: "action",
      visible: (s, env) => !!(env && env.isRemote && env.providersKnown
        && remoteProviderActionable(s, env, "grok")),
      // The flow opens in the connect wizard — one renderer, in a dialog,
      // which is not subject to the welcome card's refusal to paint over a
      // conversation. This page stays put behind it, so closing the wizard
      // returns the reader exactly where they were.
      keepOpen: (s, env) => !!(env && env.isRemote),
      // Only for the sign-IN message. This row sends `logout` when the
      // account is connected, and opening a Connect wizard on a Sign out
      // click is the opposite of what was asked (review, 2026-08-31).
      local: (s, env) => (env && env.isRemote && !providerConnectedNow(s, "grok")
        ? "connectWizard:grok"
        : ""),
      describe: (s, env) => providerRemoteDescribe(s, env, "grok"),
      actionLabel: (s) => providerAction(providerOf(s, "grok")),
      // Same two messages the desk row sends, reached through the same test.
      // Which one is offered is decided by visibility above, so this cannot
      // send `logout` to a host that did not advertise remoteAgentSignOut.
      message: (s) => {
        const provider = providerOf(s, "grok");
        return provider.connected && provider.needsLogin !== true
          ? { type: "logout", provider: "grok" }
          : { type: "runGrokLogin", provider: "grok" };
      },
    },
    {
      id: "providerCodexStatus",
      category: "providers",
      logo: "codex",
      provider: "codex",
      title: "Codex",
      vendor: "OpenAI",
      description: "",
      kind: "status",
      visible: (s, env) => !!(env && env.isRemote && env.providersKnown
        && !remoteProviderActionable(s, env, "codex")),
      describe: (s, env) => providerRemoteDescribe(s, env, "codex"),
    },
    {
      id: "providerCodexRemote",
      category: "providers",
      logo: "codex",
      provider: "codex",
      title: "Codex",
      vendor: "OpenAI",
      description: "",
      kind: "action",
      visible: (s, env) => !!(env && env.isRemote && env.providersKnown
        && remoteProviderActionable(s, env, "codex")),
      // The flow opens in the connect wizard — one renderer, in a dialog,
      // which is not subject to the welcome card's refusal to paint over a
      // conversation. This page stays put behind it, so closing the wizard
      // returns the reader exactly where they were.
      keepOpen: (s, env) => !!(env && env.isRemote),
      // Only for the sign-IN message. This row sends `logout` when the
      // account is connected, and opening a Connect wizard on a Sign out
      // click is the opposite of what was asked (review, 2026-08-31).
      local: (s, env) => (env && env.isRemote && !providerConnectedNow(s, "codex")
        ? "connectWizard:codex"
        : ""),
      describe: (s, env) => providerRemoteDescribe(s, env, "codex"),
      actionLabel: (s) => providerAction(providerOf(s, "codex")),
      // Same two messages the desk row sends, reached through the same test.
      // Which one is offered is decided by visibility above, so this cannot
      // send `logout` to a host that did not advertise remoteAgentSignOut.
      message: (s) => {
        const provider = providerOf(s, "codex");
        return provider.connected && provider.needsLogin !== true
          ? { type: "logout", provider: "codex" }
          : { type: "runGrokLogin", provider: "codex" };
      },
    },
    {
      id: "providerClaudeStatus",
      category: "providers",
      logo: "claude",
      provider: "claude",
      title: "Claude Code",
      vendor: "Anthropic",
      description: "",
      kind: "status",
      visible: (s, env) => !!(env && env.isRemote && env.providersKnown
        && !remoteProviderActionable(s, env, "claude")),
      describe: (s, env) => providerRemoteDescribe(s, env, "claude"),
    },
    {
      id: "providerClaudeRemote",
      category: "providers",
      logo: "claude",
      provider: "claude",
      title: "Claude Code",
      vendor: "Anthropic",
      description: "",
      kind: "action",
      visible: (s, env) => !!(env && env.isRemote && env.providersKnown
        && remoteProviderActionable(s, env, "claude")),
      // The flow opens in the connect wizard — one renderer, in a dialog,
      // which is not subject to the welcome card's refusal to paint over a
      // conversation. This page stays put behind it, so closing the wizard
      // returns the reader exactly where they were.
      keepOpen: (s, env) => !!(env && env.isRemote),
      // Only for the sign-IN message. This row sends `logout` when the
      // account is connected, and opening a Connect wizard on a Sign out
      // click is the opposite of what was asked (review, 2026-08-31).
      local: (s, env) => (env && env.isRemote && !providerConnectedNow(s, "claude")
        ? "connectWizard:claude"
        : ""),
      describe: (s, env) => providerRemoteDescribe(s, env, "claude"),
      actionLabel: (s) => providerAction(providerOf(s, "claude")),
      // Same two messages the desk row sends, reached through the same test.
      // Which one is offered is decided by visibility above, so this cannot
      // send `logout` to a host that did not advertise remoteAgentSignOut.
      message: (s) => {
        const provider = providerOf(s, "claude");
        return provider.connected && provider.needsLogin !== true
          ? { type: "logout", provider: "claude" }
          : { type: "runGrokLogin", provider: "claude" };
      },
    },
    {
      id: "githubConnection",
      category: "providers",
      icon: "github",
      title: "GitHub",
      description: "",
      kind: "action",
      visible: (s, env) => !!(env && !env.isRemote && githubKnown(s)),
      describe: (s) => githubDescribe(s),
      actionLabel: (s) => githubAction(s),
      keepOpen: true,
      message: (s) => githubConnectMessage(s),
    },
    {
      id: "githubConnectionStatus",
      category: "providers",
      icon: "github",
      title: "GitHub",
      description: "",
      kind: "status",
      visible: (s, env) => !!(env && env.isRemote && githubKnown(s)
        && !githubRemoteActionable(s, env)),
      describe: (s) => githubDescribe(s),
    },
    {
      id: "githubConnectionRemote",
      category: "providers",
      icon: "github",
      title: "GitHub",
      description: "",
      kind: "action",
      visible: (s, env) => !!(env && env.isRemote && githubKnown(s)
        && githubRemoteActionable(s, env)),
      describe: (s) => githubDescribe(s),
      actionLabel: (s) => githubAction(s),
      keepOpen: true,
      message: (s) => githubConnectMessage(s),
    },
    {
      id: "githubToken",
      category: "providers",
      title: "Use a GitHub token",
      description: "A fine-grained token can be scoped to one repository, with an expiry. It is stored by the GitHub CLI, not by us.",
      kind: "action",
      actionLabel: "Paste token",
      // Folded into the GitHub row as the quieter advanced path. The row
      // stays in the catalog so existing ids do not vanish; it does not paint.
      visible: () => false,
      keepOpen: true,
      local: "githubToken",
    },
    {
      id: "continueRemotely",
      category: "account",
      title: "Continue remotely",
      description: "Open AFK Pilot so you can keep this session going from another device.",
      kind: "action",
      actionLabel: "Open",
      visible: (s, env) => !!(env && !env.isRemote && env.remoteLinked === true),
      message: () => ({ type: "openRemotePortal", withHint: true }),
    },
    {
      id: "yourAccount",
      category: "account",
      title: "Your account",
      description: "Open the AFK Pilot account page for this linked device.",
      kind: "action",
      actionLabel: "Open",
      visible: (s, env) => !!(env && !env.isRemote && env.remoteLinked === true),
      message: () => ({ type: "openRemotePortal" }),
    },
    {
      id: "unlinkDevice",
      category: "account",
      title: "Unlink this device",
      description: "Stop advertising this machine to AFK Pilot. Other devices lose this desk until you link it again.",
      kind: "action",
      actionLabel: "Unlink…",
      visible: (s, env) => !!(env && !env.isRemote && env.isDesktop && env.remoteLinked === true),
      message: () => ({ type: "unlinkRemoteDevice" }),
    },
    {
      id: "remoteSignIn",
      category: "account",
      title: "Sign in",
      description: "Link this device to an AFK Pilot account so you can continue remotely.",
      kind: "action",
      actionLabel: "Link this device",
      visible: (s, env) => !!(env && !env.isRemote && env.remoteLinked === false),
      message: () => ({ type: "remoteSignIn" }),
    },
    {
      id: "remoteHowItWorks",
      category: "account",
      title: "How it works",
      description: "AFK Pilot keeps this machine awake and lets you continue from a phone without storing prompts or code.",
      kind: "action",
      actionLabel: "Learn more",
      visible: (s, env) => !!(env && !env.isRemote && env.remoteLinked === false && !env.standalone),
      local: "explainRemote",
    },
    {
      id: "remoteAccountStatus",
      category: "account",
      title: "AFK Pilot",
      description: "This browser is signed in and talking to the linked desk.",
      kind: "status",
      visible: (s, env) => !!(env && env.isRemote),
    },
    {
      id: "remoteDeviceManager",
      category: "account",
      title: "Device manager",
      description: "Open the AFK Pilot device list for this account.",
      kind: "action",
      actionLabel: "Open",
      visible: (s, env) => !!(env && env.isRemote),
      local: "openDeviceManager",
    },
    {
      id: "openGlobalConfig",
      category: "advanced",
      title: "Open global config",
      description: "Open the user-level Grok config file on this machine.",
      kind: "action",
      actionLabel: "Open",
      hostLocal: true,
      message: () => ({ type: "openGlobalConfig" }),
    },
    {
      id: "openProjectConfig",
      category: "advanced",
      title: "Open project config",
      description: "Open this project's Grok config file.",
      kind: "action",
      actionLabel: "Open",
      hostLocal: true,
      message: () => ({ type: "openProjectConfig" }),
    },
    {
      id: "routinesList",
      category: "routines",
      title: "Routines",
      description: "Send the same prompt to a project on a schedule. Each run opens a session you can read later.",
      kind: "routines",
    },
    {
      id: "connectorsCatalog",
      category: "connectors",
      title: "Connectors",
      description: CONNECTOR_BLURB_HERE,
      kind: "connectors",
      visible: (s, env) => mcpSettingsEnabled(env),
    },
    {
      id: "mcpCatalog",
      category: "connectors",
      title: "Grok connectors",
      description: CONNECTOR_BLURB_GROK,
      kind: "mcp",
      visible: (s, env) => mcpSettingsEnabled(env),
    },
    {
      id: "showLogs",
      category: "advanced",
      title: "Show logs",
      description: "Open the host log for this Grok client.",
      kind: "action",
      actionLabel: (s, env) => logsLabel(env),
      hostLocal: true,
      message: () => ({ type: "showLogs" }),
    },
    {
      id: "toggleDevTools",
      category: "advanced",
      title: "Toggle Developer Tools",
      description: "Open or close Chromium Developer Tools for this window.",
      kind: "action",
      actionLabel: "Toggle",
      hostLocal: true,
      visible: (s, env) => !!(env && env.hostCaps && env.hostCaps.toggleDevTools === true),
      message: () => ({ type: "toggleDevTools" }),
    },
    {
      id: "openVsCodeSettings",
      category: "advanced",
      title: "Open VS Code settings",
      description: "Open the host Settings editor focused on Grok.",
      kind: "action",
      actionLabel: "Open",
      hostLocal: true,
      visible: (s, env) => !!(env && !env.isDesktop),
      message: () => ({ type: "openSettings", section: "grok" }),
    },
    {
      id: "moveView",
      category: "advanced",
      title: "Move view",
      description: "Open the editor's own picker so you can move the Grok chat to another dock.",
      kind: "action",
      actionLabel: "Move view…",
      hostLocal: true,
      visible: (s, env) => !!(
        env &&
        env.hostCaps &&
        env.hostCaps.secondarySideBar === false &&
        env.hostCaps.relocateView !== false
      ),
      message: () => ({ type: "moveView", location: "pick" }),
    },
    {
      id: "hostConfigRemote",
      category: "advanced",
      title: "Host configuration",
      description: "",
      kind: "status",
      // "The desk" was nonsense on a cloud machine — there is no desk.
      describe: (s, env) => hostIsCloud(env)
        ? "Host configuration lives on your cloud machine and is not editable from this page."
        : "Host config is managed on the machine running this workspace.",
      visible: (s, env) => !!(env && env.isRemote),
    },
    {
      id: "aboutWebApp",
      category: "about",
      title: "Web app",
      kind: "value",
      visible: (s, env) => remoteAbout(s, env),
      get: () => versionLabel(webAppVersion()),
    },
    {
      id: "aboutConnectedTo",
      category: "about",
      title: "Connected to",
      kind: "value",
      visible: (s, env) => remoteAbout(s, env),
      get: (s) => {
        const gui = s && s.hostKind === "desktop" ? "Desktop app" : "Extension";
        return s && s.hostName ? `${s.hostName} · ${gui}` : gui;
      },
    },
    {
      id: "aboutHostProduct",
      category: "about",
      title: (s) => (s && s.hostKind === "desktop") ? "Grok Build Desktop" : "Grok Build extension",
      kind: "value",
      visible: (s, env) => remoteAbout(s, env),
      get: (s) => versionLabel(s && s.extVersion),
    },
    {
      id: "aboutThisExtension",
      category: "about",
      title: "This extension",
      kind: "value",
      visible: (s, env) => !remoteAbout(s, env),
      get: (s) => versionLabel(s && s.extVersion),
    },
    {
      id: "aboutGrokCli",
      category: "about",
      title: "Grok Build CLI",
      kind: "value",
      visible: (s, env) => {
        if (remoteAbout(s, env) && hasReportedProviderVersions(s)) return !!grokProvider(s);
        if (remoteAbout(s, env)) return true;
        return showGrokAbout(s, env);
      },
      get: (s) => versionLabel(grokCliVersion(s)),
    },
    {
      id: "aboutCodexCli",
      category: "about",
      title: "Codex CLI",
      kind: "value",
      visible: (s) => !!codexProvider(s),
      get: (s) => {
        const p = codexProvider(s);
        return versionLabel(p && p.cliVersion);
      },
    },
    ...cliUpdateRows("codex"),
    {
      id: "aboutClaudeCli",
      category: "about",
      title: "Claude Code CLI",
      kind: "value",
      visible: (s) => !!claudeProvider(s),
      get: (s) => {
        const p = claudeProvider(s);
        return versionLabel(p && p.cliVersion);
      },
    },
    ...cliUpdateRows("claude"),
    // Deliberately absent: "Codex ACP adapter" and "Claude ACP adapter".
    // The two adapters are pinned dependencies of THIS
    // extension (@agentclientprotocol/codex-acp, @agentclientprotocol/
    // claude-agent-acp, exact versions in package.json) and ship inside the
    // vsix, so they move only when the extension does — a version the reader
    // cannot act on reads as one more thing to keep current. All three CLIs
    // have explicit update actions; only Grok is updated automatically by us.
    {
      id: "aboutGrokUpdateStatus",
      category: "about",
      title: "Grok Build CLI updates",
      kind: "status",
      visible: (s, env) => showGrokAbout(s, env) && !remoteAbout(s, env),
      describe: (s) => grokUpdateStatusText(s),
    },
    {
      id: "aboutGrokUpdatePolicy",
      category: "about",
      title: "Updates paused",
      kind: "status",
      visible: (s, env) => showGrokAbout(s, env) && !remoteAbout(s, env) && grokUpdateBlocked(s),
      describe: (s) => {
        const policy = grokUpdateOf(s).policy;
        return (policy && policy.note) || "Updates are paused for compatibility.";
      },
    },
    {
      id: "aboutUpdateGrok",
      category: "about",
      title: "Update Grok Build CLI",
      description: "Download and install the latest Grok Build CLI on this machine.",
      kind: "action",
      actionLabel: "Update Grok Build CLI",
      visible: (s, env) => showGrokAbout(s, env) && !remoteAbout(s, env) && canUpdateGrok(s),
      message: () => ({ type: "updateGrok" }),
    },
    {
      id: "aboutUpdateGrokBlocked",
      category: "about",
      title: "Update Grok Build CLI",
      description: "Updates are paused for compatibility.",
      kind: "action",
      actionLabel: "Update Grok Build CLI",
      visible: (s, env) => showGrokAbout(s, env) && !remoteAbout(s, env) && grokUpdateBlocked(s),
      enabled: () => false,
      message: () => ({ type: "updateGrok" }),
    },
    {
      id: "aboutRemoteCliUpdate",
      category: "about",
      title: "CLI update",
      kind: "status",
      visible: (s, env) => !!(env && env.isRemote && grokUpdateOf(s).updateAvailable),
      describe: (s) => {
        const latest = grokUpdateOf(s).latest;
        return `CLI update available${latest ? ` · v${latest}` : ""}. Update it at the desk — this device can’t.`;
      },
    },
    {
      id: "reportBug",
      category: "about",
      icon: "bug",
      title: "Report a bug",
      description: "Open a new issue on the GitHub tracker.",
      kind: "action",
      actionLabel: "Open",
      href: GITHUB_ISSUE_BUG_URL,
    },
    {
      id: "requestFeature",
      category: "about",
      icon: "lightbulb",
      title: "Request a feature",
      description: "Open a new issue on the GitHub tracker.",
      kind: "action",
      actionLabel: "Open",
      href: GITHUB_ISSUE_FEATURE_URL,
    },
    {
      id: "contactSupport",
      category: "about",
      icon: "mail",
      title: "Contact",
      description: "support@productcompass.pm",
      kind: "action",
      actionLabel: "Email",
      href: SUPPORT_MAILTO,
    },
    {
      id: "aboutRepo",
      category: "about",
      icon: "github",
      title: "phuryn/grok-build-vscode",
      description: "Source repository on GitHub.",
      kind: "action",
      actionLabel: "Open",
      href: GITHUB_REPO_URL,
    },
  ];

  function mcpSettingsEnabled(env) {
    return !!(env && env.hostCaps && env.hostCaps.mcpSettings);
  }

  function connectorSection(row, env) {
    if (row.id === "connectorsCatalog") {
      return env && env.isRemote ? CONNECTOR_SECTION_HERE_REMOTE : CONNECTOR_SECTION_HERE;
    }
    return "";
  }

  function catalogCategories(env) {
    if (mcpSettingsEnabled(env)) return CATEGORIES;
    return CATEGORIES.filter((cat) => cat.id !== "connectors");
  }

  function rowVisible(row, snapshot, env) {
    if (row.hostLocal && env && env.isRemote) return false;
    if (typeof row.visible === "function") return !!row.visible(snapshot, env);
    return true;
  }

  function rowEnabled(row, snapshot) {
    if (typeof row.enabled === "function") return !!row.enabled(snapshot);
    return true;
  }

  function rowTitle(row, snapshot, env) {
    if (typeof row.title === "function") return row.title(snapshot, env);
    return row.title;
  }

  function rowDescription(row, snapshot, env) {
    if (typeof row.describe === "function") return row.describe(snapshot, env);
    return row.description || "";
  }

  function rowActionLabel(row, snapshot, env) {
    if (typeof row.actionLabel === "function") return row.actionLabel(snapshot, env);
    return row.actionLabel || "Open";
  }

  function rowValue(row, snapshot) {
    return typeof row.get === "function" ? row.get(snapshot) : undefined;
  }

  function isLocalOnly(row, snapshot, env) {
    if (typeof row.localOnly === "function") return !!row.localOnly(snapshot, env);
    return row.localOnly === true;
  }

  function visibleRows(snapshot, env) {
    return ROWS.filter((row) => rowVisible(row, snapshot, env));
  }

  function visibleCategories(snapshot, env) {
    const rows = visibleRows(snapshot, env);
    const ids = new Set(rows.map((row) => row.category));
    return catalogCategories(env).filter((cat) => ids.has(cat.id));
  }

  function searchHaystack(row, snapshot, env) {
    const cat = CATEGORIES.find((c) => c.id === row.category);
    const extraConnectors = row.kind === "connectors" && Array.isArray(snapshot && snapshot.mcpConnectors)
      ? snapshot.mcpConnectors.map((c) => [c.name, c.description, c.keyHint].join(" ")).join(" ")
      : "";
    const extraMcp = row.kind === "mcp" && Array.isArray(snapshot && snapshot.mcpServers)
      ? [
          CONNECTOR_SECTION_GROK,
          CONNECTOR_SECTION_LOCAL,
          GROK_CONNECTORS_URL,
          CONNECTOR_BLURB_GROK,
          CONNECTOR_BLURB_LOCAL,
          ...snapshot.mcpServers.map((s) => [s.displayName, s.name, s.scopeName, s.configFile].filter(Boolean).join(" ")),
        ].join(" ")
      : "";
    const section = connectorSection(row, env);
    return [
      rowTitle(row, snapshot, env),
      rowDescription(row, snapshot, env),
      extraConnectors,
      extraMcp,
      section,
      cat ? cat.title : "",
      row.id,
    ].join(" ").toLowerCase();
  }

  function filterRows(query, snapshot, env) {
    const rows = visibleRows(snapshot, env);
    const q = String(query || "").trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => searchHaystack(row, snapshot, env).includes(q));
  }

  /** Toggles / selects / sliders restore. Free-text and list inputs never do
   *  (voice send phrase + dictionary terms are the canonical cases). */
  const RESTORABLE_KINDS = { toggle: true, select: true, range: true };

  function isRestorableKind(row) {
    return !!RESTORABLE_KINDS[row.kind];
  }

  function restoreTargets(categoryId, snapshot, env) {
    return ROWS.filter((row) =>
      row.category === categoryId &&
      isRestorableKind(row) &&
      row.defaultValue !== undefined &&
      rowVisible(row, snapshot, env) &&
      rowEnabled(row, snapshot));
  }

  function restoreChanges(categoryId, snapshot, env) {
    let next = snapshot;
    const out = [];
    for (const row of restoreTargets(categoryId, snapshot, env)) {
      if (!rowEnabled(row, next)) continue;
      if (rowValue(row, next) === row.defaultValue) continue;
      out.push(row);
      next = applyValue(row, row.defaultValue, next);
    }
    return out;
  }

  function restoreValueLabel(row, value) {
    if (row.kind === "toggle") return value ? "On" : "Off";
    if (row.kind === "select") {
      const opt = (row.options || []).find((o) => o.value === value);
      return opt ? opt.label : String(value);
    }
    if (row.kind === "range") return `${value}%`;
    return String(value);
  }

  function rowMessage(row, value, snapshot) {
    if (typeof row.message !== "function") return null;
    // Action rows that need the snapshot receive it as the sole argument.
    if (row.kind === "action") return row.message(snapshot);
    return row.message(value);
  }

  function applyValue(row, value, snapshot) {
    const next = { ...snapshot };
    switch (row.id) {
      case "appPurpose":
        next.appPurpose = value === "coding" ? "coding" : "knowledge";
        break;
      case "chatFontScale":
        next.fontScale = Number(value) / 100;
        break;
      case "showThinking":
        next.showThinking = !!value;
        break;
      case "expandCommandOutputs":
        next.expandCommandOutputs = !!value;
        break;
      case "steerByDefault":
        next.steerByDefault = !!value;
        break;
      case "readRepliesAloud":
        next.readRepliesAloud = !!value;
        if (!next.readRepliesAloud) next.summarizeRepliesAloud = false;
        break;
      case "summarizeRepliesAloud":
        next.summarizeRepliesAloud = !!value;
        break;
      case "soundNotifications":
        next.soundNotifications = !!value;
        break;
      case "processingSound":
        next.processingSound = !!value;
        break;
      case "voiceSendPhrase":
        next.voiceSendPhrase = String(value ?? "");
        break;
      case "voiceKeyterms":
        next.voiceKeyterms = Array.isArray(value) ? value.slice() : [];
        break;
      case "telemetryDesktop":
        next.telemetryEnabled = !!value;
        break;
      case "thumbsFeedback":
        next.thumbsFeedback = !!value;
        break;
      default:
        break;
    }
    return next;
  }

  function defaultEnv(partial) {
    return {
      isRemote: false,
      isDesktop: false,
      clientOwnsFontScale: false,
      ttsAvailable: true,
      steerSupported: true,
      providersKnown: false,
      remoteLinked: null,
      standalone: false,
      hostCaps: {},
      ...(partial || {}),
    };
  }

  function defaultSnapshot(partial) {
    return {
      appPurpose: "knowledge",
      showThinking: false,
      expandCommandOutputs: false,
      steerByDefault: false,
      fontScale: 1,
      soundNotifications: false,
      processingSound: false,
      readRepliesAloud: false,
      summarizeRepliesAloud: true,
      voiceConfigured: false,
      voiceSendPhrase: "grok send",
      voiceKeyterms: [],
      telemetryEnabled: true,
      thumbsFeedback: false,
      providers: [],
      // Host-owned, never latched locally: an older host that ignores
      // refreshProviders leaves this false and the button stays idle rather
      // than spinning on a refresh that is never coming.
      providersChecking: false,
      extVersion: "",
      cliVersion: "",
      hostKind: "",
      hostName: "",
      grokUpdate: null,
      mcpServers: [],
      mcpLoading: false,
      mcpError: "",
      mcpWarning: "",
      mcpConnectors: [],
      // NULL, not []. Routines can legitimately be empty, so "no routines" and
      // "the host has not answered yet" are different states and the page must
      // not show the invitation while it is still the second one. The connector
      // catalog gets away with treating empty as not-arrived because a fixed
      // Tier-1 list is never legitimately empty; this one is.
      routines: null,
      routineProjects: [],
      routineModels: [],
      routineError: "",
      routineErrorId: "",
      ...(partial || {}),
    };
  }

  const FOCUSABLE_SEL = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])";

  const PHONE_NAV_MQ = "(max-width: 520px)";

  function matchPhoneNav(doc) {
    const win = doc && doc.defaultView;
    return !!(win && win.matchMedia && win.matchMedia(PHONE_NAV_MQ).matches);
  }

  function focusableControls(root) {
    return Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE_SEL), (el) => {
      if (el.disabled) return false;
      if (typeof el.closest === "function" && el.closest("[hidden]")) return false;
      return el.getAttribute("tabindex") !== "-1";
    });
  }

  function describeFocus(container, el) {
    if (!el || !container.contains(el)) return null;
    if (el.id === "settings-search") {
      return {
        kind: "search",
        start: typeof el.selectionStart === "number" ? el.selectionStart : null,
        end: typeof el.selectionEnd === "number" ? el.selectionEnd : null,
      };
    }
    const row = typeof el.closest === "function" ? el.closest(".settings-row") : null;
    if (row && row.dataset.id) {
      if (el.tagName === "SELECT") return { kind: "control", id: row.dataset.id, sel: "select" };
      if (el.matches && el.matches("input[type=range]")) return { kind: "control", id: row.dataset.id, sel: "input[type=range]" };
      if (el.classList.contains("settings-switch")) return { kind: "control", id: row.dataset.id, sel: ".settings-switch" };
      if (el.classList.contains("settings-action")) return { kind: "control", id: row.dataset.id, sel: ".settings-action" };
      if (el.classList.contains("settings-text")) {
        return {
          kind: "control",
          id: row.dataset.id,
          sel: ".settings-text",
          start: typeof el.selectionStart === "number" ? el.selectionStart : null,
          end: typeof el.selectionEnd === "number" ? el.selectionEnd : null,
        };
      }
      if (el.classList.contains("settings-tags-input")) {
        return {
          kind: "control",
          id: row.dataset.id,
          sel: ".settings-tags-input",
          start: typeof el.selectionStart === "number" ? el.selectionStart : null,
          end: typeof el.selectionEnd === "number" ? el.selectionEnd : null,
        };
      }
    }
    if (el.classList.contains("settings-nav-item") && el.dataset.category) {
      return { kind: "nav", category: el.dataset.category };
    }
    if (el.classList.contains("settings-nav-select")) return { kind: "nav-select" };
    if (el.classList.contains("settings-restore")) return { kind: "restore" };
    if (el.classList.contains("settings-restore-confirm-go")) return { kind: "restore-go" };
    if (el.classList.contains("settings-restore-confirm-cancel")) return { kind: "restore-cancel" };
    if (el.classList.contains("settings-back")) return { kind: "back" };
    return null;
  }

  /** Focus plus whether the phone category <select> is the live control.
   *  Destroying that node while its native picker is open closes the picker. */
  function describeChrome(container) {
    const doc = container.ownerDocument;
    const active = doc && doc.activeElement;
    const focus = describeFocus(container, active);
    return {
      focus,
      navMenuOpen: !!(focus && focus.kind === "nav-select"),
    };
  }

  function applyFocus(container, desc) {
    if (!desc) return;
    let next = null;
    if (desc.kind === "search") next = container.querySelector("#settings-search");
    else if (desc.kind === "nav") {
      next = container.querySelector(`.settings-nav-item[data-category="${desc.category}"]`);
      if (next && typeof next.closest === "function" && next.closest("[hidden]")) {
        next = container.querySelector(".settings-nav-select");
      }
    }
    else if (desc.kind === "nav-select") {
      next = container.querySelector(".settings-nav-select");
      if (next && typeof next.closest === "function" && next.closest("[hidden]")) {
        next = container.querySelector(`.settings-nav-item[data-category="${next.value}"]`);
      }
    }
    else if (desc.kind === "restore") next = container.querySelector(".settings-restore");
    else if (desc.kind === "restore-go") next = container.querySelector(".settings-restore-confirm-go");
    else if (desc.kind === "restore-cancel") next = container.querySelector(".settings-restore-confirm-cancel");
    else if (desc.kind === "back") next = container.querySelector(".settings-back");
    else if (desc.kind === "control") {
      const row = container.querySelector(`.settings-row[data-id="${desc.id}"]`);
      next = row ? row.querySelector(desc.sel) : null;
    }
    if (!next || next.disabled) {
      // The focused control vanished or got disabled in this repaint (a live
      // update hid its row). Without a fallback, focus lands on BODY and the
      // modal containment leaks — fall back to search, then anything focusable.
      next = container.querySelector("#settings-search")
        || container.querySelector("button, [href], input, select, [tabindex]:not([tabindex='-1'])");
      if (!next) return;
      next.focus();
      return;
    }
    next.focus();
    if ((desc.kind === "search" || desc.sel === ".settings-text" || desc.sel === ".settings-tags-input") &&
        desc.start != null && typeof next.setSelectionRange === "function") {
      try { next.setSelectionRange(desc.start, desc.end != null ? desc.end : desc.start); } catch { /* */ }
    }
  }

  function coverSiblings(container, on) {
    const parent = container.parentElement;
    if (!parent) return;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === container) continue;
      if (on) {
        // Track ownership for BOTH attributes: cleanup must not strip an
        // inert some other surface set before settings opened.
        if (!sibling.hasAttribute("inert")) {
          sibling.setAttribute("inert", "");
          sibling.setAttribute("data-settings-inert", "1");
        }
        if (!sibling.hasAttribute("aria-hidden")) {
          sibling.setAttribute("aria-hidden", "true");
          sibling.setAttribute("data-settings-cover", "1");
        }
      } else {
        if (sibling.getAttribute("data-settings-inert") === "1") {
          sibling.removeAttribute("inert");
          sibling.removeAttribute("data-settings-inert");
        }
        if (sibling.getAttribute("data-settings-cover") === "1") {
          sibling.removeAttribute("aria-hidden");
          sibling.removeAttribute("data-settings-cover");
        }
      }
    }
  }

  function switchMarkup(on, disabled) {
    return `<button type="button" class="settings-switch${on ? " on" : ""}" role="switch" aria-checked="${on ? "true" : "false"}"${disabled ? " disabled" : ""}><span class="settings-switch-knob"></span></button>`;
  }

  function mcpDetail(server) {
    const parts = [];
    if (server.enabled === false) parts.push("Disabled");
    if (server.status) parts.push(server.status);
    if (Number.isFinite(server.toolCount)) {
      parts.push(`${server.toolCount} ${server.toolCount === 1 ? "tool" : "tools"}`);
    }
    if (server.url) parts.push(server.url);
    else if (server.command) parts.push([server.command].concat(server.args || []).join(" "));
    if (server.error) parts.push(server.error);
    return parts.join(" · ");
  }

  // Local config servers commonly report whether they are enabled but do not
  // include a health/status field. They are still usable in that state. An
  // explicit status (including an error or an in-progress state) remains the
  // authoritative display signal, and an explicit enabled:false must never
  // get a green dot from a stale "ready" status.
  function mcpServerIsReady(server) {
    if (server.enabled === false) return false;
    if (server.error || server.status === "unavailable") return false;
    return !server.status || server.status === "ready";
  }

  function mcpIsManagedServer(server) {
    return !!(server && (server.managed === true || server.source === "managed"));
  }

  function settingsMediaSibling(dir) {
    try {
      const scripts = document.getElementsByTagName("script");
      for (let i = 0; i < scripts.length; i++) {
        const src = scripts[i].src || "";
        if (src.indexOf("settings.js") !== -1) return new URL(dir, src).href;
      }
    } catch (_) { /* */ }
    return "";
  }

  /**
   * Connected first, then disconnected; each group A–Z by display name.
   * Display-only — TIER1_CONNECTORS order is left alone (hostMcpServers walks it).
   */
  function sortConnectorsForDisplay(connectors) {
    return (connectors || []).slice().sort((a, b) => {
      const ac = a && a.connected ? 0 : 1;
      const bc = b && b.connected ? 0 : 1;
      if (ac !== bc) return ac - bc;
      return String(a && a.name || "").localeCompare(String(b && b.name || ""), undefined, { sensitivity: "base" });
    });
  }

  function connectorLogoSrc(id) {
    if (!CONNECTOR_LOGO_IDS[id]) return "";
    const base = settingsMediaSibling("connector-logos/");
    if (!base) return "";
    return base + id + ".webp";
  }

  /** "github.com/settings/personal-access-tokens" from its URL — host plus
   *  path, without the scheme or a trailing slash. */
  function keyDocsLabel(url) {
    const text = String(url || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return text || String(url || "");
  }

  function appendConnectorLogo(titleEl, connector) {
    const src = connectorLogoSrc(connector && connector.id);
    if (!src) return;
    const chip = document.createElement("span");
    chip.className = "settings-connector-logo";
    chip.setAttribute("aria-hidden", "true");
    const img = document.createElement("img");
    img.alt = "";
    img.draggable = false;
    img.addEventListener("load", function () {
      chip.classList.add("is-ready");
    });
    img.addEventListener("error", function () {
      if (chip.parentNode) chip.parentNode.removeChild(chip);
      if (!titleEl.querySelector(".settings-connector-logo")) titleEl.classList.remove("has-logo");
    });
    img.src = src;
    chip.appendChild(img);
    titleEl.classList.add("has-logo");
    titleEl.insertBefore(chip, titleEl.firstChild);
  }

  function appendMcpServerRows(list, servers, opts) {
    for (const server of servers) {
      const row = document.createElement("div");
      row.className = "settings-mcp-server";
      const copy = document.createElement("div");
      copy.className = "settings-mcp-copy";
      const name = document.createElement("div");
      name.className = "settings-mcp-name settings-row-title";
      const status = document.createElement("span");
      status.className = "settings-mcp-status" + (mcpServerIsReady(server) ? " is-ready" : (server.error || server.status === "unavailable" ? " is-error" : ""));
      status.setAttribute("aria-hidden", "true");
      name.appendChild(status);
      const label = document.createElement("span");
      label.textContent = server.displayName || server.name;
      name.appendChild(label);
      if (opts.managed && server.scopeName) {
        const scope = document.createElement("span");
        scope.className = "settings-mcp-scope";
        scope.textContent = server.scopeName;
        name.appendChild(scope);
      }
      const detail = document.createElement("div");
      detail.className = "settings-row-desc";
      detail.textContent = mcpDetail(server) || (server.enabled ? "Enabled" : "Disabled");
      copy.append(name, detail);
      row.appendChild(copy);
      list.appendChild(row);
    }
  }

  function renderMcpSectionState(text, error) {
    const el = document.createElement("div");
    el.className = "settings-mcp-state" + (error ? " is-error" : "");
    if (error) el.setAttribute("role", "alert");
    else el.setAttribute("aria-live", "polite");
    el.textContent = text;
    return el;
  }

  function renderMcpCatalog(snapshot, env) {
    const el = document.createElement("div");
    el.className = "settings-mcp settings-mcp-split";
    el.dataset.id = "mcpCatalog";
    const servers = Array.isArray(snapshot.mcpServers) ? snapshot.mcpServers : [];
    const managed = servers.filter(mcpIsManagedServer);
    const local = servers.filter((server) => !mcpIsManagedServer(server));
    const loading = !!snapshot.mcpLoading;
    const error = snapshot.mcpError ? String(snapshot.mcpError) : "";

    const grokHead = document.createElement("div");
    grokHead.className = "settings-group-row";
    const grokTitle = document.createElement("h2");
    grokTitle.className = "settings-group";
    grokTitle.textContent = CONNECTOR_SECTION_GROK;
    grokHead.appendChild(grokTitle);
    const grokOpen = document.createElement("button");
    grokOpen.type = "button";
    grokOpen.className = "settings-action settings-mcp-web";
    grokOpen.dataset.href = GROK_CONNECTORS_URL;
    const grokIcon = document.createElement("span");
    grokIcon.className = "settings-file-icon";
    grokIcon.setAttribute("aria-hidden", "true");
    grokIcon.innerHTML = ICON_EXTERNAL_LINK;
    grokOpen.appendChild(grokIcon);
    grokOpen.appendChild(document.createTextNode("Open"));
    grokHead.appendChild(grokOpen);
    el.appendChild(grokHead);
    const grokBlurb = document.createElement("div");
    grokBlurb.className = "settings-mcp-warning";
    grokBlurb.textContent = CONNECTOR_BLURB_GROK;
    el.appendChild(grokBlurb);
    if (loading) {
      el.appendChild(renderMcpSectionState("Loading Grok connectors…"));
    } else if (error) {
      el.appendChild(renderMcpSectionState(error, true));
    } else if (!managed.length) {
      el.appendChild(renderMcpSectionState("No grok.com connectors reported."));
    } else {
      const grokList = document.createElement("div");
      grokList.className = "settings-mcp-list";
      appendMcpServerRows(grokList, managed, { managed: true });
      el.appendChild(grokList);
    }

    const localHead = document.createElement("div");
    localHead.className = "settings-group-row";
    const localTitle = document.createElement("h2");
    localTitle.className = "settings-group";
    localTitle.textContent = CONNECTOR_SECTION_LOCAL;
    localHead.appendChild(localTitle);
    if (!(env && env.isRemote)) {
      const localOpen = document.createElement("button");
      localOpen.type = "button";
      localOpen.className = "settings-action settings-mcp-open";
      localOpen.title = "config.toml";
      const localIcon = document.createElement("span");
      localIcon.className = "settings-file-icon";
      localIcon.setAttribute("aria-hidden", "true");
      localIcon.innerHTML = ICON_SETTINGS;
      localOpen.appendChild(localIcon);
      localOpen.appendChild(document.createTextNode("Open"));
      localHead.appendChild(localOpen);
    }
    el.appendChild(localHead);
    const localBlurb = document.createElement("div");
    localBlurb.className = "settings-mcp-warning";
    localBlurb.textContent = env && env.isRemote ? CONNECTOR_BLURB_LOCAL_REMOTE : CONNECTOR_BLURB_LOCAL;
    el.appendChild(localBlurb);
    if (loading) {
      el.appendChild(renderMcpSectionState("Loading Grok connectors…"));
    } else if (error) {
      el.appendChild(renderMcpSectionState(error, true));
    } else if (!local.length) {
      el.appendChild(renderMcpSectionState("No local Grok connectors reported."));
    } else {
      const localList = document.createElement("div");
      localList.className = "settings-mcp-list";
      appendMcpServerRows(localList, local, {});
      el.appendChild(localList);
    }
    return el;
  }

  function isKeyConnectorView(connector) {
    return !!(connector && connector.auth === "key");
  }

  function canManageConnectors(snapshot, env) {
    return !(env && env.isRemote) || snapshot.mcpRemoteConnect === true;
  }

  function connectorDescription(connector, env, snapshot) {
    if (connector.status === "connecting") {
      return isKeyConnectorView(connector)
        ? "Checking the token…"
        : "Waiting for the browser sign-in to finish…";
    }
    if (connector.status === "error" && connector.error) return connector.error;
    if (env && env.isRemote && !canManageConnectors(snapshot, env)) {
      if (isKeyConnectorView(connector) && connector.connected && connector.keySet !== true) {
        return connector.description + " Connected, but no key on the desk.";
      }
      return connector.connected
        ? connector.description + " Connected on the desk machine."
        : connector.description + " Sign-in happens on the desk.";
    }
    if (isKeyConnectorView(connector) && connector.connected && connector.keySet === true) {
      return connector.description + " Key is set. Applies to new conversations and when you reopen one.";
    }
    if (isKeyConnectorView(connector) && connector.connected) {
      return connector.description + " Connected, but no key on this machine. Paste a token to use it here.";
    }
    if (connector.connected) {
      return connector.description + " Applies to new conversations and when you reopen one.";
    }
    if (isKeyConnectorView(connector) && connector.keyHint) return connector.keyHint;
    return connector.description;
  }

  function renderConnectorKeyForm(connector, keyForm) {
    const form = document.createElement("div");
    form.className = "settings-connector-key";
    const input = document.createElement("input");
    input.type = "password";
    input.className = "settings-text settings-connector-key-input";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", connector.name + " personal access token");
    input.placeholder = "Paste token";
    input.value = keyForm && keyForm.id === connector.id ? String(keyForm.value || "") : "";
    input.dataset.id = connector.id;
    form.appendChild(input);
    if (connector.keyDocsUrl) {
      const hint = document.createElement("div");
      hint.className = "settings-connector-key-hint";
      hint.appendChild(document.createTextNode("Get a token at "));
      const link = document.createElement("a");
      link.className = "settings-connector-key-docs";
      link.href = connector.keyDocsUrl;
      // Derived from the href, never hardcoded: this line said
      // "github.com/settings/personal-access-tokens" under EVERY key
      // connector, so Zapier pointed its users at GitHub.
      link.textContent = keyDocsLabel(connector.keyDocsUrl);
      link.dataset.href = connector.keyDocsUrl;
      hint.appendChild(link);
      hint.appendChild(document.createTextNode("."));
      form.appendChild(hint);
    }
    const readonly = document.createElement("label");
    readonly.className = "settings-connector-readonly";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "settings-connector-readonly-input";
    box.dataset.id = connector.id;
    box.checked = !!(keyForm && keyForm.id === connector.id ? keyForm.readOnly : connector.readOnly);
    readonly.appendChild(box);
    readonly.appendChild(document.createTextNode("Read-only (the agent can look, not write)"));
    form.appendChild(readonly);
    const actions = document.createElement("div");
    actions.className = "settings-connector-key-actions";
    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "settings-action settings-connector-key-submit";
    submit.dataset.id = connector.id;
    submit.textContent = connector.connected ? "Save key" : "Connect";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "settings-action settings-connector-key-cancel";
    cancel.dataset.id = connector.id;
    cancel.textContent = "Cancel";
    actions.append(submit, cancel);
    form.appendChild(actions);
    return form;
  }

  function renderConnectorsCatalog(snapshot, env, keyForm) {
    const el = document.createElement("div");
    el.className = "settings-mcp";
    el.dataset.id = "connectorsCatalog";
    const warning = document.createElement("div");
    warning.className = "settings-mcp-warning";
    const canManage = canManageConnectors(snapshot, env);
    warning.textContent = env && env.isRemote
      ? (canManage ? CONNECTOR_BLURB_HERE_REMOTE_CONNECT : CONNECTOR_BLURB_HERE_REMOTE)
      : CONNECTOR_BLURB_HERE;
    el.appendChild(warning);
    const connectors = sortConnectorsForDisplay(
      Array.isArray(snapshot.mcpConnectors) ? snapshot.mcpConnectors : [],
    );
    if (!connectors.length) {
      const empty = document.createElement("div");
      empty.className = "settings-mcp-state";
      empty.textContent = "Connector list has not arrived from the host yet.";
      el.appendChild(empty);
      return el;
    }
    const list = document.createElement("div");
    list.className = "settings-mcp-list";
    for (const connector of connectors) {
      const row = document.createElement("div");
      row.className = "settings-row settings-connector" + (connector.connected ? " is-connected" : "");
      row.dataset.id = "connector-" + connector.id;
      row.dataset.auth = isKeyConnectorView(connector) ? "key" : "oauth";
      const copy = document.createElement("div");
      copy.className = "settings-row-copy";
      const name = document.createElement("div");
      name.className = "settings-row-title";
      appendConnectorLogo(name, connector);
      const status = document.createElement("span");
      status.className = "settings-mcp-status" + (connector.connected ? " is-ready" : (connector.status === "error" ? " is-error" : ""));
      status.setAttribute("aria-hidden", "true");
      name.appendChild(status);
      name.appendChild(document.createTextNode(connector.name));
      const desc = document.createElement("div");
      desc.className = "settings-row-desc";
      desc.textContent = connectorDescription(connector, env, snapshot);
      copy.append(name, desc);
      const control = document.createElement("div");
      control.className = "settings-row-control";
      const connecting = connector.status === "connecting";
      const authorization = snapshot.mcpConnectorAuthorization;
      const formOpen = !!(keyForm && keyForm.id === connector.id);
      if (canManage) {
        if (isKeyConnectorView(connector) && connector.connected && !formOpen) {
          const replace = document.createElement("button");
          replace.type = "button";
          replace.className = "settings-action settings-connector-key-open";
          replace.dataset.id = connector.id;
          replace.dataset.action = "replace";
          replace.textContent = connector.keySet === true ? "Replace" : "Paste token";
          replace.disabled = connecting;
          control.appendChild(replace);
        }
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "settings-action settings-connector-action";
        btn.dataset.id = connector.id;
        btn.dataset.auth = isKeyConnectorView(connector) ? "key" : "oauth";
        btn.dataset.connected = connector.connected ? "true" : "false";
        if (connector.connected) btn.title = CONNECTOR_DISCONNECT_COPY;
        if (isKeyConnectorView(connector) && !connector.connected) {
          btn.textContent = connecting ? "Connecting…" : (formOpen ? "Cancel" : "Connect");
          btn.dataset.action = formOpen ? "cancel" : "open";
        } else {
          btn.textContent = connecting ? "Connecting…" : (connector.connected ? "Disconnect" : "Connect");
        }
        btn.disabled = connecting;
        if (connecting) btn.setAttribute("aria-busy", "true");
        control.appendChild(btn);
      } else {
        const span = document.createElement("span");
        span.className = "settings-value";
        span.textContent = connector.connected ? "Connected" : "Not connected";
        control.appendChild(span);
      }
      row.append(copy, control);
      if (canManage && isKeyConnectorView(connector) && connector.connected && connector.keySet === true && !formOpen) {
        const readonly = document.createElement("label");
        readonly.className = "settings-connector-readonly settings-connector-readonly-live";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.className = "settings-connector-readonly-input";
        box.dataset.id = connector.id;
        box.dataset.live = "true";
        box.checked = connector.readOnly === true;
        box.disabled = connecting;
        readonly.appendChild(box);
        readonly.appendChild(document.createTextNode("Read-only (the agent can look, not write)"));
        row.appendChild(readonly);
      }
      if (canManage && isKeyConnectorView(connector) && formOpen && !connecting) {
        row.appendChild(renderConnectorKeyForm(connector, keyForm));
      }
      if (canManage && authorization && authorization.id === connector.id) {
        const form = document.createElement("div");
        form.className = "settings-connector-key settings-connector-oauth";
        if (authorization.error) form.appendChild(renderMcpSectionState(authorization.error, true));
        if (authorization.status === "waiting" && authorization.url) {
          const link = document.createElement("a");
          link.className = "settings-action is-primary settings-connector-oauth-link";
          link.href = authorization.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = "Open sign-in";
          form.appendChild(link);
          form.appendChild(renderMcpSectionState("Approve access, then return here. Connection completes automatically."));
        }
        row.appendChild(form);
      }
      list.appendChild(row);
    }
    el.appendChild(list);
    return el;
  }

  /* ----------------------------------------------------------- routines */

  // Which row is open, and the draft being edited in it. Module-level so a
  // snapshot arriving mid-edit (another window saved something) re-renders the
  // list without throwing away what is half-typed here.
  const ROUTINE_UI = { open: "", draft: null, confirmRemove: "", pendingSave: false };

  /** The provider row waiting on the host, if any. One at a time: it exists to
   *  stop the second click, so a second pending row would be a contradiction. */
  const PROVIDER_PENDING = { id: "", label: "", wanted: false, at: 0 };
  /** Desk-only: a terminal sign-in was launched from this row. The host cannot
   *  observe that terminal finishing, so the row offers Re-check connection
   *  instead of guessing. */
  const PROVIDER_TERMINAL = { id: "" };
  /** Longer than the host's own 30s CLI timeout plus a relay round trip, so in
   *  every case this covers, the real answer arrives first. */
  const PROVIDER_PENDING_MS = 45000;

  function clearProviderPending() {
    PROVIDER_PENDING.id = "";
    PROVIDER_PENDING.label = "";
  }

  function clearProviderTerminal() {
    PROVIDER_TERMINAL.id = "";
  }

  /** Drop the pending label once the host has answered — or given up. */
  function reconcileProviderPending(snapshot) {
    if (!PROVIDER_PENDING.id) return;
    if (Date.now() - PROVIDER_PENDING.at > PROVIDER_PENDING_MS) { clearProviderPending(); return; }
    if (providerConnectedNow(snapshot, PROVIDER_PENDING.id) === PROVIDER_PENDING.wanted) {
      clearProviderPending();
    }
  }

  function reconcileProviderTerminal(snapshot) {
    if (!PROVIDER_TERMINAL.id) return;
    if (providerConnectedNow(snapshot, PROVIDER_TERMINAL.id)) clearProviderTerminal();
  }

  function providerPendingLabel(row) {
    return row && row.provider && PROVIDER_PENDING.id === row.provider ? PROVIDER_PENDING.label : "";
  }
  const NEW_ROUTINE = "__new__";

  const PROVIDER_LABELS = { grok: "Grok", codex: "Codex", claude: "Claude" };
  function providerLabel(provider) {
    return PROVIDER_LABELS[provider] || provider;
  }

  /** First model of `provider`, else the first model at all. Mirrors the
   *  composer: a new conversation in a project starts on that project default
   *  provider, and a routine is a new conversation on a timer. */
  function defaultModelFor(models, provider) {
    // Prefer a CONCRETE model. The host now sends each provider's empty-model
    // sentinel first, so taking models[0] would start every new routine on
    // "use the agent's default" — the one option the composer never offers, and
    // the opposite of the parity this is supposed to give.
    const real = models.filter(function (m) { return !!m.model; });
    return real.find(function (m) { return m.provider === provider; })
      || models.find(function (m) { return m.provider === provider; })
      || real[0]
      || models[0]
      || null;
  }

  function blankRoutineDraft(snapshot) {
    const projects = Array.isArray(snapshot.routineProjects) ? snapshot.routineProjects : [];
    const models = Array.isArray(snapshot.routineModels) ? snapshot.routineModels : [];
    const project = projects[0];
    const pick = defaultModelFor(models, project && project.defaultProvider);
    return {
      id: "",
      title: "",
      prompt: "",
      cwd: project ? project.cwd : "",
      provider: pick ? pick.provider : "",
      model: pick ? pick.model : "",
      every: 1,
      unit: "days",
      at: "09:00",
    };
  }

  function routineDraftFrom(routine) {
    return {
      id: routine.id,
      title: routine.title,
      prompt: routine.prompt,
      cwd: routine.cwd,
      provider: routine.provider,
      model: routine.model,
      every: routine.cadence.every,
      unit: routine.cadence.unit,
      at: routine.cadence.at || "09:00",
    };
  }

  function draftToMessage(draft) {
    const cadence = { every: Number(draft.every) || 1, unit: draft.unit };
    if (draft.unit === "days") cadence.at = draft.at || "09:00";
    return {
      type: "saveRoutine",
      ...(draft.id ? { id: draft.id } : {}),
      draft: {
        title: draft.title,
        prompt: draft.prompt,
        cwd: draft.cwd,
        provider: draft.provider,
        model: draft.model,
        cadence,
      },
    };
  }

  /**
   * "in 42m" / "in 6h 12m" / "in 3d 4h". Floors rather than rounds, so a
   * countdown never claims more time than is left.
   *
   * Deliberately duplicated rather than shared: the VS Code settings TAB loads
   * this file and nothing else, so it cannot reach webview-helpers.js. Pinned
   * by test/settings-routines.dom.test.ts along with its sibling.
   */
  function formatRoutineCountdown(ms) {
    if (!Number.isFinite(ms)) return "";
    if (ms <= 0) return "due now";
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return "in " + Math.max(1, mins) + "m";
    const hours = Math.floor(mins / 60);
    if (hours < 24) {
      const rem = mins % 60;
      return rem ? "in " + hours + "h " + rem + "m" : "in " + hours + "h";
    }
    const days = Math.floor(hours / 24);
    const remH = hours % 24;
    return remH ? "in " + days + "d " + remH + "h" : "in " + days + "d";
  }

  function routineRunLabel(run) {
    if (run.outcome === "ran") return "Ran";
    if (run.outcome === "running") return "Running now";
    if (run.outcome === "skipped") return run.detail || "Skipped";
    if (run.outcome === "interrupted") return run.detail || "Interrupted";
    return run.detail || "Failed";
  }

  function routineRunTime(run) {
    try {
      return new Date(run.startedAt).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      });
    } catch (_) {
      return "";
    }
  }

  /** The run strip — the health signal, and the only place this page spends any
   *  boldness. State is carried by HEIGHT and WIDTH as well as hue, so it
   *  survives a greyscale screenshot and a colourblind reader. */
  function renderRoutineStrip(routine) {
    const strip = document.createElement("span");
    strip.className = "settings-routine-strip";
    const runs = (routine.runs || []).slice().reverse(); // oldest left, newest right
    for (const run of runs) {
      const tick = document.createElement("button");
      tick.type = "button";
      tick.className = "settings-routine-tick is-" + run.outcome;
      tick.title = routineRunLabel(run) + " · " + routineRunTime(run);
      tick.setAttribute("aria-label", tick.title);
      if (run.sessionId) {
        tick.dataset.session = run.sessionId;
        // The run's OWN project, not the routine's current one — repointing a
        // routine must not break the links to what already ran.
        tick.dataset.cwd = run.cwd || routine.cwd;
      }
      strip.appendChild(tick);
    }
    const count = document.createElement("span");
    count.className = "settings-routine-count";
    const health = routine.health || { ran: 0, total: 0 };
    count.textContent = health.total ? health.ran + "/" + health.total : "no runs yet";
    const wrap = document.createElement("span");
    wrap.className = "settings-routine-strip-wrap";
    wrap.append(strip, count);
    return wrap;
  }

  function labelledField(labelText, control, hintText) {
    const field = document.createElement("label");
    field.className = "settings-routine-field";
    const label = document.createElement("span");
    label.className = "settings-routine-label";
    label.textContent = labelText;
    field.append(label, control);
    if (hintText) {
      const hint = document.createElement("span");
      hint.className = "settings-routine-hint";
      hint.textContent = hintText;
      field.appendChild(hint);
    }
    return field;
  }

  function renderRoutineForm(draft, snapshot, isNew) {
    const body = document.createElement("div");
    body.className = "settings-routine-body";

    const name = document.createElement("input");
    name.type = "text";
    name.className = "settings-routine-input";
    name.value = draft.title;
    name.placeholder = "Morning brief";
    name.dataset.field = "title";
    body.appendChild(labelledField("Name", name));

    const prompt = document.createElement("textarea");
    prompt.className = "settings-routine-input settings-routine-prompt";
    prompt.value = draft.prompt;
    prompt.rows = 4;
    prompt.placeholder = "Summarise what changed in this repo since your last run.";
    prompt.dataset.field = "prompt";
    body.appendChild(
      labelledField("Prompt", prompt, "Sent as the first message of a new session."),
    );

    const pair = document.createElement("div");
    pair.className = "settings-routine-pair";

    const projects = Array.isArray(snapshot.routineProjects) ? snapshot.routineProjects : [];
    const project = document.createElement("select");
    project.className = "settings-routine-input";
    project.dataset.field = "cwd";
    for (const p of projects) {
      const opt = document.createElement("option");
      opt.value = p.cwd;
      opt.textContent = p.archived ? p.label + " (archived)" : p.label;
      if (p.cwd === draft.cwd) opt.selected = true;
      project.appendChild(opt);
    }
    if (!projects.some((p) => p.cwd === draft.cwd) && draft.cwd) {
      const opt = document.createElement("option");
      opt.value = draft.cwd;
      opt.textContent = draft.cwd + " (unavailable)";
      opt.selected = true;
      project.appendChild(opt);
    }
    pair.appendChild(labelledField("Project", project));

    const models = Array.isArray(snapshot.routineModels) ? snapshot.routineModels : [];
    const model = document.createElement("select");
    model.className = "settings-routine-input";
    model.dataset.field = "model";
    // Grouped by provider. A native <select> cannot carry an icon, but an
    // optgroup says the same thing and needs no custom dropdown.
    // "<Provider> default" is the empty-model sentinel. The composer never
    // shows it once real models are known, and beside them it is clutter — worse
    // beside Claude, which has a model literally called "Default". So it is
    // rendered only when it is the ONLY thing that provider offers, or when this
    // routine is already saved on it, which keeps an existing one editable
    // instead of silently re-pointing it at a concrete model.
    const hasReal = {};
    for (const m of models) if (m.model) hasReal[m.provider] = true;
    const shown = models.filter(function (m) {
      if (m.model) return true;
      if (!hasReal[m.provider]) return true;
      return m.provider === draft.provider && !draft.model;
    });

    let group = null;
    let groupProvider = "";
    for (const m of shown) {
      if (m.provider !== groupProvider) {
        groupProvider = m.provider;
        group = document.createElement("optgroup");
        group.label = providerLabel(m.provider);
        model.appendChild(group);
      }
      const opt = document.createElement("option");
      opt.value = m.provider + " " + m.model;
      opt.textContent = m.label;
      if (m.provider === draft.provider && m.model === draft.model) opt.selected = true;
      (group || model).appendChild(opt);
    }
    pair.appendChild(
      labelledField(
        "Model",
        model,
        // "No model" would be wrong twice over: a provider with no cached
        // model list still offers its default, so an empty list can only mean
        // no PROVIDER is connected at all.
        models.length ? "Only connected models are listed." : "No provider connected.",
      ),
    );
    body.appendChild(pair);

    const cadence = document.createElement("div");
    cadence.className = "settings-routine-cadence";
    const every = document.createElement("span");
    every.className = "settings-routine-word";
    every.textContent = "Every";
    const count = document.createElement("input");
    count.type = "number";
    count.min = "1";
    count.className = "settings-routine-input settings-routine-count-input";
    count.value = String(draft.every);
    count.dataset.field = "every";
    const unit = document.createElement("select");
    unit.className = "settings-routine-input";
    unit.dataset.field = "unit";
    for (const u of ["minutes", "hours", "days"]) {
      const opt = document.createElement("option");
      opt.value = u;
      opt.textContent = u;
      if (u === draft.unit) opt.selected = true;
      unit.appendChild(opt);
    }
    cadence.append(every, count, unit);
    if (draft.unit === "days") {
      const at = document.createElement("span");
      at.className = "settings-routine-word";
      at.textContent = "at";
      const time = document.createElement("input");
      time.type = "time";
      time.className = "settings-routine-input settings-routine-time";
      time.value = draft.at || "09:00";
      time.dataset.field = "at";
      cadence.append(at, time);
    }
    body.appendChild(
      labelledField(
        "Cadence",
        cadence,
        draft.unit === "days"
          ? "Anchored to the clock, so it holds through daylight saving."
          : "At most once every 15 minutes.",
      ),
    );

    // An id-less error belongs to whichever form is open. The host names the
    // routine it refused; a relay bounce cannot, because it never reached the
    // host — and only one form is open at a time, so the open one is the asker.
    const errorId = snapshot.routineErrorId || "";
    if (snapshot.routineError && (!errorId || errorId === (draft.id || ""))) {
      const err = document.createElement("div");
      err.className = "settings-routine-error";
      err.textContent = snapshot.routineError;
      body.appendChild(err);
    }
    return body;
  }

  function renderRoutineRuns(routine) {
    const wrap = document.createElement("div");
    wrap.className = "settings-routine-runs";
    const head = document.createElement("div");
    head.className = "settings-routine-runs-head";
    head.textContent = routine.runs.length
      ? "Last " + routine.runs.length + (routine.runs.length === 1 ? " run" : " runs")
      : "No runs yet";
    wrap.appendChild(head);
    for (const run of routine.runs) {
      const line = document.createElement("div");
      line.className = "settings-routine-run is-" + run.outcome;
      const bar = document.createElement("span");
      bar.className = "settings-routine-run-bar";
      const when = document.createElement("time");
      when.textContent = routineRunTime(run);
      const what = document.createElement("span");
      what.className = "settings-routine-run-what";
      if (run.sessionId && run.outcome === "ran") {
        const link = document.createElement("button");
        link.type = "button";
        link.className = "settings-routine-open";
        link.dataset.session = run.sessionId;
        link.dataset.cwd = run.cwd || routine.cwd;
        link.textContent = "Ran — open session";
        what.appendChild(link);
      } else {
        what.textContent = routineRunLabel(run);
      }
      line.append(bar, when, what);
      wrap.appendChild(line);
    }
    return wrap;
  }

  /**
   * Who has to be running, said from where the reader is standing.
   *
   * "a window is open" named nothing the reader controls. It is also not simply
   * "this IDE": routines fire if ANY host on the machine is running, so an
   * editor-only sentence would be wrong whenever the desktop app is up, and on
   * a phone — which never runs them — it would be wrong always.
   */
  function routinesHostNote(env) {
    if (env && env.isRemote) {
      return "Routines run on your computer, while the desktop app or an editor window is open.";
    }
    if (env && env.isDesktop) {
      return "Routines run while this app or an editor window is open. Nothing runs once they are all closed.";
    }
    return "Routines run while this IDE or the desktop app is open. Nothing runs once they are all closed.";
  }

  function renderRoutines(snapshot, env) {
    const el = document.createElement("div");
    el.className = "settings-routines";
    el.dataset.id = "routinesList";

    const lease = document.createElement("div");
    lease.className = "settings-routines-note";
    lease.textContent = routinesHostNote(env);
    el.appendChild(lease);

    const routines = Array.isArray(snapshot.routines) ? snapshot.routines : null;
    if (!routines) {
      const wait = document.createElement("div");
      wait.className = "settings-routines-loading";
      wait.textContent = "Loading routines…";
      el.appendChild(wait);
      return el;
    }

    // The host answers every write with a fresh frame. One carrying no error is
    // a confirmed save, so the create form has done its job and must close —
    // left open with the same text it reads as "that did not work", and the
    // second press creates a duplicate routine.
    if (ROUTINE_UI.pendingSave && !snapshot.routineError) {
      ROUTINE_UI.pendingSave = false;
      if (ROUTINE_UI.open === NEW_ROUTINE) {
        ROUTINE_UI.open = "";
        ROUTINE_UI.draft = null;
      }
    } else if (ROUTINE_UI.pendingSave) {
      ROUTINE_UI.pendingSave = false;
    }

    if (!routines.length && ROUTINE_UI.open !== NEW_ROUTINE) {
      const empty = document.createElement("div");
      empty.className = "settings-routines-empty";
      const h = document.createElement("div");
      h.className = "settings-routines-empty-title";
      h.textContent = "No routines yet";
      const p = document.createElement("div");
      p.className = "settings-routines-empty-copy";
      p.textContent =
        "A routine sends one prompt to one project on a schedule you set — a morning summary of what changed, or a weekly dependency check. Each run becomes a session, and the last twenty stay here so you can see it working.";
      const add = document.createElement("button");
      add.type = "button";
      add.className = "settings-action settings-routine-new";
      add.textContent = "New routine";
      empty.append(h, p, add);
      el.appendChild(empty);
      return el;
    }

    const list = document.createElement("div");
    list.className = "settings-routines-list";

    if (ROUTINE_UI.open === NEW_ROUTINE) {
      const draft = ROUTINE_UI.draft || blankRoutineDraft(snapshot);
      ROUTINE_UI.draft = draft;
      const card = document.createElement("div");
      card.className = "settings-routine is-open is-new";
      card.dataset.routine = NEW_ROUTINE;
      const head = document.createElement("div");
      head.className = "settings-routine-head";
      const title = document.createElement("span");
      title.className = "settings-routine-name";
      title.textContent = "New routine";
      head.appendChild(title);
      card.appendChild(head);
      card.appendChild(renderRoutineForm(draft, snapshot, true));
      const foot = document.createElement("div");
      foot.className = "settings-routine-foot";
      const save = document.createElement("button");
      save.type = "button";
      save.className = "settings-action is-primary settings-routine-save";
      save.textContent = "Create routine";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "settings-action settings-routine-cancel";
      cancel.textContent = "Cancel";
      foot.append(save, cancel);
      card.appendChild(foot);
      list.appendChild(card);
    }

    for (const routine of routines) {
      const open = ROUTINE_UI.open === routine.id;
      const card = document.createElement("div");
      card.className =
        "settings-routine" + (open ? " is-open" : "") + (routine.paused ? " is-paused" : "");
      card.dataset.routine = routine.id;

      const head = document.createElement("button");
      head.type = "button";
      head.className = "settings-routine-head settings-routine-toggle";
      head.setAttribute("aria-expanded", open ? "true" : "false");

      const ident = document.createElement("span");
      ident.className = "settings-routine-ident";
      const name = document.createElement("span");
      name.className = "settings-routine-name";
      name.textContent = routine.title;
      if (routine.paused) {
        const tag = document.createElement("span");
        tag.className = "settings-routine-tag";
        tag.textContent = "Paused";
        name.appendChild(tag);
      }
      const meta = document.createElement("span");
      meta.className = "settings-routine-meta";
      const bits = [routine.projectLabel, routine.cadenceLabel];
      const modelRow = (Array.isArray(snapshot.routineModels) ? snapshot.routineModels : []).find(
        (m) => m.provider === routine.provider && m.model === routine.model,
      );
      bits.push(modelRow ? modelRow.label : routine.model);
      meta.textContent = bits.join(" · ");
      ident.append(name, meta);

      const next = document.createElement("span");
      next.className = "settings-routine-next";
      next.textContent = routine.paused ? "Paused" : formatRoutineCountdown(routine.nextRunAt - Date.now());

      const chev = document.createElement("span");
      chev.className = "settings-routine-chev";
      chev.setAttribute("aria-hidden", "true");
      chev.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';

      head.append(ident, renderRoutineStrip(routine), next, chev);
      card.appendChild(head);

      if (open) {
        const draft = ROUTINE_UI.draft && ROUTINE_UI.draft.id === routine.id
          ? ROUTINE_UI.draft
          : routineDraftFrom(routine);
        ROUTINE_UI.draft = draft;
        card.appendChild(renderRoutineForm(draft, snapshot, false));
        card.appendChild(renderRoutineRuns(routine));

        const foot = document.createElement("div");
        foot.className = "settings-routine-foot";
        const left = document.createElement("span");
        left.className = "settings-routine-foot-left";
        const save = document.createElement("button");
        save.type = "button";
        save.className = "settings-action is-primary settings-routine-save";
        save.textContent = "Save changes";
        const pause = document.createElement("button");
        pause.type = "button";
        pause.className = "settings-action settings-routine-pause";
        pause.dataset.paused = routine.paused ? "1" : "";
        pause.textContent = routine.paused ? "Resume" : "Pause";
        const runNow = document.createElement("button");
        runNow.type = "button";
        runNow.className = "settings-action settings-routine-run-now";
        runNow.textContent = "Run now";
        left.append(save, pause, runNow);

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "settings-action is-danger settings-routine-remove";
        remove.textContent =
          ROUTINE_UI.confirmRemove === routine.id ? "Remove for good" : "Remove";
        foot.append(left, remove);
        card.appendChild(foot);
      }
      list.appendChild(card);
    }

    el.appendChild(list);

    if (ROUTINE_UI.open !== NEW_ROUTINE) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "settings-action settings-routine-new";
      add.textContent = "New routine";
      el.appendChild(add);
    }
    return el;
  }

  function appendGithubLoginFlow(el, snapshot, opts) {
    const g = githubOf(snapshot);
    const flow = g && g.loginFlow;
    const status = (flow && flow.status) || (opts && opts.pending ? "starting" : "");
    if (status !== "starting" && status !== "waiting") return;
    const box = document.createElement("div");
    box.className = "settings-github-flow";
    box.dataset.status = status;
    if (status === "starting") {
      const heading = document.createElement("div");
      heading.className = "settings-github-flow-heading";
      heading.textContent = "Connecting GitHub";
      const p = document.createElement("p");
      p.className = "settings-github-flow-desc";
      p.textContent = opts && opts.terminal
        ? "A terminal opened for GitHub sign-in. When it finishes, re-check."
        : "Asking the GitHub CLI for a sign-in code…";
      box.appendChild(heading);
      box.appendChild(p);
    } else {
      const heading = document.createElement("div");
      heading.className = "settings-github-flow-heading";
      heading.textContent = "Finish signing in to GitHub";
      const p = document.createElement("p");
      p.className = "settings-github-flow-desc";
      p.textContent = flow.code
        ? "Open the link, then confirm this code:"
        : "Open the link to finish signing in.";
      box.appendChild(heading);
      box.appendChild(p);
      if (flow.code) {
        const cmd = document.createElement("div");
        cmd.className = "settings-github-flow-cmd";
        const code = document.createElement("code");
        code.textContent = flow.code;
        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "settings-github-flow-copy";
        copy.textContent = "Copy";
        copy.addEventListener("click", function (e) {
          e.stopPropagation();
          if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") return;
          navigator.clipboard.writeText(flow.code).then(function () {
            copy.textContent = "Copied";
            setTimeout(function () { copy.textContent = "Copy"; }, 1500);
          }).catch(function () { /* clipboard blocked */ });
        });
        cmd.appendChild(code);
        cmd.appendChild(copy);
        box.appendChild(cmd);
      }
      if (flow.url && /^https?:\/\//i.test(flow.url)) {
        const open = document.createElement("a");
        open.className = "onb-action settings-github-flow-open";
        open.href = flow.url;
        open.target = "_blank";
        open.rel = "noopener noreferrer";
        open.textContent = "Open the sign-in page";
        box.appendChild(open);
      }
      const note = document.createElement("p");
      note.className = "settings-github-flow-note";
      note.textContent = "Keep this page open — it finishes on its own.";
      box.appendChild(note);
    }
    if (opts && opts.terminal) {
      const recheck = document.createElement("button");
      recheck.type = "button";
      // Deliberately NOT `settings-action`: the row binder treats that class as
      // the row's primary control, so this button was firing Connect — opening
      // a SECOND sign-in terminal — before its own listener could ask for a
      // refresh. It styles itself completely, so the class bought nothing.
      recheck.className = "settings-github-flow-recheck";
      recheck.textContent = "Re-check connection";
      box.appendChild(recheck);
    }
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "settings-github-flow-cancel";
    cancel.textContent = "Cancel";
    box.appendChild(cancel);
    el.appendChild(box);
  }

  function appendGithubAdvanced(el) {
    const link = document.createElement("button");
    link.type = "button";
    link.className = "settings-github-advanced";
    link.textContent = "Use a token instead";
    el.appendChild(link);
  }

  function appendGithubTokenForm(el, githubTokenForm) {
    if (!githubTokenForm || !githubTokenForm.open) return;
    const form = document.createElement("div");
    form.className = "settings-github-token";
    const hint = document.createElement("p");
    hint.className = "settings-github-token-hint";
    fillGithubTokenHint(hint);
    const input = document.createElement("input");
    input.type = "password";
    input.className = "settings-github-token-input";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", "GitHub token");
    input.value = githubTokenForm.value || "";
    const actions = document.createElement("div");
    actions.className = "settings-github-token-actions";
    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "settings-action settings-github-token-submit";
    submit.textContent = "Connect with token";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "settings-action settings-github-token-cancel";
    cancel.textContent = "Cancel";
    actions.appendChild(submit);
    actions.appendChild(cancel);
    form.appendChild(hint);
    form.appendChild(input);
    form.appendChild(actions);
    el.appendChild(form);
  }

  function renderRow(row, snapshot, env, keyForm, githubTokenForm, githubCliStarted) {
    if (row.kind === "mcp") return renderMcpCatalog(snapshot, env);
    if (row.kind === "connectors") return renderConnectorsCatalog(snapshot, env, keyForm);
    if (row.kind === "routines") return renderRoutines(snapshot, env);
    const el = document.createElement("div");
    el.className = "settings-row";
    el.dataset.id = row.id;
    el.dataset.kind = row.kind || "";
    const enabled = rowEnabled(row, snapshot);
    if (!enabled) el.classList.add("is-disabled");
    const title = document.createElement("div");
    title.className = "settings-row-copy";
    const name = document.createElement("div");
    name.className = "settings-row-title";
    // The mark rides the title rather than a column of its own: the row is a
    // two-column grid (copy | control) and a third column would re-space every
    // other page. has-logo carries the flex, so rows without one are untouched.
    const logoMark = row.logo ? providerLogoMarkup(row.logo) : (row.icon ? ROW_ICONS[row.icon] || "" : "");
    if (logoMark) {
      name.classList.add("has-logo");
      const mark = document.createElement("span");
      mark.className = "settings-row-logo";
      mark.setAttribute("aria-hidden", "true");
      mark.innerHTML = logoMark;
      name.appendChild(mark);
      name.appendChild(document.createTextNode(rowTitle(row, snapshot, env)));
    } else {
      name.textContent = rowTitle(row, snapshot, env);
    }
    // Whose product this is, beside its name — provenance, not identity, so it
    // does not take the title's weight.
    if (row.vendor) {
      const vendor = document.createElement("span");
      vendor.className = "settings-row-vendor";
      vendor.textContent = " by " + row.vendor;
      name.appendChild(vendor);
    }
    const desc = document.createElement("div");
    desc.className = "settings-row-desc";
    desc.textContent = rowDescription(row, snapshot, env);
    title.appendChild(name);
    title.appendChild(desc);
    const control = document.createElement("div");
    control.className = "settings-row-control";
    const value = rowValue(row, snapshot);

    if (row.kind === "toggle") {
      control.innerHTML = switchMarkup(!!value, !enabled);
    } else if (row.kind === "select") {
      const select = document.createElement("select");
      select.className = "settings-select";
      select.setAttribute("aria-label", row.title);
      for (const opt of row.options || []) {
        const option = document.createElement("option");
        option.value = opt.value;
        option.textContent = opt.label;
        if (opt.value === value) option.selected = true;
        select.appendChild(option);
      }
      control.appendChild(select);
    } else if (row.kind === "range") {
      const wrap = document.createElement("div");
      wrap.className = "settings-range";
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(row.min);
      input.max = String(row.max);
      input.step = String(row.step || 1);
      input.value = String(value);
      input.setAttribute("aria-label", row.title);
      if (row.id === "chatFontScale") input.id = "remote-font-scale";
      const out = document.createElement("output");
      out.textContent = `${value}%`;
      wrap.appendChild(input);
      wrap.appendChild(out);
      control.appendChild(wrap);
    } else if (row.kind === "text") {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "settings-text";
      input.value = String(value ?? "");
      input.setAttribute("aria-label", row.title);
      if (row.placeholder) input.placeholder = row.placeholder;
      control.appendChild(input);
    } else if (row.kind === "tags") {
      const wrap = document.createElement("div");
      wrap.className = "settings-tags";
      const list = document.createElement("div");
      list.className = "settings-tags-list";
      for (const term of Array.isArray(value) ? value : []) {
        const chip = document.createElement("span");
        chip.className = "settings-tag";
        chip.dataset.term = term;
        const label = document.createElement("span");
        label.textContent = term;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "settings-tag-remove";
        remove.setAttribute("aria-label", "Remove " + term);
        remove.textContent = "×";
        chip.appendChild(label);
        chip.appendChild(remove);
        list.appendChild(chip);
      }
      const input = document.createElement("input");
      input.type = "text";
      input.className = "settings-tags-input";
      input.setAttribute("aria-label", row.title);
      input.placeholder = row.placeholder || "Add a term";
      wrap.appendChild(list);
      wrap.appendChild(input);
      control.appendChild(wrap);
    } else if (row.kind === "value") {
      const span = document.createElement("span");
      span.className = "settings-value";
      span.textContent = String(value ?? "—");
      control.appendChild(span);
    } else if (row.kind === "action") {
      const isGithub = row.id === "githubConnection" || row.id === "githubConnectionRemote";
      const githubStepped = isGithub && (
        !!githubCliStarted || githubCliLive(snapshot) || !!(githubTokenForm && githubTokenForm.open)
      );
      const terminalStarted = !!(row.provider && PROVIDER_TERMINAL.id === row.provider
        && !(env && env.isRemote));
      if (terminalStarted) {
        const busy = document.createElement("button");
        busy.type = "button";
        busy.className = "settings-action";
        busy.textContent = "Connecting…";
        busy.disabled = true;
        busy.setAttribute("aria-busy", "true");
        control.appendChild(busy);
      } else if (!githubStepped) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "settings-action";
        if (isGithub && !githubConnectedNow(snapshot)) {
          btn.classList.add("settings-github-connect");
        }
        const pending = providerPendingLabel(row);
        btn.textContent = pending || rowActionLabel(row, snapshot, env);
        if (!enabled || pending) btn.disabled = true;
        if (pending) btn.setAttribute("aria-busy", "true");
        control.appendChild(btn);
      }
    }

    el.appendChild(title);
    el.appendChild(control);
    if (row.id === "githubConnection" || row.id === "githubConnectionRemote") {
      if (githubCliLive(snapshot) || githubCliStarted) {
        appendGithubLoginFlow(el, snapshot, {
          pending: !!githubCliStarted && !githubCliLive(snapshot),
          terminal: !(env && env.isRemote) && !!githubCliStarted && !githubCliLive(snapshot),
        });
      } else if (githubTokenForm && githubTokenForm.open) {
        appendGithubTokenForm(el, githubTokenForm);
      } else if (!githubConnectedNow(snapshot) && githubTokenAvailable(snapshot, env)) {
        appendGithubAdvanced(el);
      }
    }
    if (row.provider && PROVIDER_TERMINAL.id === row.provider && !(env && env.isRemote)) {
      const bar = document.createElement("div");
      bar.className = "settings-provider-terminal";
      const recheck = document.createElement("button");
      recheck.type = "button";
      recheck.className = "settings-action settings-provider-recheck";
      recheck.dataset.provider = row.provider;
      recheck.textContent = "Re-check connection";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "settings-action settings-provider-terminal-cancel";
      cancel.dataset.provider = row.provider;
      cancel.textContent = "Cancel";
      bar.append(recheck, cancel);
      el.appendChild(bar);
    }
    return el;
  }

  function mount(container, opts) {
    if (!container) throw new Error("GrokSettings.mount requires a container");
    const env = defaultEnv({ ...(opts.env || {}), standalone: !!opts.standalone });
    let snapshot = defaultSnapshot(opts.snapshot);
    let categoryId = opts.category || "general";
    let query = "";
    let keyForm = { id: "", value: "", readOnly: false };
    let oauthWindow;
    let githubTokenForm = { open: false, value: "" };
    let githubCliStarted = false;
    let pendingRestore = null;
    let aboutChecked = false;
    let providersChecked = false;
    let mcpChecked = false;
    let routinesChecked = false;
    let lastPaintedCategory = "";
    let lastPaintedQuery = "";
    const post = typeof opts.post === "function" ? opts.post : () => {};
    const apply = typeof opts.apply === "function" ? opts.apply : null;
    const onLocal = typeof opts.onLocal === "function" ? opts.onLocal : null;
    const onClose = typeof opts.onClose === "function" ? opts.onClose : null;
    let phoneNav = matchPhoneNav(container.ownerDocument);
    let lastPaintedKey = "";
    let paintDeferred = false;
    let deferredPaintTimer = null;

    const modal = !opts.standalone;
    container.classList.add("settings-surface");
    container.setAttribute("role", "dialog");
    container.setAttribute("aria-label", "Settings");
    if (modal) {
      container.setAttribute("aria-modal", "true");
      coverSiblings(container, true);
    }

    function cats() {
      return visibleCategories(snapshot, env);
    }

    function ensureCategory() {
      const available = cats();
      if (!available.some((c) => c.id === categoryId)) {
        categoryId = available[0] ? available[0].id : "general";
      }
    }

    function commit(row, value) {
      const previous = snapshot;
      snapshot = applyValue(row, value, snapshot);
      const message = rowMessage(row, value, snapshot);
      const localOnly = isLocalOnly(row, previous, env);
      if (apply) apply(row.id, value, localOnly ? null : message, snapshot);
      else if (message && !localOnly) post(message);
      if (pendingRestore) pendingRestore = null;
      paint();
    }

    function dismissRestoreConfirm() {
      pendingRestore = null;
    }

    function beginRestoreConfirm() {
      const changes = restoreChanges(categoryId, snapshot, env);
      if (!changes.length) {
        pendingRestore = null;
        paint();
        return;
      }
      pendingRestore = changes;
      paint();
      const cancel = container.querySelector(".settings-restore-confirm-cancel");
      if (cancel) cancel.focus();
    }

    function cancelRestoreConfirm() {
      pendingRestore = null;
      paint();
    }

    function commitRestoreConfirm() {
      const targets = pendingRestore || [];
      pendingRestore = null;
      for (const row of targets) {
        if (!rowEnabled(row, snapshot)) continue;
        const current = rowValue(row, snapshot);
        if (current === row.defaultValue) continue;
        commit(row, row.defaultValue);
      }
      if (!targets.length) paint();
    }

    function openExternalHref(url) {
      if (env.isRemote) {
        window.open(url, "_blank", "noopener");
        return;
      }
      post({ type: "openUrl", url });
    }

    function openConnectorConsent(id) {
      if (!env.isRemote) return;
      const current = snapshot.mcpConnectorAuthorization;
      if (current && current.id === id && current.status === "waiting" && current.url) {
        openExternalHref(current.url);
        return;
      }
      // Reserve the tab inside the user's tap, before asynchronous discovery.
      // No opener reaches the provider; a blocked popup leaves the visible link.
      try {
        if (oauthWindow) oauthWindow.tab.close();
        const tab = window.open("", "_blank");
        if (tab) {
          tab.opener = null;
          tab.document.title = "Connecting…";
          tab.document.body.textContent = "Opening sign-in…";
          oauthWindow = { id, tab };
        }
      } catch { oauthWindow = undefined; }
    }

    function updateConnectorConsent() {
      if (!oauthWindow) return;
      const authorization = snapshot.mcpConnectorAuthorization;
      const row = (snapshot.mcpConnectors || []).find((c) => c.id === oauthWindow.id);
      try {
        if (authorization && authorization.id === oauthWindow.id && authorization.status === "waiting" && authorization.url) {
          const url = new URL(authorization.url);
          if (url.protocol === "https:") oauthWindow.tab.location.replace(url.href);
          else oauthWindow.tab.close();
          oauthWindow = undefined;
        } else if (row && row.status === "error") {
          oauthWindow.tab.close();
          oauthWindow = undefined;
        }
      } catch { oauthWindow = undefined; }
    }

    function maybeCheckAbout() {
      if (aboutChecked || categoryId !== "about" || query.trim() || env.isRemote) return;
      if (!legacyProviders(env) && !grokProvider(snapshot)) return;
      aboutChecked = true;
      snapshot = { ...snapshot, grokUpdate: { ...(snapshot.grokUpdate || {}), checking: true } };
      post({ type: "checkGrokUpdate" });
    }

    /** Whether this surface may ask the desk to re-observe its accounts. Remote
     *  clients see the answer — `providerState` is mirrored — but must not spawn
     *  the desk's CLIs to get it, which is why the rows there are status-only. */
    function canRefreshProviders() {
      if (env.providersKnown !== true) return false;
      // A cloud machine has no desk to do this for it — see CLOUD_DISPOSITION
      // in remote-policy.ts, which is what lets the frame through.
      return !env.isRemote || hostIsCloud(env);
    }

    function requestProvidersRefresh() {
      if (!canRefreshProviders()) return;
      post({ type: "refreshProviders" });
    }

    /**
     * Opening the page is itself the request. What the rows claim comes from a
     * persisted flag and a cached CLI path, so arriving here without asking is
     * the most common way to read something that stopped being true.
     *
     * Latched like maybeCheckAbout: paint() runs on every repaint and every
     * host update, and this must fire once per visit, not once per frame.
     */
    function maybeRefreshProviders() {
      if (providersChecked || categoryId !== "providers" || query.trim()) return;
      if (!canRefreshProviders()) return;
      providersChecked = true;
      requestProvidersRefresh();
    }

    function requestMcpRefresh() {
      snapshot = { ...snapshot, mcpLoading: true, mcpError: "" };
      post({ type: "listMcpServers" });
    }

    function maybeRefreshRoutines() {
      if (routinesChecked || categoryId !== "routines" || query.trim()) return;
      routinesChecked = true;
      post({ type: "listRoutines" });
    }

    function maybeRefreshMcp() {
      if (mcpChecked || categoryId !== "connectors" || query.trim()) return;
      mcpChecked = true;
      requestMcpRefresh();
    }

    function runAction(row) {
      // `local` may be a plain name (a purely client-side action) or a
      // function of the current state, and it no longer swallows the row's
      // message: Settings → Providers → Connect must BOTH post `runGrokLogin`
      // and open the wizard that shows what happens next. Returning here sent
      // the message nowhere and left a dialog with nothing to report.
      const local = typeof row.local === "function" ? row.local(snapshot, env) : row.local;
      if (local === "githubToken") {
        githubTokenForm = { open: true, value: "" };
        paint();
        const input = container.querySelector(".settings-github-token-input");
        if (input) input.focus();
        return;
      }
      if (local && !row.message) {
        if (onClose && !opts.standalone) onClose();
        if (onLocal) onLocal(local);
        return;
      }
      if (local && onLocal) onLocal(local);
      if (row.href) {
        openExternalHref(row.href);
        return;
      }
      const message = rowMessage(row, undefined, snapshot);
      // Sign-out is the one with nothing else to show for it: a sign-in opens
      // the wizard, and this page sits behind that.
      let marked = false;
      if (message && message.type === "logout" && message.provider && env.isRemote) {
        PROVIDER_PENDING.id = message.provider;
        PROVIDER_PENDING.label = "Disconnecting…";
        PROVIDER_PENDING.wanted = false;
        PROVIDER_PENDING.at = Date.now();
        marked = true;
        // The backstop paint. Every normal path clears this from the host's
        // answer; this is the one where no answer ever comes.
        setTimeout(() => { reconcileProviderPending(snapshot); paint(); }, PROVIDER_PENDING_MS + 500);
      }
      if (message) post(message);
      // Nothing else repaints until the host answers — which is the whole
      // point: the label has to change on the click, not on the reply.
      if (marked) paint();
      const keep = typeof row.keepOpen === "function" ? row.keepOpen(snapshot, env) : !!row.keepOpen;
      if (opts.closeOnAction && !keep && onClose) onClose();
    }

    function paintKey() {
      return JSON.stringify({
        snapshot,
        env,
        categoryId,
        query,
        pendingRestore: pendingRestore ? pendingRestore.map((row) => row.id) : null,
        phoneNav,
        keyFormId: keyForm.id,
        githubTokenOpen: githubTokenForm.open,
        githubCliStarted: githubCliStarted,
        // Which routine is open, and which unit its cadence is on — the two
        // pieces of local state that change the DOM without the snapshot
        // moving. Without them an expand or a unit switch computes the same
        // key and paint() returns early, so the click does nothing.
        routineOpen: ROUTINE_UI.open,
        routineConfirm: ROUTINE_UI.confirmRemove,
        // The draft fields that change the DOM STRUCTURE or a select's
        // selected option. Deliberately not title/prompt: those change per
        // keystroke, and repainting would rebuild the input under the caret.
        routineDraft: ROUTINE_UI.draft
          ? [ROUTINE_UI.draft.unit, ROUTINE_UI.draft.cwd, ROUTINE_UI.draft.provider, ROUTINE_UI.draft.model].join(" ")
          : "",
        // Which row is waiting on the host: local state that changes a label
        // and a disabled attribute, so the key has to carry it.
        providerPending: PROVIDER_PENDING.id + ":" + PROVIDER_PENDING.label,
        providerTerminal: PROVIDER_TERMINAL.id,
      });
    }

    function paint() {
      updateConnectorConsent();
      reconcileProviderPending(snapshot);
      reconcileProviderTerminal(snapshot);
      const chrome = describeChrome(container);
      ensureCategory();
      maybeCheckAbout();
      maybeRefreshProviders();
      maybeRefreshMcp();
      maybeRefreshRoutines();
      const key = paintKey();
      if (key === lastPaintedKey && container.firstChild) {
        paintDeferred = false;
        return;
      }
      lastPaintedKey = key;
      paintDeferred = false;
      if (deferredPaintTimer) { clearTimeout(deferredPaintTimer); deferredPaintTimer = null; }
      const focus = chrome.focus;
      const searching = !!query.trim();
      const shownCats = cats();
      const page = CATEGORIES.find((c) => c.id === categoryId) || shownCats[0];
      const rows = searching
        ? filterRows(query, snapshot, env)
        : visibleRows(snapshot, env).filter((row) => row.category === categoryId);
      const matchedCats = new Set(rows.map((row) => row.category));

      // Every repaint rebuilds the whole surface, which puts the scroll back at
      // the top. That is fine on a category switch and wrong on everything
      // else: clicking Connect, saving a routine or any host frame arriving
      // repaints, and the row the user was working on jumps off screen.
      // Category and search deliberately DO reset — a new list starts at its
      // beginning.
      const keptScroll = categoryId === lastPaintedCategory && query === lastPaintedQuery
        ? (container.querySelector(".settings-body") || {}).scrollTop || 0
        : 0;
      lastPaintedCategory = categoryId;
      lastPaintedQuery = query;

      container.innerHTML = "";
      const shell = document.createElement("div");
      shell.className = "settings-shell";

      const nav = document.createElement("nav");
      nav.className = "settings-nav";
      nav.setAttribute("aria-label", "Settings categories");
      if (modal && onClose) {
        const back = document.createElement("button");
        back.type = "button";
        back.className = "settings-back";
        back.setAttribute("aria-label", "Back to app");
        const arrow = document.createElement("span");
        arrow.className = "settings-back-arrow";
        arrow.setAttribute("aria-hidden", "true");
        arrow.textContent = "←";
        const backLabel = document.createElement("span");
        backLabel.className = "settings-back-label";
        backLabel.textContent = "Back to app";
        back.append(arrow, backLabel);
        back.onclick = (e) => { e.stopPropagation(); onClose(); };
        nav.appendChild(back);
      }
      const searchWrap = document.createElement("div");
      searchWrap.className = "settings-search-wrap";
      const search = document.createElement("input");
      search.type = "search";
      search.id = "settings-search";
      search.className = "settings-search";
      search.placeholder = "Search settings";
      search.setAttribute("aria-label", "Search settings");
      search.value = query;
      searchWrap.appendChild(search);
      nav.appendChild(searchWrap);
      const navList = document.createElement("div");
      navList.className = "settings-nav-list";
      if (phoneNav) navList.hidden = true;
      for (const cat of shownCats) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "settings-nav-item" + (cat.id === categoryId && !searching ? " active" : "");
        if (searching && !matchedCats.has(cat.id)) btn.classList.add("is-dim");
        btn.dataset.category = cat.id;
        const icon = document.createElement("span");
        icon.className = "settings-nav-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML = NAV_ICONS[cat.id] || "";
        const label = document.createElement("span");
        label.className = "settings-nav-label";
        label.textContent = cat.title;
        btn.append(icon, label);
        navList.appendChild(btn);
      }
      nav.appendChild(navList);
      const navSelect = document.createElement("select");
      navSelect.className = "settings-nav-select settings-select";
      navSelect.id = "settings-category";
      navSelect.setAttribute("aria-label", "Settings category");
      if (!phoneNav) navSelect.hidden = true;
      for (const cat of shownCats) {
        const option = document.createElement("option");
        option.value = cat.id;
        option.textContent = cat.title;
        if (cat.id === categoryId) option.selected = true;
        navSelect.appendChild(option);
      }
      nav.appendChild(navSelect);

      const main = document.createElement("div");
      main.className = "settings-main";
      const head = document.createElement("div");
      head.className = "settings-head";
      const crumb = document.createElement("div");
      crumb.className = "settings-crumb";
      crumb.innerHTML = searching
        ? `<span>Settings</span><span class="settings-crumb-sep">/</span><span>Search</span>`
        : `<span>Settings</span><span class="settings-crumb-sep">/</span><span>${escapeHtml(page ? page.title : "General")}</span>`;
      head.appendChild(crumb);
      const headActions = document.createElement("div");
      headActions.className = "settings-head-actions";
      // Above the rows, beside the breadcrumb — the strip "Restore defaults"
      // already owns, which Providers leaves empty (restore: false).
      if (!searching && page && page.id === "providers" && canRefreshProviders()) {
        const checking = snapshot.providersChecking === true;
        const refresh = document.createElement("button");
        refresh.type = "button";
        refresh.className = "settings-refresh";
        refresh.textContent = checking ? "Checking…" : "Refresh";
        refresh.disabled = checking;
        if (checking) refresh.setAttribute("aria-busy", "true");
        refresh.onclick = (e) => { e.stopPropagation(); requestProvidersRefresh(); };
        headActions.appendChild(refresh);
      }
      if (!searching && page && page.id === "connectors") {
        const refresh = document.createElement("button");
        refresh.type = "button";
        refresh.className = "settings-refresh";
        refresh.textContent = snapshot.mcpLoading ? "Loading…" : "Refresh";
        refresh.disabled = snapshot.mcpLoading === true;
        if (refresh.disabled) refresh.setAttribute("aria-busy", "true");
        refresh.onclick = (e) => { e.stopPropagation(); requestMcpRefresh(); paint(); };
        headActions.appendChild(refresh);
      }
      const changes = !searching && page && page.restore
        ? restoreChanges(page.id, snapshot, env)
        : [];
      if (changes.length && !pendingRestore) {
        const restore = document.createElement("button");
        restore.type = "button";
        restore.className = "settings-restore";
        restore.textContent = "Restore defaults";
        restore.onclick = (e) => { e.stopPropagation(); beginRestoreConfirm(); };
        headActions.appendChild(restore);
      }
      head.appendChild(headActions);
      main.appendChild(head);

      if (pendingRestore && pendingRestore.length && !searching) {
        const confirm = document.createElement("div");
        confirm.className = "settings-restore-confirm";
        confirm.setAttribute("role", "region");
        confirm.setAttribute("aria-label", "Confirm restore defaults");
        const lead = document.createElement("div");
        lead.className = "settings-restore-confirm-lead";
        lead.textContent = "These settings on this page will change:";
        const list = document.createElement("ul");
        list.className = "settings-restore-confirm-list";
        for (const row of pendingRestore) {
          const item = document.createElement("li");
          item.textContent = `${row.title} → ${restoreValueLabel(row, row.defaultValue)}`;
          list.appendChild(item);
        }
        const actions = document.createElement("div");
        actions.className = "settings-restore-confirm-actions";
        const go = document.createElement("button");
        go.type = "button";
        go.className = "settings-restore-confirm-go";
        go.textContent = "Restore";
        go.onclick = (e) => { e.stopPropagation(); commitRestoreConfirm(); };
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "settings-restore-confirm-cancel";
        cancel.textContent = "Cancel";
        cancel.onclick = (e) => { e.stopPropagation(); cancelRestoreConfirm(); };
        actions.append(go, cancel);
        confirm.append(lead, list, actions);
        main.appendChild(confirm);
      }

      const body = document.createElement("div");
      body.className = "settings-body";
      if (!rows.length) {
        const empty = document.createElement("div");
        empty.className = "settings-empty";
        empty.textContent = searching ? "No settings match that search." : "No settings on this page.";
        body.appendChild(empty);
      } else if (searching) {
        let lastCat = "";
        for (const row of rows) {
          if (row.category !== lastCat) {
            lastCat = row.category;
            const heading = document.createElement("h2");
            heading.className = "settings-group";
            const cat = CATEGORIES.find((c) => c.id === row.category);
            heading.textContent = cat ? cat.title : row.category;
            body.appendChild(heading);
          }
          body.appendChild(renderRow(row, snapshot, env, keyForm, githubTokenForm, githubCliStarted));
        }
      } else {
        let lastSection = "";
        for (const row of rows) {
          const section = connectorSection(row, env);
          if (section && section !== lastSection) {
            lastSection = section;
            const heading = document.createElement("h2");
            heading.className = "settings-group";
            heading.textContent = section;
            body.appendChild(heading);
          }
          body.appendChild(renderRow(row, snapshot, env, keyForm, githubTokenForm, githubCliStarted));
        }
        if (categoryId === "about") {
          const disclaimer = document.createElement("p");
          disclaimer.className = "settings-about-disclaimer";
          disclaimer.textContent = ABOUT_DISCLAIMER;
          body.appendChild(disclaimer);
        }
      }
      main.appendChild(body);
      shell.appendChild(nav);
      shell.appendChild(main);
      container.appendChild(shell);
      if (keptScroll) {
        const body = container.querySelector(".settings-body");
        // Clamped by the browser if the content got shorter, which is the
        // honest outcome — better than snapping to the top.
        if (body) body.scrollTop = keptScroll;
      }

      search.oninput = () => {
        query = search.value;
        dismissRestoreConfirm();
        paint();
        const next = container.querySelector("#settings-search");
        if (next) {
          next.focus();
          try { next.setSelectionRange(query.length, query.length); } catch { /* */ }
        }
      };
      function selectCategory(next) {
        if (!next) return;
        if (next !== "about") aboutChecked = false;
        if (next !== "providers") providersChecked = false;
        if (next !== "connectors") mcpChecked = false;
        if (next !== "routines") routinesChecked = false;
        categoryId = next;
        query = "";
        dismissRestoreConfirm();
        paint();
      }
      nav.querySelectorAll(".settings-nav-item").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          selectCategory(btn.dataset.category);
        });
      });
      navSelect.onchange = () => selectCategory(navSelect.value);
      body.querySelectorAll(".settings-row").forEach((el) => {
        const row = ROWS.find((r) => r.id === el.dataset.id);
        if (!row) return;
        if (row.kind === "toggle") {
          const sw = el.querySelector(".settings-switch");
          if (!sw || sw.disabled) return;
          sw.onclick = (e) => {
            e.stopPropagation();
            commit(row, !rowValue(row, snapshot));
          };
        } else if (row.kind === "select") {
          const select = el.querySelector("select");
          if (!select) return;
          select.onchange = () => commit(row, select.value);
        } else if (row.kind === "range") {
          const input = el.querySelector("input[type=range]");
          const out = el.querySelector("output");
          if (!input) return;
          input.oninput = () => { if (out) out.textContent = `${input.value}%`; };
          input.onchange = () => commit(row, Number(input.value));
        } else if (row.kind === "text") {
          const input = el.querySelector(".settings-text");
          if (!input) return;
          const flush = () => {
            if (input.value !== String(rowValue(row, snapshot) ?? "")) commit(row, input.value);
          };
          input.onchange = flush;
          input.onkeydown = (e) => {
            if (e.key === "Enter") { e.preventDefault(); flush(); }
          };
        } else if (row.kind === "tags") {
          const input = el.querySelector(".settings-tags-input");
          const current = () => {
            const got = rowValue(row, snapshot);
            return Array.isArray(got) ? got.slice() : [];
          };
          const addTerm = (raw) => {
            const term = String(raw || "").trim().slice(0, 50);
            if (!term) return;
            const next = current();
            if (next.some((t) => t.toLowerCase() === term.toLowerCase())) return;
            next.push(term);
            commit(row, next);
          };
          el.querySelectorAll(".settings-tag-remove").forEach((btn) => {
            btn.onclick = (e) => {
              e.stopPropagation();
              const chip = btn.closest(".settings-tag");
              const term = chip && chip.dataset.term;
              commit(row, current().filter((t) => t !== term));
            };
          });
          if (input) {
            input.onkeydown = (e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addTerm(input.value);
              }
            };
            input.onchange = () => addTerm(input.value);
          }
        } else if (row.kind === "action") {
          const btn = el.querySelector(".settings-action");
          if (!btn) return;
          if (btn.classList.contains("settings-github-token-submit")
            || btn.classList.contains("settings-github-token-cancel")) {
            return;
          }
          btn.onclick = (e) => {
            e.stopPropagation();
            if ((row.id === "githubConnection" || row.id === "githubConnectionRemote")
              && !githubConnectedNow(snapshot)) {
              githubCliStarted = true;
              githubTokenForm = { open: false, value: "" };
              runAction(row);
              paint();
              return;
            }
            if (row.provider && !(env && env.isRemote)
              && !providerConnectedNow(snapshot, row.provider)) {
              PROVIDER_TERMINAL.id = row.provider;
              runAction(row);
              paint();
              return;
            }
            runAction(row);
          };
        }
      });
      function closeKeyForm() {
        keyForm = { id: "", value: "", readOnly: false };
        paint();
      }
      function openKeyForm(id, readOnly) {
        keyForm = { id, value: "", readOnly: !!readOnly };
        paint();
        const input = container.querySelector(".settings-connector-key-input");
        if (input) input.focus();
      }
      body.querySelectorAll(".settings-connector-action").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!canManageConnectors(snapshot, env) || btn.disabled) return;
          const id = btn.dataset.id;
          if (!id) return;
          if (btn.dataset.auth === "key" && btn.dataset.connected !== "true") {
            if (btn.dataset.action === "cancel" || keyForm.id === id) closeKeyForm();
            else {
              const row = snapshot.mcpConnectors.find((c) => c && c.id === id);
              openKeyForm(id, row && row.readOnly);
            }
            return;
          }
          const disconnect = btn.dataset.connected === "true";
          if (!disconnect) openConnectorConsent(id);
          post({
            type: disconnect ? "disconnectMcpConnector" : "connectMcpConnector",
            id,
          });
        });
      });
      body.querySelectorAll(".settings-connector-key-open").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!canManageConnectors(snapshot, env) || btn.disabled) return;
          const id = btn.dataset.id;
          if (!id) return;
          const row = snapshot.mcpConnectors.find((c) => c && c.id === id);
          openKeyForm(id, row && row.readOnly);
        });
      });
      body.querySelectorAll(".settings-connector-key-cancel").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          closeKeyForm();
        });
      });
      body.querySelectorAll(".settings-connector-key-submit").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!canManageConnectors(snapshot, env) || btn.disabled) return;
          const id = btn.dataset.id;
          if (!id) return;
          const form = btn.closest(".settings-connector-key");
          const input = form && form.querySelector(".settings-connector-key-input");
          const box = form && form.querySelector(".settings-connector-readonly-input");
          const key = input ? String(input.value || "") : "";
          const readOnly = !!(box && box.checked);
          if (input) input.value = "";
          keyForm = { id: "", value: "", readOnly: false };
          post({ type: "connectMcpConnector", id, key, readOnly });
          paint();
        });
      });
      body.querySelectorAll(".settings-github-advanced").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          if ((githubCliStarted || githubCliLive(snapshot)) && canCancelGithubLogin(env)) {
            post({ type: "cancelDeviceLogin", provider: "github" });
          }
          githubCliStarted = false;
          githubTokenForm = { open: true, value: "" };
          paint();
          const input = container.querySelector(".settings-github-token-input");
          if (input) input.focus();
        });
      });
      body.querySelectorAll(".settings-github-flow-cancel").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          githubCliStarted = false;
          if (canCancelGithubLogin(env)) post({ type: "cancelDeviceLogin", provider: "github" });
          paint();
        });
      });
      body.querySelectorAll(".settings-github-flow-recheck").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          post({ type: "refreshProviders" });
        });
      });
      body.querySelectorAll(".settings-provider-recheck").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const provider = btn.dataset.provider;
          if (provider) post({ type: "recheckConnection", provider });
        });
      });
      body.querySelectorAll(".settings-provider-terminal-cancel").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (btn.dataset.provider === PROVIDER_TERMINAL.id) clearProviderTerminal();
          paint();
        });
      });
      const tokenInput = body.querySelector(".settings-github-token-input");
      const tokenSubmit = body.querySelector(".settings-github-token-submit");
      const tokenCancel = body.querySelector(".settings-github-token-cancel");
      if (tokenCancel) {
        tokenCancel.addEventListener("click", (e) => {
          e.stopPropagation();
          githubTokenForm = { open: false, value: "" };
          paint();
        });
      }
      if (tokenSubmit) {
        tokenSubmit.addEventListener("click", (e) => {
          e.stopPropagation();
          const token = tokenInput ? String(tokenInput.value || "") : githubTokenForm.value;
          if (tokenInput) tokenInput.value = "";
          githubTokenForm = { open: false, value: "" };
          if (token.trim()) post({ type: "githubLoginWithToken", token: token.trim() });
          paint();
        });
      }
      if (tokenInput) {
        tokenInput.addEventListener("input", () => { githubTokenForm.value = tokenInput.value; });
        tokenInput.addEventListener("keydown", (e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          if (tokenSubmit) tokenSubmit.click();
        });
      }
      body.querySelectorAll(".settings-connector-key-input").forEach((input) => {
        input.addEventListener("input", () => {
          if (keyForm.id === input.dataset.id) keyForm.value = input.value;
        });
        input.addEventListener("keydown", (e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const submit = input.closest(".settings-connector-key")
            && input.closest(".settings-connector-key").querySelector(".settings-connector-key-submit");
          if (submit) submit.click();
        });
      });
      // ---- routines ----
      // Field edits update the draft WITHOUT repainting: a repaint on every
      // keystroke would rebuild the input and lose the caret. Only structural
      // changes (open/close, unit switch, save) paint.
      body.querySelectorAll(".settings-routine-body [data-field]").forEach((input) => {
        const commit = () => {
          if (!ROUTINE_UI.draft) return;
          const field = input.dataset.field;
          if (field === "model") {
            const [provider, ...rest] = String(input.value || "").split(" ");
            ROUTINE_UI.draft.provider = provider;
            ROUTINE_UI.draft.model = rest.join(" ");
            return;
          }
          ROUTINE_UI.draft[field] = field === "every" ? Number(input.value) || 1 : input.value;
        };
        input.addEventListener("input", commit);
        input.addEventListener("change", () => {
          commit();
          // Switching project re-picks the model the same way the composer
          // does: each project has its own default provider, and carrying the
          // previous project's model across is rarely what was meant.
          if (input.dataset.field === "cwd" && ROUTINE_UI.draft) {
            const projects = Array.isArray(snapshot.routineProjects) ? snapshot.routineProjects : [];
            const models = Array.isArray(snapshot.routineModels) ? snapshot.routineModels : [];
            const project = projects.find((x) => x.cwd === ROUTINE_UI.draft.cwd);
            const pick = defaultModelFor(models, project && project.defaultProvider);
            if (pick) {
              ROUTINE_UI.draft.provider = pick.provider;
              ROUTINE_UI.draft.model = pick.model;
            }
            paint();
            return;
          }
          // The days branch grows a time control, so this one has to repaint.
          if (input.dataset.field === "unit") paint();
        });
      });
      body.querySelectorAll(".settings-routine-toggle").forEach((head) => {
        head.addEventListener("click", (e) => {
          e.stopPropagation();
          const card = head.closest(".settings-routine");
          const id = card && card.dataset.routine;
          if (!id) return;
          ROUTINE_UI.open = ROUTINE_UI.open === id ? "" : id;
          ROUTINE_UI.draft = null;
          ROUTINE_UI.confirmRemove = "";
          paint();
        });
      });
      body.querySelectorAll(".settings-routine-new").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          ROUTINE_UI.open = NEW_ROUTINE;
          ROUTINE_UI.draft = blankRoutineDraft(snapshot);
          paint();
        });
      });
      body.querySelectorAll(".settings-routine-cancel").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          ROUTINE_UI.open = "";
          ROUTINE_UI.draft = null;
          paint();
        });
      });
      body.querySelectorAll(".settings-routine-save").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!ROUTINE_UI.draft) return;
          ROUTINE_UI.pendingSave = true;
          post(draftToMessage(ROUTINE_UI.draft));
          // The host answers with a fresh `routines` frame; the draft stays
          // put so a refusal comes back to the text that caused it rather than
          // to a blank form.
        });
      });
      body.querySelectorAll(".settings-routine-pause").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const card = btn.closest(".settings-routine");
          const id = card && card.dataset.routine;
          if (!id) return;
          post({ type: "setRoutinePaused", id, paused: !btn.dataset.paused });
        });
      });
      body.querySelectorAll(".settings-routine-run-now").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const card = btn.closest(".settings-routine");
          const id = card && card.dataset.routine;
          if (!id) return;
          post({ type: "runRoutineNow", id });
        });
      });
      body.querySelectorAll(".settings-routine-remove").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const card = btn.closest(".settings-routine");
          const id = card && card.dataset.routine;
          if (!id) return;
          // Two clicks, and the second one says what it does. A routine is
          // cheap to rebuild but its run history is not.
          if (ROUTINE_UI.confirmRemove !== id) {
            ROUTINE_UI.confirmRemove = id;
            paint();
            return;
          }
          ROUTINE_UI.confirmRemove = "";
          ROUTINE_UI.open = "";
          ROUTINE_UI.draft = null;
          post({ type: "deleteRoutine", id });
        });
      });
      body.querySelectorAll(".settings-routine-open, .settings-routine-tick[data-session]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const id = btn.dataset.session;
          if (!id) return;
          if (onClose && !opts.standalone) onClose();
          post({ type: "resumeSession", id, cwd: btn.dataset.cwd || undefined, claim: true });
        });
      });
      body.querySelectorAll(".settings-connector-readonly-input").forEach((box) => {
        box.addEventListener("change", () => {
          if (!canManageConnectors(snapshot, env) || box.disabled) return;
          const id = box.dataset.id;
          if (!id) return;
          if (keyForm.id === id) keyForm.readOnly = box.checked;
          if (box.dataset.live === "true") {
            post({ type: "connectMcpConnector", id, readOnly: box.checked });
          }
        });
      });
      body.querySelectorAll(".settings-connector-key-docs").forEach((link) => {
        link.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const url = link.dataset.href || link.href;
          if (url) openExternalHref(url);
        });
      });
      body.querySelectorAll(".settings-connector-oauth-link").forEach((link) => {
        link.addEventListener("click", (e) => {
          e.preventDefault();
          openExternalHref(link.href);
        });
      });
      body.querySelectorAll(".settings-mcp-web").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const url = btn.dataset.href;
          if (url) openExternalHref(url);
        });
      });
      body.querySelectorAll(".settings-mcp-open").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (env.isRemote) return;
          post({ type: "openGlobalConfig" });
        });
      });
      applyFocus(container, focus);
    }

    function trapTab(e) {
      if (!modal || e.key !== "Tab") return false;
      const items = focusableControls(container);
      if (!items.length) {
        e.preventDefault();
        e.stopPropagation();
        return true;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = container.ownerDocument && container.ownerDocument.activeElement;
      if (e.shiftKey) {
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          e.stopPropagation();
          last.focus();
          return true;
        }
      } else if (active === last || !container.contains(active)) {
        e.preventDefault();
        e.stopPropagation();
        first.focus();
        return true;
      }
      return false;
    }

    function onKey(e) {
      // A dialog stacked above this page owns the keyboard. Both handlers are
      // on document in capture and this one was registered first, so without
      // standing down, Escape closed the page underneath the dialog and Tab
      // pulled focus out of it (review, 2026-08-31).
      if (document.body && document.body.dataset.modalAbove) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        if (onClose) onClose();
        return;
      }
      if (trapTab(e)) return;
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      e.preventDefault();
      const search = container.querySelector("#settings-search");
      if (search) search.focus();
    }

    container._onKey = onKey;
    document.addEventListener("keydown", onKey, true);
    // A deferred paint used to wait for exactly one event: the nav select
    // losing focus. But `navMenuOpen` is true whenever that select merely HAS
    // focus, and picking a category leaves it focused — so on a phone every
    // frame that arrived afterwards was deferred and nothing flushed it. The
    // page sat on "Loading routines…" (and "Loading Grok connectors…" before
    // that) until the reader touched the screen for an unrelated reason.
    //
    // So: flush on `change` as well, which fires when the dropdown closes with
    // a selection, and arm a timer as a backstop. Deferring exists to avoid
    // repainting UNDER an open dropdown; it must not be able to wait for ever.
    // `paint()` restores focus through applyFocus, so flushing costs nothing.
    const flushDeferredPaint = () => {
      if (!paintDeferred) return;
      paint();
    };
    container.addEventListener("blur", (e) => {
      const target = e.target;
      if (!target || !target.classList || !target.classList.contains("settings-nav-select")) return;
      flushDeferredPaint();
    }, true);
    container.addEventListener("change", (e) => {
      const target = e.target;
      if (!target || !target.classList || !target.classList.contains("settings-nav-select")) return;
      flushDeferredPaint();
    }, true);

    const view = container.ownerDocument && container.ownerDocument.defaultView;
    const phoneMq = view && view.matchMedia ? view.matchMedia(PHONE_NAV_MQ) : null;
    function onPhoneNavChange() {
      const next = matchPhoneNav(container.ownerDocument);
      if (next === phoneNav) return;
      phoneNav = next;
      paint();
    }
    if (phoneMq) {
      if (typeof phoneMq.addEventListener === "function") phoneMq.addEventListener("change", onPhoneNavChange);
      else if (typeof phoneMq.addListener === "function") phoneMq.addListener(onPhoneNavChange);
    }
    paint();

    return {
      update(nextSnapshot, nextEnv) {
        if (nextSnapshot) snapshot = defaultSnapshot({ ...snapshot, ...nextSnapshot });
        if (nextEnv) Object.assign(env, nextEnv);
        if (githubConnectedNow(snapshot)) githubTokenForm = { open: false, value: "" };
        if (nextSnapshot && Object.prototype.hasOwnProperty.call(nextSnapshot, "githubState")) {
          // A githubState frame is not "the terminal finished". Desk sign-in
          // cannot be observed, so keep the Re-check row until the account
          // is actually connected or a live device-code card takes over.
          if (githubConnectedNow(snapshot) || githubCliLive(snapshot)) githubCliStarted = false;
        }
        // Before the key: the answer this was waiting for is usually IN this
        // snapshot, and a stale "Disconnecting…" left in the key would make
        // the repaint that clears it look like a no-op.
        reconcileProviderPending(snapshot);
        if (container.firstChild && paintKey() === lastPaintedKey) return;
        if (describeChrome(container).navMenuOpen) {
          paintDeferred = true;
          // The backstop. An open dropdown is a short interaction; a focused
          // one can last as long as the reader looks at the page.
          if (deferredPaintTimer) clearTimeout(deferredPaintTimer);
          deferredPaintTimer = setTimeout(() => {
            deferredPaintTimer = null;
            flushDeferredPaint();
          }, DEFERRED_PAINT_MS);
          // The backstop. An open dropdown is a short interaction; a focused
          // one can last as long as the reader looks at the page.
          return;
        }
        paint();
      },
      focusSearch() {
        const search = container.querySelector("#settings-search");
        if (search) search.focus();
      },
      setCategory(id) {
        if (id !== "about") aboutChecked = false;
        if (id !== "providers") providersChecked = false;
        if (id !== "connectors") mcpChecked = false;
        if (id !== "routines") routinesChecked = false;
        categoryId = id || "general";
        query = "";
        dismissRestoreConfirm();
        paint();
      },
      dispose() {
        if (oauthWindow) {
          try { oauthWindow.tab.close(); } catch { /* already closed */ }
          oauthWindow = undefined;
        }
        document.removeEventListener("keydown", onKey, true);
        if (phoneMq) {
          if (typeof phoneMq.removeEventListener === "function") phoneMq.removeEventListener("change", onPhoneNavChange);
          else if (typeof phoneMq.removeListener === "function") phoneMq.removeListener(onPhoneNavChange);
        }
        if (modal) coverSiblings(container, false);
      },
      get snapshot() { return snapshot; },
      get category() { return categoryId; },
      get query() { return query; },
    };
  }

  const api = {
    CATEGORIES,
    NAV_ICONS,
    TELEMETRY_COPY,
    THUMBS_COPY,
    ABOUT_DISCLAIMER,
    GITHUB_REPO_URL,
    GROK_CONNECTORS_URL,
    ICON_SETTINGS,
    CONNECTOR_LOGO_IDS,
    sortConnectorsForDisplay,
    CONNECTOR_SECTION_HERE,
    CONNECTOR_SECTION_HERE_REMOTE,
    CONNECTOR_SECTION_GROK,
    CONNECTOR_SECTION_LOCAL,
    CONNECTOR_BLURB_HERE,
    CONNECTOR_BLURB_HERE_REMOTE,
    CONNECTOR_BLURB_HERE_REMOTE_CONNECT,
    CONNECTOR_BLURB_GROK,
    CONNECTOR_BLURB_LOCAL,
    CONNECTOR_BLURB_LOCAL_REMOTE,
    GITHUB_ISSUE_BUG_URL,
    GITHUB_ISSUE_FEATURE_URL,
    SUPPORT_MAILTO,
    ROWS,
    githubOf,
    githubKnown,
    githubDescribe,
    githubAction,
    githubTokenAvailable,
    githubCliLive,
    visibleRows,
    visibleCategories,
    filterRows,
    restoreTargets,
    restoreChanges,
    restoreValueLabel,
    isRestorableKind,
    rowEnabled,
    applyValue,
    defaultEnv,
    defaultSnapshot,
    formatRoutineCountdown,
    DEFERRED_PAINT_MS,
    routinesHostNote,
    keyDocsLabel,
    routineRunLabel,
    mount,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.GrokSettings = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
