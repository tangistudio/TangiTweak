import { describe, it, expect, vi } from "vitest";
import { GENERATED_NOTE } from "../src/shared/generatedFiles";

const store: Record<string, any> = {};
(globalThis as any).chrome = {
    storage: {
        local: {
            get: (k: any, cb: any) => {
                const keys = k === null ? Object.keys(store) : Array.isArray(k) ? k : [k];
                cb(Object.fromEntries(keys.filter((x: string) => x in store).map((x: string) => [x, structuredClone(store[x])])));
            },
            set: (o: any, cb?: any) => (Object.assign(store, structuredClone(o)), cb?.()),
        },
        onChanged: { addListener: () => {} },
    },
    runtime: { lastError: undefined, sendMessage: () => {}, getURL: (p: string) => `chrome-extension://x/${p}` },
};
let dts = "declare const tt: { v1: true };\n";
const sdk: Record<string, string> = {
    "package.json": JSON.stringify({ name: "tangitweak", version: "0.40.0-alpha", type: "module", types: "./index.d.ts" }, null, 2) + "\n",
    "index.d.ts": 'declare module "tangitweak" {}\n',
    "test.js": "export async function loadTweak() { return {}; }\n",
    "tsconfig.json": "{}\n",
};
(globalThis as any).fetch = async (url: string) => {
    if (url === "chrome-extension://x/lib/tt-api.d.ts") return { ok: true, status: 200, text: async () => dts };
    if (url === "chrome-extension://x/lib/tangitweak-sdk.json") return { ok: true, status: 200, json: async () => sdk };
    if (url === "chrome-extension://x/lib/builtin-types.json") return { ok: true, status: 200, json: async () => ({ "@types/react/index.d.ts": "export {};\n" }) };
    throw new Error(`unexpected fetch: ${url}`);
};
const files = new Map<string, { text: string; t: number }>();
let clock = 1;
function makeDir(prefix = ""): any {
    const segs = prefix ? prefix.slice(0, -1).split("/") : [];
    return {
        kind: "directory",
        name: segs[segs.length - 1] ?? "d",
        async *values() {
            const seenDirs = new Set<string>();
            for (const [full, f] of files) {
                if (!full.startsWith(prefix)) continue;
                const rest = full.slice(prefix.length);
                const slash = rest.indexOf("/");
                if (slash === -1) {
                    yield { kind: "file", name: rest, getFile: async () => ({ lastModified: f.t, size: f.text.length, text: async () => f.text }) };
                } else {
                    const sub = rest.slice(0, slash);
                    if (!seenDirs.has(sub)) {
                        seenDirs.add(sub);
                        yield makeDir(`${prefix}${sub}/`);
                    }
                }
            }
        },
        async getDirectoryHandle(name: string, o?: any) {
            const sub = `${prefix}${name}/`;
            const exists = [...files.keys()].some((k) => k.startsWith(sub));
            if (!exists && !o?.create) throw Object.assign(new Error("nf"), { name: "NotFoundError" });
            return makeDir(sub);
        },
        async getFileHandle(name: string, o?: any) {
            const key = `${prefix}${name}`;
            if (!files.has(key)) {
                if (!o?.create) throw Object.assign(new Error("nf"), { name: "NotFoundError" });
                files.set(key, { text: "", t: clock++ });
            }
            return {
                getFile: async () => ({ lastModified: files.get(key)!.t, size: files.get(key)!.text.length, text: async () => files.get(key)!.text }),
                createWritable: async () => ({ write: async (t: string) => files.set(key, { text: t, t: clock++ }), close: async () => {} }),
            };
        },
        async removeEntry(n: string, o?: any) {
            const key = `${prefix}${n}`;
            files.delete(key);
            if (o?.recursive) {
                for (const k of [...files.keys()]) if (k.startsWith(`${key}/`)) files.delete(k);
            }
        },
    };
}
const dir = makeDir();
vi.mock("../src/shared/folderSync", async (orig) => ({ ...(await orig<any>()), loadSavedHandle: async () => dir, saveHandle: async () => {}, clearSavedHandle: async () => {} }));

