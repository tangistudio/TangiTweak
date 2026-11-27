# Changelog

All notable changes to TangiTweak. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Each release's notes on GitHub are
its section below.

## [Unreleased]

### Changed

- **The Chrome release files are now `tangitweak-chrome-vX.Y.Z.zip` and `tangitweak-chrome-vX.Y.Z.crx`** (they were `tangitweak-mv3-…`). Every build is Manifest V3 now, so the name says the browser instead. The Firefox file stays `tangitweak-firefox-vX.Y.Z.xpi`.
- **Firefox runs the Manifest V3 build and needs Firefox 154 or later** (desktop and Android). It was Manifest V2.
- **On Firefox, `onPage` and `onSite` code need the "user scripts" permission**, like on Chrome. The Editor's banner and the toolbar's **!** offer **Grant permission**; there's no other switch to turn on. Until it's granted that code doesn't run and Problems says so. Network handlers and `onOverlay` code don't need it.
- On Firefox, `extension` strategy handlers run in the sandbox page, like every other handler.
- **`tweak.isMV3` is now `true` on Firefox too** and `tweak.isMV2` is always `false`. Both are deprecated: a tweak that picked a strategy with `tweak.isMV3 ? … : "extension"` should use `tweak.isChrome` or `tweak.isFirefox` instead.

### Removed

- **The Chrome MV2 build** (`tangitweak-mv2-vX.Y.Z.zip` / `.crx`, `dist/`). Chrome 138 turned Manifest V2 off for everyone and Chrome 139 removed the policy that kept it on. Use `tangitweak-chrome-vX.Y.Z.zip` on Chrome, Edge and Brave. The `extension` strategy is now Firefox only.
- **Breaking (SDK):** `browser: "chromium-mv2"` in `createTweakTest` and `loadTweak`. Use `"chrome"` or `"firefox"`.

### Fixed

- On Firefox the Editor, the popup and the install page list your tweaks. They showed none.

## [0.41.1-alpha] - 2026-11-27

### Added

