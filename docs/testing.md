# Testing scripts

[<img src="../icons/icon.svg" width="16" height="16" align="absmiddle" alt=""> README](../README.md) · [Glossary](../GLOSSARY.md)

Write automated unit and UI tests for scripts and multi-script bundles locally
in your [synced folder](editor.md#folder-sync) or in CI with `@tangitweak/test`.

Test files (`*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx`, `__tests__/**`)
and runner configs (`vitest.config.ts`, `vite.config.ts`, `jest.config.ts`,
`playwright.config.ts`) stay local on disk: TangiTweak skips them during Folder
Sync, package installs, **Make Package…** and zip exports.

## Local setup (Folder Sync)

Connecting a [synced folder](editor.md#folder-sync) writes the test harness to
`.tangitweak/test/` and wires `@tangitweak/test` and `#tangitweak/test` in
`tsconfig.json` and `package.json` automatically — no npm publish step needed.
Your own `scripts`, `dependencies` and `devDependencies` in `package.json` are
preserved when TangiTweak refreshes its managed files.

Install Vitest (plus `happy-dom` if you test `tt.onPage` / `tt.onSite` /
`tt.onOverlay` DOM and React components):

```sh
npm install -D vitest happy-dom @testing-library/react
```

> Zero-install option: for pure `.ts` network/rule tests on Node 24+, import
> `"#tangitweak/test"` and run `node --test` directly without `npm install`.

## Testing network handlers & rules

`loadTweak(source, options?)` compiles a script file (`"./api.ts"`), a bundle
folder or `"./metadata.json"`, or inline `{ code, files }` with TangiTweak's
real compiler, relative/data imports and DNR rules probe:

```ts
// api.test.ts
import { describe, it, expect } from "vitest";
import { loadTweak } from "@tangitweak/test";

describe("api rewrite", () => {
    it("adds auth headers, transforms JSON, and builds static DNR rules", async () => {
        await using t = await loadTweak("./api.ts", {
            params: { env: "staging" },
            mocks: {
                "https://unpkg.com/nanoid@5.0.0/index.browser.js": { nanoid: () => "id-1" },
            },
        });

        expect(t.rules).toHaveLength(1);

        const res = await t.simulate("https://api.example.com/todos/1", {
            headers: { "x-remove-me": "1" },
            upstream: { status: 200, body: { id: 1, title: "Original" } },
        });

        expect(res.requestHeaders["x-env"]).toBe("staging");
        expect(res.json()).toEqual({ id: 1, title: "Patched", reqId: "id-1" });

        await t.setParams({ env: "prod" });
    });
});
```

`t.simulate(url, init?)` runs the full request pipeline in order:
`onRequest` (`block` / `redirect` / `headers` / `replaceResponse`) →
`replaceResponse` → `upstream` (object, `Response`, or `(req) => …` callback) →
`onResponseHeaders` → `onResponseBody` (text and `binary: true`). Any
`strategy: "rules"` handler that illegally reads per-request fields throws at
load/probe time just like in the extension.

## Testing `onPage`, `onSite`, `onOverlay` & React mounts

Add `// @vitest-environment happy-dom` at the top of `.test.tsx` files to test
DOM mutations, `ctx.patch`, `ctx.style`, keyboard shortcuts (`ctx.shortcut`),
cross-world handles (`await site.myMethod()`), `valtio` stores
(`tt.globalStore`, `tt.tabStore`, `tt.pageStore`, `tt.siteStore`), and React 19
components mounted inside closed shadow roots:

```tsx
// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { fireEvent } from "@testing-library/react";
import { loadTweak } from "@tangitweak/test";

describe("PR toolbar widget", () => {
    it("mounts React UI in a closed shadow root and syncs with the overlay", async () => {
        await using t = await loadTweak("./pr-helper.tsx", {
            stores: { prHelper: { approvals: 2 } },
        });

        await using page = await t.openPage("https://github.com/org/repo/pull/9", {
            html: `<header class="pr-toolbar"></header>`,
        });

        // Inspect React containers mounted inside closed shadow roots
        const mount = page.mountFor(".pr-toolbar")!;
        expect(mount.textContent).toContain("Approvals: 2");

        // window.fetch inside components routes through t.simulate() automatically
        fireEvent.click(mount.querySelector("button")!);
        await page.flush();

        expect(mount.textContent).toContain("Approvals: 3");
        expect(page.overlay?.textContent).toContain("Approvals: 3");

        // Test keyboard shortcuts, SPA navigation, and hot-reload cleanup
        await page.pressKey("Alt+Shift+P");
        await page.navigate("https://github.com/org/repo/pull/10");
        await page.reload();
    });
});
```

## Running in CI (GitHub Actions)

In CI where Chrome and Folder Sync aren't running, install the standalone
`tangitweak-test.tgz` tarball attached to every
[TangiTweak release](https://github.com/tangistudio/TangiTweak/releases):

```sh
# Latest release
npm install -D https://github.com/tangistudio/TangiTweak/releases/latest/download/tangitweak-test.tgz

# Or pin to a specific TangiTweak version
npm install -D https://github.com/tangistudio/TangiTweak/releases/download/v0.37.0-alpha/tangitweak-test-v0.37.0-alpha.tgz
```

Then run `npx vitest run` as usual, and your imports (`import { loadTweak } from "@tangitweak/test"`) stay identical between Folder Sync and CI.
