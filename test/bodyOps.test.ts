import { describe, it, expect } from "vitest";
import { replacementBody, resolveFileRef, runOp } from "../src/shared/bodyOps";
import { normalizeRoute, NET_KINDS } from "../src/shared/route";

/** bare fns → routed handlers on "*://x.test/*" (every kind present) */
const routed = (h: Record<string, Function[]>): any =>
    Object.fromEntries([...NET_KINDS, "onDocument"].map((k) => [k, (h[k] ?? []).map((fn, i) => ({ fn, route: normalizeRoute(k as any, k === "onDocument" ? "*://x.test/*" : { url: "*://x.test/*", strategy: "helper" }, i) }))]));

describe("replaceResponse { file }", () => {
    it("decodes base64 data: URLs and uses their media type", () => {
        const ref = "data:text/plain;base64," + btoa("served ok");
        expect(resolveFileRef(ref, "https://x.test/robots.txt")).toEqual({ mime: "text/plain", content: "served ok" });
    });

    it("decodes UTF-8 in base64 data: URLs", () => {
        const bytes = new TextEncoder().encode("héllo");
        const ref = "data:text/html;base64," + btoa(String.fromCharCode(...bytes));
        expect(resolveFileRef(ref, "https://x.test/")).toEqual({ mime: "text/html", content: "héllo" });
    });

    it("decodes percent-encoded data: URLs, defaulting the type", () => {
        expect(resolveFileRef("data:,a%20b", "https://x.test/a.js")).toEqual({ mime: "text/plain", content: "a b" });
    });

    it("passes non-data refs through with the URL's mime", () => {
        expect(resolveFileRef("/tmp/lib.js", "https://x.test/lib.js")).toEqual({ mime: "application/javascript", content: "/tmp/lib.js" });
    });

    it("an onRequest replaceResponse serves the decoded file", async () => {
        const scripts = [{ id: "s", name: "S", handlers: routed({ onRequest: [() => ({ replaceResponse: { body: { file: "data:text/plain;base64," + btoa("from file") } } })] }) }];
        const out = await runOp(scripts as any, "requestDecision", { url: "https://x.test/robots.txt", method: "GET" }, { log: () => {} } as any);
        expect(out).toMatchObject({ kind: "respond", mime: "text/plain", content: "from file", who: { scriptId: "s", kind: "onRequest", index: 0 } });
    });

    it("the Content-Type falls back to the URL's extension, then the resource type, then JSON", () => {
        expect(replacementBody({ body: "x", mime: "text/csv" }, "https://x.test/a.js", "script")).toEqual({ mime: "text/csv", content: "x" });
        expect(replacementBody({ body: "x" }, "https://x.test/a.css", "script")).toEqual({ mime: "text/css", content: "x" });
        expect(replacementBody({ body: "<p>" }, "https://x.test/page", "main_frame")).toEqual({ mime: "text/html", content: "<p>" });
        expect(replacementBody({ body: "a" }, "https://x.test/lib", "script")).toEqual({ mime: "application/javascript", content: "a" });
        expect(replacementBody({ body: { a: 1 } }, "https://x.test/api", "xmlhttprequest")).toEqual({ mime: "application/json", content: '{"a":1}' });
        expect(replacementBody({ body: { file: "plain text" } }, "https://x.test/page", "sub_frame")).toEqual({ mime: "text/html", content: "plain text" });
    });
});

describe("observed vs modified logging", () => {
    const url = "https://x.test/api";
    function run(op: any, handlers: any, args: any = {}) {
        const lines: { level: string; msg: string; kind?: string }[] = [];
        const scripts = [{ id: "s", name: "S", handlers: routed(handlers) }];
        return runOp(scripts as any, op, { url, method: "GET", ...args }, { log: (_id: string, level: string, msg: string, kind?: string) => lines.push({ level, msg, kind }) } as any).then((out) => ({ out, lines }));
    }

    it("handlers that change nothing log one DEBUG 'observed (no change)' line each", async () => {
        const observed = (handler: string) => ({ level: "debug", msg: `[S] ${handler} → observed (no change) ${url}`, kind: "observed" });
        expect((await run("requestDecision", { onRequest: [() => undefined, () => ({})] })).lines).toEqual([observed("onRequest"), observed("onRequest")]);
        expect((await run("responseHeaders", { onResponseHeaders: [() => ({ headers: { set: {} } })] })).lines).toEqual([observed("onResponseHeaders")]);
        const none = await run("transform", { onResponseBody: [() => undefined, () => null] }, { body: "abc" });
        expect(none.out).toBeNull();
        expect(none.lines).toEqual([observed("onResponseBody"), observed("onResponseBody")]);
    });

    it("any body returned is a change, even the one received (bodies aren't compared)", async () => {
        const { out, lines } = await run("transform", { onResponseBody: [(_c: any, b: string) => b] }, { body: "abc" });
        expect(out).toBe("abc");
        expect(lines).toEqual([{ level: "info", msg: `[S] onResponseBody applied (3b → 3b) ${url}`, kind: undefined }]);
    });

    it("changes keep their INFO lines (no observed line)", async () => {
        const { out, lines } = await run("transform", { onResponseBody: [(_c: any, b: string) => b + "!"] }, { body: "abc" });
        expect(out).toBe("abc!");
        expect(lines).toEqual([{ level: "info", msg: `[S] onResponseBody applied (3b → 4b) ${url}`, kind: undefined }]);
        const hdr = await run("requestDecision", { onRequest: [() => ({ headers: { set: { "x-a": "1" } } })] });
        expect(hdr.lines.map((l) => l.level)).toEqual(["info"]);
    });
});

