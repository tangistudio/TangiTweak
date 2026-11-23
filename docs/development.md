# Development

[<img src="../icons/icon.svg" width="16" height="16" align="absmiddle" alt=""> README](../README.md) · [Glossary](../GLOSSARY.md)

```bash
npm install
npm run build        # bundle to dist/
npm run watch        # rebuild on change
npm test             # vitest unit tests
npm run typecheck
npm run test:e2e     # full browser e2e (needs E2E_CHROMIUM, see below)
```

The e2e suite (`test/e2e.ts`) launches a fresh MV2-capable Chromium, loads the
extension, seeds sample scripts through the real Editor page, and verifies
every strategy against a local HTTP server: matcher, redirect, block, request +
response headers, replaceResponse (main frame + fetch), onResponseBody (fetch /
XHR / script-tag CDP), per-tab badge, and enable/disable toggling.

```bash
# any Chromium that still supports MV2 (Chrome for Testing ≤ ~126 works):
E2E_CHROMIUM="/path/to/Google Chrome for Testing" npm run test:e2e
```

Load the extension from `dist/` ("Load unpacked", MV2), or any recent Firefox
(callback-based APIs work everywhere).

## Releases

Every user-facing change goes under `## [Unreleased]` in
[CHANGELOG.md](../CHANGELOG.md). To release, rename that heading to
`## [X.Y.Z] - YYYY-MM-DD`, add a fresh empty `## [Unreleased]` above it and a
compare link at the bottom, and bump the version (`manifest.json`'s
`version` without the suffix and `version_name` with it, `package.json` and
`package-lock.json`, `src/background/sandbox.ts`). A unit test fails while the
current version has no changelog section. The release notes are that section
(`scripts/release-notes.mjs`, relative links made absolute) plus a link to
[install.md](install.md); install steps live there, not in the notes.

Pushing a `vX.Y.Z` tag runs the GitHub Action (typecheck → tests → build →
zips + signed `.crx` → helper binaries → GitHub release), so the artifacts
always match the tagged `manifest.json` version. The Firefox `.xpi` is signed
by Mozilla (AMO) in a separate job, which can take a while: the release is
published without it, and the `.xpi` is added to it when signing finishes (an
unsigned one if signing fails).

### The SDK on npm

`npm run build` also builds the SDK, the npm package `tangitweak`, into
`dist-sdk/` (`buildSdk` in `scripts/build.mjs`): the `tweak` runtime and
typings (`.`), the test SDK (`./test`, from `src/testing/test.ts`), the
`tsconfig.json` tweaks extend, and the built-ins' typings it points to. Its
version is `manifest.json`'s `version_name`, and its README is
`src/testing/README.md`. The build checks with `npm pack --dry-run` that
every file its `exports` name is in the package. The extension carries the
same files as `lib/tangitweak-sdk.json`, which Folder Sync writes to
`.tangitweak/sdk/tangitweak/`.

The release job attaches `tangitweak-sdk-v<version>.tgz` to the GitHub
release and publishes `dist-sdk/` to npm with
[Trusted Publishing](https://docs.npmjs.com/trusted-publishers): the workflow
proves who it is with GitHub's OIDC token, so there's no npm token or secret,
and npm adds a provenance statement. A prerelease (`0.40.0-alpha`) goes under
its dist-tag (`alpha`), any other version under `latest`. A version that's
already on npm is skipped, so rerunning a release is safe.

Before the first automated publish, a maintainer does this once:

1. Publish the package by hand, so it exists on npm: `npm login`, then
   `npm run build` and `cd dist-sdk && npm publish --access public --tag alpha`.
2. On npmjs.com, open the `tangitweak` package's **Settings** → **Trusted
   Publisher** → **GitHub Actions**, and enter the organization
   `tangistudio`, the repository `TangiTweak` and the workflow file
   `release.yml` (no environment).
3. Optional: on the same page, under **Publishing access**, require two-factor
   authentication and disallow tokens, so only the workflow can publish.

After that, pushing a `vX.Y.Z` tag publishes that version.

### Documenting the SDK

Everything the SDK ships is public: `index.d.ts` (`src/types/tt-api.d.ts`),
`tangitweak/test` and every file under `types/` they import, such as
`types/shared/wire.d.ts` (emitted from `src/shared/wire.ts`). Readers land in
any of them through hovers and go-to-definition, so each one is documented
like an API reference. `npm run build` fails when something there has no doc
comment; `node scripts/sdkTypings.mjs [wire]` lists what's missing (all files,
or the ones whose path has `wire` in it) without a full build.

