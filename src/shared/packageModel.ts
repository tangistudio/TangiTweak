/**
 * Installed packages: a tweak bundle (a folder whose package.json has a
 * "tangitweak" block), its entry and the files it imports — installed from
 * a URL, a GitHub repository, a gist or a local folder and recorded so it
 * updates, all files together, from where it came from. The files themselves are ordinary
 * scripts and data files; the record maps each package file to the store
 * item it became (by id: params, stores and the enabled state survive an
 * update) and the hash it had, to tell when the user changed it.
 */
import type { Capabilities } from "./packageCaps";
import { MANIFEST_FILE, parseManifest, type PackageMetadata } from "./packageMetadata";
import { ENTRY_FILE_RE } from "./packageSource";
import { folderOf, isDataSpec, resolveIconSrc } from "./scriptImports";
import { scriptFileKey } from "./scriptName";

export const PACKAGES_KEY = "wtPackages"; // the extension's former name (Wiretrick): kept so stored data survives

/** what a package is at one revision: its files' texts */
export interface PackageVersion {
    revision: string;
    /** its entry's path among `files` (package.json's `main`, else index.ts / index.tsx) */
    entries: string[];
    files: Record<string, string>;
    metadata: PackageMetadata;
    caps: Capabilities;
}

export interface InstalledFile {
    kind: "script" | "data";
    id: string;
    /** the script name / data file path it was installed as */
    name: string;
    /** of the text installed */
    hash: string;
}

export interface PendingUpdate extends PackageVersion {
    /** why it didn't apply itself (wider capabilities, files changed here, auto-update off, a lower version) */
    reasons: string[];
    /** what it can do that the installed version can't */
    added: string[];
    at: number;
}

export interface InstalledPackage {
    id: string;
    /** where it was installed from, as given (parseSource reads it); "" = local files. metadata.updateURL overrides it for updates (see updateSource) */
    source: string;
    /** the folder its files went into; "" = the root (a single file) */
    folder: string;
    entries: string[];
    revision: string;
    metadata: PackageMetadata;
    caps: Capabilities;
    files: Record<string, InstalledFile>;
    autoUpdate: boolean;
    installedAt: number;
    updatedAt: number;
    lastChecked?: number;
    lastError?: string;
    pending?: PendingUpdate;
    /** a revision the user skipped ("Skip this version"): checks don't offer it again */
    skipped?: string;
    /** the version before the last update (Roll back) */
    previous?: PackageVersion;
}

/** where a package updates from: its metadata's updateURL, else where it was installed from ("": it doesn't) */
export const updateSource = (p: { source: string; metadata: PackageMetadata }): string => p.metadata.updateURL || p.source;

export const isDataPath = (rel: string): boolean => isDataSpec(rel);

const join = (folder: string, rel: string) => (folder ? `${folder}/${rel}` : rel);

/** the store item a package file becomes: scripts drop `.ts` (`.tsx` stays), data files keep their path */
export function storeItemOf(folder: string, rel: string): { kind: "script" | "data"; name: string } {
    if (isDataPath(rel)) return { kind: "data", name: join(folder, rel) };
    return { kind: "script", name: join(folder, rel).replace(/\.ts$/i, "") };
}

