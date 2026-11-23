import { describe, it, expect, vi, afterEach } from "vitest";
import { SITE_QUEUE, packageUnit, scriptUnit, siteKey, siteUnits, unitsGate } from "../src/shared/siteCode";
import { bundleSiteUnits } from "../src/background/engine/pipeline";
import { EVAL_WRAPPER_LINES } from "../src/shared/scriptError";

/** runs a unit's source with `globalThis` = `g` */
const run = (unit: string, g: any) => new Function("globalThis", unit)(g);

describe("onSite units (Chrome MV3 userScripts in the MAIN world)", () => {
    it("a script unit keeps the user's line 1 at EVAL_WRAPPER_LINES + 1 and runs strict", () => {
        const js = 'exports.x = module.n + 1;\nexports.strict = this === undefined;';
        const u = scriptUnit("hello.ts", js);
        expect(u.split("\n").indexOf("exports.x = module.n + 1;")).toBe(EVAL_WRAPPER_LINES);
        expect(u).toMatch(/\/\/# sourceURL=\S+$/);
        const g: any = {};
        run(u, g);
        const [[key, fn]] = g[Symbol.for(SITE_QUEUE)];
        expect(key).toBe(siteKey("hello.ts", js));
        const exports: any = {};
        fn.call(undefined, console, null, { exports, n: 1 }, exports);
        expect(exports).toEqual({ x: 2, strict: true });
    });

    it("a package unit runs sloppy with the CommonJS parameters", () => {
        const g: any = {};
        run(packageUnit("https://unpkg.com/p@1/index.js", "module.exports = typeof __ttStyle + typeof global;"), g);
        const [[key, fn]] = g[Symbol.for(SITE_QUEUE)];
        expect(key).toBe(siteKey("https://unpkg.com/p@1/index.js", "module.exports = typeof __ttStyle + typeof global;"));
        const module: any = { exports: {} };
        fn(null, module, module.exports, {}, g, () => {});
        expect(module.exports).toBe("functionobject");
    });

    it("keys change with the code, not just the name", () => {
        expect(siteKey("a.ts", "1")).toBe(siteKey("a.ts", "1"));
        expect(siteKey("a.ts", "1")).not.toBe(siteKey("a.ts", "2"));
        expect(siteKey("a.ts", "1")).not.toBe(siteKey("b.ts", "1"));
    });

    it("the hook takes units pushed before and after it starts; the first unit with a key wins", () => {
        const g: any = {};
        run(scriptUnit("a.ts", "exports.v = 'early'"), g);
        const onUnit = vi.fn();
        const units = siteUnits(onUnit, g);
        expect(units.get(siteKey("a.ts", "exports.v = 'early'"))).toBeTypeOf("function");
        expect(onUnit).not.toHaveBeenCalled();
        run(scriptUnit("b.ts", "exports.v = 'late'"), g);
        expect(onUnit).toHaveBeenCalledTimes(1);
        expect(units.get(siteKey("b.ts", "exports.v = 'late'"))).toBeTypeOf("function");
        const first = units.get(siteKey("b.ts", "exports.v = 'late'"));
        g[Symbol.for(SITE_QUEUE)].push([siteKey("b.ts", "exports.v = 'late'"), () => "forged"]);
        expect(units.get(siteKey("b.ts", "exports.v = 'late'"))).toBe(first);
        // the queue can't be replaced
        expect(() => {
            "use strict";
            g[Symbol.for(SITE_QUEUE)] = [];
        }).toThrow();
        expect(units.get("missing")).toBeUndefined();
    });
});

describe("onSite units an open page lacks", () => {
    afterEach(() => vi.useRealTimers());

    /** a hook whose status names the units `want`, of which `have` arrived */
    function hook() {
        const want = new Set<string>();
        const have = new Set<string>();
        const seen: string[] = [];
        const gate = unitsGate({
            missing: () => [...want].filter((k) => !have.has(k)),
            ask: (keys) => seen.push(`ask ${keys.join()}`),
            compile: (hot) => seen.push(`compile${hot ? " hot" : ""} ${[...want].filter((k) => have.has(k)).join()}`),
            timedOut: () => seen.push("timed out"),
            waitMs: 5000,
        });
        return {
            seen,
            status(keys: string[], hot = false) {
                want.clear();
                keys.forEach((k) => want.add(k));
                gate.status(hot);
            },
            arrive(key: string) {
                have.add(key);
                gate.unit();
            },
        };
    }

    it("a status whose units are all here compiles at once, without asking", () => {
        const h = hook();
        h.arrive("a");
        h.status(["a"]);
        expect(h.seen).toEqual(["compile a"]);
    });

    it("asks for the units it lacks and compiles when the last one arrives", () => {
        vi.useFakeTimers();
        const h = hook();
        h.arrive("a");
        h.status(["a", "b", "lib"], true);
        expect(h.seen).toEqual(["ask b,lib"]);
        h.arrive("b");
        expect(h.seen).toHaveLength(1);
        h.arrive("lib");
        expect(h.seen).toEqual(["ask b,lib", "compile hot a,b,lib"]);
        vi.advanceTimersByTime(6000);
        expect(h.seen).toHaveLength(2);
    });

    it("a newer status asks again and keeps a waiting hot update hot", () => {
        vi.useFakeTimers();
        const h = hook();
        h.status(["a"], true);
        h.status(["b"]);
        h.arrive("a");
        expect(h.seen).toEqual(["ask a", "ask b"]);
        h.arrive("b");
        expect(h.seen).toEqual(["ask a", "ask b", "compile hot b"]);
    });

    it("units that never come: compiles what is here after the wait; when they come after all, they run as a hot update", () => {
        vi.useFakeTimers();
        const h = hook();
        h.arrive("a");
        h.status(["a", "b"]);
        vi.advanceTimersByTime(4999);
        expect(h.seen).toEqual(["ask b"]);
        vi.advanceTimersByTime(1);
        expect(h.seen).toEqual(["ask b", "timed out", "compile a"]);
        h.arrive("other");
        expect(h.seen).toHaveLength(3);
        h.arrive("b");
        expect(h.seen).toEqual(["ask b", "timed out", "compile a", "compile hot a,b"]);
        // once only
        h.arrive("c");
        expect(h.seen).toHaveLength(4);
    });

    it("the background answers with the bundle's own units that have the asked keys", () => {
        const bundle = {
            domHandlers: [
                { name: "one/index", src: "1", fk: siteKey("one/index", "1") },
                { name: "two/index", src: "2", fk: siteKey("two/index", "2") },
            ],
            libs: [
                { name: "one/lib", src: "L", fk: siteKey("one/lib", "L") },
                { name: "https://unpkg.com/p@1/index.js", pkg: { js: "P" } as any, fk: siteKey("https://unpkg.com/p@1/index.js", "P") },
                { name: "one/data.json", json: "{}" },
            ],
        };
        const keys = new Set([siteKey("two/index", "2"), siteKey("one/lib", "L"), siteKey("https://unpkg.com/p@1/index.js", "P"), siteKey("one/index", "an older save"), "anything else"]);
        expect(bundleSiteUnits(bundle, keys)).toEqual([scriptUnit("two/index", "2"), scriptUnit("one/lib", "L"), packageUnit("https://unpkg.com/p@1/index.js", "P")]);
        expect(bundleSiteUnits(bundle, new Set())).toEqual([]);
    });
});
