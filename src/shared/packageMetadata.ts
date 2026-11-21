/**
 * A tweak bundle's metadata: a folder whose package.json has a
 * `"tangitweak"` block (a package.json without one isn't a bundle):
 *
 *     { "name": "github-compact", "version": "1.0.0",
 *       "description": "…", "main": "index.ts",
 *       "tangitweak": { "displayName": "GitHub Compact", "icon": "./icon.svg",
 *                       "connect": ["api.github.com"], "updateURL": "…" },
 *       "dependencies": { "tangitweak": "^0.40.0-alpha", "dayjs": "^1.11.0" } }
 *
 * The entry is `main`, else `index.ts`, else `index.tsx`; the other files
 * are its modules. `name`, `version`, `description`, `author`, `license`
 * and `homepage` are the standard fields. `connect` names the hosts the
 * tweak's tweak.fetch calls reach; the install page shows them and an
 * update that adds one asks for approval. `updateURL` is where updates
 * come from instead of where it was installed from (any source parseSource
 * reads). The minimum TangiTweak version is the lowest version of
 * `dependencies.tangitweak` (or the block's `minTangiTweakVersion`).
 */
import { parseSource } from "./packageSource";

export interface PackageMetadata {
    /** the display name (`tangitweak.displayName`, else the npm `name`) */
    name?: string;
    version?: string;
    /** minimum TangiTweak version required ("0.35.0") */
    minTangiTweakVersion?: string;
    description?: string;
    /** relative .svg/.png/… path, data: URL, https:// URL, or inline <svg> */
    icon?: string;
    homepage?: string;
    author?: string;
    license?: string;
    /** where updates come from (a package.json or .zip URL, a GitHub folder, a gist) */
    updateURL?: string;
    connect: string[];
}

/** a bundle's package.json */
export interface Manifest extends PackageMetadata {
    /** the npm `name` */
    packageName?: string;
    /** the declared `main` (normalized), if any */
    main?: string;
    /** `dependencies` (npm ranges, `npm:` aliases) */
    dependencies: Record<string, string>;
}

export const MANIFEST_FILE = "package.json";
/** the pre-0.40 bundle manifest: such bundles no longer load */
export const LEGACY_MANIFEST_FILE = "metadata.json";

/** a bundle's package.json path (at any folder depth) */
export const isManifestPath = (path: string): boolean => path === MANIFEST_FILE || path.endsWith("/" + MANIFEST_FILE);

const VERSION_RE = /^v?\d+(\.\d+){0,2}([-+][0-9A-Za-z.-]+)?$/;

/** a package.json's text, parsed; undefined when it isn't valid JSON or isn't an object */
function parseJsonObject(text: string): Record<string, any> | undefined {
    try {
        const raw = JSON.parse(text);
        return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : undefined;
    } catch {
        return undefined;
    }
}

/** does this package.json text declare a tweak bundle (has a `"tangitweak"` object)? */
export function isBundlePackageJson(text: string | undefined): boolean {
    const raw = text === undefined ? undefined : parseJsonObject(text);
    return !!raw && !!raw.tangitweak && typeof raw.tangitweak === "object" && !Array.isArray(raw.tangitweak);
}