/** an entry's file name without `.tangitweak.ts` */
export const entryStem = (entry: string): string => entry.replace(/^.*\//, "").replace(ENTRY_FILE_RE, "").replace(/\.tsx?$/i, "");

/** a package's display name: its package.json's displayName (else name), else its entry's file name */
export function packageName(p: { entries: string[]; metadata: Pick<PackageMetadata, "name"> }): string {
    return p.metadata.name || entryStem(p.entries[0] ?? "") || "package";
}

/** the store id of a package's entries */
export const entryIds = (p: Pick<InstalledPackage, "entries" | "files">): string[] => p.entries.flatMap((e) => (p.files[e] ? [p.files[e].id] : []));

/** the natural folder name a multi-file package wants (`""` for a single file), before collision numbering */
export function naturalPackageFolder(p: { entries: string[]; files: Record<string, string>; bundleName?: string }): string {
    if (Object.keys(p.files).length === 1) return "";
    return (p.bundleName || entryStem(p.entries[0] ?? "")).replace(/[\\/:*?"<>|]+/g, "-").replace(/^[\s.]+|[\s.]+$/g, "") || "package";
}

/**
 * Where a package installs: a folder named after its package.json's
 * `name` (or the entry), then `dark (2)/`… past what's `taken`
 * — script names, data paths and folders.
 */
export function packageFolder(p: { entries: string[]; files: Record<string, string>; bundleName?: string }, taken: string[]): string {
    const stem = naturalPackageFolder(p);
    if (!stem) return "";
    const keys = new Set(taken.map((t) => scriptFileKey(t.split("/")[0])));
    if (!keys.has(scriptFileKey(stem))) return stem;
    for (let i = 2; ; i++) if (!keys.has(scriptFileKey(`${stem} (${i})`))) return `${stem} (${i})`;
}

/** a root single-file entry's name past the `taken` ones: `x.tangitweak` → `x (2).tangitweak` (still an entry) */
export function uniqueEntryName(name: string, taken: string[]): string {
    const keys = new Set(taken.map(scriptFileKey));
    if (!keys.has(scriptFileKey(name))) return name;
    const m = /^(.*?)(\.tangitweak(?:\.tsx)?)?$/i.exec(name)!;
    for (let i = 2; ; i++) {
        const next = `${m[1]} (${i})${m[2] ?? ""}`;
        if (!keys.has(scriptFileKey(next))) return next;
    }
}

/** the package files whose store item is gone, renamed or edited since it was installed */
export function modifiedFiles(pkg: Pick<InstalledPackage, "files">, current: (f: InstalledFile) => { name: string; hash: string } | undefined): string[] {
    const out: string[] = [];
    for (const [rel, f] of Object.entries(pkg.files)) {
        const cur = current(f);
        if (!cur || cur.name !== f.name || cur.hash !== f.hash) out.push(rel);
    }
    return out.sort();
}

/** a bundle's entry script: its `main`, else index.ts, else index.tsx */
function entryScriptOf<S>(folder: string, manifest: { main?: string; scripts: string[] }, byKey: Map<string, S>): S | undefined {
    const at = (rel: string) => byKey.get(scriptFileKey(storeItemOf(folder, rel).name));
    return at(manifest.scripts[0]) ?? (manifest.main ? undefined : at("index.tsx"));
}

/**
 * For each bundle (`<folder>/package.json`) or installed folder package
 * (`pkg.folder !== ""`) with a single entry script, map that script's id to
 * the bundle's display name (and description fallback) for the popup menu.
 */
export function singleScriptBundles(
    scripts: readonly { id: string; meta: { name: string; active?: boolean } }[],
    dataFiles: readonly { path: string; text: string }[] = [],
    installed: Record<string, InstalledPackage> = {}
): Map<string, { name: string; description?: string }> {
    const out = new Map<string, { name: string; description?: string }>();
    const byKey = new Map(scripts.map((s) => [scriptFileKey(s.meta.name), s]));
    const manifestFolders = new Set<string>();
    for (const d of dataFiles) {
        if (!d.path.toLowerCase().endsWith("/" + MANIFEST_FILE)) continue;
        const folder = d.path.slice(0, -MANIFEST_FILE.length - 1);
        if (!folder) continue;
        manifestFolders.add(folder.toLowerCase());
        let manifest;
        try {
            manifest = parseManifest(d.text);
        } catch {
            continue;
        }
        const s = entryScriptOf(folder, manifest, byKey);
        if (!s) continue;
        out.set(s.id, { name: manifest.name || folder, description: manifest.description });
    }
    for (const pkg of Object.values(installed)) {
        if (!pkg.folder || manifestFolders.has(pkg.folder.toLowerCase()) || pkg.entries.length !== 1) continue;
        const ids = entryIds(pkg);
        if (ids.length === 1 && scripts.some((s) => s.id === ids[0])) {
            out.set(ids[0], { name: packageName(pkg), description: pkg.metadata.description });
        }
    }
    return out;
}

/**
 * Resolved `<img src>` icon URLs for scripts (`scriptIcons`: script id → src)
 * and package/bundle folders (`folderIcons`: folder path → src), from
 * `<folder>/package.json`'s `tangitweak.icon` and installed packages' metadata.
 */
export function resolveWorkspaceIcons(
    scripts: readonly { id: string; meta: { name: string } }[],
    dataFiles: readonly { path: string; text: string }[] = [],
    installed: Record<string, InstalledPackage> = {}
): { scriptIcons: Map<string, string>; folderIcons: Map<string, string> } {
    const scriptIcons = new Map<string, string>();
    const folderIcons = new Map<string, string>();
    const byKey = new Map(scripts.map((s) => [scriptFileKey(s.meta.name), s]));
    for (const d of dataFiles) {
        if (!d.path.toLowerCase().endsWith("/" + MANIFEST_FILE)) continue;
        const folder = d.path.slice(0, -MANIFEST_FILE.length - 1);
        if (!folder) continue;
        let manifest;
        try {
            manifest = parseManifest(d.text);
        } catch {
            continue;
        }
        const entry = entryScriptOf(folder, manifest, byKey);
        const entryScripts = entry ? [entry] : [];
        const bundleIcon = resolveIconSrc(manifest.icon, folder, dataFiles);
        if (bundleIcon) {
            folderIcons.set(folder, bundleIcon);
            for (const s of entryScripts) if (!scriptIcons.has(s.id)) scriptIcons.set(s.id, bundleIcon);
        }
    }

    for (const pkg of Object.values(installed)) {
        const ids = entryIds(pkg);
        const pkgIcon = resolveIconSrc(pkg.metadata.icon, pkg.folder, dataFiles);
        if (!pkgIcon) continue;
        if (pkg.folder && !folderIcons.has(pkg.folder)) folderIcons.set(pkg.folder, pkgIcon);
        for (const id of ids) if (!scriptIcons.has(id)) scriptIcons.set(id, pkgIcon);
    }

    return { scriptIcons, folderIcons };
}

/**
 * Resolve a package version's `<img src>` icon URL from its `metadata.icon`
 * against the package's own `files` (plus optional fallback `extraDataFiles`).
 */
export function resolvePackageIcon(
    pkg: { entries: string[]; files: Record<string, string>; metadata?: Pick<PackageMetadata, "icon"> },
    extraDataFiles: readonly { path: string; text: string }[] = []
): string | undefined {
    const pkgData = [
        ...Object.entries(pkg.files)
            .filter(([p]) => isDataPath(p))
            .map(([path, text]) => ({ path, text })),
        ...extraDataFiles,
    ];
    if (pkg.metadata?.icon) {
        const base = pkg.files[MANIFEST_FILE] !== undefined ? "" : folderOf(pkg.entries[0] ?? "");
        const resolved = resolveIconSrc(pkg.metadata.icon, base, pkgData);
        if (resolved) return resolved;
    }
    return undefined;
}