- **File overview.** Each file starts with a `/** … */` saying what the module
  is for, who uses it and how its parts fit, then `@module`, then a blank line.
  Without the blank line it reads as the first declaration's comment. The
  build puts it back at the top of the `.d.ts`, which declaration emit doesn't.
- **Members on their own lines.** Declaration emit drops comments on members
  of one-line object types (`{ a: string; b: number }`), so give each
  documented member its own line.
- **Every declaration and member.** Types, interfaces, functions, classes,
  constants, enum members and properties, including those of object types
  nested in other types. Not needed: private members, index and call
  signatures, and `WireOps` entries' `req`, `res` and `push` keys (the op's
  comment covers them; their fields still need their own).
- **Summary first.** One sentence, capitalized and ending with a period, saying
  what it is or does. Don't repeat the name or the type.
- **Then the details a caller needs**, the ones the type can't say: units (ms,
  bytes), defaults (`@defaultValue`), limits, which world or context runs it
  (background, bridge, page MAIN world, `onSite`), who sends a message and who
  answers it, timing and ordering, what happens on failure (`@throws`, or what
  it returns instead), and what lasts how long.
- **Tags.** `@param` for each parameter whose meaning isn't plain from its name
  and type, `@returns` when the result needs explaining, `@example` for
  anything a tweak calls directly, and `{@link Other}` for related symbols
  (`@see` for docs pages).
- **Facts from the code.** Every detail must match what the code and its tests
  do. Name constants (`{@link WIRE_TIMEOUT_MS}`) rather than copying their
  values, so the comment can't go stale.

```ts
/**
 * How long {@link Endpoint.call} waits for an answer when
 * {@link EndpointOptions.timeoutMs} isn't set, in milliseconds.
 *
 * Past it, the call rejects with a `TimeoutError`. Closing the link rejects
 * pending calls right away with a `DisconnectedError` instead.
 */
export const WIRE_TIMEOUT_MS = 30000;
```

The helper is versioned separately in `helper/Cargo.toml`: bump it only when
the helper changes. When the extension starts depending on new helper
behavior, also raise `MIN_HELPER_VERSION` in `src/shared/helperInstall.ts` —
older helpers then log an upgrade error. Every release still ships helper
binaries, so the install command always fetches the newest one. When nothing
the helper is built or tested from (`helper/src`, `helper/Cargo.*`, the
shared matcher fixtures) changed since the previous release, the Action
copies that release's binaries (checked against its `SHA256SUMS`) instead of
rebuilding them; run the workflow by hand with **rebuild_helper** to force a
rebuild.

## UI

The extension's pages (popup, Editor, Network view) are React components
(`src/ui/`, `.tsx`) with [Valtio](https://valtio.dev) proxy stores for
shared state: components read a store with `useSnapshot`, plain code
mutates it or `subscribe`s to it. Large lists (network entries) sit in a
`ref()` and are replaced as a whole on change, so Valtio doesn't proxy each
item. Monaco is loaded separately (`lib/monaco`) and its objects never go
into a store. The build is not minified, so the bundles stay readable.

The Editor (`editor.html`) is a single `#root` that
`src/ui/shell/mount.tsx` renders synchronously, before the rest of
`editor.ts` runs. `editor.ts` holds no markup: it owns Monaco, the scripts and
the background connection, and drives the UI only through the stores below
(and moves focus). Its layout (explorer and panel shown,
explorer width, panel tab, word wrap) is the `layout` store
(`src/ui/state/layout.ts`), saved to `localStorage` as it changes. Monaco
draws into `<MonacoHost>`; `createCodeEditor()` (`src/ui/shell/codeEditor.ts`)
creates the editor in it once Monaco has loaded.

The panel (`src/ui/panel/`) reads its own stores: `logState` and the log
buffer (`state/log.ts`; `appendLog` adds a line), `panel` (`state/panel.ts`:
the Problems, the Network view's recording and the status bar's counts, kept
in `badges` and announced with `badgesChanged()`) and `dockLayout`
(`state/dock.ts`: which edge the panel and explorer are docked to, and the
panel's size per edge). `PanelDock` keeps one `#log-panel` element and moves
it into `#editor-area`, `#app` or `#sidebar` as it is docked, rendering into
it through a portal; those containers' own React children don't change, so
the extra element doesn't upset React. Components call into `editor.ts`
through the `actions` object (`src/ui/shell/actions.ts`), which `main()`
fills in.

The explorer (`src/ui/explorer/`) renders the `explorer` store
(`state/explorer.ts`): the scripts, data files and folders, the open file,
the cursor row and multi-selection, the collapsed folders (saved to
`localStorage`) and the inline name input being edited (`editing`).
`editor.ts` still owns the file lists and copies them in with
`renderList()` → `syncExplorer()` whenever they change. The right-click menu
(`ContextMenu`) is a portal into `document.body`, rendered by `App` outside
the tree: React bubbles a portal's events through its React parents, so a
menu inside the tree would see its clicks and keys as the tree's.

The dialogs (`src/ui/dialogs/`: Settings, Help, Welcome, Quick Open, the
save-conflict diff and the import/export checklist) open and close through
the `dialogs` store (`state/dialogs.ts`). `resolveConflict()` and
`pickRows()` put their options in the store and return a promise the dialog
settles. Settings' values (theme, synced folder, launch target, helper
status, About, diagnostics) are the `settings` store (`state/settings.ts`),
which `editor.ts` loads from `chrome.storage` and keeps in sync. Form
controls listen with native listeners (`useControl` in
`dialogs/controls.tsx`) because React's `onChange` ignores a `change` event
dispatched by a script, which the e2e tests do. The toast and the tooltip
(`toast.ts`, `tooltip.ts`) stay small DOM helpers: they are shown from
anywhere, including Monaco's callbacks, and hold no state worth rendering.

The Code view's toolbar (`shell/EditorToolbar.tsx`: the Enabled switch, the
status line, Save, folder sync, ↗ and the layout toggles) renders the
`toolbar` store (`state/toolbar.ts`), which `editor.ts` sets. Save's state is
set inside `flushSync` and read with a `{ sync: true }` snapshot, so every
state (`unsaved` → `saving` → `saved`) reaches the DOM, as the e2e tests
expect. The explorer's resize handle (`SplitV`) sizes `#sidebar` directly
while dragging and saves the width to the `layout` store once let go.