/** `main` as a bundle-relative file path ("./src/index.ts" → "src/index.ts"); undefined when unset */
export function normalizeMain(main: unknown): string | undefined {
    if (typeof main !== "string" || !main.trim()) return undefined;
    return main.trim().replace(/^\.\//, "");
}

/** the lowest version a dependency range allows ("^0.40.0-alpha" → "0.40.0-alpha"); undefined for non-registry ranges */
export function rangeMinimum(range: string | undefined): string | undefined {
    const r = range?.trim();
    if (!r || /[:/]/.test(r)) return undefined;
    const m = /\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?/.exec(r);
    return m?.[0];
}

/** the minimum TangiTweak version a bundle's package.json asks for: `dependencies.tangitweak`'s lowest, else (a `file:` or git dependency) the block's `minTangiTweakVersion` */
export function minTangiTweakOf(pkg: any): string | undefined {
    const dep = pkg?.dependencies?.tangitweak;
    const fromDep = typeof dep === "string" ? rangeMinimum(dep) : undefined;
    if (fromDep) return fromDep;
    const own = pkg?.tangitweak?.minTangiTweakVersion;
    return typeof own === "string" && own.trim() ? own.trim().replace(/^v/i, "") : undefined;
}

/** a bundle's package.json, or why it isn't one (unknown keys are ignored) */
export function parseManifest(text: string, where = MANIFEST_FILE): Manifest {
    let raw: any;
    try {
        raw = JSON.parse(text);
    } catch (e: any) {
        throw new Error(`${where} isn't valid JSON: ${e?.message || e}`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: expected an object`);
    const block = raw.tangitweak;
    if (!block || typeof block !== "object" || Array.isArray(block)) throw new Error(`${where} has no "tangitweak" block — a tweak bundle's package.json needs one`);
    const str = (obj: any, k: string, label = k): string | undefined => {
        const v = obj[k];
        if (v === undefined) return undefined;
        if (typeof v !== "string") throw new Error(`${where}: "${label}" must be a string`);
        return v.trim() || undefined;
    };
    const author = typeof raw.author === "object" && raw.author && typeof raw.author.name === "string" ? raw.author.name.trim() || undefined : str(raw, "author");
    const out: Manifest = { connect: [], dependencies: {} };
    const set = <K extends keyof Manifest>(k: K, v: Manifest[K] | undefined) => {
        if (v !== undefined) out[k] = v;
    };
    set("name", str(block, "displayName", "tangitweak.displayName") ?? str(raw, "name"));
    set("packageName", str(raw, "name"));
    set("version", str(raw, "version"));
    set("description", str(raw, "description"));
    set("author", author);
    set("license", str(raw, "license"));
    set("homepage", str(raw, "homepage"));
    set("icon", str(block, "icon", "tangitweak.icon"));
    set("updateURL", str(block, "updateURL", "tangitweak.updateURL"));
    const min = str(block, "minTangiTweakVersion", "tangitweak.minTangiTweakVersion");
    if (min !== undefined && !VERSION_RE.test(min)) throw new Error(`${where}: "tangitweak.minTangiTweakVersion" must be a version like "0.40.0"`);
    if (raw.dependencies !== undefined) {
        if (!raw.dependencies || typeof raw.dependencies !== "object" || Array.isArray(raw.dependencies)) throw new Error(`${where}: "dependencies" must be an object`);
        for (const [k, v] of Object.entries(raw.dependencies)) if (typeof v === "string") out.dependencies[k] = v;
    }
    set("minTangiTweakVersion", minTangiTweakOf({ tangitweak: { minTangiTweakVersion: min }, dependencies: out.dependencies }));
    if (out.updateURL) {
        const src = parseSource(out.updateURL);
        if (typeof src === "string") throw new Error(`${where}: "tangitweak.updateURL" — ${src}`);
    }
    if (block.connect !== undefined) {
        if (!Array.isArray(block.connect) || block.connect.some((h: unknown) => typeof h !== "string")) throw new Error(`${where}: "tangitweak.connect" must be a list of host names`);
        out.connect = [...new Set((block.connect as string[]).map((h) => h.trim().toLowerCase()).filter(Boolean))];
    }
    const main = normalizeMain(raw.main);
    if (raw.main !== undefined && main === undefined) throw new Error(`${where}: "main" must be a file path`);
    if (main !== undefined) {
        if (!/\.(tsx?|js)$/i.test(main) || main.startsWith("/") || main.split("/").includes("..")) throw new Error(`${where}: "main" ("${main}") must be a .ts or .tsx file in the bundle's folder`);
        out.main = main.replace(/\.js$/i, ".ts");
    }
    return out;
}

/** package.json's JSON schema for the `"tangitweak"` block and the fields TangiTweak reads: the Editor's completions and checks */
export const MANIFEST_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "The npm package name (the bundle's name when there's no tangitweak.displayName)" },
        version: { type: "string", description: 'Dotted version ("1.2.0"); an update to a lower one waits for review' },
        description: { type: "string", description: "One line about what the tweak does" },
        main: { type: "string", pattern: "\\.(tsx?|js)$", description: "The entry file (default index.ts, then index.tsx); the other files run only when imported" },
        homepage: { type: "string", description: "A link shown when installing" },
        author: { anyOf: [{ type: "string" }, { type: "object", properties: { name: { type: "string" } } }] },
        license: { type: "string" },
        tangitweak: {
            type: "object",
            description: "Makes this folder a tweak bundle",
            properties: {
                displayName: { type: "string", description: "The name shown in the Explorer, the popup and when installing" },
                icon: { type: "string", description: "Icon shown in the Explorer and popup: a relative .svg/.png/… file path in this folder, a data: or https:// URL, or inline <svg>" },
                connect: { type: "array", items: { type: "string" }, uniqueItems: true, description: "Hosts the tweak's tweak.fetch calls reach; an update that adds one waits for review" },
                updateURL: {
                    type: "string",
                    description: "Where updates come from instead of where it was installed from: a package.json or .zip URL, a GitHub folder, a gist (an update that changes it waits for review)",
                },
                minTangiTweakVersion: {
                    type: "string",
                    pattern: "^v?\\d+(\\.\\d+){0,2}([-+][0-9A-Za-z.-]+)?$",
                    description: 'Minimum TangiTweak version, when dependencies.tangitweak isn\'t a plain range (a file: or git dependency)',
                },
            },
        },
        dependencies: {
            type: "object",
            additionalProperties: { type: "string" },
            description: 'npm packages the tweak imports by name (downloaded from unpkg), "tangitweak": "^<version>" (the minimum TangiTweak version), and Node.js built-ins for packages that need them ("events": "npm:events@^3")',
        },
    },
};

