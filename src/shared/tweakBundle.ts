/**
 * Tweak bundles: a folder whose package.json has a `"tangitweak"` block
 * (see packageMetadata). Its entry (`main`, else `index.ts`, else
 * `index.tsx`) is the tweak — the enable switch, params and stores are
 * the entry's; the other files are its modules and run only when
 * imported, their registrations, params and stores belonging to the
 * entry. A file outside any bundle (a pre-0.40 single-file script, or one
 * of a pre-0.40 metadata.json bundle) doesn't load: it needs a rewrite.
 *
 * Bare imports (`import dayjs from "dayjs"`) resolve through the bundle's
 * package.json `dependencies`, `npm:` aliases included.
 */
import { defaultMeta, finishMeta, type ResMeta } from "./metaParser";
import { currentTangiTweakVersion, isBundlePackageJson, LEGACY_MANIFEST_FILE, MANIFEST_FILE, minTangiTweakOf, minTangiTweakProblem, normalizeMain, parseManifest, type Manifest } from "./packageMetadata";
import { rangeUrl, splitBare } from "./packageImports";

/** the start of a script's error when it doesn't load as it is */
export const NEEDS_REWRITE = "Needs a rewrite:";

/** a read-only view of the data files: path → text (case-insensitive) */
export type DataReader = (path: string) => string | undefined;

export function dataReader(files: Iterable<{ path: string; text: string }>): DataReader {
    const m = new Map<string, string>();
    for (const f of files) if (!m.has(f.path.toLowerCase())) m.set(f.path.toLowerCase(), f.text);
    return (p) => m.get(p.toLowerCase());
}

/** a script's folders, nearest first: "a/b/x" → "a/b/", "a/", "" */
function ancestors(name: string): string[] {
    const parts = name.split("/").slice(0, -1);
    const out: string[] = [];
    for (let i = parts.length; i >= 0; i--) out.push(parts.slice(0, i).map((p) => p + "/").join(""));
    return out;
}

export interface Bundle {
    /** its folder, with a trailing "/" ("" at the root) */
    root: string;
    /** its package.json's path */
    pkgPath: string;
    /** the parsed package.json */
    pkg: any;
}

/** the bundle a file (script name or data path) is in: the nearest folder whose package.json lists "tangitweak" in its dependencies */
export function bundleOf(name: string, read: DataReader): Bundle | undefined {
    for (const dir of ancestors(name)) {
        const text = read(dir + MANIFEST_FILE);
        if (text !== undefined && isBundlePackageJson(text)) return { root: dir, pkgPath: dir + MANIFEST_FILE, pkg: JSON.parse(text) };
    }
    return undefined;
}

/** a file path in the bundle ("src/main.ts") as a script name ("src/main"; .tsx names keep it) */
const scriptNameOf = (path: string): string => (/\.tsx$/i.test(path) ? path : path.replace(/\.(ts|js)$/i, ""));

/** the script name of a bundle's entry: `main`, else index.ts, else index.tsx */
export function entryName(b: Bundle, hasScript: (name: string) => boolean): string {
    const main = normalizeMain(b.pkg?.main);
    if (main) return b.root + scriptNameOf(main);
    return hasScript(b.root + "index") || !hasScript(b.root + "index.tsx") ? b.root + "index" : b.root + "index.tsx";
}

export type BundleRole = { role: "entry" | "module"; bundle: Bundle; entry: string } | { role: "rewrite"; reason: string };

/** what a stored script is: its bundle's entry, one of its modules, or a file that needs a rewrite */
export function bundleRole(name: string, scriptNames: Iterable<string>, read: DataReader): BundleRole {
    const b = bundleOf(name, read);
    if (b) {
        const names = new Set([...scriptNames].map((n) => n.toLowerCase()));
        const entry = entryName(b, (n) => names.has(n.toLowerCase()));
        return { role: entry.toLowerCase() === name.toLowerCase() ? "entry" : "module", bundle: b, entry };
    }
    const plain = ancestors(name).find((dir) => read(dir + MANIFEST_FILE) !== undefined);
    if (plain !== undefined) return { role: "rewrite", reason: `${NEEDS_REWRITE} ${plain}${MANIFEST_FILE} doesn't list "tangitweak" in its "dependencies" — add it to make this folder a tweak` };
    const legacy = ancestors(name).find((dir) => read(dir + LEGACY_MANIFEST_FILE) !== undefined);
    return {
        role: "rewrite",
        reason:
            legacy !== undefined
                ? `${NEEDS_REWRITE} ${legacy}${LEGACY_MANIFEST_FILE} bundles no longer load — replace it with a package.json that lists "tangitweak" in its dependencies, with one entry (its "main", else index.ts) that imports the other files (see New Tweak…)`
                : `${NEEDS_REWRITE} single-file scripts no longer load — make it a tweak: a folder with a package.json that lists "tangitweak" in its dependencies and this code in its index.ts (see New Tweak…)`,
    };
}

