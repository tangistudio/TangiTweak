# Writing tweaks

[<img src="../icons/icon.svg" width="16" height="16" align="absmiddle" alt=""> README](../README.md) · [Glossary](../GLOSSARY.md)

A tweak is a folder with a `package.json` that lists `tangitweak` in its `dependencies`
(see [package.json](packages.md#packagejson)). **New Tweak…** in the
Explorer creates one. Its **entry** (`main`, else `index.ts`, else
`index.tsx`) is the tweak's code, called "the script" below; the folder's
other files are [modules](#modules-and-recipes) the entry imports. A `.ts`
file outside such a folder doesn't run: the Editor lists it as needing a
rewrite.

The entry imports `tweak` from `"tangitweak"` and registers **handlers** with
it at top level. Each handler takes its own [route](#routes) first, then the
function (the examples below leave the import line out):

```ts
import { tweak } from "tangitweak";

const API = { url: "*://app.example.com/api/*", strategy: "helper" } as const;

// Redirect / block / request headers / mock the response:
tweak.onRequest(API, (ctx) => {
    // return { redirect: "https://myserver/user.json" };
    // return { block: true };
    // return { replaceResponse: { body: { beta: true } } };
    return { headers: { set: { "x-debug": "1" } } };
});

// Response headers:
tweak.onResponseHeaders(API, () => ({
    headers: { set: { "access-control-allow-origin": "*" } },
}));

// Stream-modify the body:
tweak.onResponseBody({ url: "*://app.example.com/api/user*", strategy: "helper" }, (ctx, body) => String(body).replace('"role":"user"', '"role":"admin"'));

// Change the page (its DOM, in a world the site's JavaScript can't see):
tweak.onPage("*://app.example.com/*", (ctx) => {
    const title = ctx.once("title", () => document.title); // the page's own title, kept across saves
    document.title = "🎯 " + title;
});

// Run in the site's own JavaScript and return functions the other places call:
const site = tweak.onSite("*://app.example.com/*", () => ({
    user: () => (window as any).myApp?.user?.name as string | undefined,
}));

// Draw the script's own GUI over the page:
tweak.onOverlay("*://app.example.com/*", async (ctx) => {
    const hello = document.body.appendChild(document.createElement("output"));
    hello.value = `Hello ${(await site.user()) ?? "stranger"}`;
    ctx.signal.addEventListener("abort", () => hello.remove()); // a save runs this again
});
```

Register handlers synchronously at top level. A registration after an
`await` or inside a callback logs an error and is ignored. Handlers a
[module](#modules-and-recipes) registers belong to the tweak. To share a
tweak, publish its folder; opening its URL with `#tangitweak:install`
[installs it](packages.md).

Saving a script applies it in place: network handlers change for the next
request, and page code runs again on open pages without reloading them —
see [page code](#page-code--wtonsite-wtonpage-wtonoverlay) and [hot
reload](#hot-reload--runs-and-ctx).

## Routes

The first argument of every handler says where it applies. A network
handler's route is an object with `url` and a required `strategy` — there
is no default strategy, and a bare URL pattern isn't accepted (the script
fails to load and the Problems view points at the call):

| form | example |
|---|---|
| one URL pattern | `tweak.onRequest({ url: "*://example.com/*", strategy: "helper" }, fn)` |
| a list | `tweak.onRequest({ url: ["*://a.example.com/*", "*://b.example.com/*"], strategy: "helper" }, fn)` |
| all options | `tweak.onRequest({ url, exclude, methods, resourceTypes, strategy }, fn)` |
| page code (no strategy) | `tweak.onPage("*://example.com/*", fn)` or `tweak.onPage({ url, exclude, when }, fn)`; the same for `tweak.onSite` and `tweak.onOverlay` |

An empty list matches **nothing**, never everything.

### URL patterns

URL patterns are [URLPattern](https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API) strings, the web-standard syntax
also available to scripts as `new URLPattern(...)`. `*` is a wildcard
within a URL part, `:name` is a named segment, and a query or hash you
leave out matches any. `"<all_urls>"` matches every URL.

| URL pattern | matches |
|---|---|
| `*://example.com/*` | any scheme, any path on `example.com` (default port only) |
| `https://*.example.com/api/*` | every subdomain's `/api/…` (not `example.com` itself) |
| `https://cdn.example.com/static/*.js` | only `.js` files under `/static/` |
| `https://example.com/users/:id` | `/users/42`, not `/users/42/posts` |
| `http://localhost:8081/*` | that port only |
| `*://localhost:*/*` | any port (a URL pattern without a port matches only 80/443) |

An invalid URL pattern (e.g. `*example.com*`, which has no scheme) makes the
registration throw. The error shows on the script.

Name the host when you can (`example.com` or `*.example.com`). Those
patterns are only checked against requests to that host. A wildcard or
`:name` host (`*://*/*`, `<all_urls>`) is checked on every request.

Named groups land in `ctx.groups` (`*` wildcards as `"0"`, `"1"`, …):

```ts
tweak.onRequest({ url: "https://api.example.com/users/:id", strategy: "helper" }, (ctx) => {
    if (ctx.groups.id === "42") return { replaceResponse: { body: { id: 42, name: "Mock" } } };
});
```

### Route object: `exclude`, `methods`, `resourceTypes`, `strategy`

```ts
tweak.onResponseBody(
    {
        url: "https://example.com/app/*",
        exclude: ["https://example.com/app/vendor/*"],
        methods: ["GET"],
        resourceTypes: ["script"],
        strategy: "debugger",
    },
    (ctx, body) => String(body).replace("DEBUG=false", "DEBUG=true"),
);
```

`exclude`, `methods` and `resourceTypes` only **narrow** a route.

- **`exclude`** — URL patterns to skip even when `url` matches. Cheap: one
  extra URL pattern test, only on URLs that already matched `url`, on every
  strategy. It can't narrow what `debugger` or `helper` pause (their filters
  can't express "except"), so an excluded URL may still be paused there and
  continued unchanged. The local helper checks `exclude` itself, so it
  doesn't ask the extension about excluded URLs.
- **`methods`** — HTTP methods, case-insensitive. Omit for any. As cheap as
  `exclude`, checked the same way everywhere.
- **`resourceTypes`** — resource types, the browser's label for why a request was
  made (webRequest names, also `ctx.resourceType`): `main_frame`,
  `sub_frame`, `stylesheet`, `script`, `image`, `font`, `object`,
  `xmlhttprequest` (fetch and XHR), `ping`, `csp_report`, `media`,
  `websocket`, `other`. Omit for every type. How much it saves depends on
  the strategy:

  | strategy | how `resourceTypes` is applied |
  |---|---|
  | `debugger` | Only these types are paused (the debugger's `Fetch.enable` patterns); other requests are never stopped. The cheapest way to keep a route off images, fonts and other assets. |
  | `extension` | Checked in the listener before any script runs. |
  | `helper` | Checked after the helper pauses the request: filters correctly, saves no work. |
  | `page` | Only sees page fetch/XHR (`xmlhttprequest`). A list without `xmlhttprequest` means the handler never runs, and the Problems view warns. |
  | `rules` | Part of the browser-native rule: other types never match. |

  `onSite`, `onPage` and `onOverlay` routes have no `resourceTypes` or `methods`.
- **`strategy`** — **required**: the [strategy](strategies.md) that runs
  this handler: `"helper"`, `"page"`, `"extension"`, `"debugger"` or
  `"rules"`. There is no default — a route without one (or a bare URL
  pattern) makes the script fail to load. There is no fallback: when the strategy
  isn't available, the handler doesn't run and the Log view says why.
  To pick per browser or build, use `tweak.isChrome`, `tweak.isFirefox`,
  `tweak.isMV2` and `tweak.isMV3` (Chromium-based browsers count as Chrome);
  per OS, `tweak.isMac`, `tweak.isWindows` and
  `tweak.isLinux`:

  ```ts
  tweak.onResponseBody({ url: "*://example.com/app.js", strategy: tweak.isFirefox ? "extension" : "helper" }, (ctx, body) => body.replace("DEBUG=false", "DEBUG=true"));
  tweak.onRequest({ url: "*://api.example.com/*", strategy: tweak.isMV3 ? "debugger" : "extension" }, fn);
  tweak.onRequest({ url: "*://ads.example.com/*", strategy: tweak.isMV3 ? "rules" : "extension" }, () => ({ block: true }));
  ```

  On `rules` the handler runs once when scripts load and its fixed result
  (block, redirect, headers) becomes a browser-native rule; `exclude`
  isn't supported there ([what `rules` can do](strategies.md#what-rules-can-do)).
  Its code never runs for a request, so the Problems view warns about
  `console.log`, `tweak.log`, `fetch`, timers and store writes in it.

> **Tip:** `page` is the lightest strategy, but it only sees the page's own
> fetch/XHR (REST/API) calls. For documents, `<script src>`, images,
> workers, or anything that must not slip through, use `helper`,
> `extension` or `debugger`. See [strategies](strategies.md).

### Binary bodies

`onResponseBody` handlers get **text** bodies only, as a string. The
route's `binary` option (only `onResponseBody` routes accept it) picks
which bodies the handler gets — **binary** ones are images, video, audio,
fonts, wasm, PDFs, archives, as a `Uint8Array`:

| `binary`   | text bodies | binary bodies | a binary body it misses           |
| ---------- | ----------- | ------------- | --------------------------------- |
| unset      | ✓ string    | —             | "never ran" warning in the Log    |
| `false`    | ✓ string    | —             | silent (a debug line says why)    |
| `true`     | —           | ✓ `Uint8Array`| —                                 |
| `"both"`   | ✓ string    | ✓ `Uint8Array`| —                                 |

```ts
// swap a logo for another image
tweak.onResponseBody({ url: "*://example.com/img/logo*.png", binary: true, strategy: "helper" }, async (ctx, body) => {
    const res = await fetch("https://example.org/other.png");
    return new Uint8Array(await res.arrayBuffer());
});

// look into everything on a CDN without changing it: playlists and segments
tweak.onResponseBody({ url: "*://cdn.example.com/*", binary: "both", strategy: "helper" }, (ctx, body) => {
    if (typeof body === "string") console.log(ctx.url, "text", body.length, "chars");
    else console.log(ctx.url, body.length, "bytes, sync byte", body[0] === 0x47);
});

// text only, and no warning for the images it skips
tweak.onResponseBody({ url: "*://example.com/*", binary: false, strategy: "helper" }, (ctx, body) => console.log(ctx.url, body.length));
```

A `"both"` handler gets either, so check `typeof body`. Return values
work as for text: a string, a `Uint8Array` or an object (JSON) replaces
the body; returning nothing (`undefined` / `null`) leaves it unchanged.
Any returned body counts as a change, even the one the handler received:
it's re-encoded and served (a text body loses a BOM). Handlers
whose `binary` option excludes a body are skipped; when that leaves none
of a script's handlers for a body, the "onResponseBody never ran" warning
explains it — unless every one of them set `binary` explicitly (`false`,
or `true` on a text body), which counts as a choice: only a DEBUG line
records it.

**Text or binary** is decided once per response, the same way on every
strategy, from the `Content-Type` header (lowercased, parameters after
`;` dropped) matched against a list of globs, where `*` matches anything,
`/` included:

```
text/*  *json  *xml  *javascript  *ecmascript  *mpegurl  *yaml  *toml  *graphql  */x-www-form-urlencoded
```

So `image/svg+xml`, `application/vnd.api+json` and HLS playlists
(`application/vnd.apple.mpegurl`) are text; `image/png`, `video/mp2t` or
an Excel file (`application/vnd.openxmlformats-…sheet`) are binary. Set
`"textTypes"` in `settings.json` to change it — the list
**replaces** the defaults, so copy the ones you still want:

```json
{
  "textTypes": [
    "text/*",
    "*json",
    "*xml",
    "*javascript",
    "application/x-ndjson-custom"
  ]
}
```

A non-text `Content-Type` is trusted. A text one is checked against the
bytes: a body that isn't valid UTF-8 (a binary payload served as
`text/plain`, a Latin-1 page) is binary, so it's never handed out as a
string that would corrupt it. Without a `Content-Type` the body is
sniffed (a zero byte in the first 512 bytes, or invalid UTF-8 → binary).
A text body
with an unlisted type (say `application/x-subrip`) is binary, so plain
handlers never see it: add the type to `textTypes`, or use `binary: true`
(or `"both"`) and decode it with `new TextDecoder().decode(body)`.

**Limitations and implications:**

- The whole body is buffered and the response is held until every handler
  finishes — for binary bodies too. A tapped video segment or large
  download costs memory and latency, and video playback can stall. Keep
  `binary: true` / `"both"` routes narrow (`url`, `resourceTypes`,
  `methods`).
- `helper` passes bodies up to 64 MB; larger ones are skipped (and the
  warning says so).
- On the MV3 build (every strategy) and on `page`, bodies cross extension
  messaging as base64: ~33% larger copies and extra CPU per body.
- Streams — server-sent events (`text/event-stream`) and
  `multipart/x-mixed-replace` — are never passed to `onResponseBody`.
- A Range request's `206` response holds only the requested part, so the
  handler gets partial bytes (common for video and audio).
- Responses served from the browser cache aren't seen.
- `Content-Encoding` (gzip, br…) is already decoded: the handler gets the
  plain bytes.
- `rules` never sees bodies. `page` sees only the page's fetch/XHR, and binary bodies only for
  `fetch()`: an XHR with `responseType` `arraybuffer` or `blob` isn't
  intercepted (text XHRs are).
- `textTypes` is one global setting: it changes what every script sees.

## Request body

Every handler's `ctx` has the request payload, **read-only**:
`ctx.requestBody` is a string for text and a `Uint8Array` for binary,
decided by the request's `Content-Type` exactly like
[response bodies](#binary-bodies) (`textTypes` included). `ctx.json()`
parses it as JSON — the *request* body, not the response.

```ts
tweak.onRequest({ url: "*://app.example.com/api/*", methods: ["POST"], strategy: "helper" }, (ctx) => {
    const q = ctx.json(); // undefined without a body; throws on invalid JSON
    if (q?.operationName === "GetFlags") return { replaceResponse: { body: { beta: true } } };
});
```

It is `undefined` when there is no body (GET, HEAD), it is over 8 MB, or
the strategy can't get it:

| strategy | what it gets | `undefined` for |
| --- | --- | --- |
| `page` | the page's fetch/XHR body (a copy; the page's own is never read) | `ReadableStream` bodies |
| `debugger` | the paused request's post data | uploads with a file part |
| `helper` | the body, buffered only for requests a handler pauses (helper 0.4.1+) | uploads that stall for 2 s (passed on untouched), older helpers |
| `extension` | webRequest's copy; a form post arrives URL-encoded, the kind is sniffed (no `Content-Type` yet) | file and very large uploads (Chromium omits them) |
| `rules` | — the handler runs once, without a request; reading it is an error | |

It is the same in `onRequest`, `onResponseHeaders` and `onResponseBody`. Changing it has no effect on what is sent.

## Parameters

A tweak's description, version, icon and the rest come from its
`package.json` (see [package.json](packages.md#packagejson)).

`tweak.params` declares typed knobs the user changes from the popup's ⚙
dialog, the Editor or the tweak's [`.tweak/settings.json`](editor.md#a-tweaks-data-folder) without touching the script:

```ts
const cfg = tweak.params({
    enabled: { type: "boolean", default: true, description: "Master switch" },
    status:  { type: "enum", choices: ["500", "503"], default: "500" },
    note:    { type: "string", default: "forced failure" },
    tags:    { type: "stringList", default: [] },
});
// cfg.enabled: boolean · cfg.status: "500" | "503" · cfg.note: string · cfg.tags: string[]

tweak.onRequest({ url: "*://app.example.com/posts/*", strategy: "helper" }, () => {
    if (!cfg.enabled) return;
    return { replaceResponse: { status: Number(cfg.status), body: { error: cfg.note, tags: cfg.tags } } };
});
```

`tweak.params` may be called more than once (a module can declare its own;
they're all the tweak's);
the UI lists params in call order, and defining the same name twice is an
error.

Large parameter sets can be grouped into collapsible sections by nesting
plain objects inside `tweak.params` (and nested maps in `.tweak/settings.json`):

```ts
const cfg = tweak.params({
    enabled: { type: "boolean", default: true },
    network: {
        host: { type: "string", default: "api.example.com" },
        delay: { type: "number", default: 200, min: 0, max: 5000 },
    },
});
// cfg.network.host: string · cfg.network.delay: number
```

Routes may be built from params. A param change re-runs the script and
re-arms its routes:

```ts
const cfg = tweak.params({
    hosts: { type: "stringList", default: ["staging.example.com"], description: "Hosts to unlock" },
});
tweak.onResponseHeaders({ url: cfg.hosts.map((h) => `*://${h}/*`), strategy: "helper" }, () => ({
    headers: { set: { "access-control-allow-origin": "*" } },
}));
```

Param values persist per script and apply on save — the change is hot applied
like a code edit. Parameter types: `boolean` (switch), `number` (with
optional `min`, `max`, `step`), `string` (text; add `multiline: true` for a
textarea), `enum` (dropdown of `choices`), `stringList` (add/remove list),
`shortcut` (keys, recorded by pressing them; see
[Keyboard shortcuts](#keyboard-shortcuts)).

Every param type accepts an optional `parse` function that turns the raw
value into something more convenient for the script. The param's type
becomes the parser's return type; the ⚙ dialog, the Editor and
`.tweak/settings.json` keep editing (and storing) the raw value, and `parse` re-runs
on every change:

```ts
const cfg = tweak.params({
    origin: { type: "string", default: "https://app.example.com", parse: (s) => new URL(s) },
    delay:  { type: "number", default: 2, description: "Seconds", parse: (sec) => sec * 1000 },
});
// cfg.origin: URL · cfg.delay: number (ms)

const { hosts } = tweak.params({ hosts: { type: "stringList", default: ["a.com"], parse: (l) => new Set(l) } });
// hosts: Set<string>
```

A parser that throws is a script error naming the param, e.g.
`param "origin": parse failed for value "xyz": Invalid URL` — the script
shows its error indicator and the Log an ERROR line, like any other load
error. For `enum`, `parse` receives the choice typed as `string`.

### Changing params from code

The object `tweak.params` returns can be changed, like a valtio proxy. Assign
a param, or change a list in place, from a handler: onPage, onOverlay or
network code.

```ts
const cfg = tweak.params({
    enabled: { type: "boolean", default: true },
    hosts:   { type: "stringList", default: [] },
});

tweak.onOverlay("*://app.example.com/*", (ctx) => {
    const btn = ctx.once("btn", () => document.body.appendChild(document.createElement("button")));
    btn.textContent = cfg.enabled ? "Mock: on" : "Mock: off";
    btn.onclick = () => (cfg.enabled = !cfg.enabled);
    ctx.shortcut("Alt+H", () => cfg.hosts.push(new URL(ctx.url).host));
});
```

The new value is checked against the param's type: a wrong type, an
unknown choice or an unknown name throws. The code sees it right away, and
it's saved like a change in the ⚙ dialog: the Log shows
`param enabled = false (set by the script)`, `.tweak/settings.json` gets it, and
the script hot-reloads with it (what you keep with `ctx.once` stays).
Changes made in one go are saved once per param, with the last value.

- Not from the top level: each change re-runs the script, so it would
  never settle. Doing it throws.
- Not from onSite code: it runs in the site's world, where the site's own
  code could reach the setter.
- A param with `parse` can't be assigned; change it in ⚙ or
  `.tweak/settings.json`.
## Modules and recipes

A tweak's files other than its entry are **modules**: they run only when the
entry imports them (directly or through another module), and never on their
own. What they register — handlers, params, stores — belongs to the tweak:
its enable switch, badge, log, popup entry and settings.

```ts
// utils.ts:
export function double(n: number) { return n * 2; }

// index.ts:
import { double } from "./utils";   // "./utils" and "./utils.ts" both resolve
```

A module can export **recipes** — functions that register handlers. The
handler belongs to the tweak, and so does a `tabStore` / `pageStore` /
`siteStore` the recipe creates:

```ts
// mocks.ts:
import { tweak } from "tangitweak";

export function mockJson(url: string, body: object) {
    tweak.onRequest({ url, strategy: "helper" }, () => ({ replaceResponse: { body } }));
}

// index.ts:
import { mockJson } from "./mocks";
mockJson("*://api.example.com/me", { id: 1, role: "admin" });
```

Recipes can register `tweak.onSite`, `tweak.onPage` and `tweak.onOverlay` handlers
too. Call them from the top level; a call made later (from a
handler or a timer) registers nothing. The Problems panel names them like
"onPage #2 (mocks)".

Modules may declare params too. They're the tweak's params, edited in the
popup, the Editor and the tweak's `.tweak/settings.json` with the entry's own. A store ID
(`tweak.globalStore("id", …)`) can be declared once per tweak: two files of
one tweak declaring the same ID is an error.

Param definitions can be shared too — export them from a module and pass
them to `tweak.params` (directly or spread):

```ts
// utils.ts:
export const envParam = { type: "stringList", default: ["dev"] } as const;

// index.ts:
import { envParam } from "./utils";
const cfg = tweak.params({ intercept_environments: envParam });
```

## Imports, folders and data files

A file's name is its path in the explorer: `index.ts` in the tweak folder
`mock` is named `mock/index` (`mock/index.ts` in the synced folder). Imports
resolve like TypeScript, relative to the importing file's folder, and stay
inside the tweak's folder:

```ts
// in "mock/index":
import { double } from "./helpers";          // the module "mock/helpers"
import { envParam } from "./lib/utils";      // the module "mock/lib/utils"
import dayjs from "dayjs";                   // bare: from package.json's "dependencies"
```

The `.ts`/`.tsx`/`.js` extension is optional (with both `x.ts` and `x.tsx`,
`./x` is the `.ts` one) and matching is case-insensitive.

A **data file** is a JSON, Markdown, SVG or image file in the explorer (`.json`, `.md`, `.svg`, `.png`, …); it
never runs, scripts import it by its path:

```ts
// data file "mock/rate-limits.json": { "max": 5, "window": 60 }, in mock/index:
import limits from "./rate-limits.json"; // the whole object
import { max } from "./rate-limits.json"; // one property

tweak.onRequest({ url: "*://api.example.com/*", strategy: "helper" }, () => ({ headers: { set: { "x-limit": String(max) } } }));
```

`.md` and `.svg` files import as strings (their Markdown or SVG markup, e.g. `import logo from
"./icons/logo.svg"` → `'<svg …>…</svg>'`), and raster images import as `data:image/…` URLs.

Each JSON import gets a freshly parsed copy, so a handler changing it doesn't
affect other scripts. Saving, renaming or deleting a data file hot-applies
every script that imports it (directly or through a module). A missing
data file or invalid JSON is a compile error on the importing script,
naming the data file and the JSON error's line and column. In the Code
view the import is typed from the data file (hovers and completions show its
properties) and F12 on it opens the data file. Renaming or
moving a script, data file or folder doesn't rewrite the import specifiers
pointing at it.

### npm packages

A **bare import** (`import dayjs from "dayjs"`) pulls in an npm package the
tweak's `package.json` lists in `"dependencies"`. TangiTweak downloads it
from [unpkg.com](https://unpkg.com) when you save, at the version unpkg
serves for the range then, and keeps that copy:

```json
"dependencies": {
    "tangitweak": "^0.40.0-alpha",
    "dayjs": "^1.11.0",
    "path": "npm:path-browserify@^1.0.1"
}
```

npm's alias syntax (`"path": "npm:path-browserify@^1.0.1"`) imports one
package under another name, in the tweak's dependencies and in a package's
own. A bare import its `dependencies` don't list is a compile error, as is a
dependency that isn't an npm range (`file:`, a git URL).

Import packages by name only: a URL import
(`import dayjs from "https://unpkg.com/dayjs@1.11.13"`) is a compile error,
`cannot import "…": URL imports aren't supported — add the package to
"dependencies" in package.json and import it by name`, and the Editor
underlines it as you type. A path into a package works by name too:

```ts
import dayjs from "dayjs";
import { addDays } from "date-fns/addDays"; // a file inside the package

tweak.onRequest({ url: "*://api.example.com/*", strategy: "helper" }, () => ({
    headers: { set: { "x-tomorrow": dayjs(addDays(new Date(), 1)).format("YYYY-MM-DD") } },
}));
```

**How it works.** Saving the tweak downloads any dependency it imports
that it doesn't have yet. The download takes everything the package imports: relative files, and the package's own
dependencies at the versions its `package.json` asks for. A path into a
package (`@radix-ui/primitive/is-development`) goes where the package's
`exports` map sends it (the production browser build: conditions
`browser`, `production`, `import`, `module`, `require`, `default`), or to
the `main` of a folder's own `package.json`. ES modules are
converted to CommonJS, and CommonJS/UMD files run as they are, like in
Node.js (`process.env.NODE_ENV` is `"production"`). The download is kept in
the extension's storage, so the script also runs offline and after a
restart. An npm version never changes, so it isn't downloaded again.
Downloads no script imports any more are deleted when you save or delete
scripts. If the download fails (offline, a typo, a missing file), the import
line gets a compile error such as `cannot import "https://unpkg.com/…":
download failed (HTTP 404 — no such package, version or file)`; save again to retry. A dependency of the
package that fails to download isn't an error until the package `require`s
it at runtime, so optional dependencies don't break anything; saving the
script tries it again.

**Packages written for Node.js.** A package that `require`s a Node.js
built-in (`events`, `buffer`, `node:events`, …) without depending on it
itself gets the tweak's own dependency of that name. Add npm's browser
version to the tweak's `package.json`: `"events": "^3.3.0"`,
`"buffer": "^6.0.3"`, or an alias where the name differs
(`"path": "npm:path-browserify@^1.0.1"`). Without one, `require("events")`
throws `"events" is a Node.js built-in — not available in tweaks — add
"events": "latest" to the tweak's package.json "dependencies" to use npm's
browser version`. `fs`, `child_process` and `net` have no browser version.
Globals a package expects (`Buffer`, `process`) are set by a polyfill the
entry imports first, since imports run in order:

```ts
// polyfills.ts
import { Buffer } from "buffer";   // listed in "dependencies"
(globalThis as any).Buffer ??= Buffer;

// index.ts
import "./polyfills";              // first
import { tweak } from "tangitweak";
```

A polyfill that patches globals patches them for everything in that world:
in `onSite` code that's the site, and for network handlers that's
TangiTweak and other tweaks. Prefer versions that don't (`core-js-pure`
rather than `core-js`).
Packages work on every strategy and in `tweak.onSite`, `tweak.onPage` and
`tweak.onOverlay` handlers (the downloaded code is sent to the page along
with the script). `onSite` code has no React, so a package that needs it
(a UI library like `cmdk`) doesn't load there: the script still runs its
`onSite` handlers, and only using that package in `onSite` code throws.

**Types.** TangiTweak also downloads the package's TypeScript declarations:
its own (`types`, `typings`, `exports` or a `.d.ts` next to the file), else
the matching `@types/<package>` major version. Packages with neither are
typed `any`. In the Code view, hovers, completions and errors work as soon as
the save that downloads them finishes. In the [synced
folder](editor.md#synced-folder) they're written to `.tangitweak/types/`, and
the generated `tsconfig.json` maps the packages there (`paths`), so
VS Code and `tsc` type-check the same imports.

**Limits.**

- Only npm packages (from unpkg.com) can be imported. Packages that need
  Node.js built-ins with no browser version, native code, WebAssembly fetched at runtime, or a bundler (`import.meta.url`
  assets, CSS imported from inside a package's JavaScript) don't work.
- A `.css` file (`import "daisyui/daisyui.css"`)
  becomes a `<style>` in the script's [overlay](#overlays--wtonoverlay);
  everywhere else it's ignored (use [`ctx.style`](#hot-reload--runs-and-ctx)
  in `onPage` code).
- Top-level `await` in a package isn't supported. A script's `import()` of a
  package must be a string literal so the save finds and downloads it.
- Per import: at most 1000 files, 5 MB per file and 20 MB in total; typings
  stop at 500 files or 10 MB. A download times out after 15 s.
- `typesVersions` in a package's `package.json` is ignored.
- In the Code view, global declarations from downloaded typings are visible
  in every script (the synced folder's `tsconfig.json` doesn't include them).

**Security.** A package is third-party code that runs with the same powers as
your script: it sees and can change the requests and pages your handlers
touch. Import only packages you trust. The code doesn't change after you
review it: npm versions are immutable, and the copy TangiTweak stored is the
one that runs. Downloads come straight from unpkg.com over
HTTPS, so you trust unpkg to serve npm's files unaltered. Only the extension
background downloads them (when scripts are saved, imported or compiled);
pages never fetch them.

## Shared state and fetching — `tweak.globalStore`, `tweak.tabStore`, `tweak.pageStore`, `tweak.siteStore`, `tweak.fetch`

Four reactive [valtio](https://valtio.dev) stores, ordered from widest to
narrowest lifetime and trust boundary. **Anything the site's own JavaScript may
read or write goes in `tweak.siteStore`; everything else goes in the other three.**

### Lifetime & persistence

| Store | Scope (one copy per) | Page reload / navigation | Tab closed | Browser restart | Saved in `.tweak/stores/<id>.json` | Site JS can read/forge? |
|---|---|---|---|---|---|---|
| `tweak.globalStore` | Entire browser (all tabs) | **Kept** | **Kept** | **Kept** (`persist: false` resets) | **Yes** (when persisted) | No |
| `tweak.tabStore` | Browser tab (`tabId`) | **Kept** | Dropped | Dropped | No | No |
| `tweak.pageStore` | Top-frame document load | **Resets** (SPA route changes kept) | Dropped | Dropped | No | No |
| `tweak.siteStore` | Page's JS world | **Resets** (SPA route changes kept) | Dropped | Dropped | No | **Yes** (untrusted page data) |

*(All three background-owned stores — `globalStore`, `tabStore`, and `pageStore` — also survive hot script saves and MV3 service-worker restarts while their tab/page remains open. Stores declared in a module belong to the tweak; `siteStore` must be declared in the entry itself.)*

### Which handlers can access each store

| Store | `onRequest` (`strategy: "rules"`) | Network handlers (`page`, `debugger`, `extension`, `helper`) | `tweak.onPage` | `tweak.onOverlay` | `tweak.onSite` | Top-level / timers |
|---|---|---|---|---|---|---|
| `tweak.globalStore` | **Yes** (rebuilds session rules on change) | **Yes** (sync & after `await`) | **Yes** | **Yes** | No (throws) | **Yes** |
| `tweak.tabStore` | **Yes** (builds per-tab `tabIds` rules on change) | **Yes — before first `await`** | **Yes** | **Yes** | No (throws) | Declare only (reading throws) |
| `tweak.pageStore` | No (throws — use `tweak.tabStore`) | **Yes — before first `await`** | **Yes** | **Yes** | No (throws) | Declare only (reading throws) |
| `tweak.siteStore` | No (throws) | No (throws) | **Yes** (live mirror) | **Yes** (live mirror) | **Yes** (direct sync) | Declare only |

### `tweak.globalStore`

`tweak.globalStore(id, initial)` returns a live object that every copy of the
script shares: its handlers on every strategy see the same values, and
changes survive a browser restart. It's a [valtio](https://valtio.dev)
proxy — read and assign like a plain object.

```ts
const state = tweak.globalStore("state", { mocking: true, hits: 0, seen: [] as string[] });

tweak.onRequest({ url: "*://api.example.com/*", strategy: "helper" }, (ctx) => {
    state.hits++;
    state.seen.push(ctx.url);
    if (state.mocking) return { replaceResponse: { body: { mocked: true } } };
});
```

- **Lifetime.** Shared across every tab and page; survives reloads,
  navigations, closing tabs, script saves, and — with `{ persist: true }`
  (default) or `{ persist: ["mocking"] }` — browser restarts (editable in the tweak's
  [`.tweak/stores/<id>.json`](editor.md#a-tweaks-data-folder)). With `{ persist: false }`, kept in memory/session until
  the browser quits.
- **Handlers.** Every network handler (`rules`, `page`, `debugger`,
  `extension`, `helper` — both before and after `await`), `tweak.onPage`,
  `tweak.onOverlay`, and top-level/timer code. Throws in `tweak.onSite`.
- **ID.** The first argument is the store's key: lowercase letters, digits,
  `-`, `_` and `.` (not starting with `.`), unique per script. Call
  `tweak.globalStore` at top level and share the result; a second call with
  the same ID throws.
- **Initial.** Used the first time. Later, the saved values win and
  `initial` only adds fields that are missing, so you can add fields
  without losing data.
- **Values.** JSON only — objects, arrays, strings, numbers, booleans,
  `null` — at most 1 MB per store. A change that breaks this is undone and
  logged. Functions and getters on the object stay local and aren't shared.
- **Watching.** `import { subscribe } from "valtio"` runs code when the
  store changes. A `rules` handler that reads a store is re-run (and its
  rules rebuilt) when the store changes.
- The saved copy lives in `tweak.storage` as `"$store:<id>"`; change the
  store, not that key (writing it logs a warning).

### `tweak.tabStore`

`tweak.tabStore(initial)` keeps one copy per browser tab: unlike
`tweak.pageStore`, it **survives refreshes and navigations** in that tab and
goes away only when the tab closes. It works on **`strategy: "rules"`**
too — TangiTweak builds per-tab browser rules (`tabIds` / `excludedTabIds`)
and updates them whenever a tab's copy changes, so toggling a switch in an
overlay and refreshing redirects even the tab's first requests.

```tsx
import { useSnapshot } from "valtio";

const tab = tweak.tabStore({ staging: false });

tweak.onRequest({ url: "https://api.example.com/*", strategy: "rules" }, (ctx) =>
    tab.staging ? { redirect: `https://staging-api.example.com/${ctx.groups["0"]}` } : undefined,
);

tweak.onOverlay("https://example.com/*", (ctx) => {
    function Switch() {
        const snap = useSnapshot(tab);
        return <button onClick={() => (tab.staging = !tab.staging)}>Staging: {snap.staging ? "on" : "off"}</button>;
    }
    ctx.mount(<Switch />);
});
```

- **Lifetime.** One copy per browser tab (`tabId`); subframes share their
  top tab's copy. **Survives page reloads, cross-page navigations, and
  script saves** in that tab; dropped when the tab closes or the browser
  quits (never saved to disk or a store file).
- **Handlers.** Every network handler (`rules`, `page`, `debugger`,
  `extension`, `helper`), `tweak.onPage`, and `tweak.onOverlay`. In network
  handlers, **read/write before the first `await`** (after `await` the
  handler no longer knows its tab and throws; tabless requests see a
  throwaway copy of `initial`). Throws in `tweak.onSite` and outside a
  handler at top level.
- **Names & values.** It takes no name (see [Store names](#store-names));
  1 MB JSON rule as `tweak.globalStore`.

### `tweak.pageStore`

`tweak.pageStore(initial)` is a store with one copy per page. Each
tab's page starts from `initial`; a navigation or a reload starts a new
page, so its copy starts over (a single-page app's route change doesn't).
A network handler sees the copy of the page its request comes from, and an
overlay sees its own page's — so the overlay and the handlers of that
page's requests share state, and other tabs aren't affected.

```tsx
import { useSnapshot } from "valtio";

const page = tweak.pageStore({ staging: false });

tweak.onRequest({ url: "https://api.example.com/*", strategy: "helper" }, (ctx) => {
    if (page.staging) return { redirect: ctx.url.replace("api.", "staging-api.") };
});

tweak.onOverlay("https://example.com/*", (ctx) => {
    function Switch() {
        const snap = useSnapshot(page);
        return (
            <label style={{ position: "fixed", right: 16, bottom: 16 }}>
                <input type="checkbox" checked={snap.staging} onChange={() => (page.staging = !page.staging)} /> Staging (this tab)
            </label>
        );
    }
    ctx.mount(<Switch />);
});
```

- **Lifetime.** One copy per top-frame document load (subframes share their
  top page's copy). Survives in-page SPA route changes and script saves;
  **resets to `initial` on reload or navigation**, and drops when the page
  unloads or the tab closes (never saved to disk or a store file).
- **Handlers.** Network handlers on `page`, `debugger`, `extension`, and
  `helper` (**before the first `await`**), `tweak.onPage`, and `tweak.onOverlay`.
  **Not available** in `strategy: "rules"` (throws — use `tweak.tabStore` for
  per-tab rules), `tweak.onSite` (throws), or top-level/timer code.
- **Which page.** A navigation's own requests (the document, a redirect of
  it) still belong to the page being left. Requests that aren't from a page
  (service workers, other apps through the helper) get a throwaway copy of
  `initial` for that call.
- **Names & values.** It takes no name (see [Store names](#store-names));
  1 MB JSON rule as `tweak.globalStore`.

### Store names

`tweak.tabStore`, `tweak.pageStore` and `tweak.siteStore` take no name: a
store is named after the file whose code creates it and its position among
that file's `tabStore` / `pageStore` / `siteStore` calls (`index#0`,
`lib/state#1`). Every place a tweak runs — the background, the page, the
site's world, the overlay — runs the same code in the same order, so they
all agree on which store is which. Create stores at top level (or in a
module function called at top level) in a fixed order; they all belong to
the tweak.

### Stores in page code

`onPage` and `onOverlay` code get live copies of the script's stores:
reads are synchronous, writes reach the background, the overlay and other
tabs (`tweak.pageStore`: this page's copy only), and their changes come back.

```ts
import { subscribe } from "valtio";

const page = tweak.pageStore({ hits: 0 });

tweak.onRequest({ url: "https://example.com/api/*", strategy: "page" }, () => {
    page.hits++;
});

tweak.onPage("https://example.com/*", (ctx) => {
    const badge = document.body.appendChild(document.createElement("output"));
    const show = () => (badge.value = `${page.hits} API calls`);
    show();
    const stop = subscribe(page, show);
    ctx.signal.addEventListener("abort", () => (stop(), badge.remove())); // a save runs this again
});
```

`onSite` code runs among the site's own scripts, which could read the
stores and forge writes to them. There, using `tweak.globalStore`, `tweak.tabStore`, or
`tweak.pageStore` throws (declaring one at top level is fine: that line runs
there too). Either keep what the site may see in a
[`tweak.siteStore`](#ttsitestore), or keep the stores in `onPage` code, read
the site through an `onSite` [handle](#handles--calls-between-places), and
pass what `onSite` code needs as arguments. An `onSite` handler that uses
one of them is an error in the Problems view; its quick fixes move the
handler to `tweak.onPage`, or change the stores to `tweak.siteStore` (their data
becomes page data).

```ts
const site = tweak.onSite("*://app.example.com/*", () => ({
    user: () => (window as any).myApp?.user?.name as string | undefined,
}));
const state = tweak.globalStore("state", { user: "" });

tweak.onPage("*://app.example.com/*", async () => {
    const name = await site.user();
    if (typeof name === "string") state.user = name; // the site's data: check it
});
```

### `tweak.siteStore`

`tweak.siteStore(initial)` is a store that lives in the site's
JavaScript world, one copy per page, for the data `onSite` code and the
site share: `onSite` code reads and changes it synchronously, and the
script's `onPage` and `onOverlay` code on that page get a live copy — it
changes when the site's does, and their changes go back.

```tsx
import { useSnapshot } from "valtio";

const site = tweak.siteStore({ loggedIn: false, mockCart: false });

tweak.onSite("https://shop.example/*", (ctx) => {
    // in the site's world, ahead of its own scripts: react to the switch synchronously
    site.loggedIn = /(^|; )session=/.test(document.cookie);
    const realFetch = window.fetch;
    window.fetch = (input, init) => (site.mockCart && String(input).includes("/cart") ? Promise.resolve(Response.json({ items: [] })) : realFetch(input, init));
    ctx.signal.addEventListener("abort", () => (window.fetch = realFetch)); // a save runs this again
});

tweak.onOverlay("https://shop.example/*", (ctx) => {
    function Panel() {
        const snap = useSnapshot(site);
        return (
            <label style={{ position: "fixed", right: 16, bottom: 16 }}>
                <input type="checkbox" checked={snap.mockCart} onChange={() => (site.mockCart = !site.mockCart)} /> Empty cart
                {snap.loggedIn ? "" : " (logged out)"}
            </label>
        );
    }
    ctx.mount(<Panel />);
});
```

- **Lifetime.** One copy per page JS world: survives SPA route changes and
  hot script saves; **resets to `initial` on full page reload or
  navigation**, and disappears when the document unloads (never persisted).
- **Handlers.** `tweak.onSite` (direct synchronous access), `tweak.onPage` (live
  mirror), and `tweak.onOverlay` (live mirror of the top frame's copy).
  **Not available in any network handler** (`onRequest`,
  `onResponseHeaders`, `onResponseBody` — throws and is flagged in
  Problems) or inside imported modules.
- **Page data.** The site can read it, change it and fake its values, like
  anything else in its world. Check what you read from it before it
  decides what trusted code does, and never put secrets in it.
- **Values.** JSON only, at most 1 MB, as the other stores; functions on
  the object stay local to each copy.
- **Names.** Named like the others (see [Store names](#store-names)).
- **Watching.** `subscribe` and `snapshot` from `"valtio"` work in `onSite`
  code (the site's world has valtio's core, not React); `useSnapshot` in
  `onPage` and `onOverlay`.

### `tweak.fetch`

`tweak.fetch(url, init)` is `fetch` for scripts. It runs in the background,
with the extension's host permissions (no CORS) and the browser's cookies,
and returns a normal `Response`.

```ts
// the real response, even though this script mocks the same URL
tweak.onRequest({ url: "*://api.example.com/user", strategy: "helper" }, async () => {
    const real = await (await tweak.fetch("https://api.example.com/user", { bypass: true })).json();
    return { replaceResponse: { body: { ...real, role: "admin" } } };
});
```

- `bypass: true` keeps every script's handlers — this one's too — off
  that request. The Log lists it as a `bypass`.
- The URL must be absolute. Bodies are capped at 10 MB each way.
  `signal` (abort) isn't supported.
- `from: "background"` is the default in handlers. `from: "page"` fetches
  as the page — its origin, cookies and CORS rules — and works only in
  [overlays](#overlays--wtonoverlay), where it's the default (relative URLs
  resolve against the page); in handlers it rejects.
- **`onPage` code reaches only the hosts in its `package.json`'s
  `"tangitweak.connect"`** (and their subdomains: `"example.com"` also
  allows `api.example.com`). Any other host rejects, naming the host to
  add. That's because `onPage` code runs in the page's process: a page that
  takes it over could ask the background to fetch anything with your
  cookies, so the tweak says up front where it fetches, and an update that
  adds a host waits for your review. Relative URLs resolve against the page.
  `from: "page"` rejects there: the page's own `fetch` does that.

  ```json
  { "tangitweak": { "connect": ["mail.google.com"] } }
  ```

- `onSite` code has no `tweak.fetch` (it rejects), since the site's own
  scripts could call it: use `fetch`, or a handle to `onPage` code.

### Built-in valtio and React

`valtio` (and `valtio/vanilla`, `valtio/utils`, `valtio/react`) and React 19
(`react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`) come with the
extension: import them by name, or by any `https://esm.sh/` URL of those
packages, with no download. They load only in scripts that import them.
JSX (`<div />`) goes in a `.tsx` script — one whose name ends in `.tsx`,
like `ui/Panel.tsx` (create or rename it with the extension; a plain
script's `.ts` is implied). It compiles with React's automatic runtime, so
components need no `import React`. JSX in a `.ts` script is an error with a
**Rename to Name.tsx** quick fix. The built-ins work in `tweak.onOverlay`
and `tweak.onPage` code too (in the isolated world React loads on first use,
and handlers that import it start once it has), but not in `tweak.onSite`
code, where using one throws.

```ts
import { subscribe } from "valtio";

const state = tweak.globalStore("state", { mocking: false });
subscribe(state, () => tweak.log("mocking is now", state.mocking));
```

## Page code — `tweak.onSite`, `tweak.onPage`, `tweak.onOverlay`

Three handlers run code in the page instead of on its requests. They
aren't strategies: they work the same whatever the network handlers use.
Each runs in its own place:

| | runs in | sees | the site | has |
|---|---|---|---|---|
| `tweak.onSite` | the site's own JavaScript world | the DOM and the site's globals (`window.myApp`); its `fetch`/XHR go through the `page` strategy | sees it and can tamper with it: **untrusted** | `tweak.siteStore` only, no handle calls, no React |
| `tweak.onPage` | an isolated world | the DOM, none of the site's globals | can't see or reach it | all stores, handle calls, React (`ctx.mount`), shortcuts |
| `tweak.onOverlay` | the script's own frame over the page (top frame) | its own DOM | can't see or reach it | all stores, handle calls, React, shortcuts, `fetch` as the page |

Use `onPage` for DOM changes, `onSite` only for what needs the site's
JavaScript (its globals, wrapping its functions), and `onOverlay` for a
GUI the page can't touch. Each returns a
[handle](#handles--calls-between-places) to the functions its handler
returns, so the places work together:

```ts
// the site's world: read its globals, hand them over as functions
const site = tweak.onSite("*://app.example.com/*", () => ({
    flags: () => Object.keys((window as any).__APP_FLAGS__ ?? {}),
}));

// isolated: change the DOM, ask the site
tweak.onPage("*://app.example.com/*", async (ctx) => {
    const title = ctx.once("title", () => document.title);
    const flags = await site.flags(); // string[], typed from the onSite handler
    document.title = `${flags.length} flags · ${title}`;
});
```

- **Route.** URL pattern(s), or `{ url, exclude, when }`, matched against
  each frame's own URL (iframes too); `onOverlay` matches the tab's top
  page. A script may register several of each, with different routes and
  `when`s.
- **Register at top level.** Like every handler, unconditionally and
  synchronously: the n-th `tweak.onPage` call is the same handler in every
  place the script runs. That's how a handle finds its handler, and how a
  save matches new runs to old ones ([hot reload](#hot-reload--runs-and-ctx)).
- Because it runs in the page, page code works however the response
  arrived — service-worker-served HTML, cached pages, or hydration
  overwriting a body transform — which is why it's the resilient choice
  for title/DOM changes on SPAs.

### When page code runs — `when`

**`onSite` runs before the site, `onPage`/`onOverlay` when the DOM is
ready; `when` changes that.**

| Place | Default `when` | Why |
|---|---|---|
| `tweak.onSite` | `document_start` | it's there to get in *before* the site: `ctx.patch(window, "fetch", …)`, catching a store as the site creates it. By `document_end` most of what you'd patch has run, and site code may already hold the original functions |
| `tweak.onPage` | `document_end` | DOM work needs `<body>`; at `document_start` `querySelector` finds (almost) nothing |
| `tweak.onOverlay` | `document_end` | a GUI: nothing to gain by racing the parser |

In every frame, TangiTweak's hook starts at `document_start`, asks the
background for the scripts with a page route matching that frame's URL,
compiles them and captures the matching handlers (stored, not yet run).
Each then runs once, at its route's `when`. Handlers with the same `when`
run in script-list order, then registration order.

```ts
tweak.onSite("*://example.com/*", () => { ... });                                       // default: document_start
tweak.onPage("*://example.com/*", () => { ... });                                       // default: document_end
tweak.onSite({ url: "*://example.com/*", when: "document_idle" }, () => { ... });       // reads globals the site sets up while loading
tweak.onPage({ url: "*://example.com/*", when: "document_start" }, () => { ... });      // sees the parser's first nodes
```

| `when` | Runs | DOM state | Use for |
|---|---|---|---|
| `document_start` *(`onSite`)* | as soon as the script is compiled | `<html>` only; `head`/`body` usually `null` | stubbing globals, `MutationObserver` on `document`, capture listeners — getting in ahead of page code |
| `document_end` *(`onPage`, `onOverlay`)* | at `DOMContentLoaded` (DOM parsed), `defer`/module scripts done | complete DOM; images/CSS/iframes may still load; framework hydration may not have happened | most title/text/attribute changes |
| `document_idle` | after the page's `load` event | everything loaded | final layout/sizes, content built during load |

`when` stays on all three for the exceptions: an `onSite` that reads
globals the site sets up while loading, an `onPage` that must see the
parser's first nodes. An `onPage` at `document_start` can still draw:
[`ctx.mount(target, ui)`](#hot-reload--runs-and-ctx) waits for `target`,
so one handler can add an early listener and a late mount.

- **Already past that moment?** (slow bundle, bfcache restore) The
  handler runs immediately.
- **`document_start` race:** in the Firefox build the bundle arrives in ~1ms
  and reliably beats page scripts. In the Chrome build a cold service
  worker can take ~50-100ms, so early inline `<script>`s may already
  have run. When page code *must* see your change, rewrite the response
  with `onResponseBody` instead.
- **`document_idle` always waits for the page's `load` event**, unlike
  Chrome's content-script `run_at: "document_idle"` (which can fire
  before `load`); one slow image or ad iframe delays it.
- **Once per document, per matching frame.** SPA soft navigations
  (`pushState`) don't re-run it unless the route sets
  [`navigation`](#single-page-apps--navigation). Framework re-renders never
  do — start a `MutationObserver` inside the handler to keep re-applying.
  Hard navigations start over.
- **Saving the script** runs the handlers again right away, whatever their
  `when`, without reloading the page ([hot reload](#hot-reload--runs-and-ctx)).
  What they set up with `ctx.once`/`ctx.patch`/`ctx.style`/`ctx.mount` is
  kept, not added twice, so no `if (document.readyState …)` guards are
  needed.
- **Async handlers** aren't awaited; `when` only sets when they start.
- `ctx` has the request-context shape: `ctx.url` is the frame's URL (the
  page's in an overlay); `method`, `resourceType` and `groups` are
  placeholders (`"GET"`, `"main_frame"`, `{}`).

### Single-page apps — `navigation`

Single-page apps change the URL in place (history API, back/forward,
`#hash`) without loading a new page. By default a route is matched once,
against the URL the page loaded with. The route's `navigation` changes
that:

| `navigation` | in-place URL changes |
|---|---|
| `"load"` (default) | ignored: matched once at load |
| `"match"` | runs while the URL matches: starts when it starts matching, ends when it stops |
| `"every"` | like `"match"`, and runs again on each URL change while it matches |

```ts
// only on pull request pages, however you got there
tweak.onPage({ url: "https://github.com/*/*/pull/*", navigation: "match" }, (ctx) => {
    ctx.mount("#partial-discussion-header", <Badge />);
});
```

- **Starting.** At the route's `when`, or right away if that has passed.
- **Ending.** As if the handler were removed: `ctx.signal` aborts and what
  the run set up with `ctx.patch`/`ctx.style`/`ctx.mount` is undone. Its
  [handles](#handles--calls-between-places) answer only while it runs.
- **`"every"`** starts a new run for each URL, like a save does, so mounts
  stay without flicker.
- **`ctx.onNavigate(fn)`** runs `fn(url)` on each in-place URL change
  while the run goes on, for when one run should follow the URL itself.
- Iframes follow their own URL. Works in all three worlds.

### `tweak.onSite` — the site's world

`onSite` code runs among the site's own scripts: it reads `window.myApp`
or a Redux store directly, wraps the site's functions with
[`ctx.patch`](#hot-reload--runs-and-ctx), and its `fetch`/XHR go through
the `page` strategy (a `fetch` in `onPage` code doesn't).

```ts
// by default before the site's own scripts: they get the patched fetch
tweak.onSite("*://app.example.com/*", (ctx) => {
    ctx.patch(window, "fetch", (orig) => (input, init) => {
        console.log("fetch", String(input));
        return orig(input, init);
    });
});
```

The site can see that code, call the functions it returns and fake their
answers, so `onSite` code is untrusted:

- **Only site stores, no handle calls.** `tweak.globalStore`, `tweak.tabStore`, and
  `tweak.pageStore` throw there ([stores in page code](#stores-in-page-code));
  [`tweak.siteStore`](#ttsitestore) is the store for it. Calling a handle
  throws `SiteCannotCallError` — the site could make the same call.
  Problems shows both, with a quick fix (**Ctrl+.** / **⌘.**) that moves
  the handler to `tweak.onPage`. Call your own functions directly.
- **No built-in React** (using it throws), so no `ctx.mount`
  or `ctx.each`. A module that uses React at its top level
  (`const Item = memo(…)`) fails the `onSite` side of every script that
  imports it; the error names the line and the import chain, so keep what
  `onSite` code needs in a module without React. Of valtio only its core (`subscribe`, `snapshot`); no
  `tweak.fetch` (use `fetch`). `tweak.log`, `tweak.params`,
  `tweak.storage` and `console` work; logs go to the Log tagged `page › host`.
- **Its results are page data.** The site can replace `Object.keys`, patch
  your functions or answer in their place. Fine to show; check them before
  they decide what your network handlers do (which URLs to redirect, which
  headers to set), and never pass secrets (store values, tokens) in.
- **CSP fallback.** If the page's CSP forbids `eval`, `onSite` handlers run
  in the isolated world instead: same DOM and timing, but the site's
  globals aren't visible. They're still treated as site code.

### `tweak.onPage` — the isolated world

`onPage` code runs where the site's JavaScript can't see or imitate it:
the same DOM, none of the site's globals (read those through an
[`onSite` handle](#handles--calls-between-places)). It's trusted: it gets
`tweak.storage`, `tweak.log`, `tweak.params` and `console` (lines go to the Log
tagged `isolated › host`), live [stores](#stores-in-page-code) (site stores too), the
built-in React and valtio, and calls the script's handles. Errors its code
throws later, in a timer, an event listener or a promise nobody awaits, go to
the Log too (`onPage (uncaught)`, `onPage (unhandled rejection)`); the page's
own errors don't. Its `tweak.fetch` reaches only the hosts in
`"tangitweak.connect"` ([why](#tweakfetch)); its `fetch` isn't seen by the
`page` strategy.

```tsx
tweak.onPage("*://app.example.com/*", (ctx) => {
    ctx.style(`.ad-banner { display: none !important }`);
    ctx.mount("#header", <button onClick={() => alert("hi")}>Hi</button>); // in a closed shadow root
});
```

#### User scripts on Chrome

Firefox runs `onPage` code in the extension's
content-script world and `onSite` code in the site's. The Chrome (MV3)
build runs both through Chrome's user scripts API, which is off until you
turn it on:

1. **Grant the permission.** When a script has `onPage` or `onSite` code, the Editor
   shows a banner: click **Grant permission** (the optional "user
   scripts" permission).
2. **Allow user scripts.** Chrome 138 and later: turn on **Allow User
   Scripts** on TangiTweak's details page (`chrome://extensions/?id=…`; the
   banner's **Open extension details** button and the Problems error link
   there). Chrome 120–137: turn on **Developer mode** at the top right of
   `chrome://extensions` instead.

Until then the handler doesn't run, Problems shows an error on its
`tweak.onPage` or `tweak.onSite` line saying how to turn user scripts on, and
the overlay's calls into it reject with `not running on this page (user
scripts are off)`. Once they're on, pages loaded from then on run it
(reload open ones); after that, saving the script updates open pages in
place. On Chrome before 135, saved `onSite` changes reach a page only
when you reload it (the old code keeps running until then).
`onOverlay` code and network handlers don't need user scripts.

Chrome 133 and later give each script's `onPage` code a world of its
own; before that, scripts share one user-script world (each still in its
own scope, apart from the site's JavaScript).

## Handles — calls between places

`tweak.onSite`, `tweak.onPage` and `tweak.onOverlay` return a **handle** to the
functions their handler returns. Call them from another place with
`await`:

```ts
const page = tweak.onPage("*://app.example.com/*", () => ({
    highlight(sel: string) {
        const els = [...document.querySelectorAll<HTMLElement>(sel)];
        els.forEach((el) => (el.style.outline = "2px solid red"));
        return els.length;
    },
}));

tweak.onOverlay("*://app.example.com/*", (ctx) => {
    const input = ctx.once("input", () => document.body.appendChild(document.createElement("input")));
    input.onchange = async () => (input.title = `${await page.highlight(input.value)} matches`);
});
```

- **Exposing.** A handler that returns a plain object of functions exposes
  them; any other return value (nothing, a string, an element) exposes
  nothing. Types follow: `page.highlight` is
  `(sel: string) => Promise<number>`, and a wrong argument is a compile
  error. A function may return a promise: the caller gets its value.
- **Who can call whom.**

  | calling from \ handle of | `onSite` | `onPage` | `onOverlay` |
  |---|---|---|---|
  | `onSite` code | ✗ throws | ✗ throws | ✗ throws |
  | `onPage` code | ✓ same frame | ✓ same frame | ✓ from the top frame only |
  | `onOverlay` code | ✓ top frame | ✓ top frame | ✓ |
  | network handlers | ✗ rejects | ✗ rejects | ✗ rejects |

  An `onPage` call to the overlay from an iframe rejects with `only the top
  frame can call the overlay`. Handles from an imported module don't
  connect: register the handler in the script itself.
- **Calls wait — with no time limit.** A call made before the handler has
  run in that frame (an overlay calling `onPage` code at `document_start`,
  a save in between) waits for it: up to 100 calls per handle queue.
  Arguments and results are JSON, at most 1 MB each, so a store's objects
  can be passed as they are.
- **Errors.** A call rejects with:
  - `AbortError` — the calling run ended first (the script was saved,
    disabled or deleted); the call is cancelled on the other side too;
  - `ReloadedError` — the handler's script was saved while the function
    ran; call again and the new run answers ([`ctx.each`](#waiting-for-events--ctxeach)
    does it for you);
  - `DisconnectedError` — the other side went away (the overlay closed,
    the frame navigated);
  - `WtCallError` — the function threw (its message only), doesn't exist,
    a value isn't JSON or is too big, or the handler isn't running on this
    page (its route didn't match, or it threw before ever returning). A
    call to an `onSite` handle whose route doesn't match the page fails
    at once. After a save, your `onPage` code can start a moment before
    the page gets the new `onSite` code: a call to a handle whose route
    matches the page waits until the page has that version (giving up
    after 5 s if it never arrives, e.g. the page changed its URL in
    place). In
    the Editor's [Preview](editor.md#preview), calls into `onSite` and
    `onPage` code reject with `there's no page in the Editor preview`.

  Check `e.name`: `catch (e: any) { if (e.name === "ReloadedError") … }`.
- **Answers from `onSite` are the site's data** — see [the site's
  world](#wtonsite--the-sites-world).

### Waiting for events — `ctx.each`

A function that returns a promise answers when the promise does, however
long that takes. To hear about the site's events, keep a queue in `onSite`
code, return a `next()` that waits for the next item, and loop over it with
`ctx.each(fn, ...args)` in `onPage` or `onOverlay` code:

```ts
const site = tweak.onSite("*://app.example.com/*", (ctx) => {
    const logins: string[] = [];
    const waiting: ((user: string) => void)[] = [];
    window.addEventListener("app:login", (e) => {
        const user = String((e as CustomEvent).detail);
        // answer every waiting call: one may be from a run that ended since
        if (waiting.length) for (const w of waiting.splice(0)) w(user);
        else logins.push(user);
    }, { signal: ctx.signal });
    return {
        nextLogin: () => (logins.length ? Promise.resolve(logins.shift()!) : new Promise<string>((r) => waiting.push(r))),
    };
});

const state = tweak.globalStore("state", { lastLogin: "" });

tweak.onPage("*://app.example.com/*", async (ctx) => {
    for await (const user of ctx.each(site.nextLogin)) state.lastLogin = user;
});
```

`ctx.each` calls the function again after each answer, makes a call cut by
the other side's reload (`ReloadedError`) again, and ends quietly when its
own run ends. Other errors end the loop with that error. A call whose run
ended (the `onPage` code was saved) still waits on the `onSite` side, so
answer every waiting call, as above — otherwise that stale call takes the
next item and the new run never sees it.

## Hot reload — runs and `ctx`

Saving a script applies it to open pages in place: neither the page nor
the overlay frame reloads, and stores keep their values. The script's
code evaluates again in every place, and each page handler runs again —
a new **run** — right away, whatever its `when`.

What a run sets up through `ctx` belongs to it, and a save reconciles it:
the new run takes over what it sets up again, and the rest is undone.
What your code does directly — appending elements, adding listeners,
starting timers — isn't undone, and the new run does it again: an
`appendChild` in a handler adds a second element on every save. So:

| `ctx` | `onSite` | `onPage` | `onOverlay` | |
|---|---|---|---|---|
| `url` | frame URL | frame URL | page URL | where it runs |
| `signal` | ✓ | ✓ | ✓ | an `AbortSignal` that aborts when this run ends: pass it to `addEventListener`, `fetch`, or listen for `abort` to clean up |
| `once(key, fn)` | ✓ | ✓ | ✓ | `fn()`'s value, made once per page and kept across saves while a run asks for it |
| `patch(obj, prop, wrap)` | ✓ | ✓ | ✓ | replace the function `obj[prop]` with `wrap(original)`; a save swaps the wrapper |
| `style(css)` | ✓ | ✓ | ✓ | add CSS to the page (and to each `ctx.mount`) |
| `mount(ui)`, `mount(target, ui, opts?)` | — | ✓ | ✓ | render React UI (JSX) on every match; a save re-renders it, state kept |
| `each(fn, ...args)` | — | ✓ | ✓ | [loop over a handle function's answers](#waiting-for-events--ctxeach) |
| `iframes(selector?, fn)` | ✓ | ✓ | — | run `fn` in each same-origin iframe, now and later |
| `onNavigate(fn)` | ✓ | ✓ | ✓ | [in-place navigations](#single-page-apps--navigation) |
| `shortcut(keys, fn, opts)` | — | ✓ | ✓ | [keyboard shortcuts](#keyboard-shortcuts) |

```ts
tweak.onPage("*://app.example.com/*", (ctx) => {
    document.addEventListener("click", (e) => console.log("clicked", e.target), { signal: ctx.signal });
    const t = setInterval(() => console.log("tick"), 1000);
    ctx.signal.addEventListener("abort", () => clearInterval(t));
    const seen = ctx.once("seen", () => new Set<string>()); // the same Set after a save
});
```

- **`ctx.signal`** aborts when the run ends: a save replaced it, its
  handler was removed or no longer matches, or the script was disabled or
  deleted. `ctx.onNavigate` and `ctx.shortcut` registrations end with it.
- **`ctx.once(key, fn)`** calls `fn` the first time a run asks for `key`
  on this page; later runs get the same value. A save that no longer asks
  for `key` drops it. Use it for state that should survive saves (a cache,
  the page's original title) — a top-level `let` starts over on every
  save.
- **`ctx.patch(obj, prop, wrap)`** installs a `Proxy` stand-in for `obj[prop]`
  once (the site may keep a reference to it) and points it at
  `wrap(original)`; a save points it at the new wrapper. Once no run
  patches it any more it calls the original. It keeps `new`, static properties
  (like `WebSocket.OPEN`), `name`, `length` and `instanceof` working, and throws if `obj[prop]` isn't a
  function or can't be replaced. Two handlers patching the same function
  each add a layer.

  ```ts
  tweak.onSite("*://app.example.com/*", (ctx) => {
      ctx.patch(history, "pushState", (orig) => function (this: History, ...args: any[]) {
          console.log("navigating to", args[2]);
          return orig.apply(this, args as Parameters<History["pushState"]>);
      });
  });
  ```
- **`ctx.style(css)`** adds one `<style>` to the document's `<head>` per
  distinct CSS, copied into each `ctx.mount`'s shadow root; removed once no
  run adds it.
- **`ctx.elements(selector, opts?)`** returns the elements `selector`
  matches now, in page order. **`ctx.elements(selector, fn, opts?)`** runs
  `fn(el, signal)` on each match, now and as matches appear. When one
  leaves (removed, or it no longer matches) its `signal` aborts and the
  function `fn` returned, if any, runs. On a save every match leaves and
  arrives again with the new `fn`. It returns a function that stops it.
  - **`first: true`**: only the first match; with `fn`, it moves to the
    next match when that one leaves.
  - **`shadow: true`**: also look inside shadow roots. Each part of the
    selector matches within one root, so `"x-app .bar"` can't reach into
    `<x-app>`'s shadow root; write `".bar"`. Closed shadow roots are found
    too in `onSite` and in MV2 (Firefox) `onPage`; in MV3 (Chrome)
    `onPage` only open ones are.
  - **`root`**: where to look (an element, document or shadow root).
  - **`key`**: tells apart two `fn` calls with the same selector.
  - What it notices: elements added or removed, and changes to the
    attributes the selector uses (`.on` → `class`). Focus, hover and
    values set by code (`input.value`, `checkbox.checked`) don't change
    attributes, so `:focus`, `:hover` and `:checked` aren't followed:
    listen for `focusin`, `mouseover` or `change` instead.
  - Your own `ctx.mount` UI never matches.

  ```ts
  tweak.onPage("*://video.example.com/*", (ctx) => {
      ctx.elements("video", (video, signal) => {
          video.playbackRate = 2;
          video.addEventListener("ratechange", () => (video.playbackRate = 2), { signal });
      }, { shadow: true });
  });
  ```
- **`ctx.mount(ui)` / `ctx.mount(target, ui, opts?)`** renders JSX (a
  `.tsx` script; without React it throws `ctx.mount needs React`) with the
  [built-in React](#built-in-valtio-and-react). A save renders into the
  same React roots, so component state survives (see
  [Component state across saves](#component-state-across-saves)); once no
  run mounts there any more, it unmounts and its element goes. It returns
  a function that removes the mount early.
  - **Target.** Without one the UI floats over the page (`position: fixed`
    at the top left). A selector puts it on **every** match, now and
    later: a match that appears gets its own root, and one that goes away
    unmounts it. An element target, or `{ first: true }`, means one root
    that moves to the next match when the page replaces the first. Matches
    inside your own UI don't count. A selector that matches nothing yet is
    waited for (the run ending stops the wait), so `ctx.mount` works from
    `document_start` too.
  - **`ui`** is JSX, or a function of the anchor element that returns JSX.
    The function may use hooks and is re-run with the latest code on each
    save; changing which hooks it calls remounts it.
  - **`position`**: `"inside-last"` (default) or `"inside-first"` puts it in
    the match as its last or first child, `"before"` / `"after"` next to it,
    and `"overlay"` covers it (`position: absolute; inset: 0`). Clicks pass
    through an overlay to the page except on your UI, and a `static` match
    becomes `position: relative` while the overlay is there.
  - **`shadow: true`** also mounts on matches inside shadow roots (as in
    `ctx.elements`).
  - **`autoRestore: true`** puts the UI back when the page removes it (a
    framework re-rendering the match's children). If the page keeps
    removing it, more than 20 times a second, it stops and Problems says so
    (until the next save). Without it the UI goes back only when
    `ctx.mount` runs again.
  - In `onPage` the UI sits in a `<tangitweak-mount>` element with a closed
    shadow root: the page's CSS doesn't reach it (`ctx.style` does). It's
    `display: contents`, so a label next to text stays on its line.
  - In `onOverlay` it's a plain `<div>` in the overlay's `<body>` (or the
    target).
  - A handler has one mount per (target, position, `key`): calling
    `ctx.mount` again with the same ones (or again without a target)
    re-renders that mount, also later in the same run (from a listener or
    a shortcut). Use `key` for two mounts at the same place.

  ```tsx
  tweak.onPage("*://app.example.com/*", (ctx) => {
      // a label after every version tag, also ones the app adds later
      ctx.mount('[data-testid="version"]', <Label />, { position: "after" });
      // a badge over the avatar, put back when the app re-renders the header
      ctx.mount("#avatar", (el) => <Badge user={el.title} />, { position: "overlay", autoRestore: true });
  });
  ```
- **`ctx.iframes(fn, opts?)` / `ctx.iframes(selector, fn, opts?)`** runs `fn` in every
  same-origin iframe of the document (or only those `selector` matches),
  now and as they're added. It also reaches iframes your script may not
  run in itself, such as the `about:blank` and `srcdoc` frames that
  rich-text editors and mail compose windows use. It returns a function
  that stops it early.
  - **`f`**, what `fn` gets, is a run of its own in the iframe:
    `f.iframe` (the element), `f.document`, `f.window`, and the same
    `signal`, `once`, `patch`, `style` (and in `onPage`, `mount` and
    `each`) as `ctx`, aimed at the iframe's document. `f.iframes` reaches
    nested iframes.
  - `fn` runs again when the iframe loads a new document (the previous
    `f.signal` aborts first) and on each save, keeping its mounts' state.
    Its run ends when the iframe goes away or the handler's run ends.
  - Cross-origin iframes are skipped: their document is out of reach. If
    one later loads a same-origin page, `fn` runs then. (Shortcuts can
    still follow them: see `ctx.shortcut`'s `crossOrigin`.)
  - Inside `fn`, the global `document` is still the parent page's: use
    `f.document`. The iframe's elements aren't `instanceof` the parent's
    classes (`HTMLElement` and the like): use `f.window.HTMLElement`, or
    check `tagName`.
  - **`shadow: true`** also follows iframes inside shadow roots.
  - A page the iframe swaps in with `document.open()` (no load event)
    counts as a new document too: `fn` runs again.
  - In `onPage`, `f.shortcut` listens for keys pressed in that iframe.

  ```ts
  tweak.onPage("*://mail.example.com/*", (ctx) => {
      ctx.iframes("iframe.editor", (f) => {
          f.style("body { font-size: 16px }");
          f.document.addEventListener("keydown", (e) => console.log(e.key), { signal: f.signal });
      });
  });
  ```

### Limits — shadow roots and iframes

What `ctx.elements`, `ctx.mount`, `ctx.iframes` and `ctx.shortcut` can't
reach yet:

| Limit | Where | What to do |
|---|---|---|
| Closed shadow roots aren't found with `shadow: true`, only open ones | `onPage` in MV3 (Chrome) | Use `onSite`, which finds both |
| `:focus`, `:hover`, `:checked` and values set by code aren't noticed by `ctx.elements(selector, fn)` | everywhere | Listen for events: `focusin`, `mouseover`, `change` |
| Cross-origin iframes are skipped; `crossOrigin: true` throws | `ctx.iframes` | Only `ctx.shortcut` follows them for now |
| Keys pressed right after an iframe's `document.open()` go to the page | `ctx.shortcut` with `iframes` | The shortcut listens again a moment later |
| In a cross-origin iframe the key is always kept from the page (`"pass"` can't give it back) | `ctx.shortcut` with `crossOrigin: true` | Pick keys the iframe doesn't need |
| Iframes inside a cross-origin iframe aren't followed, nor a page it wipes with `document.open()` | `ctx.shortcut` with `crossOrigin: true` | — |

### Component state across saves

A save keeps the state of your components, nested ones too: a counter
stays at its count, an open panel stays open, and the new code renders it.
React Refresh needs a development build of React, so TangiTweak does its
own, smaller version of it on the built-in (production) React:

- Each **named function component** in your script (`function Panel()`,
  `const Panel = () => …`) is kept across saves by its file and name. React
  sees the same component, so its state stays, and it renders the new code.
- **Changing the hooks it calls** (adding a `useState`, reordering) remounts
  that component: its state starts over, the rest of the page keeps its own.
  If a render after a save throws (a custom hook's hooks changed), it
  remounts once.
- **Effects, `useMemo` and `useCallback`** in a file you changed run again
  after the save, so a new interval or listener takes effect. Their cleanups
  run first.
- **Contexts** made at top level (`createContext`) stay the same object, so
  providers don't remount what's under them.

These remount on a save (their state starts over):

- Anonymous components (`export default () => …`) and class components.
- Components from a downloaded package. They keep their state when the
  package didn't change, since the same functions are reused.
- A name bound to two functions in one compile: a component defined inside
  another one, or two imports with the same name.

**What a save does, in order:**

1. The script compiles again. A compile error keeps the whole previous
   version running (Problems shows the error).
2. Each matching handler runs: a new run, with a fresh `ctx`. If it throws,
   only the new run ends — the old run and the functions its handle
   exposes keep going (Problems shows the error).
3. When the new run returns, the old run's `signal` aborts.
4. When the new run's promise settles (right away for a sync handler), or
   it starts a `ctx.each` loop, the old run's claims are released: what the new run set up again stays (a
   mount re-renders, a patch has its new wrapper, a `once` value is kept),
   the rest is undone (unmounted, style removed, patch passing through,
   `once` value dropped).
5. A handler removed from the script, or whose route no longer matches,
   has its run ended. Disabling or deleting the script ends every run.

Handle calls carry across a save: calls waiting for a handler are answered
by the new run, a function still running in the old run rejects with
`ReloadedError`, and the old runs' own pending calls reject with
`AbortError`.

Handlers are told apart by position: the n-th `tweak.onPage` (or `onSite`,
`onOverlay`) call in the script. Moving one before another of the same
kind swaps their keys, so their mounts start over and their `once` values
are made again.

## Overlays — `tweak.onOverlay`

`tweak.onOverlay(route, fn)` gives a script its own GUI on a page: `fn` runs
in a transparent frame laid over the tab, and whatever it draws in that
frame's `document` shows on top of the page. Clicks on empty areas go
through to the page.

```tsx
import { useSnapshot } from "valtio";

const mock = tweak.globalStore("mock", { enabled: false });

tweak.onRequest({ url: "*://app.example.com/api/me", strategy: "helper" }, () =>
    mock.enabled ? { replaceResponse: { body: { name: "Test user", plan: "pro" } } } : undefined);

tweak.onOverlay("*://app.example.com/*", (ctx) => {
    function Panel() {
        const snap = useSnapshot(mock);
        return (
            <label style={{ position: "fixed", right: 16, bottom: 16 }}>
                <input type="checkbox" checked={snap.enabled}
                       onChange={() => (mock.enabled = !mock.enabled)} /> Mock /api/me
            </label>
        );
    }
    ctx.mount(<Panel />);
});
```

Clicking the box changes `mock.enabled`; the next `/api/me` request sees
it right away, and the value survives restarts.

- **Route.** `{ url, exclude, when }` or URL pattern(s), matched against
  the tab's top page. Overlays exist in the top frame only.
- **One overlay per script per tab.** Every matching overlay handler of
  the script runs in the same frame, in registration order, sharing the
  script's top-level variables. The frame is created at the earliest
  matching `when`; a script whose routes don't match gets none.
- **What runs there.** The whole script evaluates in the frame, but only
  its `onOverlay` handlers run: network, `onSite` and `onPage` handlers
  register nothing there (their handles work). Stores are live copies of
  the background's, so the GUI and the handlers see the same values; a
  `tweak.pageStore` is the copy of the overlay's page, and a `tweak.siteStore`
  the copy of its page's site. `tweak.log`, `console.*`,
  errors and unhandled rejections go to the script's Log, tagged
  `overlay › host`.
- **Isolation.** The page's CSS can't reach the GUI and the GUI's CSS
  can't leak into the page. The page can't find the frame (it sits in a
  closed shadow root) or read the script's code, which comes from the
  extension, never through the page. Strict page CSPs don't stop it.
- **Clicks and stacking.** The frame covers the viewport; the parts with
  visible elements take clicks and everything else lets them through to
  the page. A full-viewport element (a modal backdrop) takes every click.
  With several scripts' overlays, the one last clicked is on top.
- **Saving and disabling.** Saving the script updates the overlay in
  place: the frame stays and its handlers run again
  ([hot reload](#hot-reload--runs-and-ctx)) — draw with `ctx.mount`, or
  clean up on `ctx.signal`, so the GUI isn't added twice. Disabling the
  script removes the overlay.
- **Debuggers from other extensions.** Chrome won't let an extension attach
  its debugger to a tab holding another extension's frame, so tools like
  Playwriter remove the overlay's frame when they attach. The overlay's
  GUI and shortcuts then stop and the Log shows a warning. TangiTweak
  doesn't put the frame back on its own, since the other tool would just
  remove it again. Reload the page or change the script to start it again.
  The frame is an extension page on purpose: that's how overlays run on
  sites whose CSP blocks scripts and `eval`, and why the site can't reach
  them. An `about:blank` frame wouldn't be removed, but it would inherit
  the page's CSP and be open to the page. For a GUI that must survive
  these tools, pass `debuggerSafe: true` in the route options (it draws in
  a closed shadow root in the page, see below) or turn on
  [Debugger-friendly overlays](#debugger-friendly-overlays) for every
  overlay. `tweak.onPage` with `ctx.mount` and `ctx.shortcut` works too.
- **Preview in the Editor.** The Editor's **Preview** tab (⌥⇧V) runs the
  open script's overlay without its page, with the real stores, and
  updates it on save; see [Preview](editor.md#preview).
- **`ctx`.** `ctx.url` is the page's URL. `ctx.onNavigate(fn)` runs `fn(url)`
  whenever the page navigates in place (`pushState`, back/forward,
  `#hash`), as single-page apps do; the overlay stays. It returns a
  function that stops listening; it also stops when the run ends. To
  show the overlay only on some in-app pages, use the route's
  [`navigation`](#single-page-apps--navigation) instead.

  ```ts
  tweak.onOverlay("*://app.example.com/*", (ctx) => {
      const badge = ctx.once("badge", () => document.body.appendChild(document.createElement("div")));
      badge.textContent = "In the cart";
      const show = (url: string) => (badge.hidden = !url.includes("/cart"));
      show(ctx.url);
      ctx.onNavigate(show);
  });
  ```

### Keyboard shortcuts

`ctx.shortcut(keys, fn)` runs `fn` when the keys are pressed on the page,
in `onPage` and `onOverlay` handlers:

```ts
tweak.onOverlay("*://app.example.com/*", (ctx) => {
    const box = ctx.once("box", () => document.body.appendChild(document.createElement("div")));
    box.textContent = "Hello";
    box.hidden = true;
    ctx.shortcut("Alt+Shift+H", () => { box.hidden = !box.hidden; });   // beats the page's own shortcuts
    // ctx.shortcut("Mod+K", fn, { priority: "after-page" })            // only if the page didn't handle it
    ctx.shortcut("Esc", () => (box.hidden ? "pass" : void (box.hidden = true)));   // the page gets Esc while the box is hidden
});
```

- **Keys.** Modifiers (`Mod`, `Ctrl`, `Alt`, `Shift`, `Meta`, in any
  order) then one key: a character (`K`, `1`, `/`) or a name (`Esc`,
  `Enter`, `Space`, `Up`, `F2`, `Plus`). `Mod` is ⌘ on macOS and Ctrl
  elsewhere. Modifiers must match exactly; `Alt+L` works with Option on
  macOS too. For other per-OS choices, use `tweak.isMac`, `tweak.isWindows`
  and `tweak.isLinux` (desktop only: none of them on Android or ChromeOS).
- **Before or after the page.** By default the shortcut wins: the page
  never sees the key. With `{ priority: "after-page" }` it runs only if
  the page didn't handle the key (didn't call `preventDefault` or stop it).
- **Passing the key on.** Return `"pass"` from `fn` and the page gets the
  key as if no shortcut matched: decide each time whether it's yours.
  Anything else (`undefined`, `false`, a promise, a throw) consumes it.
  In an overlay this works for keys pressed while the overlay has focus.
  A key pressed in the page reaches the overlay's code only after the
  page's turn, so it's always consumed there; use `tweak.onPage` when that
  matters.
- **Where.** An overlay's: on the page (its top frame) and while the
  overlay has focus. An `onPage` handler's: in the frame it runs in, so
  it keeps working when another extension's debugger (such as
  Playwriter) removes overlays. Shortcuts are hot keys: they work at all
  times, also while typing in a text field or editable area. Only events
  the page makes up itself don't count.
- **Iframes.** Keys pressed inside an iframe don't reach the page around
  it. Editors such as Google Docs take typing in a hidden iframe, so add
  `{ iframes: true }` to count keys pressed in child iframes too (nested
  ones included), or a selector, `{ iframes: "iframe.editor" }`, for some
  of them. `{ iframes: { shadow: true } }` also finds iframes inside
  shadow roots. When an iframe wipes its page with `document.open()`, the
  shortcut listens again right after; keys pressed in that moment go to
  the page.

  Iframes from other sites are skipped unless you add `crossOrigin`:
  `{ iframes: { crossOrigin: true } }`. There TangiTweak watches the keys
  inside the iframe and runs `fn` in your script, as usual. A few limits
  apply in those iframes: the key is always kept from the page (`"pass"`
  can't give it back), iframes nested inside them aren't followed, and a
  page they wipe with `document.open()` isn't followed either.

  ```ts
  tweak.onPage("*://docs.google.com/*", (ctx) => {
      if (window.top !== window) return;
      ctx.shortcut("Alt+Shift+R", renameTab, { iframes: true });
  });
  ```
- **Several scripts.** If two overlays use the same keys, the one higher
  in the script list gets them; the other's Log says so. The same goes
  for two `onPage` scripts on Firefox. On Chrome each `onPage` script
  runs on its own, so the first to add the keys gets them, with no
  warning. An `onPage` shortcut and an overlay's with the same keys
  aren't ranked either: give them different keys.
- `ctx.shortcut` returns a function that removes the shortcut. Shortcuts
  also go away when the run ends (a save sets them up again) and when
  the script is disabled.

To let the user pick the keys, make them a `shortcut` param:

```ts
const cfg = tweak.params({
    toggle: { type: "shortcut", default: "Alt+Shift+H", description: "Show or hide the box" },
});
tweak.onOverlay("*://app.example.com/*", (ctx) => {
    ctx.shortcut(cfg.toggle, () => { box.hidden = !box.hidden; });
});
```

In the ⚙ dialog the param shows its keys as keycaps (⌥⇧H on macOS).
Click it and press the new keys to change them (Esc cancels). **×**
removes the shortcut and **↺** puts the default back. A recorded `Mod`
means ⌘ on macOS and Ctrl elsewhere, so the setting works on both. The
value is the keys as a string, or `""` once removed, and
`ctx.shortcut("")` adds nothing. In `.tweak/settings.json` you can type the
keys yourself; keys that aren't a shortcut are flagged and ignored. A
`default` that isn't a shortcut is a script error.

### Fetching from the overlay

The overlay's own `fetch` is the page's: the page's content script makes
the request, with the page's origin, cookies and CORS rules, and relative
URLs resolve against the page. Your scripts' handlers see it like any
request — on every strategy except `page`, which only sees the page's own
JavaScript (to go through `page`, fetch from an [`onSite`
handle](#handles--calls-between-places)). `tweak.fetch` defaults to the same
in an overlay; `bypass: true` keeps every script's handlers off the
request, and `from: "background"` fetches from the extension instead (host
permissions, no CORS).

```ts
tweak.onOverlay("*://app.example.com/*", async () => {
    const me = await (await fetch("/api/me")).json();                            // as the page, through your handlers
    const real = await (await tweak.fetch("/api/me", { bypass: true })).json();     // as the page, skipping all handlers
    const other = await tweak.fetch("https://other.site/x", { from: "background" }); // from the extension, no CORS
});
```

### Frameworks and CSS

- **React and valtio** are [built in](#built-in-valtio-and-react). A `.tsx`
  script's JSX compiles with the automatic runtime against the built-in
  React; `ctx.mount` renders it.
- **Other frameworks:** Lit, Solid or plain DOM by
  [package import](#npm-packages) work too. `ctx.mount` is React's only:
  render with the framework's own `render`, and undo it on `ctx.signal`.
- **CSS:** a `.css` [package import](#npm-packages) becomes a
  `<style>` in the overlay, added once; `ctx.style(css)` works in every
  place and reaches `ctx.mount`'s shadow roots; inline styles work as
  usual.
- **Tailwind 4 + daisyUI:** Tailwind's browser build generates CSS from the
  classes it finds in the overlay's document. Load it with a dynamic
  `import()` inside the handler so it only runs in the overlay:

  ```tsx
  import "daisyui/daisyui.css"; // "daisyui" and "@tailwindcss/browser" in "dependencies"
  import { useState } from "react";

  tweak.onOverlay("*://app.example.com/*", async (ctx) => {
      await import("@tailwindcss/browser");
      function Modal() {
          const [open, setOpen] = useState(true);
          return open ? (
              <div className="modal modal-open">
                  <div className="modal-box">
                      <h3 className="text-lg font-bold">Debug tools</h3>
                      <button className="btn" onClick={() => setOpen(false)}>Close</button>
                  </div>
              </div>
          ) : null;
      }
      ctx.mount(<Modal />);
  });
  ```

### Recipes

- **Edit a handler's setting live:** keep it in a store and bind an input
  to it.

  ```ts
  const redirect = tweak.globalStore("redirect", { target: "" });

  tweak.onRequest({ url: "*://cdn.example.com/app.js", strategy: "helper" }, () =>
      redirect.target ? { redirect: redirect.target } : undefined);

  tweak.onOverlay("*://app.example.com/*", (ctx) => {
      const input = ctx.once("input", () => document.body.appendChild(document.createElement("input")));
      input.value = redirect.target;
      input.onchange = () => (redirect.target = input.value);   // the next app.js load is redirected
  });
  ```

- **Modal:** a full-viewport backdrop `<div>` (`position: fixed; inset: 0`)
  takes every click until it's closed.
- **Toast:** a fixed element plus `setTimeout` to remove it.
- **Remember open/closed:** a store field (`ui.open`), so it survives
  reloads and is the same in every tab.
- **Per-tab switch (kept across reloads):** a `tweak.tabStore` field — works with `strategy: "rules"` too.
- **Per-page switch (resets on reload):** a `tweak.pageStore` field, so turning it on affects only this document load.
- **Surviving Chrome debugger extensions (such as Playwriter):** Chrome blocks `chrome-extension://` iframes inside a tab while another extension attaches `chrome.debugger`. Pass `debuggerSafe: true` in the `onOverlay` route options to mount your overlay in an isolated-world closed shadow root instead. On Chrome MV3, this option requires [user scripts](#user-scripts-on-chrome) to be enabled.

### Debugger-friendly overlays

**Settings → Overlays → Debugger-friendly overlays** (off by default,
`"debuggerFriendlyOverlays": true` in [settings.json](editor.md#settingsjson))
does this for every tweak at once, so you can use Playwriter on any tab:

- Every `tweak.onOverlay` draws as if it passed `debuggerSafe: true`.
- [Toast panes](#toast-panes) draw in a closed shadow root in the page
  instead of an extension frame. Their `t` and `ui` work the same.
- `tweak.site` keeps its own `debuggerSafe` option and the Editor's
  Preview keeps its frames.

The trade-offs:

- Keys typed into an overlay or pane bubble out of its shadow root, so
  the page can see them. Don't type secrets into them on sites you don't
  trust.
- On Chrome MV3 they need [user scripts](#user-scripts-on-chrome); toast
  panes also need Chrome 135. Without them, overlays and panes stay in
  their frames and Problems says why.

Turning it on reloads the tabs whose overlays move (Chrome MV3). Turning
it off moves open overlays back into their frames right away.

## Full-page replacement: `tweak.site`

`tweak.site(route, fn)` replaces an existing website in place without running a local helper or showing Chrome's debugger banner.

The browser stays on the real origin URL (for example `https://www.costco.ca/`). Before the original page can run, TangiTweak attaches a strict `Content-Security-Policy` rule to matching `main_frame` responses so the original scripts, styles and media do not execute. TangiTweak then mounts your React or DOM app full-viewport at `document_start`.

```ts
import { tweak } from "tangitweak";

tweak.site(
    {
        url: "*://www.costco.ca/*",
        exclude: ["*://www.costco.ca/checkout*", "*://www.costco.ca/Logon*"],
    },
    (ctx) => {
        ctx.setTitle("Costco Reimagined");
        ctx.mount(<App ctx={ctx} />);
    },
);
```

### Route options

- `url`: URL pattern or list of patterns to replace.
- `exclude`: patterns that always load the real website (useful for login or checkout flows). Calling `ctx.navigate()` to an excluded path triggers a real top-frame navigation so the original page loads.
- `defaultMode`: `"custom"` (default) replaces matching pages automatically. `"original"` loads the real website until the user switches to **Custom** in the popup.
- `debuggerSafe`: opt-in (`false` by default). Set `debuggerSafe: true` if you use Playwriter or another `chrome.debugger` extension on the same tab. In this mode, TangiTweak hosts the full-page app in a nonce-authorized `srcdoc` iframe instead of a `chrome-extension://` iframe so it stays visible while a debugger is attached.

### Switching between Custom and Original

When a tab matches an enabled `tweak.site` tweak, the toolbar popup shows an **Original | Custom** toggle bar for that tab. Switching reloads the tab in the chosen mode. Your app can also call `ctx.showOriginal()` directly, and if your app fails to start, TangiTweak displays a recovery bar with a **Show original site** button.

### Origin data: `ctx.origin`

Because your app runs on the real website's origin, `ctx.origin` exposes that origin's browser state:

- `ctx.origin.fetch(input, init)` fetches as the page with its session cookies (including `HttpOnly` cookies).
- `ctx.origin.localStorage` and `ctx.origin.sessionStorage` provide async `get`, `set`, `remove`, `keys` and `clear` over the origin's Web Storage.
- `ctx.origin.cookies` provides async `all`, `get`, `set` and `remove` for non-`HttpOnly` cookies.
- `ctx.origin.indexedDB` provides async `databases`, `stores`, `get`, `getAll`, `put`, `delete` and `clear` over the origin's IndexedDB databases.
- `ctx.origin.readBlob(url)` fetches same-origin or `blob:` resources as the page and returns a `Blob`.

### Client-side routing and React Router

`tweak.site` syncs with the real browser address bar. `ctx.location` mirrors the top-frame URL (`href`, `origin`, `pathname`, `search`, `hash`, `state`, `key`), and `ctx.navigate(to, { replace })` updates the top-frame URL via the History API when staying inside matched paths or performs a real navigation for cross-origin and `exclude` URLs.

`ctx.navigator` implements React Router's `Navigator` interface (`createHref`, `push`, `replace`, `go`), so you can mount `<Router>` directly:

```tsx
import { tweak } from "tangitweak";
import { useEffect, useState } from "react";
import { Router, Routes, Route, Link } from "react-router";

tweak.site({ url: "*://www.costco.ca/*", exclude: ["*://www.costco.ca/checkout*"] }, (ctx) => {
    function App() {
        const [loc, setLoc] = useState(ctx.location);
        useEffect(() => {
            ctx.onNavigate(() => setLoc({ ...ctx.location }));
        }, []);

        return (
            <Router location={loc} navigator={ctx.navigator}>
                <nav>
                    <Link to="/">Home</Link>
                    <Link to="/deals">Deals</Link>
                </nav>
                <Routes>
                    <Route path="/" element={<Home />} />
                    <Route path="/deals" element={<Deals />} />
                </Routes>
            </Router>
        );
    }

    ctx.mount(<App />);
});
```

## Schedules and toasts

A tweak can check something on a schedule with `tweak.every`, also while
no tab is open, and tell the user with `tweak.toast`: a small card that
pops up inside the tab, on top of the page. Toasts aren't system
notifications and need no permission.

```json
{
  "name": "release-watch",
  "dependencies": { "tangitweak": "*" },
  "tangitweak": { "connect": ["api.github.com"] }
}
```

```ts
import { tweak } from "tangitweak";

const cfg = tweak.params({ repo: { type: "string", default: "tangistudio/TangiTweak" } });
const last = tweak.globalStore("last", { tag: "" });

tweak.every("1h", async () => {
    const res = await tweak.fetch(`https://api.github.com/repos/${cfg.repo}/releases/latest`);
    if (!res.ok) throw new Error(`GitHub said ${res.status}`);
    const { tag_name, html_url } = await res.json();
    if (last.tag && tag_name !== last.tag) {
        tweak.toast({ kind: "success", title: `${cfg.repo} ${tag_name}`, message: "A new release is out.", url: html_url });
    }
    last.tag = tag_name;
});
```

### `tweak.every`

`tweak.every(interval, handler)` runs `handler` in the background on a
schedule. Call it at top level, like the other handlers.

- `interval` is a duration: `"30s"`, `"5m"`, `"1h"`, `"1d"`, `"1h30m"`
  or a number of milliseconds. Schedules run at most once a minute: a
  shorter interval runs every minute, with a warning in Problems.
- The handler gets `ctx`: `ctx.reason` (`"alarm"`, `"startup"` or
  `"manual"`), `ctx.lastRun` (ms since epoch, none on the first run),
  `ctx.signal` (aborts when the run's time is up) and `ctx.stop()`.
- A run gets 60 s and up to 20 `tweak.fetch` calls. Runs never overlap.
  After 5 failures in a row the interval doubles, up to 1 day, until a
  run works again. Failures go to the Log.
- A run that was due while the browser was closed runs once at start,
  with `ctx.reason` `"startup"`.
- **In a packaged tweak, `tweak.fetch` in `tweak.every` reaches only the
  hosts in `package.json`'s `"tangitweak.connect"`** (and their
  subdomains), like [`onPage` code](#tweakfetch). A local script may
  fetch anywhere; the Log notes hosts a package would have to list.
- Keep what you saw last in a [`tweak.globalStore`](#tweakglobalstore):
  it survives browser restarts, so a change is noticed only once.
- The Editor's **Schedules** view (⌥⇧S) shows each schedule with its next
  run, its last run, **Run now** and **Pause**. A pause is the user's: the tweak can't undo
  it. Settings has **Pause all schedules**.

#### Stopping a schedule

There are three ways, from the shortest to the longest lasting:

```ts
// 1. until the tweak is saved, turned off and on, or run by hand
tweak.every("10m", async (ctx) => {
    if (await isDone()) ctx.stop();
});

// 2. a function as the interval: it is read again whenever a store it read changes
const watch = tweak.globalStore("watch", { on: true, every: "15m" });
tweak.every(() => (watch.on ? watch.every : false), check);

// 3. off from the page: flip the store from onPage or overlay code
tweak.onPage("https://shop.example.com/*", () => {
    document.querySelector("#bought")?.addEventListener("click", () => (watch.on = false));
});
```

The function form must return right away (not a promise). `false`,
`null`, `undefined` and `0` mean off.

### `tweak.toast`

`tweak.toast(message)` or `tweak.toast(options)` shows a toast and
resolves to `{ id, status, reason? }`. `status` is `"shown"`, `"queued"`
(no tab can show it yet: it shows when one does) or `"dropped"` (muted,
rate limited or too many).

```ts
tweak.toast("Saved your filters.");

tweak.toast({
    kind: "warning",           // "info" (default), "success", "warning" or "error"
    icon: "🏷️",               // an emoji, an image URL or false (the kind's icon otherwise)
    title: "Price dropped",
    message: "Now 59, was 89.",
    url: "https://shop.example.com/item/42",   // a click on the card opens it
    actions: [{ id: "buy", label: "Buy now" }, "Later"],
    duration: "10s",           // default "6s"; errors default to "sticky"
    id: "price",               // a toast with the same id replaces this one in place
    where: "*://shop.example.com/*",
    ttl: "1d",                 // how long it waits for a tab (default "1h", at most "7d")
});
```

- **Where it shows.** `where: "active"` is the tab in front (the default
  in background code), `"this"` the calling page's tab (the default in
  `onPage` and `onOverlay` code) and a URL pattern or list every open tab
  that matches. From a network handler `"this"` is the tab that made the
  request. With no tab to show it, it waits up to `ttl`.
- **Where it's called from.** An `every`, a network handler, `onPage` or
  `onOverlay` code, or `tweak.onToastAction`. Not at top level, and not in
  `onSite` code (it rejects: the site's scripts could call it).
- **Text only.** `title` and `message` are plain text, never HTML. For
  your own layout, use a [pane](#toast-panes).
- **Limits.** Each tweak may show 1 new toast every 10 s and 20 an hour;
  updating one with the same `id` doesn't count. A tab shows 3 at a time
  and keeps up to 6; the rest wait.
- **A tab in the background.** While a toast waits unseen, the tab's
  title flashes and its icon gets a dot until the user comes back, and its
  timer waits too. The TangiTweak button in the other tabs gets a dot in
  the toast's color. `attention: "window"` also asks the browser window for
  attention; `attention: "none"` does neither.
- **The user is in charge.** The popup can mute a tweak's toasts and shows
  the last 20. Settings can mute all, pick the corner, give every toast the
  same look and turn the title flash, the icon dot and the window flash
  off.

#### Clicks: `tweak.onToastAction`

```ts
const s = tweak.globalStore("uptime", { down: false, snoozedUntil: 0 });

tweak.every("5m", async () => {
    const ok = await tweak.fetch("https://status.example.com/health").then((r) => r.ok, () => false);
    if (!ok && !s.down && Date.now() > s.snoozedUntil) {
        tweak.toast({
            id: "uptime", kind: "error", title: "example.com is down", message: "The health check failed.",
            actions: [{ id: "status", label: "Open status", url: "https://status.example.com" }, { id: "snooze", label: "Snooze 1 h" }],
        });
    }
    if (ok && s.down) tweak.toast({ id: "uptime", kind: "success", message: "example.com is back." });
    s.down = !ok;
});

tweak.onToastAction(({ toastId, actionId }) => {
    if (actionId === "snooze") s.snoozedUntil = Date.now() + 60 * 60 * 1000;
});
```

The handler gets `{ toastId, actionId, value? }`. `actionId` is a
button's `id`, `"click"` (the card, when it has a `url`) or `"close"`
(the user closed it). A button with a `url` opens it and still reports the
action. The handler runs in the background, also after the browser
restarted the extension.

### Toast styles

Toasts have a finished look by default: a card with a stripe and icon in
the kind's color that follows the system's light or dark mode. A tweak can
give its toasts its own look with `tweak.toastStyle` at top level:

```ts
tweak.toastStyle({
    position: "top-right",
    accent: "#f97316",
    background: "#fffaf5",
    text: "#3b2414",
    border: "#fed7aa",
    radius: 16,
    width: 400,                // 280 to 480, default 360
    font: "'Inter', system-ui, sans-serif",
    dark: { background: "#1c1410", text: "#fde7d4", border: "#7c2d12" },
    css: `
        [part=title] { letter-spacing: .01em; }
        [part=action] { border-radius: 999px; }
    `,
});
```

- It affects only this tweak's toasts. Each toast sits in its own shadow
  root, so one tweak's `css` can't reach another's.
- Several calls merge and later keys win (Problems warns about a key set
  twice). A toast's own `style` goes on top:
  `tweak.toast({ message: "Mocking is on.", style: { width: 480 } })`.
- `css` (up to 8 KB) can target the parts `[part=toast]`, `icon`, `title`,
  `message`, `actions`, `action`, `close`, `source` and `progress`, and the
  variables `--tt-accent`, `--tt-bg`, `--tt-text`, `--tt-border`,
  `--tt-radius` and `--tt-font`.
- `titleFlash: false` and `iconDot: false` turn the background tab
  signals off for this tweak.

**Stacking.** Toasts from all tweaks share the tab's corners. Each keeps
its own look, has a "from <tweak>" line and stacks newest nearest the
corner, so tweaks with different styles still line up. With **Same look
for all toasts** in Settings every toast uses the default look.

**Position.** The first of these that is set wins:

1. the corner the user picked for this site (drag a toast to another
   corner),
2. the corner picked in Settings,
3. the toast's `style.position`,
4. the tweak's `toastStyle({ position })`,
5. `"bottom-right"`.

### Toast panes

For a layout of your own, register a pane: a React component that draws
the inside of a toast. Background code can't send JSX, so the pane is
registered by name at top level and each toast picks one and passes data:

```tsx
import { useState } from "react";

tweak.toastPane<{ title: string; before: number; after: number; img: string }>("price", (t, ui) => (
    <div className="price">
        <img src={t.data.img} width={64} />
        <b>{t.data.title}</b>
        <p><s>{t.data.before}</s> <strong>{t.data.after}</strong></p>
        <button onClick={() => ui.action("buy")}>Buy now</button>
        <button onClick={() => ui.action("snooze", "1d")}>Remind me tomorrow</button>
    </div>
), { sample: { title: "Desk lamp", before: 89, after: 59, img: "https://shop.example.com/lamp.jpg" } });

tweak.toastPane<{ build: string }>("deploy", (t, ui) => {
    const [note, setNote] = useState("");
    return (
        <form onSubmit={(e) => { e.preventDefault(); ui.action("approve", note); }}>
            <b>Build {t.data.build} is waiting for approval</b>
            <input placeholder="Note" value={note} onFocus={ui.keepOpen} onChange={(e) => setNote(e.target.value)} />
            <button>Approve</button>
        </form>
    );
});

tweak.every("30m", async () => {
    const p = await (await tweak.fetch("https://shop.example.com/api/item/42")).json();
    tweak.toast({ id: "price-42", pane: "price", data: { title: p.name, before: p.was, after: p.price, img: p.image },
                  title: `${p.name} is now ${p.price}`, message: "Price drop" });
});

tweak.onToastAction(({ actionId, value }) => {
    if (actionId === "approve") tweak.log("approved with", value);
});
```

- The pane gets `t` (`id`, `data`, `title`, `message`, `kind`) and `ui`:
  `ui.action(id, value)` reaches `tweak.onToastAction` and leaves the
  toast open, `ui.close()`, `ui.keepOpen()` stops the timer and
  `ui.update(data)` draws it again.
- It runs in its own extension frame, like an [overlay](#overlays--tweakonoverlay),
  up to 480 × 480 px; the frame grows with its content. With
  [Debugger-friendly overlays](#debugger-friendly-overlays) on, it draws
  in a closed shadow root in the page instead. TangiTweak keeps
  the corner, the stacking, the timer, the close button and the "from
  <tweak>" line.
- `data` must be JSON, up to 32 KB.
- **Always fill `title` and `message` too.** They show when the pane can't
  be drawn (a page that blocks extension frames, a pane name that doesn't
  exist). Problems warns about a `pane` name the script doesn't register.
- `sample` fills the pane in the Editor's **Preview**: pick **Toasts** and
  a pane. What its `ui` calls would do goes to the Log.

### Testing

`tangitweak/test` records toasts and runs schedules by hand:

```ts
import { expect, test } from "vitest";
import { loadTweak } from "tangitweak/test";

test("toasts on a new tag", async () => {
    const t = await loadTweak("./index.ts", {
        fetch: async () => Response.json({ tag_name: "v2", html_url: "https://x" }),
    });
    t.store("last").tag = "v1";
    await t.trigger("every");             // the first tweak.every; trigger("every", 1) for the second
    expect(t.toasts).toMatchObject([{ kind: "success", title: "tangistudio/TangiTweak v2", url: "https://x" }]);
    await t.trigger("toastAction", { toastId: t.toasts[0].id, actionId: "click" });
});
```

The `tweak` fixture of `test` has the same `toasts` and `trigger`.

## Multiple handlers — how they stack

One rule, the same on every strategy: **handlers run from general to
specific and the last word wins.** A general tweak (an API interceptor that
matches every host) runs first. A tweak for one site runs after it and can
build on what it did or overrule it.

### Order

Within a stage of a strategy, handlers run in this order:

1. **Layer**: `base`, then `site`, then `override`.
2. **List order**: scripts top to bottom in the Editor's explorer. With
   folders the order is depth-first: in each folder, its subfolders first
   (alphabetically, each with its whole content), then its scripts.
3. **Registration order** within a script.

A request goes through the stages in this order:

```text
onRequest → (network) → onResponseHeaders → onResponseBody
```

| stage | what "the last word wins" means |
|---|---|
| `onRequest` | Every handler runs. The last one that returns `block`, `redirect`, `replaceResponse` or `allow` decides. Returning nothing keeps what came before. Header edits stack. |
| `onResponseHeaders` | Every handler runs. Header edits stack. |
| `onResponseBody` | A chain: each handler gets the body the one before it returned. |

### Layers

Most tweaks never set a layer. It is inferred from each route's URL
pattern:

| pattern host | examples | layer |
|---|---|---|
| any host | `*://*/*`, `<all_urls>`, `https://:host/api/*` | `base` |
| a named host | `shop.example.com`, `*.example.com`, `localhost:*` | `site` |

`override` is never inferred. A layer set explicitly wins over inference,
in this order:

1. **You**, in the tweak's settings: the **Layer** select in the popup's
   settings fold, or `"layer"` in its `.tweak/settings.json`. Use it to
   demote a tweak you didn't write without editing it.
2. **The route**: `{ url, strategy, layer: "override" }`.
3. **The tweak's package.json**: `"tangitweak": { "layer": "base" }`.
4. **Inferred** from the pattern's host.

```ts
// Offline mode: a broad block that must win over every site mock
tweak.onRequest({ url: "<all_urls>", resourceTypes: ["xmlhttprequest"], strategy: "helper", layer: "override" }, () => ({ block: true }));
```

A general tweak that ships defaults for named hosts (a mock of
`https://api.github.com/user`, say) declares `"layer": "base"` once in its
package.json, so a user's own tweak for that host still wins.

### Examples

An **API interceptor** tweak matches every host, so its handlers are
`base`. A **Shop** tweak matches `shop.example.com`, so its handlers are
`site`. Shop runs after the interceptor whatever their list order.

**Header edits stack.** For each header (case-insensitive) the later
handler wins, whether it sets or removes it.

```ts
// API interceptor
tweak.onRequest({ url: "*://*/*", strategy: "helper" }, () => ({ headers: { set: { "x-trace": "1", "x-env": "dev" } } }));
// Shop
tweak.onRequest({ url: "*://shop.example.com/*", strategy: "helper" }, () => ({ headers: { set: { "x-env": "staging" } } }));
```

`https://shop.example.com/cart` is sent with `x-trace: 1` and
`x-env: staging`. Other hosts get `x-env: dev`. A later handler's
`ctx.requestHeaders` (and `ctx.responseHeaders` in `onResponseHeaders`)
already includes the earlier edits.

**The last decision wins.** Returning nothing keeps it.

```ts
// API interceptor: block every user lookup
tweak.onRequest({ url: "*://*/users/*", strategy: "helper" }, () => ({ block: true }));
// Shop: mock only the admin user
tweak.onRequest({ url: "https://shop.example.com/users/:id", strategy: "helper" }, (ctx) => {
    if (ctx.groups.id === "1") return { replaceResponse: { body: { id: 1, role: "admin" } } };
});
```

`/users/1` gets the mock and `/users/2` stays blocked. The Log notes the
overruled decision:

```text
[API interceptor] onRequest #1 → block was overruled: [Shop] onRequest #1 → replaceResponse has the last word (layer "site" runs after "base") https://shop.example.com/users/1
```

**`allow` undoes an earlier decision.** It lets the request go to the
network and drops an earlier `block`, `redirect` or mock.

```ts
// API interceptor
tweak.onRequest({ url: "*://*/ads/*", strategy: "helper" }, () => ({ block: true }));
// Shop
tweak.onRequest({ url: "*://shop.example.com/ads/house.js", strategy: "helper" }, () => ({ allow: true }));
```

**Same layer: the list decides.** Two `site` tweaks for one host run in
list order, so the lower one has the last word. The narrower URL doesn't
win by itself. The Log warns about it (`same layer, it comes later in the
list`). Drag the tweaks or set one's layer to fix it.

**Body transforms chain** from general to specific:

```ts
// API interceptor: unwrap the envelope every API uses
tweak.onResponseBody({ url: "*://*/api/*", strategy: "helper" }, (ctx, body) => JSON.parse(body).data);
// Shop
tweak.onResponseBody({ url: "*://shop.example.com/api/cart", strategy: "helper" }, (ctx, body) => ({ ...JSON.parse(body), discount: 0.5 }));
```

```text
{"data":{"items":[…]}} → API interceptor → {"items":[…]} → Shop → {"items":[…],"discount":0.5} → page
```

### Mocks go through the response handlers

A mock (`onRequest` returning `replaceResponse`) is a response like any
other: the matching `onResponseHeaders` and `onResponseBody` handlers run
on it, with `ctx.replacedBy` set to `{ tweak, handler }`. The Log notes it
once per pair of handlers:

```text
[Shop] onResponseBody #1 ran on a mock from [API interceptor] onRequest #1 (ctx.replacedBy is set) https://shop.example.com/flags
```

A transform written for the real response can skip mocks:

```ts
tweak.onResponseBody({ url: "*://*/api/*", strategy: "helper" }, (ctx, body) => {
    if (ctx.replacedBy) return; // leave mocks alone
    return JSON.parse(body).data;
});
```

```ts
tweak.onRequest({ url: "*://api.example.com/me", strategy: "helper" }, () => ({
    replaceResponse: {
        body: { id: 1, name: "Mocked User" }, // object → JSON; strings pass through; { file: "data:…" } serves a data: URL
        status: 200, // default 200
        mime: "application/json", // default: from the URL's extension, then the resource type, then application/json
        headers: { set: { "x-mock": "1" } },
    },
}));
```

`tweak.replaceResponse` was removed. Return `{ replaceResponse: { body } }`
from `tweak.onRequest` instead. Returning nothing still leaves the request
alone.

On `page`, `debugger` and `helper` a mock is served with any status and
headers, URL kept, and the request is never sent. `extension` serves
status 200 only (another status isn't served, with a warning), in place:
the request is sent and its body discarded.
See [how each strategy serves a replacement](strategies.md#how-each-strategy-serves-a-replacement).

A `redirect` starts a new request to the target, and the handlers matching
the target run on it. To stop a redirect, return `allow` from a handler
that matches the original URL.

### Across strategies

A handler's `strategy` decides which mechanism runs it, and the mechanisms
sit at different points on the request's way out:

```text
page → rules → extension → debugger → helper → server
```

Layers order handlers within a strategy, never across strategies.
Across strategies, the request reaches one only if those in front let it
through:

- A decision in one strategy means the strategies **behind** it never see
  the request (a `rules` block means the `helper` gets nothing, and a
  `page` mock beats a `site` mock on `helper`).
- Strategies **in front** see a mock or a redirect as an ordinary
  response, so their `onResponseHeaders` and `onResponseBody` still run on
  it.
- After a block there is no response, so no response handler runs.

On `rules` nothing runs per request: run order becomes rule priority, and
`allow` becomes an allow rule. See [what `rules` can do](strategies.md#what-rules-can-do).

### `onSite` patches

When several tweaks patch the same function with `ctx.patch`, they share
one chain per function and frame, ordered by layer and list:

```ts
// API interceptor (base)
tweak.onSite("*://*/*", (ctx) => {
    ctx.patch(window, "fetch", (orig) => async (input, init) => record(await orig(input, init)));
});
// Shop (site)
tweak.onSite("*://shop.example.com/*", (ctx) => {
    ctx.patch(window, "fetch", (orig) => (input, init) => orig(input, withAuth(init)));
});
```

```text
site code → Shop's patch → API interceptor's patch → page strategy handlers → network
```

The `base` patch sits closest to the original function. A `site` patch
sees the call first and the result last. `orig` is the next patch in the
chain, so it is not always the original function.

### Seeing the stack

- **Network view**: pick a request and open its **TangiTweak** tab. The
  **Handler stack** lists every handler that matches it in run order,
  with its strategy, its layer (and where the layer came from) and what it
  did: decided, overruled, skipped, ran on mock, ran or not seen.
- **Problems**: when you save, handlers of different tweaks that may match
  the same request in the same stage are listed as hints, with who runs
  after whom. The check uses a sample URL of each route, so it is a hint
  and not a proof.
- **Log**: a warning when a decision is overruled or a handler is skipped,
  a note when a response handler runs on a mock. Each is logged at most
  once a minute per handler and URL.

```text
[Logger] onResponseBody #1 → skipped: [Blocklist] onRequest #1 → block took priority (strategy "rules" comes before "helper", so the request never got there) https://cdn.example.com/a.js
[B] onRequest #1 overrides request header "authorization" from [A] onRequest #1 (the later one in the list wins) https://api.example.com/me
```

## Async handlers

All `tweak.*` handlers may be `async` (return a Promise). What happens with the
result depends on the handler's strategy:

| handler | `page` (page fetch/XHR) | `extension` (Firefox) | `debugger` | `helper` |
|---|---|---|---|---|
| `onRequest` redirect/block/replaceResponse/allow | ✅ awaited: the page's `fetch`/XHR waits as long as the handler needs | ✅ awaited natively, a mock written in place (URL kept) | ✅ awaited at the Request stage, a mock never contacts upstream | ✅ awaited, a mock never contacts upstream |
| `onRequest` headers | ✅ awaited | ✅ awaited | ✅ awaited, applied at the Request stage | ✅ awaited, sent upstream |
| `onResponseHeaders` | — (not on `page`) | ✅ awaited | ✅ awaited, merged into the fulfilled headers | ✅ awaited |
| `onResponseBody` | ✅ awaited (chained between handlers) | ✅ awaited | ✅ awaited | ✅ awaited (served `no-store`) |
| `onSite`, `onPage`, `onOverlay` | run in the page / overlay on every strategy; not awaited (fire-and-forget) — a save waits for the new run's promise before undoing what the old run set up ([hot reload](#hot-reload--runs-and-ctx)) | | | |

Practical rules of thumb:

- **Mocking/transforming APIs (fetch/XHR)?** Async just works — write
  `tweak.onResponseBody(API, async (ctx, body) => { const j = await translate(body); return …; })`.
- **Redirect/block or header changes decided asynchronously** on Chrome?
  Use `helper` or `debugger` (both await).
- **A mock from an async source** (file read, fetch): an async `onRequest`
  returning `{ replaceResponse }` on `helper`, `debugger` or `page` is all
  you need.
- **No time limit on `page`.** A handler may wait as long as it likes — for
  the user to decide on a paused request, say — and the page's request waits
  with it. TangiTweak only lets a request through untouched when the
  extension stops answering "is this call still running?" for a few seconds
  (the extension reloaded, or a message got lost), never because a handler
  is slow.