describe("precedence in runOp", () => {
    it("request headers: the later handler wins per header, with a warning", async () => {
        const logs: string[] = [];
        const scripts = [
            { id: "a", name: "A", handlers: routed({ onRequest: [() => ({ headers: { set: { "X-Who": "a" } } })] }) },
            { id: "b", name: "B", handlers: routed({ onRequest: [() => ({ headers: { remove: ["x-who"] } })] }) },
        ];
        const out = await runOp(scripts as any, "requestDecision", { url: "https://x.test/prec", method: "GET" }, { log: (_id: string, level: string, msg: string) => level === "warn" && logs.push(msg) } as any);
        expect(out).toEqual({ kind: "headers", changes: { set: {}, remove: ["x-who"] } });
        expect(logs).toEqual([`[B] onRequest #1 overrides request header "x-who" from [A] onRequest #1 (the later one in the list wins) https://x.test/prec`]);
    });

    it("an onRequest result is one thing: a combination keeps the first (replaceResponse > redirect > block > headers) and warns once", async () => {
        const logs: string[] = [];
        const env = { log: (_id: string, level: string, msg: string) => level === "warn" && logs.push(msg) } as any;
        const scripts = [{ id: "m", name: "M", handlers: routed({ onRequest: [() => ({ redirect: "https://x.test/to", headers: { set: { a: "1" } }, block: false })] }) }];
        const req = { url: "https://x.test/mixed", method: "GET" };
        expect(await runOp(scripts as any, "requestDecision", req, env)).toMatchObject({ kind: "redirect", url: "https://x.test/to" });
        expect(await runOp(scripts as any, "requestDecision", req, env)).toMatchObject({ kind: "redirect" });
        expect(logs).toEqual([
            "[M] onRequest #1 returned `redirect` and `headers` — an onRequest result is one of replaceResponse, redirect, block, allow or headers, so only `redirect` applied (to change the redirected request's headers, add an onRequest handler for the target URL) https://x.test/mixed",
        ]);
        const both = [{ id: "n", name: "N", handlers: routed({ onRequest: [() => ({ block: true, redirect: "https://x.test/to" })] }) }];
        expect(await runOp(both as any, "requestDecision", req, env)).toMatchObject({ kind: "redirect" });
    });

    it("a final decision names the handler that made it", async () => {
        const scripts = [{ id: "a", name: "A", handlers: routed({ onRequest: [() => null, () => ({ block: true })] }) }];
        const out = await runOp(scripts as any, "requestDecision", { url: "https://x.test/y", method: "GET" }, { log: () => {} } as any);
        expect(out).toEqual({ kind: "cancel", who: { scriptId: "a", scriptName: "A", kind: "onRequest", index: 1, layer: "site" } });
    });
});

