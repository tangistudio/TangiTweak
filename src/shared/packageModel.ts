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
import { isDataSpec, resolveIconSrc } from "./scriptImports";
import { scriptFileKey } from "./scriptName";

export const PACKAGES_KEY = "wtPackages"; // the extension's former name (Wiretrick): kept so stored data survives

/** what a package is at one revision: its files' texts */
export interface PackageVersion {
    revision: string;
    /** `[its entry's path]` among `files` (package.json's `main`, else index.ts / index.tsx) — a list: the stored shape */
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
    /** the folder its files went into */
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

/** a package's display name: its package.json's displayName (else name), else its folder */
export function packageName(p: { folder: string; metadata: Pick<PackageMetadata, "name"> }): string {
    return p.metadata.name || p.folder || "package";
}

/** the store id of a package's entry */
export const entryIds = (p: Pick<InstalledPackage, "entries" | "files">): string[] => p.entries.flatMap((e) => (p.files[e] ? [p.files[e].id] : []));

/** the folder name a package wants (its package.json's name), before collision numbering */
export function naturalPackageFolder(bundleName: string | undefined): string {
    return (bundleName ?? "").replace(/[\\/:*?"<>|]+/g, "-").replace(/^[\s.]+|[\s.]+$/g, "") || "package";
}

/**
 * Where a package installs: a folder named after its package.json's
 * `name`, then `dark (2)/`… past what's `taken` — script names, data
 * paths and folders.
 */
export function packageFolder(bundleName: string | undefined, taken: string[]): string {
    const stem = naturalPackageFolder(bundleName);
    const keys = new Set(taken.map((t) => scriptFileKey(t.split("/")[0])));
    if (!keys.has(scriptFileKey(stem))) return stem;
    for (let i = 2; ; i++) if (!keys.has(scriptFileKey(`${stem} (${i})`))) return `${stem} (${i})`;
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
function entryScriptOf<S>(folder: string, manifest: { main?: string }, byKey: Map<string, S>): S | undefined {
    const at = (rel: string) => byKey.get(scriptFileKey(storeItemOf(folder, rel).name));
    return manifest.main ? at(manifest.main) : (at("index.ts") ?? at("index.tsx"));
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
    pkg: { files: Record<string, string>; metadata?: Pick<PackageMetadata, "icon"> },
    extraDataFiles: readonly { path: string; text: string }[] = []
): string | undefined {
    const pkgData = [
        ...Object.entries(pkg.files)
            .filter(([p]) => isDataPath(p))
            .map(([path, text]) => ({ path, text })),
        ...extraDataFiles,
    ];
    if (pkg.metadata?.icon) {
        const resolved = resolveIconSrc(pkg.metadata.icon, "", pkgData);
        if (resolved) return resolved;
    }
    return undefined;
}
