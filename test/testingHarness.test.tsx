import { describe, it, expect } from "vitest";
import { fireEvent } from "@testing-library/react";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTweak } from "../src/testing/index";
import { pickStart } from "../src/shared/packageSource";

describe("@tangitweak/test harness", () => {
    it("loads tweak folders from disk (their package.json's entry and what it imports) while ignoring co-located test/config files", async () => {
        const dir = mkdtempSync(join(tmpdir(), "tt-test-pkg-"));
        try {
            mkdirSync(join(dir, "tool/shared"), { recursive: true });
            mkdirSync(join(dir, "tool/__tests__"), { recursive: true });

            writeFileSync(join(dir, "tool/package.json"), JSON.stringify({ name: "tool", main: "main.ts", tangitweak: {} }));
            writeFileSync(join(dir, "tool/shared/fmt.ts"), `export const badge = (n: number) => \`[\${n}]\`;\n`);
            writeFileSync(join(dir, "tool/config.json"), JSON.stringify({ prefix: "PR" }));
            writeFileSync(join(dir, "tool/icon.svg"), `<svg viewBox="0 0 8 8"><circle cx="4" cy="4" r="3"/></svg>`);
            writeFileSync(
                join(dir, "tool/main.ts"),
                `import { tweak } from "tangitweak"; 
                import { badge } from "./shared/fmt";
                import cfg from "./config.json";
                import icon from "./icon.svg";
                export function formatTitle(n: number) {
                    return \`\${cfg.prefix} \${badge(n)} \${icon.startsWith("<svg") ? "ok" : "bad"}\`;
                }
                `
            );
            // Co-located tests & runner configs that must not confuse package discovery
            writeFileSync(join(dir, "tool/main.test.ts"), `export {};\n`);
            writeFileSync(join(dir, "tool/__tests__/smoke.ts"), `export {};\n`);
            writeFileSync(join(dir, "tool/vitest.config.ts"), `export default {};\n`);

            expect(pickStart(["main.ts", "main.test.ts", "__tests__/smoke.ts", "vitest.config.ts", "package.json"], "tool")).toBe("package.json");
            expect(() => pickStart(["main.ts"], "tool")).toThrow(/no package\.json in tool/);

            // Folder load starts at package.json's main AND resolves ./shared/fmt + JSON + SVG imports
            const single = await loadTweak(join(dir, "tool"));
            expect(single.manifest?.packageName).toBe("tool");
            expect(single.exports.formatTitle(42)).toBe("PR [42] ok");
            await single.dispose();

            // The entry (index.ts) imports modules whose handlers are the tweak's
            const bundleDir = join(dir, "bundle");
            mkdirSync(bundleDir, { recursive: true });
            writeFileSync(
                join(bundleDir, "package.json"),
                JSON.stringify({ name: "dev-suite", version: "2.1.0", tangitweak: { displayName: "Dev Suite", connect: ["api.example.com"] } })
            );
            writeFileSync(join(bundleDir, "index.ts"), `import "./headers";\nimport "./body";\n`);
            writeFileSync(
                join(bundleDir, "headers.ts"),
                `import { tweak } from "tangitweak"; tweak.onRequest({ url: "*://api.example.com/*", strategy: "helper" }, () => ({ headers: { set: { "x-suite": "1" } } }));\n`
            );
            writeFileSync(
                join(bundleDir, "body.ts"),
                `import { tweak } from "tangitweak"; tweak.onResponseBody({ url: "*://api.example.com/*", strategy: "helper" }, (_ctx, body) => ({ ...JSON.parse(String(body)), patched: true }));\n`
            );

            const bundle = await loadTweak(bundleDir);
            expect(bundle.manifest?.name).toBe("Dev Suite");
            expect(bundle.metadata?.version).toBe("2.1.0");
            expect(bundle.scripts.map((s) => s.name)).toEqual(["index"]); // the one tweak; its modules run as part of it
            expect(bundle.capabilities.connect).toContain("api.example.com");

            const res = await bundle.simulate("https://api.example.com/items", {
                upstream: { body: { items: [1, 2] } },
            });
            expect(res.action).toBe("modified");
            expect(res.requestHeaders["x-suite"]).toBe("1");
            expect(res.json()).toEqual({ items: [1, 2], patched: true });
            await bundle.dispose();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("simulates the full HTTP & DNR rules pipeline, params, storage, and mocked URL imports", async () => {
        const t = await loadTweak(
            {
                name: "pipeline",
                code: `import { tweak } from "tangitweak";
                import { sign } from "https://unpkg.com/fake-signer@1.0.0/index.js";

                const p = tweak.params({
                    env: { type: "string", default: "staging" },
                    blockAds: { type: "boolean", default: true },
                });

                tweak.onRequest({ url: "*://ads.example.com/*", strategy: "rules" }, () => {
                    if (p.blockAds) return { block: true };
                });

                tweak.onRequest({ url: "*://old.example.com/*", strategy: "helper" }, () => ({
                    redirect: "https://new.example.com/landed",
                }));

                tweak.onRequest({ url: "*://api.example.com/short", strategy: "helper" }, () => ({
                    replaceResponse: {
                        status: 201,
                        headers: { set: { "x-short": "yes" } },
                        body: { shortcut: true },
                    },
                }));

                tweak.onRequest({ url: "*://api.example.com/*", strategy: "helper" }, (ctx) => {
                    tweak.storage.set("lastMethod", ctx.method);
                    return {
                        headers: {
                            set: { "x-env": p.env, "x-sig": sign(typeof ctx.requestBody === "string" ? ctx.requestBody : "") },
                            remove: ["x-strip-me"],
                        },
                    };
                });

                tweak.replaceResponse({ url: "*://api.example.com/mock", strategy: "helper" }, () => ({
                    mocked: true,
                    env: p.env,
                }));

                tweak.onResponseHeaders({ url: "*://api.example.com/*", strategy: "helper" }, () => ({
                    headers: {
                        set: { "x-powered": "tangitweak" },
                        remove: ["server"],
                    },
                }));

                tweak.onResponseBody({ url: "*://api.example.com/items", strategy: "helper" }, (_ctx, body) => {
                    const data = JSON.parse(String(body));
                    return { ...data, count: data.items.length, env: p.env };
                });

                tweak.onResponseBody({ url: "*://cdn.example.com/*.bin", strategy: "helper", binary: true }, (_ctx, bytes) => {
                    const out = new Uint8Array(bytes.length + 1);
                    out.set(bytes, 0);
                    out[bytes.length] = 0xff;
                    return out;
                });
                `,
            },
            {
                mocks: {
                    "https://unpkg.com/fake-signer@1.0.0/index.js": {
                        sign: (s: string) => `sig:${s.length}`,
                    },
                },
            }
        );

        // DNR rules generated from strategy: "rules"
        expect(t.rules).toHaveLength(1);
        expect(t.rules[0].action.type).toBe("block");

        const blocked = await t.simulate("https://ads.example.com/pixel.js");
        expect(blocked.blocked).toBe(true);
        expect(blocked.action).toBe("blocked");

        // Changing params recomputes DNR rules dynamically
        await t.setParams({ blockAds: false, env: "prod" });
        expect(t.rules).toHaveLength(0);
        const unblocked = await t.simulate("https://ads.example.com/pixel.js", { upstream: { body: "ok" } });
        expect(unblocked.blocked).toBe(false);

        // Redirect
        const redir = await t.simulate("https://old.example.com/page");
        expect(redir.action).toBe("redirected");
        expect(redir.redirectedTo).toBe("https://new.example.com/landed");

        // onRequest inline replaceResponse
        const short = await t.simulate("https://api.example.com/short");
        expect(short.action).toBe("replaced");
        expect(short.status).toBe(201);
        expect(short.headers["x-short"]).toBe("yes");
        expect(short.json()).toEqual({ shortcut: true });

        // replaceResponse handler
        const rep = await t.simulate("https://api.example.com/mock");
        expect(rep.replaced).toBe(true);
        expect(rep.json()).toEqual({ mocked: true, env: "prod" });

        // Full upstream round-trip: request headers mutated -> upstream sees mutated headers -> 3xx skips body transform -> 200 runs headers + body transform
        let seenUpstreamHeaders: Record<string, string> = {};
        const full = await t.simulate("https://api.example.com/items", {
            method: "POST",
            headers: { "X-Strip-Me": "secret" },
            body: { hello: "world" },
            upstream: (req) => {
                seenUpstreamHeaders = req.headers;
                expect(req.body?.json()).toEqual({ hello: "world" });
                return { status: 200, headers: { Server: "nginx" }, body: { items: ["a", "b", "c"] } };
            },
        });
        expect(seenUpstreamHeaders["x-strip-me"]).toBeUndefined();
        expect(seenUpstreamHeaders["x-env"]).toBe("prod");
        expect(seenUpstreamHeaders["x-sig"]).toBe("sig:17");
        expect(t.storage.get("lastMethod")).toBe("POST");
        expect(full.headers["server"]).toBeUndefined();
        expect(full.headers["x-powered"]).toBe("tangitweak");
        expect(full.json()).toEqual({ items: ["a", "b", "c"], count: 3, env: "prod" });

        // 304 skips onResponseBody just like production
        const notMod = await t.simulate("https://api.example.com/items", {
            upstream: { status: 304, body: "" },
        });
        expect(notMod.status).toBe(304);
        expect(notMod.text()).toBe("");

        // Binary response body
        const bin = await t.simulate("https://cdn.example.com/chunk.bin", {
            upstream: { body: new Uint8Array([1, 2, 3]), contentType: "application/octet-stream" },
        });
        expect([...bin.bytes()]).toEqual([1, 2, 3, 255]);

        await t.dispose();
    });

    it("mounts React 19 UI in closed shadow roots on onPage, syncs valtio stores + onOverlay + onSite RPC, and restores patches", async () => {
        const t = await loadTweak(
            {
                name: "github-pr-helper",
                code: `import { tweak } from "tangitweak"; 
                import { useSnapshot } from "valtio";

                const appStore = tweak.globalStore("pr-helper", { approvals: 1 });
                const tabState = tweak.tabStore({ panelOpen: false });
                const sharedSite = tweak.siteStore({ theme: "dark" });

                const site = tweak.onSite("*://github.com/*", (ctx) => {
                    ctx.patch(window as any, "__ttSiteVersion", (orig) => () => orig() + "+v1");
                    return {
                        readPageGlobal() {
                            return (window as any).__pageToken + ":" + sharedSite.theme;
                        },
                    };
                });

                tweak.onPage("*://github.com/*", (ctx) => {
                    ctx.style(".pr-widget { font-weight: 600; }");
                    ctx.shortcut("Alt+Shift+P", () => {
                        tabState.panelOpen = !tabState.panelOpen;
                    });

                    function ApproveWidget() {
                        const snap = useSnapshot(appStore);
                        const siteSnap = useSnapshot(sharedSite);
                        return (
                            <div data-testid="pr-widget" data-theme={siteSnap.theme}>
                                <span data-testid="count">Approvals: {snap.approvals}</span>
                                <button
                                    data-testid="approve-btn"
                                    onClick={async () => {
                                        const res = await fetch("https://github.com/api/approve", { method: "POST" }).then((r) => r.json());
                                        const token = await site.readPageGlobal();
                                        appStore.approvals = res.nextCount;
                                        sharedSite.theme = token.endsWith("dark") ? "light" : "dark";
                                    }}
                                >
                                    Approve
                                </button>
                            </div>
                        );
                    }
                    ctx.mount(".pr-toolbar", <ApproveWidget />);
                });

                tweak.replaceResponse({ url: "*://github.com/api/approve", strategy: "page" }, () => ({
                    nextCount: appStore.approvals + 1,
                }));

                tweak.onOverlay("*://github.com/*", (ctx) => {
                    function OverlayPanel() {
                        const snap = useSnapshot(appStore);
                        const tabSnap = useSnapshot(tabState);
                        return (
                            <div data-testid="overlay-panel">
                                Overlay count: {snap.approvals} / open: {String(tabSnap.panelOpen)}
                            </div>
                        );
                    }
                    ctx.mount(<OverlayPanel />);
                });
                `,
            },
            {
                stores: { "pr-helper": { approvals: 2 } },
            }
        );

        (window as any).__pageToken = "tok123";
        (window as any).__ttSiteVersion = () => "orig";
        document.title = "Pull Request #9";

        const page = await t.openPage("https://github.com/org/repo/pull/9", {
            html: `<header class="pr-toolbar"><span class="native">Files changed</span></header>`,
        });

        // Closed shadow root: page DOM cannot reach inside host.shadowRoot, while page.mountFor() can!
        const hostEl = page.mounts[0]?.host;
        expect(hostEl).toBeTruthy();
        expect(hostEl.shadowRoot).toBeNull();

        const mount = page.mountFor(".pr-toolbar")!;
        expect(mount).toBeTruthy();
        expect(mount.querySelector('[data-testid="count"]')!.textContent).toBe("Approvals: 2");
        expect(mount.querySelector('[data-testid="pr-widget"]')!.getAttribute("data-theme")).toBe("dark");
        expect(document.title).toBe("Pull Request #9");
        expect((window as any).__ttSiteVersion()).toBe("orig+v1");
        expect(document.head.querySelectorAll("style")).toHaveLength(1);

        // Overlay rendered and shares live globalStore + tabStore
        expect(page.overlay?.textContent).toContain("Overlay count: 2 / open: false");

        // Keyboard shortcut toggles tabStore and updates the React overlay
        const handled = await page.pressKey("Alt+Shift+P");
        expect(handled).toBe(true);
        expect(page.overlay?.textContent).toContain("Overlay count: 2 / open: true");

        // Clicking Approve inside the shadow root triggers intercepted window.fetch -> background replaceResponse
        // AND cross-world site.call() -> mutates globalStore & siteStore -> updates both page mount and overlay!
        fireEvent.click(mount.querySelector('[data-testid="approve-btn"]')!);
        await page.flush();

        expect(t.store("pr-helper").approvals).toBe(3);
        expect(mount.querySelector('[data-testid="count"]')!.textContent).toBe("Approvals: 3");
        expect(mount.querySelector('[data-testid="pr-widget"]')!.getAttribute("data-theme")).toBe("light");
        expect(page.overlay?.textContent).toContain("Overlay count: 3 / open: true");

        // Dynamic DOM mutation triggers ctx.observe automatically
        const secondToolbar = document.createElement("div");
        secondToolbar.className = "pr-toolbar";
        document.body.appendChild(secondToolbar);
        await page.flush();
        expect(page.mounts).toHaveLength(2);

        // Hot reload re-applies ctx.patch & ctx.style without stacking wrappers or duplicate <style> tags
        await page.reload();
        expect((window as any).__ttSiteVersion()).toBe("orig+v1");
        expect(document.head.querySelectorAll("style")).toHaveLength(1);

        // Closing page unmounts React roots, removes injected styles, and restores patched globals
        await page.close();
        expect((window as any).__ttSiteVersion()).toBe("orig");
        expect(document.head.querySelectorAll("style")).toHaveLength(0);
        expect(page.mounts).toHaveLength(0);

        await t.dispose();
    });

    it("runs `import { tweak } from \"tangitweak\"` in every world, from the script and from a file it imports", async () => {
        const t = await loadTweak({
            name: "main",
            files: {
                "state.ts": `
                import { tweak } from "tangitweak";
                export const page = tweak.pageStore({ hits: 0 });
                export const mark = () => tweak.onPage("*://example.com/*", () => { document.body.dataset.lib = "1"; });
                `,
            },
            code: `
            import { tweak } from "tangitweak";
            import { page, mark } from "./state";
            const app = tweak.globalStore("app", { n: 1 });
            const tab = tweak.tabStore({ visits: 0 });
            const flags = tweak.siteStore({ seen: false });
            const site = tweak.onSite("*://example.com/*", () => {
                flags.seen = true;
                return { token: () => (window as any).__tok };
            });
            mark();
            tweak.onPage("*://example.com/*", async () => {
                page.hits++;
                tab.visits++;
                const out = document.createElement("output");
                out.textContent = [await site.token(), page.hits, tab.visits, app.n].join("/");
                document.body.appendChild(out);
            });
            tweak.replaceResponse({ url: "*://api.example.com/*", strategy: "helper" }, () => ({ n: app.n }));
            `,
        });
        expect(t.errors).toEqual([]);
        expect(await (await t.simulate("https://api.example.com/x")).json()).toEqual({ n: 1 });
        (window as any).__tok = "tok";
        const page = await t.openPage("https://example.com/");
        await page.flush();
        expect(document.querySelector("output")!.textContent).toBe("tok/1/1/1");
        expect(document.body.dataset.lib).toBe("1");
        // an unnamed store: its file + position among the file's tab/page/site stores
        expect(page.siteStore("main#1").seen).toBe(true);
        await page.close();
        await t.dispose();
    });

    it("catches invalid dynamic reads inside strategy: 'rules' handlers", async () => {
        await expect(
            loadTweak({
                name: "bad-rule",
                code: `import { tweak } from "tangitweak"; 
                tweak.onRequest({ url: "*://example.com/*", strategy: "rules" }, (ctx) => {
                    if (ctx.method === "POST") return { block: true };
                });
                `,
            })
        ).rejects.toThrow(/rules/i);
    });
});