An effect's arrow function must not return a value by accident:
`useLayoutEffect(() => el.scrollIntoView())` breaks in Chromium, where
`scrollIntoView()` returns a promise that React then calls as the cleanup.
Write `() => void el.scrollIntoView()`.

Valtio's `useSnapshot` re-renders a component only for the properties it
read, and in a microtask unless `{ sync: true }`: views that must be up to
date right after a `flushSync()` (panel tab, docking) use `sync`.

Two React habits to keep in mind: `onChange` on a text input fires on every
keystroke (use a native `change` listener for "commit on blur/Enter"), and a
document listener added by an effect in response to a click or key may see
that same event; skip it with `openedBy()` from `src/ui/lib/events.ts`.

## Built-in modules and overlays

Scripts can import the extension's own valtio and React 19 by name
(`src/shared/builtinSpecs.ts` lists the specifiers, `src/shared/builtins.ts`
resolves them). valtio's vanilla parts are bundled with the compiler;
React is a separate chunk, `builtins-react.js` (`src/builtins/react.ts`),
loaded with a `<script>` tag only when a script imports it. Bumping
`react` in `package.json` changes what scripts get: note it in the
changelog. `.tsx` scripts compile with the automatic JSX runtime
(`"jsx": "react-jsx"` in the generated `tsconfig.json`).

A script's overlay GUI (`tweak.onOverlay`) runs in `overlay.html` + `overlay.js`
(`src/overlay/overlayRuntime.ts`), a web-accessible page the bridge
(`src/hook/bridge.ts`) frames into the top page inside a closed shadow
root, one frame per script. The bridge hands the frame a `MessagePort`;
the frame's code, stores and `from: "page"` fetches go through the
bridge's extension port (`src/background/engine/overlayLinks.ts`
authorizes each script on it). Calls between the overlay, `onPage` and
`onSite` code (handles) use `src/shared/rpc.ts`; a save re-runs handlers
in place through `src/shared/runLifecycle.ts`. On Chromium (MV2 and MV3) the manifest lists
`overlay.html` as a sandbox page, so it runs scripts without the extension
CSP and has an opaque origin; Firefox has no manifest sandbox, so there it's
a normal extension page that checks a one-time nonce with the background
before it accepts a port. If something else removes a frame (another
extension's debugger attach; the page can't reach the shadow root), the
bridge logs a warning and closes that overlay, and doesn't start it again
until its code hash changes or the page reloads.

## How the MV3 build works

`npm run build` produces both bundles:

- **`dist/` (= `dist-mv2/`)** — the MV2 build for Chromium.
- **`dist-firefox/`** — the same MV2 build for Firefox (the `.xpi`): its
  manifest also registers the page hook as a MAIN-world content script,
  which Chromium's MV2 rejects ("The 'world' property is restricted…").
  On Chromium MV2 the bridge injects the hook with a `<script>` tag instead.