/** compare dotted versions ("1.10.0" > "1.9"); non-numeric parts compare as text */
export function compareVersions(a: string | undefined, b: string | undefined): number {
    const pa = (a || "").split(/[.+-]/);
    const pb = (b || "").split(/[.+-]/);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] ?? "0";
        const y = pb[i] ?? "0";
        const nx = /^\d+$/.test(x) ? Number(x) : NaN;
        const ny = /^\d+$/.test(y) ? Number(y) : NaN;
        const c = !isNaN(nx) && !isNaN(ny) ? nx - ny : x < y ? -1 : x > y ? 1 : 0;
        if (c) return c < 0 ? -1 : 1;
    }
    return 0;
}

const versionCore = (v: string): string => v.trim().replace(/^v/i, "").split(/[-+]/)[0];

/** the running TangiTweak version (e.g. "0.35.0-alpha") */
export function currentTangiTweakVersion(): string {
    try {
        const m = (globalThis as any).chrome?.runtime?.getManifest?.();
        return m?.version_name || m?.version || "0.0.0";
    } catch {
        return "0.0.0";
    }
}

/** the highest required version in `versions`, or undefined */
export function highestVersion(versions: Iterable<string | undefined>): string | undefined {
    let best: string | undefined;
    for (const raw of versions) {
        const v = raw?.trim().replace(/^v/i, "");
        if (!v) continue;
        if (!best || compareVersions(versionCore(v), versionCore(best)) > 0) best = v;
    }
    return best;
}

/** warning message when `required` is newer than `current` (null when satisfied or unset) */
export function minTangiTweakProblem(required: string | undefined, current = currentTangiTweakVersion()): string | null {
    const req = required?.trim().replace(/^v/i, "");
    if (!req || !VERSION_RE.test(req)) return null;
    if (compareVersions(versionCore(current), versionCore(req)) < 0) {
        return `Requires TangiTweak ${req} or newer (you have ${current}).`;
    }
    return null;
}
