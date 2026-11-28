# Testing tweaks

[<img src="../icons/icon.svg" width="16" height="16" align="absmiddle" alt=""> README](../README.md) · [Glossary](../GLOSSARY.md)

Test a tweak with [Vitest](https://vitest.dev) and `"tangitweak/test"`,
locally in your [synced folder](editor.md#folder-sync) or in CI.

Test files (`*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx`, `__tests__/**`)
and runner configs (`vitest.config.ts`, `vite.config.ts`, `jest.config.ts`,
`playwright.config.ts`) stay local on disk: TangiTweak skips them during Folder
Sync, package installs and zip exports.

## Setup

`"tangitweak/test"` is part of the `tangitweak` package on npm (the
**SDK**), the same one a tweak's `import { tweak } from "tangitweak"` and its
`tsconfig.json`'s `"extends": "tangitweak/tsconfig.json"` come from. Add
Vitest next to it:

```sh
npm install -D tangitweak vitest react react-dom valtio
# only for plain component tests (renderTweak or React Testing Library on its own):
npm install -D happy-dom @testing-library/react
```

It needs Node.js 23.8 or later and Vitest 2, 3 or 4. React, ReactDOM and
valtio are the copies the tests share with the tweak's code (in the browser,
TangiTweak provides them). The SDK's version is the extension's, so install
the one that matches the TangiTweak you run
(`npm install -D tangitweak@0.42.0-alpha`).

**Without npm's copy:** in a [synced folder](editor.md#folder-sync), Folder
Sync writes the SDK of the extension you're running to
`.tangitweak/sdk/tangitweak/` and the folder's root `package.json` links it
(`"tangitweak": "file:.tangitweak/sdk/tangitweak"`). Run
`npm install -D vitest react react-dom valtio` there and the tests use that
copy, which always matches your extension. Each
[GitHub release](https://github.com/tangistudio/TangiTweak/releases) also
attaches it as `tangitweak-sdk-v<version>.tgz`
(`npm install -D ./tangitweak-sdk-v0.42.0-alpha.tgz`).

Put the tests inside the tweak's folder, for example in `__tests__/`:

```
my-tweak/
├── package.json           # "tangitweak": { … }
├── index.ts
├── features/palette/…
└── __tests__/
    ├── palette.test.ts
    └── Palette.test.tsx
```

A test finds its tweak by itself: the nearest `package.json` listing
`tangitweak` in its `dependencies` above the test file. No `vitest.config.ts` is needed.

## Three styles

| What you test | Style | Looks like |
| :--- | :--- | :--- |
| Handlers, pages, tabs, network, params | [Fixtures](#fixtures): `test` and `createTweakTest` | Playwright |
| One React component | [`mount`](#one-component-mount), or [`renderTweak`](#one-component-rendertweak) | Playwright, or React Testing Library |
| Plain functions (parsers, helpers) | [Plain tests](#plain-functions) | Ordinary Vitest |

Fixture and `mount` tests run the tweak the way the extension does: TangiTweak's
own compiler loads it, each test gets **its own copy** of the tweak and its
stores, and each tab its own document. The others are ordinary Vitest tests
that import the tweak's files.

| | Fixtures and `mount` | `renderTweak` and plain tests |
| :--- | :--- | :--- |
| Who loads the tweak's code | TangiTweak's compiler, as in the browser | Vitest, as normal imports |
| npm packages come from | `node_modules`, resolved as the extension resolves them | `node_modules`, resolved by Vitest |
| Stores are separate per | Test (and per tab for `tabStore`, per page for `pageStore`) | Test file (reset after each test) |
| `test.concurrent` in one file | Yes | No |
| Replacing a dependency | The `mocks` option (`vi.mock` doesn't reach the tweak's code) | `vi.mock` |
| Needs a DOM environment | No: each page has its own | Yes (`// @vitest-environment happy-dom`) |

## Fixtures

`test` from `"tangitweak/test"` is Vitest's `test` with these fixtures (Vitest's
own `test.extend`). Each test gets a fresh copy of the tweak and cleans up by
itself.

| Fixture | What it is |
| :--- | :--- |
| `page` | A fresh tab: `goto(url, opts?)`, `press(combo)`, `click(el)`, `type(el, text)`, `reload()`, `flush()`. `page.ui` has Testing Library's queries for the tweak's own UI (its mounts, inside closed shadow roots too, and its overlay). `page.document` and `page.window` are the website's. |
| `browser` | `browser.newPage(url, opts?)` opens another tab with the same tweak. |
| `net` | `net.request(url, init?)` sends a request through the handlers ([below](#network)). `net.rules` lists the browser rules the tweak generates. |
| `tweak` | `setParams(values)`, `logs`, `problems` (what the Problems view would show), `store(store, page?)`. |
| `mount` | Renders one component with this test's stores ([below](#one-component-mount)). |

```ts
// __tests__/palette.test.ts
import { expect } from "vitest";
import { test } from "tangitweak/test";

test("a shortcut opens the palette", async ({ page }) => {
    await page.goto("https://app.example.com/home");
    expect(page.ui.queryByRole("listbox")).toBeNull();

    await page.press("Alt+Shift+P");

    await page.ui.findByRole("listbox");
    // the website can't see into the tweak's closed shadow root
    expect(page.document.querySelector("[role=listbox]")).toBeNull();
});

test("the compact choice survives a reload", async ({ page }) => {
    await page.goto("https://app.example.com/home");
    await page.press("Alt+Shift+P");
    await page.click(await page.ui.findByText(/Compact: OFF/));

    await page.reload();

    await page.ui.findByText(/Compact: ON/);
});
```

`goto` options: `html` (the website's `<body>`), `phase` (`"document_start"`,
`"document_end"` by default, `"document_idle"`), `csp` ([below](#browser-differences-the-tests-catch))
and `setup(window)`, which runs before any handler with the website's own
`window`, for the globals the site itself would have.

**Tabs.** A reload or a `goto` in the same tab keeps its `tabStore`s and
starts its `pageStore`s over. Another tab shares the `globalStore`s, not the
`tabStore`s:

```ts
test("tabs share choices but not the open palette", async ({ page, browser }) => {
    await page.goto("https://app.example.com/home");
    const other = await browser.newPage("https://app.example.com/other");

    await page.press("Alt+Shift+P");
    await page.click(await page.ui.findByText(/Compact: OFF/));

    expect(other.ui.queryByRole("listbox")).toBeNull(); // tabStore: per tab

    await other.press("Alt+Shift+P");
    await other.ui.findByText(/Compact: ON/); // globalStore: shared
});
```

**State you can't see in the UI.** Import the store: it only says *which*
store is meant, and `tweak.store` returns this test's copy of it (on `page`:
that tab's):

```ts
import { site } from "../features/palette/state";

test("records the last visited URL", async ({ page, tweak }) => {
    await page.goto("https://app.example.com/home");
    expect(tweak.store(site, page).lastUrl).toBe("https://app.example.com/home");
});
```

**Other params, one feature, another browser:** make another `test` with
`createTweakTest`, or change params inside a test with `tweak.setParams`.

```ts
import { createTweakTest } from "tangitweak/test";

const prodTest = createTweakTest({ params: { env: "prod" } });
const netOnly = createTweakTest({ entry: "./only-net.ts" }); // a tiny entry that installs one feature
const firefoxTest = createTweakTest({ browser: "firefox" });
```

`createTweakTest` options: `params`, `entry`, `browser` (`"chrome"`: MV3, the
default, or `"firefox"`), `realLimits` ([below](#network)),
`mocks` (`{ "some-package": exports, "./api": exports }`) and `storage`.
A tweak for several browsers runs the same tests once per browser:

```ts
describe.each(["chrome", "firefox"] as const)("%s", (browser) => {
    const t = createTweakTest({ browser });
    t("…", async ({ net }) => { /* … */ });
});
```

### Network

`net.request(url, init?)` walks a request through the strategies in the order
the extension uses them, `page → rules → extension → debugger → helper`, each
with its real limits in the chosen browser. Handlers run inside the test; no
browser, helper process or network is involved. The request is a fetch/XHR
unless `resourceType` says otherwise.

1. Handlers that can't run in that browser are turned off when the tweak
   loads, with the text the Problems view shows (`tweak.problems`). `rules`
   handlers run once and become fixed browser rules (`net.rules`).
2. On the way out, each layer sees the request only if the browser would let
   it: `page` sees only the page's own fetch/XHR, `helper` never sees
   `localhost`, `rules` applies its fixed rules. The first block, redirect or
   replacement stops the request.
3. `upstream` (the fake server: an object, a `Response` or `(req) => …`) answers
   only if no layer stopped it.
4. On the way back, the layers in front run their response handlers.

The result has the response (`status`, `headers`, `text()`, `json()`,
`bytes()`, `blocked`, `redirectedTo`, `requestHeaders`) plus:

- **`res.skipped`**: each handler that matched but didn't run, and why, in the
  extension's words (`{ handler, strategy, script, why }`).
- **`res.decidedBy`**: the handler whose block, redirect or replacement made
  the result (`{ strategy, handler, script, outcome }`), or `null`.

```ts
// the tweak
tweak.onRequest({ url: FLAGS, strategy: "helper" }, () => ({ replaceResponse: { body: { newNav: true } } }));
tweak.onResponseBody({ url: FLAGS, strategy: "page" }, (ctx, body) => ({ ...JSON.parse(String(body)), seen: true }));

// the test
test("the page sees the helper's replacement", async ({ net }) => {
    const res = await net.request(FLAGS);

    expect(res.json()).toEqual({ newNav: true, seen: true });
    expect(res.decidedBy).toMatchObject({ strategy: "helper", handler: "onRequest #1" });
});

test("page handlers don't see the document", async ({ net }) => {
    const res = await net.request(FLAGS, { resourceType: "document" });

    expect(res.skipped).toContainEqual(expect.objectContaining({
        handler: "onResponseBody #1",
        why: expect.stringContaining(`the "page" strategy only sees the page's own fetch/XHR`),
    }));
});

test("blocks telemetry with a browser rule", async ({ net }) => {
    expect(net.rules).toContainEqual(expect.objectContaining({ action: { type: "block" } }));
    expect((await net.request("https://telemetry.example.com/ping")).blocked).toBe(true);
});
```

`createTweakTest({ realLimits: false })` turns the layers off: every matching
handler runs in one chain, whatever its strategy and browser. Use it only to
test a handler's logic on its own.

## One component: `mount`

`mount(path, opts?)` loads one component through TangiTweak's compiler, as a
page does, and renders it in a closed shadow root with this test's own
stores. Tests using it can run with `test.concurrent`.

```ts
// __tests__/palette.test.ts
import { expect } from "vitest";
import { test } from "tangitweak/test";
import { choices, palette } from "../features/palette/state";

test.concurrent("toggles compact", async ({ mount, tweak }) => {
    const ui = await mount("features/palette/Palette", {
        stores: [[palette, { open: true, filter: "" }]],
        props: { title: "Palette" },
    });

    await ui.click(ui.getByText(/Compact: OFF/));

    await ui.findByText(/Compact: ON/);
    expect(tweak.store(choices).compact).toBe(true);
});
```

The path is relative to the tweak's folder, with or without the extension.
The file's default export is rendered, else the export named like the file,
else its only exported function. Options: `stores` (`[[store, value], …]`
starting values), `props` and `mocks`. The result has Testing Library's
queries plus `container`, `click`, `type`, `press` and `flush`.

## One component: `renderTweak`

`renderTweak(ui, opts?)` is React Testing Library's `render`, plus starting
values for stores and a `store(...)` reader. The component is an ordinary
import, so TypeScript checks it, and `vi.mock`, `vi.spyOn` and breakpoints work
as usual. It needs a DOM environment:

```tsx
// @vitest-environment happy-dom
// __tests__/Palette.test.tsx
import { fireEvent, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { renderTweak } from "tangitweak/test";
import { Palette } from "../features/palette/Palette";
import { choices, palette } from "../features/palette/state";

test("toggles compact", async () => {
    const { store } = renderTweak(<Palette />, {
        stores: [[palette, { open: true, filter: "" }]],
    });

    fireEvent.click(screen.getByText(/Compact: OFF/));

    await screen.findByText(/Compact: ON/);
    expect(store(choices).compact).toBe(true);
});
```

Vitest loads one copy of the component and its stores per test file:
`renderTweak` unmounts and resets the stores after each test, so the tests in
one file run one after another (React Testing Library's `screen` has the same
limit).

## Plain functions

```ts
import { expect, test } from "vitest";
import { parsePairs } from "../features/text/pairs";

test("parses key=value pairs", () => {
    expect(parsePairs("env=staging, region=us-east-1")).toEqual({ env: "staging", region: "us-east-1" });
});
```

In `renderTweak` and plain tests, `import { tweak } from "tangitweak"` runs on
its own in Node: stores are plain Valtio objects, params return their
defaults, and handlers are recorded but never called (an `onSite` handle's
functions reject).

## npm packages

Fixture and `mount` tests read the tweak's npm packages from `node_modules`
(the tweak folder's, or one in a folder above it), with no network, and
resolve them the way the extension does:
only packages in the tweak's `dependencies`, `npm:` aliases
(`"path": "npm:path-browserify@^1.0.1"`), and a Node built-in a package
`require`s coming from the tweak's own dependency of that name. Run
`npm install` first; a package that isn't installed fails the load and says
so. `mocks` replaces a package or a
file with the exports you give.

## Browser differences the tests catch

Fixture and `mount` tests close these gaps between Node and the browser.
`renderTweak` and plain tests run in Node and close none of them.

| In the browser | In fixture and `mount` tests |
| :--- | :--- |
| No Node globals or built-ins. | The tweak sees no `Buffer`, `process`, `global` or `setImmediate`, and a Node built-in (`"events"`) fails unless the tweak depends on a package of that name: a missing polyfill fails in the test as it does in the extension. |
| Chrome checks each rule's regex with RE2. | Each generated rule regex is checked with [`re2js`](https://www.npmjs.com/package/re2js), a port of RE2, and a rejected one is a load error with the extension's text. Chrome's 2 KB compiled-size limit is estimated: clearly over is an error, close to it a warning. |
| Chrome allows 5,000 session rules and 1,000 regex rules. | Loading fails when the tweak's own rules go over. |
| `onSite` (the MAIN world) and `onPage` (the isolated world) share the DOM, not JavaScript globals. | Each has its own `window` globals: a `window.foo` one sets is invisible to the other, and the website's globals (`goto`'s `setup`) are visible to `onSite` only. |
| The `debugger` strategy can miss the first page load in a new tab. | `res.skipped` lists the handler as "may miss it" for a tab's first document request (it still runs). |

Not covered; these stay with TangiTweak's own real-browser tests:

- Properties added to DOM nodes (`el.foo = 1`) are shared between the worlds
  in tests, not in Chrome.
- The CSP isn't enforced on what the tweak loads itself (an `<img>`, a
  `<script>`, an inline `style`).
- Rule limits are counted per tweak; in the browser, other tweaks share them.
- The browser cache, and whether a cached response skips handlers.
- The helper process itself: proxy routing, HTTPS certificates, "helper not
  installed".

## `loadTweak`: the low-level API

The fixtures are built on `loadTweak(source, options?)`, also exported from
`"tangitweak/test"`. It loads a tweak's folder, its `package.json`, a file in
it, or an inline `{ code, files }` tweak, and returns `simulate(url, init?)`
(what `net.request` calls), `openPage(url, opts?)`, `rules`, `errors`,
`warnings`, `logs`, `setParams` and `dispose`. Use it for tests that need a
tweak written inside the test:

```ts
import { expect, it } from "vitest";
import { loadTweak } from "tangitweak/test";

it("blocks ads", async () => {
    await using t = await loadTweak({
        code: `import { tweak } from "tangitweak";
tweak.onRequest({ url: "*://ads.example.com/*", strategy: "rules" }, () => ({ block: true }));`,
    });
    expect((await t.simulate("https://ads.example.com/x")).blocked).toBe(true);
});
```

Its options are the ones `createTweakTest` takes, plus `stores`, `fetch`
(the default upstream), `files` and `allowCompileErrors`.

## Running in CI

Install the tweak's dependencies and run Vitest; nothing else is needed:

```sh
npm ci
npx vitest run
```