describe("onRequest handlers stack: every one runs, the last decision wins", () => {
    const url = "https://x.test/stack";
    function run(scripts: any[], args: any = {}) {
        const lines: { id: string; level: string; msg: string }[] = [];
        const env = { log: (id: string, level: string, msg: string) => lines.push({ id, level, msg }) } as any;
        return runOp(scripts.map(([id, h]) => ({ id, name: id, handlers: routed(h) })) as any, "requestDecision", { url, method: "GET", ...args }, env).then((out) => ({ out, lines }));
    }

    it("a later decision replaces an earlier one, with an overruled warning", async () => {
        const { out, lines } = await run([
            ["A", { onRequest: [() => ({ block: true })] }],
            ["B", { onRequest: [() => ({ redirect: "https://x.test/to" })] }],
        ]);
        expect(out).toMatchObject({ kind: "redirect", url: "https://x.test/to", who: { scriptId: "B" } });
        expect(lines.filter((l) => l.level === "warn")).toEqual([
            { id: "A", level: "warn", msg: `[A] onRequest #1 → block was overruled: [B] onRequest #1 → redirect has the last word (same layer, it comes later in the list) ${url}` },
        ]);
    });

    it("returning nothing or only headers keeps the earlier decision", async () => {
        const { out } = await run([
            ["A", { onRequest: [() => ({ block: true })] }],
            ["B", { onRequest: [() => undefined, () => ({ headers: { set: { "x-a": "1" } } })] }],
        ]);
        expect(out).toMatchObject({ kind: "cancel", who: { scriptId: "A" } });
    });

    it("allow undoes an earlier decision; the stacked header edits stay", async () => {
        const { out, lines } = await run([
            ["A", { onRequest: [() => ({ headers: { set: { "x-a": "1" } } }), () => ({ block: true })] }],
            ["B", { onRequest: [() => ({ allow: true })] }],
        ]);
        expect(out).toEqual({ kind: "headers", changes: { set: { "x-a": "1" }, remove: [] } });
        expect(lines.map((l) => l.msg)).toContain(`[B] onRequest → allow ${url}`);
    });

    describe("layers: base, then site, then override, whatever the list order", () => {
        const on = (url: string, fn: Function, layer?: string) => ({ onRequest: [{ fn, route: normalizeRoute("onRequest", { url, strategy: "helper", ...(layer ? { layer } : {}) } as any, 0) }] });
        const decide = async (scripts: any[]) => {
            const lines: string[] = [];
            const handlers = (h: any) => Object.fromEntries([...NET_KINDS, "onDocument"].map((k) => [k, h[k] ?? []]));
            const out = await runOp(scripts.map((s) => ({ ...s, name: s.id, handlers: handlers(s.handlers) })) as any, "requestDecision", { url, method: "GET" }, { log: (_: string, level: string, msg: string) => level === "warn" && lines.push(msg) } as any);
            return { out, lines };
        };
        const block = () => ({ block: true });
        const redirect = () => ({ redirect: "https://x.test/site" });

        it("an any-host api interceptor runs first, so the site tweak has the last word", async () => {
            const { out, lines } = await decide([
                { id: "Site", handlers: on("https://x.test/*", redirect) },
                { id: "Interceptor", handlers: on("*://*/*", block) },
            ]);
            expect(out).toMatchObject({ kind: "redirect", who: { scriptId: "Site", layer: "site" } });
            expect(lines).toEqual([`[Interceptor] onRequest #1 → block was overruled: [Site] onRequest #1 → redirect has the last word (layer "site" runs after "base") ${url}`]);
        });

        it("package.json base keeps a named-host interceptor below the site tweak", async () => {
            const { out } = await decide([
                { id: "Site", handlers: on("https://x.test/*", redirect) },
                { id: "Interceptor", layers: { pkg: "base" }, handlers: on("https://x.test/*", block) },
            ]);
            expect(out).toMatchObject({ kind: "redirect", who: { scriptId: "Site" } });
        });

        it("override runs last; the user setting beats the route option", async () => {
            const scripts = [
                { id: "Over", handlers: on("https://x.test/*", block, "override") },
                { id: "Site", handlers: on("https://x.test/*", redirect) },
            ];
            expect((await decide(scripts)).out).toMatchObject({ kind: "cancel", who: { scriptId: "Over", layer: "override" } });
            scripts[0] = { ...scripts[0], layers: { user: "base" } } as any;
            expect((await decide(scripts)).out).toMatchObject({ kind: "redirect", who: { scriptId: "Site" } });
        });
    });

    it("ctx.requestHeaders shows the earlier handlers' edits", async () => {
        const seen: any[] = [];
        await run(
            [
                ["A", { onRequest: [() => ({ headers: { set: { "X-Token": "t" }, remove: ["cookie"] } })] }],
                ["B", { onRequest: [(ctx: any) => void seen.push(ctx.requestHeaders)] }],
            ],
            { requestHeaders: { cookie: "c", accept: "*/*" } }
        );
        expect(seen).toEqual([{ accept: "*/*", "x-token": "t" }]);
    });

    it("a mock goes through onResponseHeaders and onResponseBody with ctx.replacedBy", async () => {
        const ctxs: any[] = [];
        const { out, lines } = await run([
            ["A", { onRequest: [() => ({ replaceResponse: { body: { n: 1 } } })] }],
            [
                "B",
                {
                    onResponseHeaders: [(ctx: any) => (ctxs.push(ctx), { headers: { set: { "x-mock": "yes" } } })],
                    onResponseBody: [(ctx: any, body: string) => (ctxs.push(ctx), body.replace("1", "2"))],
                },
            ],
        ]);
        expect(out).toMatchObject({ kind: "respond", mime: "application/json", content: '{"n":2}', headers: { "x-mock": "yes" }, replacedBy: { tweak: "A", handler: "onRequest #1" } });
        expect(ctxs.map((c) => c.replacedBy)).toEqual([
            { tweak: "A", handler: "onRequest #1" },
            { tweak: "A", handler: "onRequest #1" },
        ]);
        expect(lines.map((l) => l.msg)).toContain(`[B] onResponseBody #1 ran on a mock from [A] onRequest #1 (ctx.replacedBy is set) ${url}`);
    });

    it("a response handler on a real response has no ctx.replacedBy", async () => {
        let ctx: any;
        await runOp([{ id: "B", name: "B", handlers: routed({ onResponseBody: [(c: any) => void (ctx = c)] }) }] as any, "transform", { url, method: "GET", body: "x" }, { log: () => {} } as any);
        expect(ctx.replacedBy).toBeUndefined();
    });
});
