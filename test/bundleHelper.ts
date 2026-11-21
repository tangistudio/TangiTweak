/**
 * Seeding tweak bundles for engine tests: a folder whose package.json has a
 * "tangitweak" block, so its index (or `main`) is a tweak and its other
 * files are modules. No dependencies.tangitweak, so no version check.
 */

/** a bundle's package.json text */
export function bundlePkg(name: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ name: name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-"), version: "1.0.0", tangitweak: {}, ...extra }, null, 2);
}

/** `<folder>/package.json` saved in the engine's store (import after the chrome stub is set up) */
export async function seedBundle(folder: string, extra: Record<string, unknown> = {}): Promise<void> {
    const { saveDataFile } = await import("../src/background/engine/scriptStore");
    await saveDataFile({ path: `${folder}/package.json`, text: bundlePkg(folder.split("/").pop()!, extra) });
}

/** the same as data files, for the compile helpers that take them */
export const bundleData = (folder: string, extra: Record<string, unknown> = {}) => [{ path: `${folder}/package.json`, text: bundlePkg(folder.split("/").pop()!, extra) }];

export type FakeFiles = Map<string, { text: string; t: number }>;

/**
 * A fake directory handle over one map keyed by full path ("kit/index.ts"),
 * so folder sync tests can sync bundles in subfolders. Dot folders throw
 * NotFoundError unless `special` hands one out (a backup folder) or `dots`
 * lets them be (tweak data folders).
 */
export function pathDir(files: FakeFiles, o: { tick: () => number; ops?: string[]; special?: (name: string) => any; dots?: boolean }, prefix = "", name = "d", dirs = new Set<string>()): any {
    const notFound = () => Object.assign(new Error("nf"), { name: "NotFoundError" });
    const fileObj = (f: { text: string; t: number }) => ({ lastModified: f.t, size: f.text.length, text: async () => f.text, arrayBuffer: async () => new TextEncoder().encode(f.text).buffer });
    const under = (p: string) => (p.startsWith(prefix) ? p.slice(prefix.length) : undefined);
    return {
        kind: "directory",
        name,
        async *values() {
            const subs = new Set<string>();
            for (const [p, f] of files) {
                const rest = under(p);
                if (rest === undefined) continue;
                if (rest.includes("/")) subs.add(rest.slice(0, rest.indexOf("/")));
                else yield { kind: "file", name: rest, getFile: async () => fileObj(f) };
            }
            for (const d of dirs) if (under(d) !== undefined && !under(d)!.includes("/")) subs.add(under(d)!);
            for (const n of subs) yield pathDir(files, o, prefix + n + "/", n, dirs);
        },
        async getFileHandle(n: string, opts?: any) {
            const p = prefix + n;
            if (!files.has(p)) {
                if (!opts?.create) throw notFound();
                files.set(p, { text: "", t: o.tick() });
            }
            return {
                getFile: async () => fileObj(files.get(p)!),
                createWritable: async () => ({
                    write: async (t: string | ArrayBuffer) => {
                        o.ops?.push(`write ${p}`);
                        files.set(p, { text: typeof t === "string" ? t : new TextDecoder().decode(t), t: o.tick() });
                    },
                    close: async () => {},
                }),
            };
        },
        async getDirectoryHandle(n: string, opts?: any) {
            const p = prefix + n;
            const sp = o.special?.(p);
            if (sp) return sp;
            if (n.startsWith(".") && !o.dots) throw notFound();
            const exists = dirs.has(p) || [...files.keys()].some((k) => k.startsWith(p + "/"));
            if (!exists) {
                if (!opts?.create) throw notFound();
                dirs.add(p);
            }
            return pathDir(files, o, p + "/", n, dirs);
        },
        async removeEntry(n: string, opts?: { recursive?: boolean }) {
            const p = prefix + n;
            if (files.delete(p)) o.ops?.push(`delete ${p}`);
            else if (dirs.delete(p)) o.ops?.push(`delete ${p}`);
            if (opts?.recursive) for (const k of [...files.keys(), ...dirs]) if (k.startsWith(p + "/") && (files.delete(k) || dirs.delete(k))) o.ops?.push(`delete ${k}`);
        },
    };
}