- **[Debugger-friendly overlays](docs/scripting.md#debugger-friendly-overlays)** in Settings → Overlays (off by default, `debuggerFriendlyOverlays` in `settings.json`). Every `tweak.onOverlay` and toast pane draws in a closed shadow root in the page instead of an extension frame, so Playwriter and other `chrome.debugger` extensions can attach without removing them. The page can see keys typed into them. On Chrome MV3 it needs user scripts (toast panes also Chrome 135); without them Problems says so. `tweak.site` keeps its own `debuggerSafe` option.

### Fixed

- Toast panes show their source and close button above the pane instead of squeezed beside it.

## [0.41.0-alpha] - 2026-11-25

Handlers from several tweaks now stack predictably: they run from general to specific and the last word wins ([docs](docs/scripting.md#multiple-handlers--how-they-stack)).

### Added

- **Layers**: every network handler runs in a layer, `base`, `site` or `override`, before list order. A route on any host (`*://*/*`) is `base` and a route on a named host is `site`, so a site tweak builds on a general one whatever their order in the explorer. Set it in the popup's **Layer** select or `"layer"` in `.tweak/settings.json` (wins), on the route (`layer: "override"`) or in `package.json` (`"tangitweak": { "layer": "base" }`).
- **`{ allow: true }`** from `onRequest` lets the request through and drops an earlier `block`, `redirect` or mock. On `rules` it becomes an allow rule.
- **`ctx.replacedBy`** in `onResponseHeaders` and `onResponseBody`: `{ tweak, handler }` when the response is a mock, so a transform can skip mocks.
- **`replaceResponse: { body: { file } }`** serves a `data:` URL with its media type (it used to be `tweak.replaceResponse` only).
- **Handler stack** in the Network view: a request's **TangiTweak** tab lists the handlers that match it in run order, with strategy, layer and where it came from, and what each did (decided, overruled, skipped, ran on mock, ran).
- **Overlap hints** in Problems: when two tweaks' handlers may match the same request in the same stage, the later one gets an info hint naming who runs after whom. Hints aren't counted as warnings.
- **Log lines** when a decision is overruled by a later handler (with the layer reason) and when a response handler runs on a mock, throttled.
- **[`tweak.every(interval, fn)`](docs/scripting.md#tweakevery)** runs code on a schedule in the background, also while no tab is open: `"30s"`, `"5m"`, `"1h"`, `"1d"` or a function that returns the interval, or `false` to stop. Runs that were due while the browser was closed run once at start. In a package, its `tweak.fetch` calls reach only the `"tangitweak.connect"` hosts.
- **[`tweak.toast(...)`](docs/scripting.md#tweaktoast)** shows a small card inside the tab: a title, a message, a link and buttons that reach `tweak.onToastAction`. It shows in the tab in front, the calling tab or the tabs that match a URL pattern, and waits up to `ttl` for one. A tab in the background flashes its title and gets a dot on its icon until the user comes back. The TangiTweak button shows a dot too.
- **[`tweak.toastStyle(...)`](docs/scripting.md#toast-styles)** gives a tweak's toasts their own colors, size, corner and CSS, in light and dark mode. Toasts from every tweak share the corners and stack neatly. The user can drag them to another corner for a site.
- **[`tweak.toastPane(name, render)`](docs/scripting.md#toast-panes)** lets a toast draw its own React layout.
- The Editor has a **Schedules** view (⌥⇧S) with Run now and Pause, and its Preview draws toast panes. The popup can mute a tweak's toasts and shows its last 20; Settings has a Toasts section.
- `tangitweak/test`: `t.trigger("every")`, `t.trigger("toastAction", event)` and `t.toasts`.
- **The toolbar icon shows an amber "!" while user scripts are off** (Chrome MV3), on every tab, because `onPage` and `onSite` code don't run then. Hovering the icon says why. The popup explains it too, with a button for the next step: grant the `userScripts` permission, then open TangiTweak's details to turn on "Allow User Scripts".
- **[`tweak.site(route, fn)`](docs/scripting.md#full-page-replacement-tweaksite)** replaces a website in place with your own React app. The tab stays on the real URL, so `ctx.origin.fetch` sends the site's cookies. `exclude` keeps pages like login or checkout on the real site. The popup gets an **Original | Custom** switch, `ctx.navigator` works with React Router and the original site comes back if your app fails to start.
- **`debuggerSafe: true`** on `tweak.site` and `tweak.onOverlay` keeps them visible while another extension (such as Playwriter) has `chrome.debugger` attached to the tab.

### Changed

- **Breaking:** the last decision wins instead of the first. When two `onRequest` handlers in the same layer return `block`, `redirect` or `replaceResponse`, the one later in the list now wins.
- **Breaking:** every `onRequest` handler runs. Handlers after the deciding one used to be skipped, so their side effects (counters, logging) now happen. Returning nothing keeps the earlier decision.
- **Breaking:** handlers on any host are `base` and run before named-host handlers, whatever the explorer order.
- **Breaking:** mocks go through `onResponseHeaders` and `onResponseBody`. A transform written for the real response now runs on mocks too unless it checks `ctx.replacedBy`. Not on Chromium's MV2 `extension` strategy or `rules`, which serve mocks by redirect.
- **Breaking:** a mock for a document, stylesheet or script with no known URL extension gets its Content-Type from the resource type (HTML, CSS, JavaScript) instead of `application/json`.
- **Breaking:** `ctx.patch` in `onSite` shares one chain per patched function and frame, ordered by layer then list: the `base` patch sits closest to the original. `orig` is the next patch in the chain, so it is no longer always the original function.
- `ctx.requestHeaders` in `onRequest` and `ctx.responseHeaders` in `onResponseHeaders` include the edits of the handlers that ran before.
- On `rules`, the run order becomes the rules' priority.
- **Open pages ask for the `onSite` code they lack** (Chrome 135+), instead of every save sending its new code into every open tab. Only the frames a tweak runs in get its code. A page asks again every 1.5 seconds while the code hasn't come, so a failed delivery recovers by itself.
- The Firefox build gets fewer warnings from Firefox Add-ons (61 down to 39 in `addons-linter`, no errors). It's now its own build that leaves out what Firefox doesn't have (the `debugger` permission and its calls, `webRequest.onActionIgnored` and the Chromium-only `serve.html` page), and its manifest says TangiTweak collects no data (`data_collection_permissions`). The build fails if a Chromium-only call gets back in. What's left is needed: running scripts' code (`eval`/`Function`, the CSP's `'unsafe-eval'`) and React's and Monaco's own `innerHTML`.
- Firefox needs version 140 or later (142 on Android), which the data-collection setting needs. Every older Firefox stopped getting updates by September 2025.

### Removed

- **Breaking:** `tweak.replaceResponse`. Calling it throws an error that shows the rewrite: return `{ replaceResponse: { body } }` from `tweak.onRequest` instead, e.g. `tweak.onRequest(route, () => ({ replaceResponse: { body: { ok: true } } }))`.

### Fixed

- **One stuck tab no longer stops `onSite` changes everywhere** (Chrome 135+): while a tab couldn't run code (an open `alert` or `confirm`, a page paused in DevTools, a busy page), every save after the first left all tabs with "… onSite code isn't on this page: reload the page to run it", and reloading the page didn't help. Saves now update the other tabs at once, and the stuck tab when it responds again.
- **`onSite` code that reaches a page late still runs** (Chrome 135+): code that arrived more than 5 seconds after its save was dropped until the page reloaded.
- **`onSite` code runs on pages whose CSP forbids `eval`** in Firefox and Chrome MV2. It didn't run there: the [fallback to the isolated world](docs/scripting.md#tweakonsite--the-sites-world) wasn't wired up, and Firefox's CSP error wasn't recognized. Saves reach those pages too.
- **A page restored with Back or Forward runs the `onSite` and `onPage` code saved meanwhile, and keeps getting saves**: a page kept in the browser's back/forward cache got no updates, came back with its old code and missed every later save until it was reloaded. Nothing runs again when nothing changed.
- **`onPage` changes reach open tabs after the service worker restarts** (Chrome MV3): a save that woke the worker left open tabs running their old `onPage` code until they were reloaded.
- **Firefox: the first page loaded after the extension starts runs its `onSite` code**. It could miss it and hold its first fetch/XHR requests for 3 seconds, because the page hook asked for its scripts before the extension's side was listening.
- Editor: Monaco's editor worker loads again (diffs, word completions and links ran without it). It logged `Failed to fetch dynamically imported module: …/lib/monaco/editor.worker.js` each time it started.

## [0.40.2-alpha] - 2026-11-22

The first published release since 0.36.1-alpha: it also brings the changes under 0.40.1-alpha and 0.37.0-alpha in the [CHANGELOG](CHANGELOG.md).

### Added

- **`ctx.iframes(selector?, fn)`** in `onPage` and `onSite` handlers runs `fn` in each same-origin iframe, now and as they're added, with its own `signal`, `style`, `patch`, `mount` and more aimed at the iframe's document. It reaches `about:blank` and `srcdoc` editor frames, re-runs when an iframe loads a new document, and keeps state across saves.
- **`ctx.elements(selector, fn?, opts?)`** in `onPage` and `onSite` handlers returns the elements a selector matches, or runs `fn(el, signal)` on each match now and as matches appear, aborting `signal` when one leaves. Options: `first`, `shadow`, `root` and `key`.
- **Shadow DOM**: `shadow: true` in `ctx.elements`, `ctx.mount` and `ctx.iframes` also looks inside shadow roots (closed ones too in `onSite` and in MV2 `onPage`).
- **Iframe shortcuts**: `ctx.shortcut(keys, fn, { iframes: true })` (or a selector, or `{ shadow, crossOrigin }`) also counts keys pressed in child iframes, such as the hidden editing iframe of Google Docs; `crossOrigin: true` follows iframes from other sites too. In `onPage`, `ctx.iframes`'s `f.shortcut` listens in one iframe. Page code now also runs in `about:blank` and `srcdoc` frames. The limits are in [docs](docs/scripting.md#limits--shadow-roots-and-iframes).
- **Script lint** in the Editor's Problems: stores or handles used in `onSite` code, `tweak.siteStore` in network handlers, logging, timers or store writes in `strategy: "rules"` handlers, and bad CSS selectors and shortcut keys, found before the tweak runs.
- **Folder Sync writes `eslint.config.mjs`** and `.tangitweak/eslint-plugin.mjs`, and lists ESLint and typescript-eslint in the root `package.json`, so `npx eslint .` or VS Code's ESLint extension shows the Editor's checks in a synced folder ([docs](docs/editor.md#synced-folder)).
- **Uncaught errors in `onPage` code show in the Log**: an error thrown in a timer, event listener or observer callback, or a promise nobody awaits, is logged as the tweak's (`onPage (uncaught)` / `onPage (unhandled rejection)`) with its source lines. The page's own errors aren't.
- **`tweak.fetch` in `onPage` code**, to the hosts listed in the tweak's `package.json` `"tangitweak.connect"` and their subdomains only. Any other host rejects and names the host to add ([docs](docs/scripting.md#tweakfetch)). It used to reject everywhere in page code; `onSite` code still can't use it.
- **Page code can follow single-page apps**: a route's `navigation: "match"` runs an `onPage`, `onSite` or `onOverlay` handler while the URL matches, starting when an in-place URL change (history API, back/forward, `#hash`) makes it match and ending, with its setup undone, when one makes it stop; `"every"` also runs it again on each URL change. `ctx.onNavigate(fn)` now works in `onPage` and `onSite` too ([docs](docs/scripting.md#single-page-apps--navigation)). Routes still match only the URL a page loaded with by default.
- **A "!" badge on tabs TangiTweak isn't running in**: tabs left open while TangiTweak was installed, updated or reloaded get no page code until they reload, because the browser only adds extensions to pages loaded afterwards. The popup says why and has a **Reload tab** button, or **Allow and reload** when the site's access is turned off in the browser.

### Changed

- **Folder Sync and Import load everything first, then compile once**: they list and read every file, save it all, then compile the scripts together, so open tabs reload once with the finished set instead of once per file with half-loaded tweaks and missing-import errors in between. The Editor's toolbar shows the progress (listing, reading, saving, compiling) while it takes longer than a moment.
- **The SDK's typings are documented throughout**: every declaration and member in `index.d.ts`, `tangitweak/test` and the `types/` files they import (such as `types/shared/wire.d.ts`) says what it is, its units, defaults, limits, which world runs it and what happens on failure. `npm run build` fails when something is undocumented (see [Documenting the SDK](docs/development.md#documenting-the-sdk)).
- **The Editor checks scripts with TypeScript 6** (Monaco 0.57), so newer browser APIs like `navigation`, `URLPattern`, `scheduler.postTask` and `Uint8Array.prototype.toBase64` no longer show false type errors. TypeScript 6 checks strictly by default (`strict`), so scripts may see new errors like implicit `any` parameters or possibly-`null` values.
- **`npm install` in a synced tweak's folder works before the SDK is on npm**: the synced folder's root `package.json` now lists every tweak and `.tangitweak/sdk/tangitweak` as npm `workspaces`, so a tweak's `tangitweak` dependency installs as the running extension's SDK instead of failing with `No versions available for tangitweak`.
- **No more "registered no handler at top level" warnings** for a bundle's modules: a module that registers handlers inside a function its entry calls is the normal layout.
- **No more `tt-api.d.ts`** at the root of the synced folder: each tweak's `tsconfig.json` extends the SDK's, whose `index.d.ts` has the same typings. The one TangiTweak wrote is removed; one you wrote yourself stays.
- **No more `settings.schema.json`** in the synced folder. The one TangiTweak wrote is removed; `settings.json` still gets completions and validation in the Editor.
- **The Explorer folds a tweak's stores** under one `.tweak/stores` row, closed until you open it (click, Enter or →); opening a store from elsewhere opens the row.
- **Faster URL matching with many tweaks**: each request is now checked only against the routes whose host could match it (its exact host, a `*.domain` it's under, or patterns with a wildcard host), not every route. With 1,000 routes on different hosts, matching a request drops from about 0.2 ms to under a microsecond. Parsed URL patterns are no longer all thrown away once there are more than 1,000 of them.
- **A tweak's `"tangitweak"` block in `package.json` is optional**: listing `tangitweak` in `dependencies` is enough to make a folder a tweak (a `package.json` with only the block still counts). A `package.json` with neither now says so in the Editor, instead of calling its files "single-file scripts".
- **The popup lists tweaks, not their modules**, and the Explorer's tooltip on a module names its tweak's entry. **New Module…** starts from a small importable module instead of a whole script, the Welcome page's **New empty tweak** makes a tweak, and **Import…** takes zips only.

### Fixed

- **`onSite` changes reach open tabs after the service worker restarts** (Chrome 135+): a save or folder sync that woke the worker no longer leaves open tabs with "… onSite code isn't on this page: reload the page to run it". Only an extension reload or update still needs the page reloaded.
- **`about:blank`, `srcdoc` and sandboxed iframes** no longer hold their first fetch/XHR requests for 3 seconds and then send them unhandled, and `onSite` code in them gets its routes. The page hook and the extension couldn't message each other in frames whose origin is `"null"`.
- **Packages whose `exports` points at a `.js` file with its `.d.ts` beside it** (e.g. `@redux-devtools/instrument`) get their real types in the Editor instead of an `any` stub (`has no exported member 'instrument'`). Packages already stored with a stub are fetched again.
- **Packages with class static blocks** (e.g. `bson`) no longer fail to load with `this.resetState is not a function`: CommonJS files assigning `exports.x` aren't mistaken for ES modules, and modern class syntax in packages is kept as is.
- **Two browsers syncing one folder** no longer rewrite `.tweak/stores/*.json` back and forth forever (`changed on disk — applied` every few seconds): a file holding the same data in another key order isn't rewritten.
- **Bare imports type-check in the Editor**: `import { zip } from "fflate"` in a tweak with `fflate` in its `package.json` `dependencies` gets the package's types instead of `Cannot find module 'fflate'`. Range dependencies like `^0.8.2` now get typings too.
- **The Editor no longer checks a tweak's `.gitignore` as JSON** (`Expected a JSON object, array or literal`).
- **A tweak whose handlers depend on its params** (e.g. `if (params.on) tweak.onPage(…)`) keeps its enable switch in the popup, Editor and Explorer while they're off, instead of turning into a 𝑓 library.

### Removed

- **URL imports** (`import x from "https://unpkg.com/x@1.2.3"`) are no longer supported: list packages in the tweak's `package.json` `dependencies` and import them by name. Such an import is now a compile error that the Editor and ESLint mark. The pin-the-version quick fix and Preact via `@jsxImportSource https://unpkg.com/preact@…` go with them.
- **The 𝑓 library marker** and the last single-file paths: a script with no handlers is a module of its tweak, and installed packages always have one entry in their own folder.

## [0.40.1-alpha] - 2026-11-21

### Added

- **`import { tweak } from "tangitweak"`**, the imported authoring API that replaces `tt`. It works in every world (network handlers, `onSite`, `onPage`, `onOverlay`, tests) and in imported files, with full typings in the Editor and in Folder Sync. `tweak.globalStore(id, …)` takes a file-name-safe ID (lowercase letters, digits, `-`, `_`, `.`); `tweak.tabStore`, `tweak.pageStore` and `tweak.siteStore` take no name.
- **Tweaks are folders with a `package.json`** that has a `"tangitweak"` block (`displayName`, `icon`, `connect`, `updateURL`, `minTangiTweakVersion`); `name`, `version`, `description`, `author`, `license` and `homepage` are the standard fields. The entry is `main`, else `index.ts`, else `index.tsx`: it owns the enable switch, params and stores, and the modules it imports register handlers, params and stores for it. A store ID can be declared once per tweak ([docs](docs/packages.md#packagejson)).
- **`dependencies.tangitweak`** sets the oldest TangiTweak a tweak runs on (`^0.40.0-alpha` → 0.40.0 or newer; only `major.minor.patch` is compared). On an older TangiTweak the tweak doesn't run and says which version it needs; the install page warns and auto-updates wait for review.
- **New Tweak…** in the Explorer creates a folder with `package.json` (its `"tangitweak"` block and `"dependencies": { "tangitweak": "^<version>" }`), `tsconfig.json` (`{ "extends": "tangitweak/tsconfig.json" }`), an example `index.ts` and a `.gitignore`.
- **Bare imports from `dependencies`**: `import dayjs from "dayjs"` downloads the package the tweak's `package.json` lists from unpkg. npm aliases (`"path": "npm:path-browserify@^1.0.1"`) work in a tweak's dependencies and in a package's own. A package that `require`s a Node.js built-in (`events`, `buffer`, `node:events`, …) it doesn't depend on gets the tweak's own dependency of that name (each tweak its own), and the error says which line to add ([docs](docs/scripting.md#packages-from-unpkg)).
- **The `tangitweak` npm package** (the SDK): `npm install --save-dev tangitweak vitest react react-dom valtio` gives a tweak's tests `tangitweak/test`, the `tweak` API's typings, and the `tsconfig.json` a tweak extends (React, ReactDOM, valtio and Vitest are optional peers, so type-checking alone needs only `tangitweak`). Its version is the extension's. Each GitHub release attaches it as `tangitweak-sdk-v<version>.tgz` too ([docs](docs/testing.md#setup)).
- **Folder Sync writes the same SDK** to `.tangitweak/sdk/tangitweak/` and lists it as the root `package.json`'s `tangitweak` devDependency, so `npm install` in a synced folder sets up tests and type-checking without the npm registry. A tweak's own `package.json`, `tsconfig.json` and `.gitignore` sync as its data files.
- **A tweak's data folder**, `.tweak` by default: `.tweak/settings.json` holds its enable switch and the params you changed from their defaults, and `.tweak/stores/<id>.json` holds each persisted `tweak.globalStore("<id>", …)`. The Explorer lists them inside the tweak's folder and Folder Sync mirrors them both ways; an invalid file is reported and neither applied nor overwritten ([docs](docs/editor.md#a-tweaks-data-folder)).
- **Settings → Tweaks → Tweak data folder** (`"dataFolder"` in `settings.json`) names that folder; changing it renames it in every tweak.
- **`"tangitweak/test"`**, replacing `@tangitweak/test`: Vitest's `test` with `page`, `browser`, `net`, `tweak` and `mount` fixtures, and `createTweakTest({ params, entry, browser, realLimits, mocks })` for others. A test finds its tweak from the nearest `package.json` with a `"tangitweak"` block, and each test gets its own copy of the tweak and its stores (so `test.concurrent` works), each tab its own document. `mount("features/x/Panel")` renders one component through TangiTweak's compiler; `renderTweak(<Panel />, { stores })` is React Testing Library's `render` with store seeds and a reset after each test ([docs](docs/testing.md)).
- **Tests follow each strategy's real limits:** `net.request` walks a request through `page → rules → extension → debugger → helper` as the chosen browser (`"chrome"`, `"chromium-mv2"`, `"firefox"`) would, and the result's `skipped` and `decidedBy` say which handlers didn't run and why, and which one decided. `realLimits: false` runs every handler in one chain as before.
- **Tests catch browser differences:** the tweak sees no Node globals (`Buffer`, `process`, …), `rules` regexes are checked with RE2 (`re2js`) and the rule counts with Chrome's limits, `onSite` and `onPage` have separate window globals, `page.goto(url, { csp })` applies a page's CSP, and `res.skipped` warns that the `debugger` may miss a new tab's first page load. npm packages in tests come from `node_modules`, resolved as the extension resolves them ([docs](docs/testing.md#browser-differences-the-tests-catch)).
- **Export…** has **Include my settings and saved data**, off by default, to add each tweak's data folder to the zip; **Import…** lists a zip's data folder files in their tweak's folder.

### Changed

- Handlers are keyed by their registration order per API (`onPage:0`, `onPage:1`, `onPage:0@lib` for a module's), the same in every world, with no source rewriting. Unnamed stores are named after the file that creates them and their position among its `tabStore` / `pageStore` / `siteStore` calls (`index#0`, `lib/state#1`); a store or handler a module creates belongs to the tweak.
- The built-in samples, new-script templates, quick fixes, completions, hover docs, Problems and log messages all use `tweak`.
- **Install, update and Export Package…** read a tweak's `package.json`: its name, version and `updateURL` (in the `"tangitweak"` block). Installing a `.ts` URL installs the tweak whose `package.json` is next to it, and a folder, gist or zip installs its `package.json`'s tweak.
- **New Script…** and **Install Script…** are now **New Tweak…** and **Install Tweak…**.
- Installing or updating a tweak never takes a package's data folder (or any dot folder) and never overwrites the tweak's settings or saved stores.
- A synced folder's root `package.json` and `tsconfig*.json`, and `package-lock.json` / `jsconfig.json` anywhere, are left alone; Folder Sync's typings for downloaded packages skip `.tangitweak/sdk/`.
- `loadTweak`'s `simulate` follows the strategies' real limits by default (`realLimits: false` for the old single chain), and `openPage` takes `setup(window)` for the website's own globals instead of the test setting them on a shared window.
- In tests, a `tweak.tabStore` survives a reload of its tab, as in the browser. It used to be per page.

### Removed

- **The `tt` global**, with no compatibility shim. A script that still uses it fails to load with an error that says to `import { tweak } from "tangitweak"`.
- **Single-file scripts and `metadata.json` bundles** no longer load or install. The Editor lists their files in Problems as needing a rewrite and keeps them.
- **Make Package…**: make a tweak with **New Tweak…** instead.
- **`tt.metadata(…)`**: metadata comes from the tweak's `package.json`.
- **`tt.defineParam(…)`**: use `tweak.params({ … })`, which may be called more than once.
- **The root `stores.json`** and **`settings.json`'s `"scripts"` key**: each tweak's settings and stores are in its data folder. A `stores.json` left in a synced folder is now an ordinary data file, and a `"scripts"` key is ignored.
- **`@tangitweak/test` and `#tangitweak/test`**: use `tangitweak/test`. Folder Sync deletes the old `.tangitweak/test/` folder and its two entries in the root `package.json`, and releases no longer attach `tangitweak-test.tgz`.

## [0.37.0-alpha] - 2026-11-15

### Added

- **`@tangitweak/test` (`#tangitweak/test`) automated script testing** for Folder Sync and CI: `loadTweak()` runs TangiTweak's real compiler, module/JSON/SVG resolver, `strategy: "rules"` DNR probe, `simulate()` HTTP pipeline, and `openPage()` DOM lifecycle (React 19 closed shadow roots via `page.mountFor()`, `onOverlay`, `onSite` RPC, `tt.globalStore` / `tt.tabStore` / `tt.pageStore` / `tt.siteStore`, keyboard shortcuts, SPA navigation, and hot-reload cleanup). See [docs/testing.md](docs/testing.md).
- Folder Sync now writes the standalone harness to `.tangitweak/test/`, merges `package.json` non-destructively (`#tangitweak/test` subpath import for zero-install `node --test` and `@tangitweak/test` for Vitest), configures `tsconfig.json` paths, and attaches `tangitweak-test.tgz` (`tangitweak-test-v<version>.tgz`) to every GitHub Release for CI.

### Changed

- Test and test-runner files (`*.test.ts(x)`, `*.spec.ts(x)`, `__tests__/`, and `vitest` / `vite` / `jest` / `playwright` config files) in synced folders and repositories are now ignored by Folder Sync, package discovery, **Make Package**, and **Export Zip**.

## [0.36.1-alpha] - 2026-11-13

### Changed

- Source URLs (`From …` and `updates from …`) in the **Install Script** dialog and `install.html` are now clickable links to the repository, folder, or script source page.

### Fixed

- Upgrading an unmanaged Explorer folder (such as a local git checkout synced via Folder Sync) now diffs only crawled package files instead of every file in the folder, so unimported companion files (`README.md`, unused utilities) are neither reported as `removed` nor deleted on **Upgrade**.

## [0.36.0-alpha] - 2026-11-13

### Added

- **`minTangiTweakVersion`** in `tt.metadata({ minTangiTweakVersion })` and bundle `metadata.json`: scripts and packages can declare the oldest TangiTweak version they support. TangiTweak warns on **Import…** (`.zip` and single files), **Install**, **Upgrade**, and in the Editor **Problems** view when the running extension is older, and holds background auto-updates for review until TangiTweak is updated.

### Changed

- Multi-file package installs and upgrades compile and save scripts in a single batch pass, speeding up large multi-file repository installs by an order of magnitude.

### Fixed

- Passing a `stringList` parameter (`cfg.pages`) into a route (`tt.onSite(cfg.pages, …)` or `tt.onPage({ url: cfg.pages }, …)`) no longer fails with `pattern.trim is not a function` during package analysis or corrupts stored route URLs in `chrome.storage.local`.

## [0.35.0-alpha] - 2026-11-13

### Added

- First-class GitLab repository, subfolder (`…/-/tree/<branch>/<folder>`), and file (`…/-/blob/…` / `…/-/raw/…`) installs and updates (including `#tangitweak:install` links, nested subgroups, slash-containing branch names, and self-hosted GitLab instances), working for both public and private repositories when signed in to GitLab in the browser and pinning updates to exact commit SHAs.

## [0.34.0-alpha] - 2026-11-13

### Added

- Private GitHub repository, subfolder (`…/tree/<branch>/<folder>`), and file (`…/blob/…`) installs and updates (including `#tangitweak:install` links): when `api.github.com` returns `404` or hits its rate limit, TangiTweak automatically fetches the repository archive using your browser's existing GitHub session cookies (including slash-containing branch names and large monorepo subfolders) and pins updates to the commit SHA.
- Cookie-authenticated fallback for `.zip`, script, and `metadata.json` package URLs that require an active browser login session.

## [0.33.1-alpha] - 2026-11-13

### Changed

- Clarified store lifetimes, persistence, and per-handler access rules across `tt.globalStore`, `tt.tabStore`, `tt.pageStore`, and `tt.siteStore` in Monaco hover typings (`tt-api.d.ts`) and [docs/scripting.md](docs/scripting.md).

## [0.33.0-alpha] - 2026-11-13

### Breaking

- **`settings.json` replaces `settings.yaml`**: extension settings and per-script `enabled` / `tt.params` overrides now live in a sparse `settings.json` file (`{}` when everything is at its default, with global settings at the top level and script overrides under `"scripts"`). Deleting any key — or saving `{}` — resets it to its default, and Monaco's built-in JSON worker provides schema validation, completions, and hover documentation directly from `settings.schema.json`.

### Added

- **`tt.tabStore(name, initial)`**: live `valtio` store scoped per browser tab across background, MV3 sandbox, overlays, and isolated `onPage` runtimes — surviving reloads and navigations within that tab and dropping automatically when the tab closes.
- **Reactive per-tab `strategy: "rules"`**: `rules` handlers can now read `tt.tabStore`, `tt.globalStore`, and `tt.params` conditionally (returning `undefined` when off without triggering a probe error), automatically emitting `tabIds` / `excludedTabIds` `declarativeNetRequest` session rules for diverged tabs and attributing Network `Modified` outcomes accurately per tab.

## [0.32.0-alpha] - 2026-11-12

### Added

- Root **`stores.json`** in the Explorer (below `settings.yaml`) and Quick Open (`⌘P` / `Ctrl+P`): view and edit persisted `tt.globalStore` data live across open tabs and overlays, sync it two-way at the root of your synced folder, include it selectively in **Export…** and **Import…** `.zip` archives, and inspect a `## Stores` section in **Collect diagnostics**.
- Same-name upgrade prompt in **Install Script**: when an incoming script or bundle matches an already-installed package or Explorer folder/script by name, TangiTweak shows version changes and expanded file diffs with **Upgrade** (preserving script IDs, `tt.params`, enabled state, and a **Roll Back** snapshot) alongside **Install as "`<name> (2)`"**.
- Feature comparison matrix and popularity-ordered survey of browser extensions and desktop proxies in [docs/comparison.md](docs/comparison.md).

### Changed

- Consistent `.ts` and `.tsx` file extensions across `settings.yaml` (migrating existing extensionless keys in place), `stores.json`, Quick Open (`⌘P`), and diagnostics reports.
- Updated extension manifest and documentation descriptions to `"Rewrite requests, responses, and pages in TypeScript."`

### Fixed

- `tt.globalStore` and `tt.pageStore` declared inside an imported library (`B.ts`) now consistently belong to `B.ts` across `onOverlay`, Editor Preview, and `onPage` (MV2 and MV3) instead of creating separate store entries under the importing script.

## [0.31.0-alpha] - 2026-11-12

### Added

- One-click `#tangitweak:install` share links: appending `#tangitweak:install` to any supported package or bundle URL (such as `https://github.com/owner/repo#tangitweak:install` in a GitHub `README.md`) opens TangiTweak's install page directly when clicked or visited.
- **Expand All** and **Fold All** in the Explorer's right-click menu on folders (and empty tree space), with keyboard shortcuts (`⌥→` / `⌥←` on macOS, `Ctrl+→` / `Ctrl+←` on Windows/Linux) and `⌥`/Alt-click on folders.
- Hovering a script in the extension popup now shows a larger preview of the script's custom icon inside its tooltip.
- `PageUp` and `PageDown` keyboard navigation (with automatic scroll-into-view) in the Quick Open (`⌘P` / `Ctrl+P`) dialog.

### Changed

- Scripts in the extension popup that are not active on the current tab now show a muted gray status dot instead of blank space.

## [0.30.0-alpha] - 2026-11-12

### Added

- Markdown (`.md`) data files in the Explorer and Editor: files like `README.md` sync in folders, travel with installed and exported packages/zips, open in Monaco with Markdown syntax highlighting, and import into scripts as strings (`import readme from "./README.md"`).

### Fixed

- `ctx.patch` now installs a `Proxy` stand-in instead of a plain `function` wrapper, keeping static properties on constructors (such as `WebSocket.CONNECTING`, `WebSocket.OPEN`, `WebSocket.CLOSING` and `WebSocket.CLOSED`) intact so patching `window.WebSocket` no longer breaks site code checking `ws.readyState === WebSocket.OPEN`.

## [0.29.0-alpha] - 2026-11-12

### Added

- Nested parameter sections in `tt.params`: group related parameters in plain nested objects (`tt.params({ network: { host: { type: "string", default: "api.example.com" } } })`) to render collapsible sections in the popup and nested maps in `settings.yaml`. Leaf parameters stay typed and assignable from handler code (`cfg.network.host = "staging.example.com"`).
- Custom icons on scripts and bundles: set `icon` in `tt.metadata({ icon })` or a bundle's `metadata.json` to a relative `.svg`, `.png`, `.jpg`, `.webp`, `.gif`, `.ico` or `.avif` file, a `data:` or `https://` URL, or inline `<svg>` markup. Icons show in the popup, the Explorer (on scripts and package folders), and the Install Script dialog. Raster image data files sync in folders and travel with exported packages and zips.
- Download progress bar in the Install Script dialog and page while fetching remote files, zip archives, or uncached `unpkg.com` packages.
- Folder sync now writes a managed `package.json` alongside `tsconfig.json`, and both note that they are auto-generated by TangiTweak and editing them has no effect.

### Changed

- New TangiTweak icon across the extension, extension pages, documentation, and store assets.
- In the popup, a bundle (`metadata.json` or installed folder package) with a single entry script shows only the bundle's name instead of `<folder>/<script>`.

### Fixed

- Opening the Editor with many scripts that import React, `valtio`, `unpkg.com` packages, JSON data files, or each other no longer flashes transient type errors while TypeScript loads. A single workspace coordinator stages all typings and models before running an epoch-stamped check pass, checking the open file first.
- Opening the Editor with `.svg` data files no longer logs an unhandled rejection (`Error: [object Event]`) from Monaco's AMD loader; `basic-languages/xml/xml.js` is now included in the bundle.
- Resizing the extension popup now stretches the script list to fill the full popup height and width.

## [0.28.0-alpha] - 2026-11-11

### Changed

- Wiretrick is now **TangiTweak**. Scripts use the `tt` global instead of `wt` (`tt.onRequest`, `tt.onSite`, `tt.params`…) and the `TangiTweak.*` types instead of `Wiretrick.*`: update existing scripts. Other renames:
  - shareable script files end in `.tangitweak.ts`;
  - a synced folder's generated files move to `.tangitweak/` and conflict backups to `.tangitweak-backup/` (delete the old `.wiretrick` folders);
  - the local helper is `tangitweak-helper`, with the native messaging host `com.tangitweak.helper` and `TANGITWEAK_HELPER_*` environment variables: reinstall the helper;
  - the repository and release links point to `tangistudio/TangiTweak`.
- Firefox: the add-on ID is now `tangitweak@tangistudio`, so Firefox installs it as a new add-on. Export your scripts from the old one first and remove it.

## [0.27.0-alpha] - 2026-11-11

### Added

- A [privacy policy](docs/privacy.md): what Wiretrick accesses and stores, the requests it makes, and why it needs each permission.

### Changed

- Chrome no longer asks for the "native messaging" and "browsing data" permissions at install. They're asked for the first time a script uses the `helper` strategy: Settings → Local helper shows "needs your permission" and an **Allow** button. Handlers on `helper` wait until then.
- Shorter extension description, within the Chrome Web Store's 132-character limit.
- Chrome 120 or later is required (was 116): the user scripts API that runs `onPage` and `onSite` code needs it.
- Chrome: `wt.onSite` code now runs through Chrome's user scripts API, like `wt.onPage`, so it needs [user scripts turned on](docs/scripting.md#user-scripts). Until they are, it doesn't run, and Problems and the Editor's banner say how to turn them on. The extension no longer compiles code in the page, which the Chrome Web Store doesn't allow. Saved `onSite` changes update open pages in place on Chrome 135 and later; on older versions, reload the page.

- Saving a script and hot reload are faster with many scripts. Each script's TypeScript is transpiled once and reused until its code changes. When a library is saved, all the scripts that import it are compiled together in one pass, so each library runs once instead of once per importer. In Firefox and other MV2 browsers, the analysis of all scripts is reused until a script, param, data file or package changes. The debug log's "compile" category now shows how long saves, analyses, reloads and page bundles take (`timing:` lines).
- The Editor's TypeScript checker loads every open script's model up front, so imports between scripts resolve at once instead of briefly showing errors.

### Fixed

- A library imported by several scripts is now shipped to pages for each of them. Before, only the first script to import it listed the library, so a page that matched only another importer could miss it.

## [0.26.0-alpha] - 2026-11-11

### Changed

- The object `wt.params` returns can now be changed, like a valtio proxy. Assign a param (`cfg.enabled = false`) or change a list in place (`cfg.hosts.push("a.com")`) from onPage, onOverlay or network handler code. The value is checked against the param's type, the code sees it right away, and it's saved like a change in the ⚙ dialog: logged, written to `settings.yaml`, and the script hot-reloads with it. It throws at the top level (each change re-runs the script), in onSite code, and for params with `parse`. A library's params can be changed by scripts that import it.

### Fixed

- `wt.onSite`, `wt.onPage` and `wt.onOverlay` handlers that a library's exported function registers, when a script calls it from its top level, now run on the page. Before, the Editor listed them but the page skipped them, and their names could clash with the script's own handlers.

## [0.25.0-alpha] - 2026-11-10

### Added

- A `ctx.shortcut` function can return `"pass"` to hand the key on to the page, as if no shortcut matched, so a handler can decide each time whether the key is its own. Any other return value still consumes the key. In an overlay, this works for keys pressed while the overlay has focus. Keys pressed in the page are always consumed, because they reach the overlay after the page's turn.

### Changed

- `ctx.shortcut` keys now work at all times, including while typing in a text field, `<select>` or editable area. Before, shortcuts were ignored there. Only events the page makes up itself still don't count.

- A call from `onPage` code to an `onSite` handle no longer waits a fixed time when the page doesn't have that `onSite` code. If the handle's route matches the page, the call waits only until the page gets that version of the script, and answers as soon as it arrives. Otherwise it fails at once. In 0.24.0-alpha, any call to `onSite` code the page didn't have waited up to 3 seconds, so calls to handles that don't run on the page were slow to fail.

### Fixed

- When the Editor opened with many scripts that import each other, scripts were briefly flagged with errors like "Cannot find module '../lib/util'" until things settled. TypeScript checked some scripts before the scripts they import had reached it. The Editor now shows such an error only after checking the script with every other script loaded. Scripts with a real error also no longer lose their error flag for a moment while the Editor loads.

## [0.24.0-alpha] - 2026-11-10

### Added

- The Editor downloads a package import as soon as you type its pinned unpkg URL, not only when you save. While the package and its types download, the URL shows a warning (`downloading "…" from unpkg…`, then `fetching the types of "…"…`). If the download fails, the URL shows the actual reason, such as an HTTP 404.
- `ctx.shortcut` now works in `onPage` handlers too, for keys pressed in the frame the handler runs in. Unlike an overlay's, an `onPage` shortcut keeps working when another extension's debugger, such as Playwriter, removes Wiretrick's overlay frames.

### Fixed

- When another extension removes a script's overlay frame, the Log now shows a warning naming the script and saying how to start it again. This happens when a tool like Playwriter attaches its debugger to the tab, because Chrome doesn't allow that while another extension's frame is in the page. Previously the overlay's GUI and shortcuts stopped without any message. Wiretrick doesn't put the frame back on its own, because the other tool would just remove it again.
- Cancelling the folder picker no longer stops the folder sync. Clicking the folder button in **Settings → Synced folder** used to stop syncing straight away, and clicking it again opened the picker. Now the button always opens the picker (**Choose Folder…**, or **Change Folder…** once a folder is synced), and the current folder keeps syncing until you pick another one. A new **Disconnect** button next to it stops syncing.
- Right after a save, `onPage` code calling its script's `onSite` handles could fail with `WtCallError: not running on this page`. This happened on Chrome when a save added `onSite` code to an open tab (for example, when you change a `pages` param so the tab now matches), because the `onPage` code could start before the page had the new `onSite` code. Such a call now waits up to 3 seconds for it.
- A package URL that can't load, either unpinned like `https://unpkg.com/@codemirror/state@6` or still downloading, no longer also shows TypeScript's `Cannot find module` error. Each import now shows one problem instead of two.

## [0.23.0-alpha] - 2026-11-09

### Added

- `wt.isMac`, `wt.isWindows` and `wt.isLinux`, which work everywhere `wt.isChrome` does. On Android and ChromeOS all three are `false`.
- `shortcut` params: `wt.params({ toggle: { type: "shortcut", default: "Alt+Shift+H" } })`. In the ⚙ dialog you click the field and press the keys to set it, with buttons to remove it or reset it to the default. Its value goes straight into `ctx.shortcut(cfg.toggle, fn)`. `ctx.shortcut("")` now does nothing, so a removed shortcut needs no special case.
- `ctx.mount(target, ui, { position, key, first, autoRestore })`. `position` places the UI `"inside-last"` (default), `"inside-first"`, `"before"`, `"after"` or as an `"overlay"` covering the match. `key` allows two mounts at one place, `autoRestore` puts the UI back when the page's framework removes it, and `ui` can be a function of the anchor element that uses hooks. `ctx.mount` returns a function that removes the mount.
- A save keeps the state of every named function component, nested ones too, not just the mounted root. Effects in a changed file run again, and a component whose hooks changed starts over. See "Component state across saves" in the scripting docs.
- When **Import…** brings in a new version of a package, the files you have in that package that the new version doesn't are listed as **deleted**. They're ticked, so importing deletes them. Untick any you want to keep.

### Changed

- **Breaking:** `ctx.mount(selector, ui)` now mounts on every element the selector matches, now and later, not only the first one. Pass `{ first: true }` for the old behavior.
- In the Explorer, scripts that register handlers are in bold. Libraries and `settings.yaml` are no longer gray and italic.

### Fixed

- A `page` handler that takes a long time, like one waiting for the user to resume a paused request, is no longer cut off after 15 seconds (20 on Chrome MV3) with the request let through untouched. Each hop now asks the next whether the call is still running and only gives up when it stops answering.

## [0.22.6-alpha] - 2026-11-07

### Fixed

- An error from calling another place's handle (like `Caused by: WtCallError: getSettings(): the result must be JSON — a Date isn't JSON`) shows the line of your script that made the call. Before, it had no stack trace.

## [0.22.5-alpha] - 2026-11-07

### Changed

- A module that uses React at its top level (like `const Item = memo(…)`) fails `onSite` code again, as it did before 0.22.4, instead of loading with a `memo` that does nothing. The error now names where React is used and how the script imports it, so you know which module to split: `cannot use "react" in onSite code: redwood/feature-flag/gui.tsx:96 uses it at its top level, and onSite code imports it (redwood/feature-flag-override.tsx → redwood/feature-flag/gui.tsx)`.

## [0.22.4-alpha] - 2026-11-07

### Fixed

- Error stack traces point at the right file and line. A script's `onSite` error listed Wiretrick's own page code as lines of the script (like `feature-flag-override.tsx:2504:6` in a 330-line file), and a library script's lines carried the importing script's name. Each frame now names the script it's in, and the rest are left out. The Problems view goes to the line in the script itself.
- A script whose imports define React components at their top level (like `const Item = memo(…)`) no longer fails its `onSite` handlers with `cannot use "react" in onSite code`. In the site's world those calls do nothing at load, and only using React in `onSite` handler code throws. Before, the whole `onSite` side failed to load, so an `onPage` handler waiting on it timed out.
- An error's `cause` shows in the log and Problems as `Caused by: …`, so an error like `Action failed after 101 attempts.` shows why the last attempt failed.

## [0.22.3-alpha] - 2026-11-07

### Fixed

- A script importing a package that needs React (like `cmdk` for its overlay) no longer fails its `onSite` handlers with `React.forwardRef is not a function`. The package doesn't load in the site's world, which has no React, and only using it in `onSite` code throws.

## [0.22.2-alpha] - 2026-11-07

### Fixed

- Saving a script retries the failed dependencies of a package it already downloaded. Before, a package stored with a failed dependency (like `cmdk@1.1.1` before 0.22.1) kept the error until it was no longer imported.

## [0.22.1-alpha] - 2026-11-07

### Fixed

- Package imports follow a dependency's `exports` map for paths into it, and a folder's own `package.json`. `cmdk@1.1.1` failed with `cannot import "@radix-ui/primitive/is-development" … HTTP 404`, and then on `react-remove-scroll-bar/constants`.

## [0.22.0-alpha] - 2026-11-07

### Breaking

- `wt.onSite` now runs at `document_start` by default, before the site's own scripts, so `ctx.patch(window, "fetch", …)` is in place before site code holds the original. `document.body` is usually `null` then; an `onSite` that reads the DOM or globals set up while the page loads needs `when: "document_end"`. `onPage` and `onOverlay` still default to `document_end`. Rule of thumb: `onSite` runs before the site, `onPage`/`onOverlay` when the DOM is ready; `when` changes that.

### Changed

- `ctx.mount(target, ui)` waits for a selector that matches nothing yet, instead of throwing, until the run ends. An `onPage` at `document_start` can now mount too.
- Saving a script runs its overlay handlers right away, whatever their `when`, like page handlers already did.
- The two dummyjson samples that draw on the page set `when: "document_end"`.

## [0.21.0-alpha] - 2026-11-07

### Added

- `wt.siteStore(name, initial)`: a store whose data lives in the site's own world — the one store `onSite` code can use. `onSite` code reads and writes it synchronously; `onPage` and `onOverlay` code hold a live mirror (valtio, `useSnapshot`, `subscribe` as usual). It holds page data: one copy per document, gone on reload, and the site can read it.
- `onSite` code can import valtio's core (`proxy`, `subscribe`, `snapshot` from `"valtio"` or `"valtio/vanilla"`).
- Problems: a quick fix "Change to wt.siteStore" on a store used in `onSite` code, and an error for `wt.siteStore` used in a network handler.
- A sample: "Watch and mock the site's fetch (wt.siteStore)".

### Changed

- A store used in `onSite` code is now an error in Problems, not a warning.
- The Explorer's Install Script button shows a document with a down arrow.

## [0.20.0-alpha] - 2026-11-07

### Breaking

A simpler page API: three places to run code, each a function of its own, and saving a script updates the page in place.

| 0.19 | now |
|---|---|
| `wt.onPage({ url, js: "page" }, fn)` | `wt.onSite(url, fn)` — the site's own JavaScript world |
| `wt.onPage({ url, dom: "overlay" }, fn)` | `wt.onOverlay(url, fn)` — the script's own GUI over the page |
| `unsafe: true`, page-world overlays | gone: stores and overlay handles can't reach the site's world |
| `ctx.evaluate(fn, ...args)` | an `wt.onSite` handler that returns `{ fn }`; call `await site.fn(...args)` from `onPage` or `onOverlay` |
| a callback passed to `ctx.evaluate` | an `onSite` function that returns a promise, looped with `for await (const v of ctx.each(site.next))` |
| functions in a `ctx.evaluate` result | more functions on the `onSite` handler's object |
| `WtTimeoutError` (calls gave up after 10 s) | calls don't time out; see the errors below |

- `wt.onOverlay` is back under its old name, now with the overlay's new behaviour: a save no longer reloads its frame — the handlers run again in place. Overlay code that adds to the DOM directly (`document.body.appendChild`, `createRoot(...)`) now adds a second copy on every save: draw with `ctx.mount(<Ui />)` instead.
- A handle called from `onSite` code throws `SiteCannotCallError`: the site's world can answer calls but never make them.
- Handle calls reject with `AbortError` when the calling run ends (a save, the page navigating), and the call is cancelled on the other side too; with `ReloadedError` when the called script is saved mid-call (safe to retry; `ctx.each` does); with `DisconnectedError` when the other side is gone.

### Added

- Hot apply in the page: saving a script runs its handlers again in place, and each run keeps only what it claims again. New on `ctx`:
  - `ctx.signal` aborts when the run is replaced or ends — pass it to listeners, timers and `fetch`;
  - `ctx.once(key, fn)` keeps a value across saves;
  - `ctx.patch(obj, prop, wrap)` wraps a function once; saves swap the wrapper, and dropping the patch passes calls straight through;
  - `ctx.style(css)` adds a stylesheet, removed when no run asks for it;
  - `ctx.mount(ui)` / `ctx.mount(selector, ui)` (`onPage` and `onOverlay`) renders React UI once per target, re-rendered on save and unmounted when dropped; in `onPage` it sits in a closed shadow root the page can't restyle;
  - `ctx.each(fn, ...args)` loops over a function's answers until the run ends.
- A save whose handler throws keeps the previous run (and its handle's functions) working; a compile error keeps the whole previous version.
- `ctx.onNavigate` and `ctx.shortcut` registrations end with their run.
- Drag and drop to install: drop a link, a script file, a folder or a `.zip` onto the install dialog or page, or onto the Explorer to open the dialog with it. The drop target lights up while you drag.

### Changed

- **Install Script…** and **Review Update…** open as a dialog in the Editor instead of a new tab. The install page still serves links to `.wiretrick.ts` files.
- The Explorer's **Install Script…** button has a new icon (a box with a +), so it no longer looks like a download.

## [0.19.0-alpha] - 2026-11-06

### Added

- Isolated `onPage` code can call the script's `js: "page"` handlers' functions — also at `document_start`, where the call waits for the page handler to return. The answers are page data, as with `ctx.evaluate`. Arguments and results cross as JSON copies, so a store's objects can be passed as they are.

## [0.18.0-alpha] - 2026-11-06

### Added

- A package's `metadata.json` marks each `scripts` entry that names no script in its folder as an error, in the file and in Problems.
- `ctx.evaluate`'s function can use the script's imports and top-level helpers and constants: they come along to the page world (re-created there from their declarations). Only the handler's own variables still need passing as arguments, and the Problems view now warns about just those — and about stores or overlay handles used in the page.
- `ctx.evaluate` can return functions (also inside plain objects and arrays — a Redux store, a small page-side API): they come back as async stand-ins that call them in the page, with `this` the object they came on, for as long as the document lives. Its result type says so.

### Changed

- The Problems view's header has **Download diagnostics** too, in the same place as on Log and Network.
- In a `ctx.evaluate` function, `console` and `wt` are the script's: its logs go to the script's Log instead of the page's console.

### Fixed

- `ctx.evaluate` no longer fails with "the page world didn't answer" on a page busy loading its scripts (a local webpack dev build): the browser could run its 3-second timer before the page hook's queued answer. It now confirms the hook is really missing before giving up.
- A `ctx.evaluate` error points at the script's `ctx.evaluate` call instead of line 1.
- Calling an `onPage` handle from isolated `onPage` code said "not from page code"; it now says only the overlay calls them and shows how to get page functions from `ctx.evaluate` instead.

## [0.17.0-alpha] - 2026-11-06

### Added

- In a package's `metadata.json`, `scripts` completes the `.ts`/`.tsx` files in its folder and subfolders that aren't listed yet.

### Changed

- **Collect diagnostics…** (and the panel's **Download diagnostics**) first opens a picker, like Export…'s: the report's sections and every script, all ticked. Untick what shouldn't go in; the report says what was left out. The *management* permission is only asked for when *Other installed extensions* is ticked.

### Fixed

- `?.` and `??` inside a `ctx.evaluate` callback no longer fail with "`_optionalChain` isn't defined in the page world": scripts' modern syntax is kept as written instead of being rewritten into helpers the page doesn't have.

## [0.16.0-alpha] - 2026-11-05

### Added

- `updateURL` in `wt.metadata` and `metadata.json`: where a package updates from, instead of where it was installed from. It can be a script, `metadata.json` or `.zip` URL, a GitHub file or folder, a gist or a gist's raw file. A package installed from a folder or zip now updates when it has one. An update that changes it waits for review.
- Installing from a `.zip` URL (a release asset, a GitHub archive): its top-level `metadata.json` or single script, read from the zip's one folder if it has a single top folder.

### Changed

- An update check whose files match the installed ones only records the new revision. Before, a commit elsewhere in the repository came up as an update.

### Removed

- Help (**?**) no longer has a Reference tab (nor the Welcome page its **API reference** button): the samples cover the API, the editor's completions and hovers document each call, and [docs/scripting.md](docs/scripting.md) has the full reference. The strategy pros and cons table lives in [docs/strategies.md](docs/strategies.md). Help opens on Samples.

## [0.15.0-alpha] - 2026-11-05

### Changed

- A `ctx.evaluate` callback the page side can't call (its arguments aren't plain data) no longer throws into the site's code: it's the script's runtime error, in the Problems view.
- The toolbar badge counts an `onPage` script only once its code ran on the tab — not because the page's URL matches. A `document_start` script saved while the page is open no longer counts until the next load. Network handlers still count when one of the tab's requests matches (now honoring `exclude`), and the counts survive the MV3 service worker restarting.
- **Breaking:** `unsafe: true` now applies only to `js: "page"` routes; with `js: "isolated"` (also `dom: "overlay"` alone, where it did nothing) the script fails to compile.
- A page-world overlay (`js: "page"`, `dom: "overlay"`, `unsafe: true`) now has the script's stores and can call its default overlay, like any `unsafe: true` code (below); an auto-update that adds `unsafe: true` still waits for review.
- **Breaking:** Settings → Export… downloads a zip (`wiretrick-export.zip`) laid out like the synced folder — scripts and data files at their paths, empty folders, and `settings.yaml` with the globals and the exported scripts' `enabled` state and params — and Import… takes such a zip (or a zipped synced folder) or a single script file. The YAML bundle format is gone.

### Added

- `onPage` errors that used to show only in the browser console are now the script's runtime errors (Problems view, red badge): an async handler that rejects, a `ctx.evaluate` callback that throws, and a `ctx.evaluate` rejection the script doesn't handle.
- The Problems view warns about code in a `rules` handler that looks meant to run per request — `console.*`, `wt.log`, `fetch`/`wt.fetch`, timers and store writes: a rules handler runs once, when scripts load, so that code never runs for a request.
- `unsafe: true` on `js: "page"` `onPage` code (`dom: "page"` too): it gets `wt.globalStore` and `wt.pageStore` (live, persisted and synced like isolated code's) and can call the script's overlay, accepting that the site can then read and change that script's stores — never another script's — and call its overlay too. Without it, page-world code still gets neither, and the error now names this opt-in.
- The toolbar badge turns red when one of the tab's active scripts has an error (runtime, type or rules) and amber for a route warning; the icon's tooltip lists the active scripts and marks the ones with problems.
- The Export… and Import… dialogs show the files as a tree, with a box per folder that ticks everything in it, and a filter that narrows the tree by path.

### Fixed

- Chrome (MV3): only one script's isolated `onPage` code ran on a page — Chrome injects an extension file once per document, however many user-script registrations name it. Each script's registration now carries the runtime inline.

## [0.14.0-alpha] - 2026-11-05

### Removed

- **Breaking:** the deprecated `wt.onDocument` (use `wt.onPage`), `wt.onOverlay` (use `wt.onPage({ …, dom: "overlay" })`), the `world` route option (use `js`), `wt.store` (use `wt.globalStore` / `wt.pageStore`) and the `Wiretrick.Route` type (use `Wiretrick.RouteOptions`).
- **Breaking:** the startup migration that rewrote scripts and settings written for older API names; scripts still using old names now fail to compile.
- **Breaking:** imports by a script's underscored key (`./My_Utils` for "My Utils"); import scripts by their path.

## [0.13.0-alpha] - 2026-11-05

Wiretrick is experimental: its scripting API keeps changing, and releases may break scripts.

### Added

- One `wt.onPage` for all page code, with its isolation set by two route options: `js: "isolated" | "page"` (which JavaScript world it runs in) and `dom: "page" | "overlay"` (whether it changes the site's document or draws the script's own GUI). `wt.onPage({ url, dom: "overlay" }, fn)` is the overlay.
- `js: "page"` with `dom: "overlay"`, opt-in with `unsafe: true`: an overlay GUI whose code runs in the site's JavaScript world (its globals at hand), drawing in its own click-through document over the page. The site can see and tamper with it, so it gets no stores and no calls to or from it; it doesn't run where the page's CSP forbids `eval`. Without `unsafe: true` the script fails to compile.

- Installing scripts like a userscript manager ([docs](docs/packages.md)): opening a URL ending in `.wiretrick.ts` (a raw GitHub or gist file, any site, a local `file://` path) goes to an install page; the Explorer's **Install Script…** button also takes a GitHub file or folder URL, a gist URL, a `metadata.json` URL, a local folder or a `.zip`. A package is a script plus every file it imports by a relative path (scripts, JSON, SVG), or a **bundle**: a folder whose `metadata.json` lists several scripts that install, update and roll back together. Before installing, the page shows the metadata, what the scripts can do (riskiest first), missing and bare imports, and every file.
- `wt.metadata({ name, version, description, author, license, homepage, connect })` describes a script for sharing; a bundle's `metadata.json` takes the same fields plus `scripts`, and the Editor checks and completes it against its schema.
- **Make Package…** in the Explorer: on a script that imports nothing it fills in `wt.metadata`; on one that imports files it moves them into a folder with a `metadata.json` (copying files other scripts also use) and rewrites their imports; on a folder it adds a `metadata.json` listing the folder's scripts ([docs](docs/packages.md#sharing-scripts)). **Export Package…** downloads a package: one file as its `.ts`, more as a `.zip`. Package folders show a box icon instead of a folder.
- Auto-update for installed packages: checked daily (and on **Check for Updates**); an update applies by itself only when it can't do more than the installed version (no new sites, strategies, page-world code, overlays, `connect` hosts or unpkg packages), none of its files were edited here, its version doesn't go down and it compiles. Otherwise it waits for review — ⬆ on the package in the Explorer, a diff of every file — where you update or skip that version. **Roll Back** restores the version before the last update. Installed packages are marked in the Explorer (a one-file package's script with 📦), with their update actions in the right-click menu.

### Changed

- **Breaking:** `wt.about("…")` is replaced by `wt.metadata({ description: "…" })`.
- Renaming a file leaves the whole `.wiretrick.ts` unselected.
- Welcome sample chips and Network tags say "overlay" ("overlay shown") instead of "onOverlay".

### Deprecated

- `world` (now `js`) and `wt.onOverlay(route, fn)` (now `wt.onPage({ …route, dom: "overlay" }, fn)`). Both still work; the samples and docs use the new forms.

## [0.12.2-alpha] - 2026-11-04

### Added

- `ctx.evaluate` callbacks can also sit inside plain objects and arrays (`ctx.evaluate((cb) => …, { onOpen: () => …, onClose: () => … })`); before, passing one threw "arguments must be plain data".
- The diagnostics report includes the Problems view's current problems (errors and warnings per file, with line and column).
- A Problems warning when a `ctx.evaluate` function uses the script's own variables (like `cfg`), which aren't defined in the page world; it points at the variable's use inside the function. At run time the error now names the variable and says to pass it as an argument.

### Fixed

- In `.tsx` scripts, JSX like `<A x={y} />` could hide later onPage handlers from the Problems view's onPage checks, and wrongly flag the next top-level `wt.onPage` with "call wt.onPage() at the top level" (`/>` was read as the start of a regex).

## [0.12.1-alpha] - 2026-11-04

### Added

- `ctx.evaluate` callbacks: a function passed as an argument is a callback the page-world `fn` can call — also later, from the site's own events — to run code back in isolated code, where stores and the overlay are. E.g. `ctx.evaluate((set) => app.on("login", (u) => set(u.name)), (name) => { state.user = name; })`.

### Fixed

- The built-in `react`, `react-dom` and `valtio` threw "aren't available in page code" in `onPage` code, which now runs in the isolated world by default: they work there now (React loads on first use). `world: "page"` code still can't use them, and its error says so.

## [0.12.0-alpha] - 2026-11-04

### Added

- `.tsx` scripts: a script whose name ends in `.tsx` (`ui/Panel.tsx`) is a `.tsx` file everywhere — explorer (⚛ icon), tabs, the synced folder and imports (`./Panel` finds it). Create or rename a script with the `.tsx` extension; renaming keeps the extension unselected. JSX in a `.ts` script is now an error with a **Rename to Name.tsx** quick fix.

- `ctx.evaluate(fn, ...args)` in `onPage` code: runs `fn` in the page's own JavaScript world and resolves with its (awaited) result, so isolated code can read the site's globals. `fn` can't use the script's variables (pass them as arguments); arguments and result are plain data, and the result is page data the site could fake.

- `.svg` data files: `import logo from "./icons/logo.svg"` gives the SVG's markup as a string (typed `string`, in the Editor and the synced folder). Create one by typing `.svg` in New JSON File…, or put `.svg` files in the synced folder; they open as XML.

### Changed

- **`onPage` code runs in the isolated world by default** (same DOM, none of the site's JavaScript), so it can use `wt.globalStore`/`wt.pageStore` and call the overlay. Code that needs the site's globals or the `page` strategy to see its `fetch` uses `world: "page"` — the new name of `world: "main"`, which still works — or `ctx.evaluate`. On Chrome (MV3) default-world code needs user scripts turned on (the Editor's banner says how); `world: "page"` code doesn't. `wt.onDocument` follows the same default.

- Scripts saved with JSX are renamed once to `Name.tsx` (their `settings.yaml` section follows, also in the synced folder), since TypeScript parses JSX only in `.tsx` files.

### Fixed

- In the synced folder, VS Code and `tsc` couldn't find `valtio`, `react` or `react-dom` ("Cannot find module"): their typings are now written to `.wiretrick/types/builtin/` and mapped in the generated `tsconfig.json`, which also covers `.tsx` files and no longer sets an option `tsc` rejects.

- A script renamed while its synced folder wasn't connected came back as a duplicate (the old file re-imported) on reconnect; its file is now moved instead.

## [0.11.1-alpha] - 2026-11-04

### Added

- `wt.globalStore` and `wt.pageStore` in isolated-world `onPage` code (`world: "isolated"`): live copies like the overlay's — synchronous reads, writes that reach the background, the overlay and (global stores) other tabs, `wt.pageStore` being the copy of the code's page.

- Problems view warnings for a main-world `onPage` handler that uses a store or an `onOverlay` handle (both disallowed there: the page could read and forge them), with a quick fix that moves the handler to `world: "isolated"`. In main-world code the stores' error now says to use the isolated world.

## [0.11.0-alpha] - 2026-11-04

### Changed

- The bottom panel in a narrow window: the view's filter moves to its own row below the tabs (panel narrower than 720 px), and the Problems / Log / Network / Preview tabs become icons (narrower than 520 px; the name is in the tooltip).

- **Breaking:** `wt.store` is now `wt.globalStore` (same behavior); calling `wt.store` throws with the new name.

### Added

- `wt.pageStore(name, initial)`: a store with one copy per page — a navigation or reload starts it over, a single-page app's route change doesn't, and other tabs have their own. A network handler sees the copy of its request's page (until its first `await`) and an overlay its own page's, so a switch in the overlay can change what the handlers do for that tab only. Not available in `onPage` code or `rules` handlers.

- Network: a page's document request names the scripts whose `onPage` ran or whose `onOverlay` was shown on it, and the overlay's fetches name their script (both as observed).

### Fixed

- Chrome: an overlay's calls into isolated-world `onPage` code, and back, are matched to the overlay's own document, so a call made while the tab navigates can't reach the next page.
- `strategy: "page"` handlers now see a page's first requests too: the `fetch`/`XHR` calls its inline scripts make while it loads used to go out before the hook knew the page's handlers. They now wait for that (at most 3 s); pages with no page-strategy handlers get their native `fetch`/`XHR` back untouched. Chrome MV2 injects the hook inline so it runs before the page's own scripts (strict-CSP pages too).
- Chrome MV3: after turning on "Allow User Scripts" on chrome://extensions, coming back to the Editor clears the "user scripts are off" banner and Problems error and registers the isolated `onPage` code right away (it used to wait for the next script change).

## [0.10.0-alpha] - 2026-11-03

### Added

- `wt.onOverlay(route, fn)` gives a script its own GUI on a page: `fn` runs in a transparent frame over the tab (top frame, one per script), so the page's CSS and JavaScript can't reach it and clicks on its empty areas go through to the page. It shares the script's `wt.store`s with the network handlers, so a switch in the GUI can turn a mock on or off live. Its `fetch` (and `wt.fetch`, `from: "page"`) fetches as the page, with its cookies. `ctx.onNavigate(fn)` follows single-page-app navigations. Saving the script reloads its overlay; disabling it removes it.
- The Editor's bottom panel has a **Preview** tab (⌥⇧V): the open script's overlay, live, in a frame in the Editor, reloaded on every save. Its stores are the real ones, so a switch in the preview turns a mock on or off in your tabs. A URL field sets the overlay's `ctx.url` (it starts from the script's route); with no page behind it, the overlay's `fetch` goes from the extension background (a badge says so), and calls into `onPage` code reject.
- `ctx.shortcut(keys, fn)` in an overlay: a keyboard shortcut on the page (`"Alt+Shift+H"`, `"Mod+K"` — ⌘ on macOS, Ctrl elsewhere) that beats the page's own, or runs only if the page didn't handle the key with `{ priority: "after-page" }`. It works while the overlay has focus too, leaves text fields alone, and ignores key events the page makes up. Two scripts with the same keys: the one higher in the list keeps them, with a Log warning.
- `wt.onPage` and `wt.onOverlay` return the functions their handler returns, to call from the other side: `const page = wt.onPage(route, () => ({ count: (sel: string) => … }))`, then `await page.count("a")` in the overlay, typed. Calls are async, JSON (≤ 1 MB), and time out after 10 s. Isolated-world `onPage` code can call the overlay too (`overlay.picked(tag)`); main-world code can only answer.
- Scripts can use JSX (`.tsx`): it compiles against the built-in React, or another runtime with `/** @jsxImportSource <url> */`. A `.css` package import becomes a `<style>` in the script's overlay (e.g. daisyUI; Tailwind 4's browser build works via `import()`).
- `wt.onPage` and `wt.onOverlay` must be called at the top level of a script; Problems flags them elsewhere.
- An import from an unpinned unpkg URL (`import { sleep } from "https://unpkg.com/asyncbox"`, or `@latest`, `@^1`) is now underlined in the Editor as you type, before saving, with a **Pin to asyncbox@6.5.0** quick fix (Ctrl+. / ⌘.) that fills in the version unpkg resolves it to. After saving, the error points at the URL rather than the start of the line, and the Problems view lists it once.
- `wt.onPage({ url, world: "isolated" }, fn)` runs page code in the extension's isolated world: same DOM, none of the site's JavaScript, and the site can't see or tamper with it. On Chrome it runs through Chrome's user scripts API, which needs the optional "user scripts" permission (the Editor shows a banner with a **Grant permission** button) and **Allow User Scripts** on Wiretrick's details page (Developer mode before Chrome 138). Until then, Problems shows an error saying how to turn them on, and the overlay's calls into that code reject with `not running on this page (user scripts are off)`.
- Log lines and runtime errors from script code that runs on a page say where it ran: `overlay › host`, `isolated › host` or `page › host`. A main-world `overlay.fn()` call shows in Problems with a quick fix that moves the handler to `world: "isolated"`.
- `wt.store(name, initial)`: a live object shared by every copy of a script — its handlers on every strategy see the same values — kept across browser restarts (`{ persist: false }` or a list of fields to keep less). It's a valtio proxy; values are JSON, up to 1 MB per store. A `rules` handler that reads a store is re-run when the store changes.
- `wt.fetch(url, init)`: `fetch` from the extension background (host permissions, no CORS, the browser's cookies), returning a normal `Response`; in an overlay it fetches as the page. `{ bypass: true }` keeps every script's handlers off that request, e.g. to get the real response a script mocks; the Log shows it as a bypass.
- `valtio` and React 19 (`react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`) are built in: scripts import them by name or by an `https://esm.sh/` URL, with no download. They load only in scripts that import them.
- A welcome page for first-time users: with no scripts yet, the Editor opens on a gallery of the samples. **Try it** adds one (turned on), waits until it's running and opens its page in a new tab with the change already visible; **Open** just adds it. Reopen it from Help (**?**) → **Welcome**.
- Two new samples (Help → Samples and the welcome page): **Overlay panel (React + wt.store)** — a React panel over dummyjson.com that turns a `page` mock on and off through a shared `wt.store` and asks `onPage` code to fetch through it; **Overlay outline (calls + shortcut)** — a floating outline of a Wikipedia article that gets the headings from `onPage` code, scrolls the page on click and hides with Alt+Shift+O. Samples are now type-checked in the tests.
- Help → Reference covers `wt.onPage` (with `world`), `wt.onOverlay` (`ctx.onNavigate`, `ctx.shortcut`, React), calls between the overlay and the page, and `wt.store` / `wt.fetch`.
- The popup marks the scripts behind the toolbar badge number with a green dot, and its header says how many are active on the current tab (enabled, and matched the page or one of its requests since it loaded). It updates while the popup is open.
- The toolbar icon shows when script changes are being applied: from saving (compiling) until every strategy has reloaded and open tabs got the hot-reload, it fades with a spinning arc in the corner and its tooltip says "applying script changes…". Changes that finish within 150 ms don't show it.

### Changed

- **Breaking:** there is no default strategy any more. Every network handler names its own: `wt.onRequest({ url: "*://example.com/*", strategy: "helper" }, fn)` (the same for `onResponseHeaders`, `replaceResponse` and `onResponseBody`). A bare URL pattern (`wt.onRequest("*://example.com/*", fn)`) or a route without `strategy` now stops the script from loading, with the error shown in Problems at that line. Existing scripts are not rewritten: add `strategy` to their routes. `onDocument` is unchanged and still takes a bare pattern.
- The `defaultStrategy` setting is gone. The update removes it (and its comment block) from `settings.yaml`; if it's typed back in, the editor flags it as having no effect. Settings no longer has a **Strategies** section: each strategy's pros and cons, and which ones this browser can't run, are now a table in Help (**?**) → Reference → *Strategies*, under the strategy docs.
- The bundled samples (Help → Samples) no longer need the local helper. Redirect, block, request headers, CORS and parameters use `rules` (no banner, Chrome and Firefox). The fetch/XHR replace and transform samples use `page` and show their result in a box on dummyjson.com. Storage now counts Wikipedia visits from `onDocument`. Only **Rewrite page HTML** and **Serve a local file**, which must change the page itself, use `debugger` on Chrome (with its banner) and `extension` on Firefox. Adding a sample now turns it on and gives it a unique name ("Redirect a URL 2") if one is taken.

- `wt.onDocument` is renamed `wt.onPage`. The old name keeps working, unchanged; the editor marks it deprecated.
- The samples, the docs, Help → Reference and the editor's hover docs use `wt.onPage`; `wt.onDocument` is no longer documented beyond its deprecation note.
- The page can no longer read or write a script's `wt.storage` unless that script's `onPage` code runs in the page.
- The extension's pages are now built with React and Valtio: the popup and the Network view (before: Preact) and the whole Editor (before: hand-written DOM code), from its page layout, explorer tree, toolbar, panel and status bar to its dialogs. They look and behave the same; the extension's download is larger.

### Fixed

- Settings → Logging → **Default level** showed "Debug+" until a level had been chosen, though the Log panel showed Info+ (the actual default).
- `wt.storage.get` in an `onDocument` handler returned `{ value }` instead of the stored value (unless the page's CSP had moved the handler to the isolated world).

## [0.9.18-alpha] - 2026-10-31

### Added

- Network: Copy → **Copy as HAR** (**Copy all as HAR** with several rows selected) puts a HAR 1.2 log on the clipboard: headers, cookies, query string, timings, server IP, and the request/response bodies as recorded (a comment marks bodies that were cut or not captured). Opens in devtools' Network panel or any HAR viewer.
- WebSocket warnings: a redirect or `replaceResponse` aimed at a WebSocket (`ws:`/`wss:`) now logs a clear warning that it isn't applied (Chrome ignores redirects on WebSocket handshakes, so the socket still connects to the original URL), instead of an "info: redirect" that looked like it worked. `debugger`/`page` routes that match a WebSocket warn that they never see it, and routes aimed only at WebSockets with `replaceResponse`/`onResponseBody` show up in Problems. Only block and request-header changes work on a WebSocket ([details](docs/strategies.md)).

### Fixed

- Network: ↑/↓, PageUp/PageDown and Home/End did nothing in the request table. They now move the selection (Shift extends it) and scroll it into view; an open details pane follows the selected request, and Enter opens it.
- The toolbar badge kept counting scripts after they were disabled (or deleted), and never reset when the tab moved to another site. It now drops them right away and starts over on each page load. On Chrome (MV3) it also counts scripts that match only the page's requests (an API host, a CDN) rather than the page URL, as it already did on MV2/Firefox.
- Moving or deleting scripts didn't re-check the scripts importing them, so a now-broken `import "./lib/util"` showed no error until that file was edited. After a move or delete, the moved scripts and everything importing them (directly or through other scripts, at the old path or the new one) are type-checked again.

### Changed

- Log and Network share the panel header's actions, in the same place on both: **Clear** empties the Log and the Network recording together (also ⌥⇧K), and **Download diagnostics** saves the diagnostics report. The Log's separate debug-log download is gone (the report includes the debug log), as is the Network view's own Clear.
- Network view: each request/response body is now kept up to 2 MB by default (was 256 kB). `bodyCap:` / Settings → Network → Body capture still changes it.

## [0.9.17-alpha] - 2026-10-26

### Added

- URIs in the Log are clickable, any scheme: `https:`, `chrome:`, `file:`, `data:`… open in a new tab (⌘/Ctrl- or middle-click: in the background); `vscode:`, `mailto:` and other app schemes open their app. Punctuation right after a URI isn't taken into it. A link wrapped over several lines stays hovered across the gaps between them.
- Network: select several requests (Shift-click, Ctrl/⌘-click, Ctrl/⌘+A) and right-click them for Open in new tab and Copy → Copy URL / Copy as cURL / Copy as fetch, devtools-style (all selected at once). Ctrl/⌘+C copies the selected URLs. The full-URL tooltip on rows is gone (Copy URL replaces it).
- Log filter bar like Network's: Basic chips or an Advanced query with autocomplete and **?** help, over `message` (bare words, `"phrases"`, `/regex/`), `source`, `level` (`level:>=warn`) and `is:observed` / `is:link`. It replaces the Log's text and source boxes; the level menu stays.
- Filter bars (Network and Log): Ctrl+Space in Basic shows suggestions for the word at the caret, or opens the + Filter field list there. The + Filter field list works from the keyboard: ↑/↓ (or a letter) to move, Enter or Tab to pick, Esc back to the filter box.
- Network: a **Copy** button on the Payload and Response bodies (copies the body as shown, JSON pretty-printed).
- Settings → Network → Body capture (`bodyCap:` in `settings.yaml`, kB): how much of each request/response body the Network view keeps, 16–16384 kB (default 256). A cut body's notice points there.
- Log scroll lock, as in VS Code: a 🔒 button in the Log toolbar stops new lines from scrolling the view until clicked again. Scrolling up also pauses auto-scrolling (the button shows it), and scrolling back to the end resumes it.

### Fixed

- Settings → Strategy scrolled sideways on Chrome MV3: the unavailable `extension` option in the picker spelled out its whole reason, stretching it past the pane.

### Changed

- Settings → Strategy: the pros/cons table is the picker now (click a row, or its radio button) instead of a separate dropdown above it listing the same strategies. Unavailable ones are greyed out with the reason.
- Settings → Synced folder → Folder path says how to copy a folder's path on your OS (the browser's folder picker can't reveal it), shows an example path for it, and cleans up what's pasted: the quotes Windows' Copy as path adds, a `file://` URI, a trailing slash.
- After you pick a synced folder, Settings → Folder path flashes and shows a ⚠ while the path is empty or doesn't end in that folder's name (likely another folder's). Pressing the ↗ button without a path takes you there too.

## [0.9.16-alpha] - 2026-10-25

### Changed

- `onResponseBody` handlers may return nothing (`void` / `undefined` / `null`) to leave the body as it is — now in the typings too, like every other handler. Any body returned counts as modified, even the one the handler received: bodies are no longer compared, so `(ctx, body) => body` re-encodes and serves the body (use a handler that returns nothing to only read it).

## [0.9.15-alpha] - 2026-10-25

### Fixed

- A binary body served with a text `Content-Type` (x.com's `jf.x.com/onboarding/web/landing` is `text/plain`) was decoded as UTF-8 and re-encoded, corrupting it even when the handler returned it unchanged; x.com stopped loading under an `onResponseBody` on `*`. A text body that isn't valid UTF-8 is now binary (`binary: true` routes only), and a body handed back unchanged keeps its original bytes on every strategy.
- Picking a field suggestion (e.g. `script:`) with Tab opened the "+ Filter" popup at the far right of the filter bar; it now opens under the word it came from.

## [0.9.14-alpha] - 2026-10-25

### Added

- Package imports: a script can import an npm package by its pinned unpkg.com URL, e.g. `import dayjs from "https://unpkg.com/dayjs@1.11.13"`. Saving downloads the package and its dependencies once and stores them, so scripts also run offline, on every strategy and in `wt.onDocument`. Its TypeScript declarations (or `@types`) type-check the import in the Code view and, through `.wiretrick/types/` and `tsconfig.json` `paths`, in the synced folder. Unpinned versions and other hosts are compile errors. See [Packages from unpkg](docs/scripting.md#packages-from-unpkg).

## [0.9.13-alpha] - 2026-10-25

### Added

- `ctx.requestBody` and `ctx.json()`: every handler can read the request payload (read-only), as a string or a `Uint8Array` decided by `Content-Type` and `textTypes` like response bodies. Works on `page`, `debugger`, `helper` (helper 0.4.1+, bodies up to 8 MB) and `extension`; not on `rules`. See [Request body](docs/scripting.md#request-body).

### Changed

- An `onRequest` result is now exactly one of `replaceResponse`, `redirect`, `block` or `headers`. Returning several is a type error in the editor. At runtime only the first in that order applies, the same on every strategy, and a warning names what was ignored. Previously `headers` were silently dropped next to a `redirect` on most strategies but applied on `extension`. To change a redirected request's headers, add an `onRequest` handler for the target URL.

### Fixed

- Scripts saved under an older version kept that version's parsed routes until edited (e.g. `binary: false` stayed "unset" and still warned). Stored script meta is now recompiled once after every extension update.
- The "body is binary" warning no longer tells you to add `binary: true` when the script already has such a route. It names that route and says what dropped the body — usually an outdated helper (reinstall it).

## [0.9.12-alpha] - 2026-10-24

### Added

- `binary: "both"` on an `onResponseBody` route: the handler gets text
  bodies as a string and binary ones as a `Uint8Array`.
- `binary: false` keeps a handler text-only and silences the "the body is
  binary" warning for it; the warning now mentions this.

### Changed

- `binary: true` now means binary bodies **only** — text bodies skip the
  handler. Use `binary: "both"` for the old behavior.
- The local helper is now v0.4.0-alpha and the extension requires it: helpers
  from before v0.9.11-alpha don't know about binary routes or
  `settings.textTypes` (they still treated HLS playlists as binary), so
  the extension now asks you to reinstall.

### Fixed

- Two requests to the same URL (e.g. a playlist fetched twice, once from
  the browser cache) now each show their own script results in the Network
  view and their own "onResponseBody never ran" reason. Before, both
  landed on the latest row and shared one reason — e.g. "the body is
  binary" for a request that never reached the helper.

## [0.9.11-alpha] - 2026-10-24

### Added

- `onResponseBody` can tap binary bodies (images, video, fonts, wasm,
  PDFs…): add `binary: true` to the route and the handler also gets binary
  bodies as a `Uint8Array` (and may return new bytes). Handlers without it
  still get text bodies only. Works on every strategy that sees bodies —
  `helper`, `debugger`, `page` (fetch only) and Firefox `extension` — and
  on the MV3 build, which used to pass text bodies only. Buffering a large
  binary body holds the response until handlers finish; see
  [Binary bodies](docs/scripting.md#binary-bodies) for the limitations.
- `textTypes:` in `settings.yaml` sets which Content-Types are text (globs,
  `*` = anything; replaces the defaults). Every strategy now uses this one
  list, so a body is text or binary the same way everywhere.

### Fixed

- Text `application/vnd.*` responses are no longer treated as binary:
  `+json` / `+xml` types (e.g. `application/vnd.api+json`) and HLS playlists
  (`application/vnd.apple.mpegurl`, `.m3u8`) now reach `onResponseBody` on
  every strategy. Needs the updated helper.
- "onResponseBody never ran" now says when `debugger`, `page` or
  `extension` skipped a binary body, and how to get it (`binary: true` or
  `settings.textTypes`).

## [0.9.10-alpha] - 2026-10-24

### Changed

- "onResponseBody never ran" and "→ skipped" warnings are no longer rate
  limited (once a minute per script + URL, 20 a minute overall): every
  request gets its own Log line and *missed* entry on its Network row, in
  every tab. Before, a burst like a video's segments stopped being flagged
  after the first 20.

## [0.9.9-alpha] - 2026-10-24

### Fixed

- "onResponseBody never ran" on the helper strategy said "no strategy
  observed it" for bodies the helper skips on purpose (e.g. YouTube's
  `/videoplayback` video, `.wasm`). It now says why — a binary body (with
  its Content-Type), one over 64 MB, or a stream — and no longer warns for
  responses without a body (204, 304, HEAD).
- Network filter (Basic), + Filter on a text field with suggestions (tab,
  script…): ↑/↓ now move through the suggestion list instead of switching
  the operator; Alt+↑/↓ switches the operator (plain ↑/↓ still does when
  there's no list, as on url).

### Added

- Shortcuts for the bottom panel: ⌥⇧P / ⌥⇧L / ⌥⇧N (Alt+Shift+P/L/N) show
  Problems, Log or Network and focus its filter (again: close the panel);
  ⌥⇧K clears the Log or Network view shown. Alt+Shift letters avoid the
  Chrome, Firefox and OS shortcuts. ⌘⇧M now focuses the Problems filter too.
- Settings → About: a Help… button opens the API reference, samples and
  shortcuts (the same as the ? in the editor toolbar).

## [0.9.8-alpha] - 2026-10-24

### Added

- Network filter (Basic): `OR ` / `AND ` typed between capsules set the
  connector there; Backspace turns an OR back into AND.
- Network filter: status suggestions say what each code means (404 Not
  Found) and name the classes (2xx Success, 4xx Client error, 5xx Server
  error) instead of "range".

### Changed

- Network filter: suggestions open under the word being completed instead
  of spanning the whole box.
- Panel: the Problems, Log and Network filters sit in the same slim spot in
  the panel header, next to the tabs (Network no longer has a filter bar of
  its own); clear and Network's collect diagnostics are icons after them.
  When the panel is narrow the filters move to a row of their own.
- Network filter: Basic/Advanced is a single `{ }` toggle inside the filter
  box.

### Fixed

- Missed warning: a `helper` handler matching a localhost URL (e.g. after
  redirecting to a local dev server) now says the helper can't see
  loopback requests — Chrome never proxies them — and suggests `page` or
  `debugger`, instead of "no strategy observed it".
- Log: redirect lines read from → to (`onRequest → redirect <url> →
  <target>`) instead of putting the target before the request's URL.
- Network filter (Basic): Shift+←/→ with the caret between capsules,
  Shift+click, and dragging from the text onto capsules now select them.

## [0.9.7-alpha] - 2026-10-24

### Added

- A problem that says where to fix it ("Settings → Local helper") links
  there, in the Problems view and the editor hover.
- Network filter (Basic): typing `OR ` or `AND ` turns into a connector
  capsule, `(` / `-(` opens a group (NOT group) that the next filters go
  into, and `)` closes it. Backspace takes them back one at a time.
- Network filter (Basic): Enter, Space or a double-click on a capsule
  turns it back into text you edit in place. ←/→ stop on either side of
  each capsule, so you can type a filter before or between them, or
  Backspace/Delete the capsule next to the caret.
- Network filter (Basic): `(` and `)` can be typed anywhere among the
  capsules — open a group before one capsule, move to another and close
  it (or type `)` first, then `(`). Backspace/Delete next to a parenthesis
  removes just that one, so it can be moved.

### Changed

- Network: the type toggles, the script and tab dropdowns and the
  script-activity menu are gone — the filter bar does it all (`type:`,
  `script:`, `tab:`, `is:observed` / `is:modified`). It starts with an
  `is:touched` chip, so by default you still see what scripts touched.
- Network filter (Basic): ↑/↓ put the highlighted suggestion in the text
  box, in the filter box and in **+ Filter**; Esc puts back what you typed.
- **+ Filter**: on text fields (url, host, path, …) ↑/↓ switch the operator
  (contains, is, matches…); Tab adds the filter, like **Add**.

### Fixed

- **+ Filter**: **Add** ignored a value picked with ↑/↓.

## [0.9.6-alpha] - 2026-10-24

### Added

- Network filter: Ctrl+Z / Ctrl+Shift+Z undo and redo Basic filter changes,
  chips included.
- **+ Filter**: ↑/↓ move through the value suggestions from the text box,
  and Enter picks the highlighted one.
- Adding a filter puts the focus back in the filter text box.

### Changed

- Release notes are the version's CHANGELOG.md section, with install steps
  in [docs/install.md](docs/install.md).

## [0.9.5-alpha] - 2026-10-24

### Changed

- **Predictable handler precedence, the same on every strategy.** A request
  goes through `onRequest → replaceResponse → (network) → onResponseHeaders →
  onResponseBody`, and each stage runs every script's handlers in list order
  before the next one starts. See
  [how handlers stack](docs/scripting.md#multiple-handlers--how-they-stack).
- A final result (block, redirect, replacement) ends the request: no later
  handler or stage runs, and a replaced response never reaches the network.
- Header edits (`onRequest` `headers`, `onResponseHeaders`): for each header
  the handler later in the list wins, whether it sets or removes it.
- `debugger`: `replaceResponse` is served before the request goes out (the
  server is never contacted) and no longer runs `onResponseHeaders` or
  `onResponseBody`.
- `extension`: every script's `onRequest` runs before any `replaceResponse`.
  On Firefox, an async result no longer stops the later scripts, and a
  replacement no longer runs `onResponseHeaders`.
- `page`: `fetch` now honors `onRequest` block, redirect and header changes.
  XHR no longer runs `replaceResponse` before `onRequest`, and no longer
  transforms a body twice.

### Added

- A warning when a matching handler is skipped because another took
  priority, naming both handlers and the reason (Network: `is:missed`).
- A warning when a header edit is overridden by a later handler.
- Network filter: autocomplete in Basic mode, AND/OR groups that round-trip
  with Advanced mode, and chips that select like text.

## [0.9.4-alpha] - 2026-10-24

### Added

- Network view: a Basic/Advanced filter bar with a query syntax,
  autocomplete and help.

## [0.9.3-alpha] - 2026-10-23

### Added

- Open button: a custom editor URL (with `{path}` and `{line}`) next to
  VS Code and VS Code Insiders.

## [0.9.2-alpha] - 2026-10-23

### Added

- A warning when a `page`-strategy request runs in a tab that has no page
  hook (reload the tab).

## [0.9.1-alpha] - 2026-10-23

### Added

- Explorer: select several files to move or delete them together.

### Changed

- Rename keeps the `.ts` extension visible but unselected.
- The status bar shows the Problems, Log and Network counts; the bottom
  panel tabs no longer have badges.

## [0.9.0-alpha] - 2026-10-23

### Added

- Folders: a VS Code-like explorer tree, synced recursively with the
  scripts folder.
- JSON data files: edit them in the Editor and `import` them from scripts.
- Network view: filter by script (the Wiretrick column).
- A collect-diagnostics button in the panel header while the Network view
  is open.
- The Log explains why `onResponseBody` made no change when it returns the
  body it received.

### Changed

- Releases are published right away; the signed Firefox `.xpi` is added
  when Mozilla finishes signing it.

## [0.8.3-alpha] - 2026-10-23

### Changed

- Problems show in the editor as markers: their hover comes before the API
  docs, and F8 reaches them.

## [0.8.2-alpha] - 2026-10-23

### Added

- Problems view: live errors and warnings per script that clear once fixed,
  each pointing at a line, with squiggles in the editor. `rules` and route
  problems point at the URL pattern.

### Fixed

- Chromium MV2: dropped the MAIN-world hook entry it rejects.
- Folder sync no longer echoes a received change back as sending.

## [0.8.1-alpha] - 2026-10-22

### Changed

- Network counts are live before the view opens; Touched is the default
  filter; the panel has a close button.
- Folder sync badge: a solid triangle that moves in its direction.

### Fixed

- No native tooltip stacks on top of Wiretrick's tooltips.

## [0.8.0-alpha] - 2026-10-22

### Changed

- Renamed the `extension` strategy, `wt.onDocument` and the
  `replaceResponse` result; `manager.html` is now `editor.html`.
- Dropped the `DOMContentLoaded` `when` option: `document_end` is the
  default.
- A save with a compile error still sets the baseline.

### Added

- Tooltips you can hover, which copy on click.
- `rules`: smaller regexes, and a too-complex error that shows the regex,
  its size and the limit.

## [0.7.0-alpha] - 2026-10-22

### Added

- The `rules` strategy: browser-native declarativeNetRequest rules.
- `wt.isChrome`, `wt.isFirefox`, `wt.isMV2` and `wt.isMV3` to pick a
  strategy per browser.

### Changed

- Panel counts stay until the Log or Network view is cleared.

## [0.6.0-alpha] - 2026-10-22

### Added

- Editor: API types in hovers are links that drill into the same hover,
  a read-only `wt-api.d.ts`, and Go Back/Forward.
- Params: an optional `parse` function on every param definition.
- Save button shows the save state; a folder sync status button.

### Fixed

- Quick saves and slow-drive echoes no longer cause conflicts; the
  conflict dialog takes focus and has key shortcuts.

## [0.5.0-alpha] - 2026-10-22

### Changed

- Renamed the script API (strategies, `wt.about`, `onResponseBody`,
  `block`, `resourceTypes`, `defaultStrategy`) and UI terms (Editor,
  Observed, Touched, Library, Synced folder…), with a one-time migration.
- Clearing the Log also drops its replay history.

### Added

- Imported param definitions compile; library params are editable in the
  popup.
- Folder sync refreshes typings, `tsconfig` and the schema on every start.

## [0.4.0-alpha] - 2026-10-22

### Changed

- Simpler script API: routes per handler, a single strategy, params.
- Removed deprecated APIs and legacy migrations.

### Added

- A VS Code-style status bar with unseen Log/Network counts.
- Network keeps script-touched requests while the view isn't open.
- Help dialog: type-to-search in Reference and Samples.

## [0.3.9-alpha] - 2026-10-21

### Added

- Network view: Tapped/Modified markers, a filter menu, a "never ran"
  warning, and in-place replacements.
- About: checks for the latest release.

### Fixed

- `extension` strategy header changes (`extraHeaders`), and the final
  headers shown in Network.

## [0.3.8-alpha] - 2026-10-21

### Changed

- Scripts match URLs with URLPattern.
- Ship only the Monaco files the editor loads.

## [0.3.7-alpha] - 2026-10-21

### Added

- A VS Code-like Editor, diagnostics, a Shortcuts tab in the help dialog;
  Ctrl+` toggles the bottom panel.

## [0.3.6-alpha] - 2026-10-21

### Fixed

- MV2 popup params resolve imports.

## [0.3.5-alpha] - 2026-10-21

### Fixed

- Folder sync: the background is the single writer, and scripts saved
  outside the Editor are written to the folder.
- `tsWorker.js` stays under AMO's 5 MB file limit.

## [0.3.4-alpha] - 2026-10-20

### Fixed

- Release: whitespace in the AMO keys.

## [0.3.3-alpha] - 2026-10-20

Release-only rebuild.

## [0.3.2-alpha] - 2026-10-20

### Added

- A Firefox `.xpi` (signed by Mozilla when the keys are set);
  `wiretrick-mv2-*` release names.

## [0.3.1-alpha] - 2026-10-20

### Added

- A new icon, with a 32 px size for HiDPI toolbars.

## [0.3.0-alpha] - 2026-10-20

### Added

- Settings → Appearance: system, dark or light theme.
- Partial import/export with a checklist of scripts and settings.
- `settings.yaml`: diagnostics, completion and hover, a generated schema,
  and whole-file folder sync.
- VS Code-style completion details, parameter hints and hovers.

## [0.2.0-alpha] - 2026-10-20

### Added

- The script list docks to either edge; inline rename.
- `debugger`: a first page load that slipped past is re-issued through the
  debugger (MV3).
- Detects a helper older than the extension needs.

### Changed

- A script's name is its file name.

## [0.1.0-alpha] - 2026-10-20

### Added

- Network view, a Preact popup, and script error indicators; Editor
  TypeScript errors show as errors.

### Changed

- The script API is `wt.*` (was `res.*`).

## [0.0.1-alpha] - 2026-10-19

First tagged release (as **Wiretrick**, renamed **TangiTweak** in `0.21.0-alpha`):
TypeScript scripts with typed handlers and parameters, multi-strategy interception (`page`, `debugger`, `extension`, and the Rust local MITM helper), two-way folder sync, and signed MV2/MV3 packages.

## Pre-release history (2026-10-12 to 2026-10-19)

Before `0.0.1-alpha` was tagged, the extension grew from an initial TypeScript prototype (`res.*` API) into a multi-strategy MV2/MV3 scripting environment over five milestones:

### 2026-10-19: Rust local helper proxy & Wiretrick launch

- Added the Rust local MITM proxy helper (`nativeMessaging` + per-user local CA + selective `chrome.proxy` PAC routing only for matched hosts), enabling banner-free network-level request/response interception with gzip/deflate/brotli decoding, upstream HTTP/HTTPS/SOCKS proxy chaining, and one-line `curl`/PowerShell installers verified against `SHA256SUMS`.
- Named the extension **Wiretrick**, retargeted sample scripts to live verifiable sites with MV3 Chromium E2E coverage, and set up automated signed MV2 + MV3 `.crx` and `.zip` release publishing.

### 2026-10-17: Manifest V3 build, Quick Open & source-mapped errors

- Added a Chrome Manifest V3 build alongside MV2 using a service worker + sandboxed compile host and session analysis cache.
- Added Quick Open (`⌘P` / `Ctrl+P`) with per-file cursor and scroll restoration, cross-file Go to Definition in Monaco, schema-validated settings file sync, and source-mapped `line:col` script error attribution.

### 2026-10-15: Typed parameters & multi-file library imports

- Replaced `==ResScript==` / `@directive` comment headers with programmatic declarations and typed parameters (`boolean`, `number`, `string`, `enum`, `stringList`), editable inline via collapsible folds in a drag-resizable popup.
- Added relative ES module imports across scripts (`import "./utilities"`): files without handler registrations act as reusable library modules (marked `𝑓`), backed by per-script `file:///` Monaco models, generated `tsconfig.json` for VS Code, and `F12` definition navigation.

### 2026-10-13: Eval-free page hook, async handlers & hot reload

- Moved response body execution out of page scripts into the extension background so the `MAIN`-world `fetch`/XHR hook runs completely `eval`-free on strict-CSP pages, with proper `AbortSignal` propagation and automatic `debugger`-tier fallback.
- Added `async` handler support across all hooks, predictable handler stacking, synthetic networkless responses (`onRequest.respond` with status, MIME type, and headers), live hot reload for open tabs on save, log source filtering, and an **Open in VS Code** toolbar button.

### 2026-10-12: Initial TypeScript engine, Monaco editor & folder sync

- Built the initial TypeScript script engine (in-browser Sucrase transpilation, `res.onRequest` / `res.onDom` / `res.log`, script `console.*` capture), embedded Monaco editor with bundled API typings, movable log panel, popup with per-tab active-script badge, sample scripts, and bundle import/export.
- Implemented three initial interception tiers (`MAIN`-world `fetch`/XHR hook, MV2 blocking `webRequest`, and `chrome.debugger` `Fetch` for main-frame HTML and subresources with adaptive idle detach), two-way local folder sync via the File System Access API, and the headless Chromium E2E suite.

[Unreleased]: https://github.com/tangistudio/TangiTweak/compare/v0.41.1-alpha...HEAD
[0.41.1-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.41.0-alpha...v0.41.1-alpha
[0.41.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.40.2-alpha...v0.41.0-alpha
[0.40.2-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.36.1-alpha...v0.40.2-alpha
[0.40.1-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.37.0-alpha...v0.40.1-alpha
[0.37.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.36.1-alpha...v0.37.0-alpha
[0.36.1-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.36.0-alpha...v0.36.1-alpha
[0.36.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.35.0-alpha...v0.36.0-alpha
[0.35.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.34.0-alpha...v0.35.0-alpha
[0.34.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.33.1-alpha...v0.34.0-alpha
[0.33.1-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.33.0-alpha...v0.33.1-alpha
[0.33.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.32.0-alpha...v0.33.0-alpha
[0.32.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.31.0-alpha...v0.32.0-alpha
[0.31.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.30.0-alpha...v0.31.0-alpha
[0.30.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.29.0-alpha...v0.30.0-alpha
[0.29.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.28.0-alpha...v0.29.0-alpha
[0.28.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.27.0-alpha...v0.28.0-alpha
[0.27.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.26.0-alpha...v0.27.0-alpha
[0.26.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.25.0-alpha...v0.26.0-alpha
[0.25.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.24.0-alpha...v0.25.0-alpha
[0.24.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.23.0-alpha...v0.24.0-alpha
[0.23.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.22.6-alpha...v0.23.0-alpha
[0.22.6-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.22.5-alpha...v0.22.6-alpha
[0.22.5-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.22.4-alpha...v0.22.5-alpha
[0.22.4-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.22.3-alpha...v0.22.4-alpha
[0.22.3-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.22.2-alpha...v0.22.3-alpha
[0.22.2-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.22.1-alpha...v0.22.2-alpha
[0.22.1-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.22.0-alpha...v0.22.1-alpha
[0.22.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.21.0-alpha...v0.22.0-alpha
[0.21.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.20.0-alpha...v0.21.0-alpha
[0.20.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.19.0-alpha...v0.20.0-alpha
[0.19.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.18.0-alpha...v0.19.0-alpha
[0.18.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.17.0-alpha...v0.18.0-alpha
[0.17.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.16.0-alpha...v0.17.0-alpha
[0.16.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.15.0-alpha...v0.16.0-alpha
[0.15.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.14.0-alpha...v0.15.0-alpha
[0.14.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.13.0-alpha...v0.14.0-alpha
[0.13.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.12.2-alpha...v0.13.0-alpha
[0.12.2-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.12.1-alpha...v0.12.2-alpha
[0.12.1-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.12.0-alpha...v0.12.1-alpha
[0.12.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.11.1-alpha...v0.12.0-alpha
[0.11.1-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.11.0-alpha...v0.11.1-alpha
[0.11.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.10.0-alpha...v0.11.0-alpha
[0.10.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.9.18-alpha...v0.10.0-alpha
[0.9.18-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.9.17-alpha...v0.9.18-alpha
[0.9.17-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.9.16-alpha...v0.9.17-alpha
[0.9.16-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.9.15-alpha...v0.9.16-alpha
[0.9.15-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.9.14-alpha...v0.9.15-alpha
[0.9.14-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.9.13-alpha...v0.9.14-alpha
[0.9.13-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.9.12-alpha...v0.9.13-alpha
[0.9.12-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.9.11-alpha...v0.9.12-alpha
[0.9.11-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.9.10-alpha...v0.9.11-alpha
[0.9.10-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.9.9-alpha...v0.9.10-alpha
[0.9.9-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.9.8-alpha...v0.9.9-alpha
[0.9.8-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.9.7-alpha...v0.9.8-alpha
[0.9.7-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.9.6-alpha...v0.9.7-alpha
[0.9.6-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.9.5-alpha...v0.9.6-alpha
[0.9.5-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.9.4-alpha...v0.9.5-alpha
[0.9.4-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.9.3-alpha...v0.9.4-alpha
[0.9.3-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.9.2-alpha...v0.9.3-alpha
[0.9.2-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.9.1-alpha...v0.9.2-alpha
[0.9.1-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.9.0-alpha...v0.9.1-alpha
[0.9.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.8.3-alpha...v0.9.0-alpha
[0.8.3-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.8.2-alpha...v0.8.3-alpha
[0.8.2-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.8.1-alpha...v0.8.2-alpha
[0.8.1-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.8.0-alpha...v0.8.1-alpha
[0.8.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.7.0-alpha...v0.8.0-alpha
[0.7.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.6.0-alpha...v0.7.0-alpha
[0.6.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.5.0-alpha...v0.6.0-alpha
[0.5.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.4.0-alpha...v0.5.0-alpha
[0.4.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.3.9-alpha...v0.4.0-alpha
[0.3.9-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.3.8-alpha...v0.3.9-alpha
[0.3.8-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.3.7-alpha...v0.3.8-alpha
[0.3.7-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.3.6-alpha...v0.3.7-alpha
[0.3.6-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.3.5-alpha...v0.3.6-alpha
[0.3.5-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.3.4-alpha...v0.3.5-alpha
[0.3.4-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.3.3-alpha...v0.3.4-alpha
[0.3.3-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.3.2-alpha...v0.3.3-alpha
[0.3.2-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.3.1-alpha...v0.3.2-alpha
[0.3.1-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.3.0-alpha...v0.3.1-alpha
[0.3.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.2.0-alpha...v0.3.0-alpha
[0.2.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.1.0-alpha...v0.2.0-alpha
[0.1.0-alpha]: https://github.com/tangistudio/TangiTweak/compare/v0.0.1-alpha...v0.1.0-alpha
[0.0.1-alpha]: https://github.com/tangistudio/TangiTweak/releases/tag/v0.0.1-alpha