describe("folder sync support files", () => {
    it("writes typings, tsconfig, the SDK and schema on start and preserves user package.json fields", async () => {
        files.set("feature.ts", { text: "import { tweak } from 'tangitweak'; tweak.onPage('*://example.com/*', () => {});\n", t: clock++ });
        files.set("feature.test.ts", { text: "import { test } from 'tangitweak/test';\n", t: clock++ });
        // what Folder Sync wrote before 0.40.0-alpha
        files.set(".tangitweak/test/index.mjs", { text: "old\n", t: clock++ });
        files.set(
            "package.json",
            {
                text: JSON.stringify({
                    imports: { "#tangitweak/test": "./.tangitweak/test/index.mjs" },
                    devDependencies: { "@tangitweak/test": "file:.tangitweak/test", tangitweak: "file:.tangitweak/sdk/tangitweak" },
                }),
                t: clock++,
            }
        );
        files.set("ui.spec.tsx", { text: "export {};\n", t: clock++ });
        files.set("__tests__/helper.ts", { text: "export const x = 1;\n", t: clock++ });
        files.set("vitest.config.ts", { text: "export default {};\n", t: clock++ });

        const sync = await import("../src/background/folderSync");
        const { listScripts } = await import("../src/background/engine/scriptStore");
        await sync.startFromStoredHandle({ fresh: true });

        // Test & config files are ignored by Folder Sync (only feature.ts becomes a script)
        const importedScripts = await listScripts();
        expect(importedScripts.map((s) => s.meta.name)).toEqual(["feature"]);

        const d = files.get("tt-api.d.ts")!;
        expect(d.text).toContain(GENERATED_NOTE);
        expect(d.text).toContain("v1: true");
        const ts = files.get("tsconfig.json")!.text;
        expect(ts.startsWith(`// ${GENERATED_NOTE}\n`)).toBe(true);
        const tsParsed = JSON.parse(ts.slice(ts.indexOf("\n") + 1));
        expect(tsParsed.include).toEqual(["**/*.ts", "**/*.tsx"]);
        expect(tsParsed.compilerOptions.paths).toMatchObject({
            "https://unpkg.com/*": ["./.tangitweak/types/unpkg.com/*"],
            react: ["./.tangitweak/types/builtin/@types/react/index.d.ts"],
            "tangitweak/test": ["./.tangitweak/sdk/tangitweak/test.d.ts"],
        });

        // the SDK (the build's files plus its typings of the built-ins), which the root package.json links and tweaks' tsconfig.json extends
        for (const [p, text] of Object.entries(sdk)) expect(files.get(`.tangitweak/sdk/tangitweak/${p}`)?.text).toBe(text);
        expect(files.get(".tangitweak/sdk/tangitweak/types/builtin/@types/react/index.d.ts")?.text).toBe("export {};\n");
        // the old @tangitweak/test harness goes
        expect([...files.keys()].filter((k) => k.startsWith(".tangitweak/test/"))).toEqual([]);

        const pkg = JSON.parse(files.get("package.json")!.text);
        expect(pkg.$comment).toContain(GENERATED_NOTE);
        expect(pkg).toMatchObject({ private: true, type: "module" });
        expect(pkg.imports).toBeUndefined();
        expect(pkg.devDependencies).toEqual({ tangitweak: "file:.tangitweak/sdk/tangitweak" });
        expect(JSON.parse(files.get("settings.schema.json")!.text).$comment).toBe(GENERATED_NOTE);
        const kept = ["tt-api.d.ts", "tsconfig.json", "package.json", "settings.schema.json", ".tangitweak/sdk/tangitweak/test.js"];
        const stamps = kept.map((f) => files.get(f)!.t);

        // unchanged → nothing rewritten on the next start
        sync.halt();
        await sync.startFromStoredHandle({ fresh: true });
        expect(kept.map((f) => files.get(f)!.t)).toEqual(stamps);

        // User adds vitest + test scripts to package.json → preserved on restart while restoring managed defaults
        files.set(
            "package.json",
            {
                text: JSON.stringify({
                    scripts: { test: "vitest run" },
                    devDependencies: { vitest: "^2.1.4", "happy-dom": "^21.0.0" },
                }),
                t: clock++,
            }
        );
        dts = "declare const tt: { v2: true };\n";
        files.set("tsconfig.json", { text: "{}", t: clock++ });
        sync.halt();
        await sync.startFromStoredHandle({ fresh: true });
        expect(files.get("tt-api.d.ts")!.text).toContain("v2: true");
        expect(files.get("tsconfig.json")!.text).toBe(ts);
        const mergedPkg = JSON.parse(files.get("package.json")!.text);
        expect(mergedPkg.$comment).toContain(GENERATED_NOTE);
        expect(mergedPkg.type).toBe("module");
        expect(mergedPkg.scripts).toEqual({ test: "vitest run" });
        expect(mergedPkg.devDependencies).toEqual({
            vitest: "^2.1.4",
            "happy-dom": "^21.0.0",
            tangitweak: "file:.tangitweak/sdk/tangitweak",
        });

        // Temporarily broken JSON in package.json is left untouched rather than clobbered
        files.set("package.json", { text: "{ broken json", t: clock++ });
        sync.halt();
        await sync.startFromStoredHandle({ fresh: true });
        expect(files.get("package.json")!.text).toBe("{ broken json");
        sync.halt();
    });
});