/** what the UI shows a stored script as (see bundleRole): an entry is a tweak (its switch, its popup row), named by its bundle */
export interface ScriptRole {
    role: BundleRole["role"];
    /** a module's entry: the tweak it's part of */
    entry?: string;
    /** an entry's bundle's display name (its package.json's, else its folder) and description */
    bundleName?: string;
    bundleDescription?: string;
}

/** each stored script's role, by id */
export function scriptRoles(scripts: readonly { id: string; meta: { name: string } }[], dataFiles: Iterable<{ path: string; text: string }>): Map<string, ScriptRole> {
    const read = dataReader(dataFiles);
    const names = scripts.map((s) => s.meta.name);
    const out = new Map<string, ScriptRole>();
    for (const s of scripts) {
        const r = bundleRole(s.meta.name, names, read);
        if (r.role !== "entry") {
            out.set(s.id, r.role === "module" ? { role: "module", entry: r.entry } : { role: "rewrite" });
            continue;
        }
        let m: Manifest | undefined;
        try {
            m = parseManifest(read(r.bundle.pkgPath)!, r.bundle.pkgPath);
        } catch {
            // an invalid field: named by its folder
        }
        const name = m?.name || r.bundle.root.slice(0, -1);
        out.set(s.id, { role: "entry", ...(name ? { bundleName: name } : {}), ...(m?.description ? { bundleDescription: m.description } : {}) });
    }
    return out;
}

/** why a bundle's entry can't run here (its package.json asks for a newer TangiTweak), or null */
export function versionProblem(pkg: any, current = currentTangiTweakVersion()): string | null {
    const p = minTangiTweakProblem(minTangiTweakOf(pkg), current);
    return p && `${p.replace(/\.$/, "")} — update TangiTweak to run this tweak (its package.json's dependencies.tangitweak asks for it).`;
}

type Compiled = { meta: ResMeta; paramDefs?: any; error: string | null };

/**
 * A stored script's compile result as its bundle role makes it: an entry
 * keeps it (unless its package.json asks for a newer TangiTweak); a module
 * is an inert part of its entry (its errors show through the entry); a
 * file outside a bundle doesn't load.
 */
export function gateCompiled<T extends Compiled>(name: string, c: T, scriptNames: Iterable<string>, read: DataReader, current?: string | null): T {
    const role = bundleRole(name, scriptNames, read);
    const inert = (error: string | null): T => ({ ...c, meta: finishMeta({ ...defaultMeta(c.meta.name), routes: [] }), paramDefs: {}, error });
    if (role.role === "rewrite") return inert(role.reason);
    if (role.role === "module") return inert(null);
    // null: whatever version it asks for (a package being reviewed)
    const v = current === null ? null : versionProblem(role.bundle.pkg, current);
    return v ? inert(v) : c;
}

/**
 * A bare import (`dayjs`, `@s/x/sub`) in a bundle file: the package URL
 * its package.json's dependencies give it (undefined when there's no
 * bundle or no such dependency), and the package.json's path.
 */
export function bareImport(importer: string, spec: string, read: DataReader): { url: string; pkgPath: string } | { error: string; pkgPath: string } | undefined {
    if (/^[./]/.test(spec) || /^[a-z][a-z0-9+.-]*:/i.test(spec)) return undefined;
    const b = bundleOf(importer, read);
    if (!b) return undefined;
    const { name, sub } = splitBare(spec);
    const range = b.pkg?.dependencies?.[name];
    if (typeof range !== "string" || name === "tangitweak") return undefined;
    const url = rangeUrl(name, range, sub);
    return url ? { url, pkgPath: b.pkgPath } : { error: `cannot import "${spec}": ${b.pkgPath} gives it "${range}" — only npm registry ranges (and npm: aliases) can be imported`, pkgPath: b.pkgPath };
}

/** the package URLs a bundle file's bare imports name (for downloading) */
export function bareImportUrls(importer: string, specs: Iterable<string>, read: DataReader): string[] {
    const out: string[] = [];
    for (const s of specs) {
        const r = bareImport(importer, s, read);
        if (r && "url" in r) out.push(r.url);
    }
    return out;
}

/** the dependencies of the bundle a file is in (where a Node.js built-in its packages need comes from) */
export function dependenciesOf(name: string, read: DataReader): Record<string, string> {
    const deps = bundleOf(name, read)?.pkg?.dependencies;
    return Object.fromEntries(Object.entries(deps && typeof deps === "object" ? deps : {}).filter(([, r]) => typeof r === "string")) as Record<string, string>;
}