- **`dist-mv3/`** — the Manifest V3 build (`manifest_version: 3`,
  background service worker, `action`, `host_permissions`).

How MV3 differs (Chrome forbids `eval` in service workers and extension
pages, and drops blocking `webRequest`):

- **User scripts compile and run in a sandbox page.** The manifest's
  `sandbox` key exempts `sandbox.html` from the extension CSP — it's the
  only MV3 context where `new Function` is allowed. The service worker
  routes compiles/ executions there through an offscreen document
  (`offscreen.html` bridges chrome.runtime ⇄ iframe postMessage). Handler
  results, script logs and `tweak.storage` round-trip back over the same
  channel.
- **The `page` strategy carries page fetch/XHR interception** (patching in the
  page's MAIN world — same behavior, transforms execute in the sandbox).
  The `extension` strategy is gone (no blocking webRequest in MV3).
- **Browser-initiated loads (`<script src>`, `<img>`, stylesheets, fonts,
  main-frame HTML) go through the `debugger` strategy** for handlers whose
  strategy is `debugger` (or through the local helper with `helper`).
  The service worker
  drives `chrome.debugger` / CDP `Fetch` (pausing only URLs matching those
  handlers' routes, fetch/XHR included);
  handler decisions (`onRequest`, `replaceResponse`, `onResponseBody`) are
  computed in the sandbox, so only the owning handlers apply.
  `page` handlers stay fetch/XHR-only (a page load they match is warned about).
  Caveats:
  - Chrome shows its "started debugging this browser" banner, and every
    http(s) tab is attached while such scripts exist (the resource's CDN
    host rarely equals the tab's host).
  - The first navigation in a tab usually leaves before the debugger
    attaches. If a script matches the page itself and the request was a
    GET, it is re-issued through the debugger (`Page.navigate`) so it IS
    intercepted ("re-loaded it through the debugger" in the log). Anything
    else that slips through (POSTs, very fast subresources) is logged as a
    **warning** ("… was NOT intercepted by "X" — it loaded before the
    debugger attached … Reload the tab"); a reload is intercepted (tabs
    stay attached). MV2 attaches only once the navigation has started, so
    there the page itself is always missed on its first load (warned).
  - `onResponseHeaders` is applied at the Response stage
    (`Fetch.continueResponse` keeps the body streaming when no body handler
    changes it); redirects/error statuses pass through untransformed.
  - Extra permissions: `debugger`, `webNavigation` (attach as early as
    `onBeforeNavigate`), `webRequest` (observe-only, for the Missed warning).
- **Folder sync works** — the poller runs in the service worker: a 25s
  keep-alive ping (any extension API call resets the SW's ~30s idle
  timer) holds the worker open while a folder is connected, with a 30s
  `chrome.alarms` poll as the fallback if the worker is reaped anyway.
- onPage runs in the isolated world (MV3: a `chrome.userScripts`
  world); onSite runs in the MAIN world (MV2: when the page CSP allows,
  isolated fallback otherwise).
- **No `eval` in content scripts (MV3).** The Chrome Web Store allows
  running code that isn't in the package only through `chrome.userScripts`
  and `chrome.debugger`, so `hook.js` and `bridge.js` are built with
  `__NO_EVAL__` and never compile code. Each onSite script, the module
  scripts it imports and its package modules are registered as
  `chrome.userScripts` with `world: "MAIN"` (`tt-main-<id>`,
  `src/shared/siteCode.ts`): each pushes its function onto a queue on the
  page's global, keyed by name and code hash, and the hook takes them from
  there. Saving a script also runs the new functions in open tabs
  (`userScripts.execute`, Chrome 135+). With user scripts off, onSite
  code doesn't run. **`document_start` timing caveat:** in MV2 the
  always-alive background answers the bundle in ~1ms, so onPage handlers
  reliably beat the page's own scripts. In MV3 the service worker must
  wake first — analyses are cached in `chrome.storage.session` (and
  refreshed on every script change), so the bundle is served from storage
  without waking the sandbox, but a cold SW still costs ~50-100ms; inline
  page scripts may run before an onPage handler does. Fetch/XHR
  interception is unaffected.

Verify the MV3 bundle: `npx tsx test/mv3.e2e.ts` (SW registration, Editor,
script save/list through the sandbox, settings.json, `page` interception,
`debugger` `<script src>` interception incl. gzip, lazy chunks and reloads).
