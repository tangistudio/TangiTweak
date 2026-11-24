/**
 * A tweak bundle's metadata: how TangiTweak reads a tweak's package.json and
 * the version checks built on it.
 *
 * A tweak bundle is a folder whose package.json lists `"tangitweak"` in its
 * `dependencies` or has a `"tangitweak"` block ({@link isTweakPackage}); a
 * package.json with neither isn't a tweak's:
 *
 *     { "name": "github-compact", "version": "1.0.0",
 *       "description": "…", "main": "index.ts",
 *       "tangitweak": { "displayName": "GitHub Compact", "icon": "./icon.svg",
 *                       "connect": ["api.github.com"], "updateURL": "…" },
 *       "dependencies": { "tangitweak": "^0.40.0-alpha", "dayjs": "^1.11.0" } }
 *
 * - The entry is `main`, else `index.ts`, else `index.tsx`; the other files
 *   are its modules.
 * - `name`, `version`, `description`, `author`, `license` and `homepage` are
 *   the standard npm fields.
 * - `connect` names the hosts the tweak's `tweak.fetch` calls reach from
 *   `onPage` code ({@link connectAllows}); the install page shows them and an
 *   update that adds one asks for approval.
 * - `updateURL` is where updates come from instead of where the tweak was
 *   installed from (any source `parseSource` in shared/packageSource.ts
 *   reads).
 * - The minimum TangiTweak version is the lowest version of
 *   `dependencies.tangitweak`, else the block's `minTangiTweakVersion`
 *   ({@link minTangiTweakOf}).
 *
 * {@link parseManifest} validates a package.json into a {@link Manifest} for
 * the background (install, import, updates) and the Editor;
 * {@link MANIFEST_SCHEMA} gives the Editor's completions and checks.
 * `tangitweak/test` exposes the {@link PackageMetadata} of a loaded tweak.
 *
 * @see docs/packages.md for the user-facing description.
 *
 * @module
 */

import { parseSource } from "./packageSource";
import { isLayer, LAYER_ORDER, type Layer } from "./route";

/**
 * A tweak's package.json fields as TangiTweak shows and compares them: what an
 * installed package stores, without the parts only the compiler needs
 * (see {@link Manifest}).
 *
 * String fields are trimmed; an empty one is left out.
 */
export interface PackageMetadata {
    /** The display name: `tangitweak.displayName`, else the npm `name`. */
    name?: string;
    /** The package.json `version`, e.g. `"1.2.0"`; an update to a lower one ({@link compareVersions}) waits for review. */
    version?: string;
    /**
     * Minimum TangiTweak version required, e.g. `"0.35.0"`, as
     * {@link minTangiTweakOf} reads it: the lowest version of
     * `dependencies.tangitweak`, else `tangitweak.minTangiTweakVersion`
     * without a leading `v`.
     */
    minTangiTweakVersion?: string;
    /** One line about what the tweak does: also its tooltip in the popup. */
    description?: string;
    /** `tangitweak.icon`: a relative .svg/.png/… path in the bundle, a `data:` URL, an `https://` URL or inline `<svg>` markup. */
    icon?: string;
    /** The package.json `homepage`: a link shown when installing. */
    homepage?: string;
    /** The package.json `author`: the string or the `name` of an `{ "name": … }` object. */
    author?: string;
    /** The package.json `license`, e.g. `"MIT"`. */
    license?: string;
    /**
     * `tangitweak.updateURL`: where updates come from instead of where the
     * tweak was installed from (a package.json or .zip URL, a GitHub folder,
     * a gist). {@link parseManifest} rejects one `parseSource` can't read.
     */
    updateURL?: string;
    /**
     * `tangitweak.connect`: the hosts the tweak's `tweak.fetch` calls reach
     * from `onPage` code and their subdomains ({@link connectAllows}).
     * Trimmed, lower case and deduplicated; empty when not set.
     */
    connect: string[];
    /**
     * `tangitweak.layer`: the layer of every handler in the tweak whose route
     * doesn't name one (see `handlerLayer` in `shared/route.ts`); unset =
     * inferred from each route's hosts.
     */
    layer?: Layer;
}

/** A bundle's package.json as {@link parseManifest} reads it: the {@link PackageMetadata} plus what compiling and downloading need. */
export interface Manifest extends PackageMetadata {
    /** The npm `name` (whereas {@link PackageMetadata.name} prefers `tangitweak.displayName`). */
    packageName?: string;
    /** The declared `main`, normalized ({@link normalizeMain}) with a `.js` extension turned into `.ts`; unset when package.json has none. */
    main?: string;
    /** The package.json `dependencies` with string values (npm ranges, `npm:` aliases, `file:` or git URLs); other entries are dropped. */
    dependencies: Record<string, string>;
}

/** The name of a bundle's manifest file. */
export const MANIFEST_FILE = "package.json";
/** The pre-0.40 bundle manifest's file name: bundles that have one instead of a {@link MANIFEST_FILE} no longer load and must be rewritten. */
export const LEGACY_MANIFEST_FILE = "metadata.json";

/** Whether a `/`-separated path is a {@link MANIFEST_FILE}, at the root or in any folder. */
export const isManifestPath = (path: string): boolean => path === MANIFEST_FILE || path.endsWith("/" + MANIFEST_FILE);

const VERSION_RE = /^v?\d+(\.\d+){0,2}([-+][0-9A-Za-z.-]+)?$/;

/** Parses a package.json's text; undefined when it isn't valid JSON or isn't an object. */
function parseJsonObject(text: string): Record<string, any> | undefined {
    try {
        const raw = JSON.parse(text);
        return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : undefined;
    } catch {
        return undefined;
    }
}

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Whether a parsed package.json is a tweak's: it lists `"tangitweak"` (as a
 * string range) in its `dependencies` or has a `"tangitweak"` object. Either
 * one is enough.
 */
export function isTweakPackage(raw: unknown): boolean {
    return isObject(raw) && (isObject(raw.tangitweak) || (isObject(raw.dependencies) && typeof raw.dependencies.tangitweak === "string"));
}

/** Whether a package.json's text declares a tweak bundle ({@link isTweakPackage}); false for `undefined`, invalid JSON or a non-object. */
export function isBundlePackageJson(text: string | undefined): boolean {
    return isTweakPackage(text === undefined ? undefined : parseJsonObject(text));
}

/**
 * Turns `main` into a bundle-relative file path: trimmed, without a leading
 * `./` (`"./src/index.ts"` → `"src/index.ts"`).
 *
 * @returns Undefined when `main` isn't a string or is blank.
 */
export function normalizeMain(main: unknown): string | undefined {
    if (typeof main !== "string" || !main.trim()) return undefined;
    return main.trim().replace(/^\.\//, "");
}

/**
 * The lowest version a dependency range allows: its first version number,
 * with any prerelease suffix (`"^0.40.0-alpha"` → `"0.40.0-alpha"`,
 * `">=0.41.2 <1"` → `"0.41.2"`, `"~1.2"` → `"1.2"`).
 *
 * @returns Undefined for an empty range, one without a version number or a
 *   non-registry one (containing `:` or `/`, like `file:../sdk` or a git URL).
 */
export function rangeMinimum(range: string | undefined): string | undefined {
    const r = range?.trim();
    if (!r || /[:/]/.test(r)) return undefined;
    const m = /\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?/.exec(r);
    return m?.[0];
}

/**
 * The minimum TangiTweak version a bundle's package.json asks for:
 * `dependencies.tangitweak`'s lowest ({@link rangeMinimum}), else (no
 * dependency or a `file:` or git one) the block's `minTangiTweakVersion`,
 * trimmed and without a leading `v`.
 *
 * @param pkg The parsed package.json; anything else is read defensively.
 * @returns Undefined when neither gives a version: any version will do.
 */
export function minTangiTweakOf(pkg: any): string | undefined {
    const dep = pkg?.dependencies?.tangitweak;
    const fromDep = typeof dep === "string" ? rangeMinimum(dep) : undefined;
    if (fromDep) return fromDep;
    const own = pkg?.tangitweak?.minTangiTweakVersion;
    return typeof own === "string" && own.trim() ? own.trim().replace(/^v/i, "") : undefined;
}

/**
 * Reads and validates a bundle's package.json. Unknown keys are ignored.
 *
 * Runs wherever a bundle is read: the background (install, import, update
 * checks) and the Editor.
 *
 * @param text The package.json's text.
 * @param where How error messages name the file.
 * @throws An `Error` naming `where` and the problem when the text isn't valid
 *   JSON or an object, isn't a tweak's ({@link isTweakPackage}) or a field
 *   has the wrong shape: a non-string standard field, a `tangitweak` that
 *   isn't an object, a `minTangiTweakVersion` that isn't a version, a
 *   `dependencies` that isn't an object, an `updateURL` `parseSource` can't
 *   read, a `connect` that isn't a list of strings or a `main` that isn't a
 *   `.ts`, `.tsx` or `.js` file inside the bundle's folder.
 *
 * @example
 * parseManifest('{ "name": "x", "dependencies": { "tangitweak": "^0.40.0" } }');
 * // { connect: [], dependencies: { tangitweak: "^0.40.0" }, name: "x", packageName: "x", minTangiTweakVersion: "0.40.0" }
 */
export function parseManifest(text: string, where = MANIFEST_FILE): Manifest {
    let raw: any;
    try {
        raw = JSON.parse(text);
    } catch (e: any) {
        throw new Error(`${where} isn't valid JSON: ${e?.message || e}`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: expected an object`);
    if (raw.tangitweak !== undefined && !isObject(raw.tangitweak)) throw new Error(`${where}: "tangitweak" must be an object`);
    if (!isTweakPackage(raw)) throw new Error(`${where} isn't a tweak's — list "tangitweak" in its "dependencies"`);
    const block = raw.tangitweak ?? {};
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
    if (block.layer !== undefined) {
        if (!isLayer(block.layer)) throw new Error(`${where}: "tangitweak.layer" must be one of ${LAYER_ORDER.map((l) => JSON.stringify(l)).join(", ")}`);
        out.layer = block.layer;
    }
    const main = normalizeMain(raw.main);
    if (raw.main !== undefined && main === undefined) throw new Error(`${where}: "main" must be a file path`);
    if (main !== undefined) {
        if (!/\.(tsx?|js)$/i.test(main) || main.startsWith("/") || main.split("/").includes("..")) throw new Error(`${where}: "main" ("${main}") must be a .ts or .tsx file in the bundle's folder`);
        out.main = main.replace(/\.js$/i, ".ts");
    }
    return out;
}

/**
 * A parsed package.json's `"tangitweak.connect"` hosts: trimmed, lower case
 * and deduplicated, with non-string entries skipped.
 *
 * Unlike {@link parseManifest} it never throws: the background calls it on
 * each `tweak.fetch` from `onPage` code.
 *
 * @returns Empty when there's no `tangitweak` block or `connect` isn't an array.
 */
export function connectOf(pkg: any): string[] {
    const list = isObject(pkg) && isObject(pkg.tangitweak) ? pkg.tangitweak.connect : undefined;
    return Array.isArray(list) ? [...new Set(list.filter((h): h is string => typeof h === "string").map((h) => h.trim().toLowerCase()).filter(Boolean))] : [];
}

/**
 * A parsed package.json's `"tangitweak.layer"`. Never throws, unlike
 * {@link parseManifest}: the background reads it on every reload.
 *
 * @returns Undefined when there's no `tangitweak` block or `layer` isn't a layer name.
 */
export function layerOf(pkg: any): Layer | undefined {
    const l = isObject(pkg) && isObject(pkg.tangitweak) ? pkg.tangitweak.layer : undefined;
    return isLayer(l) ? l : undefined;
}

/**
 * Whether `connect` lets a tweak's `onPage` code reach `url` with
 * `tweak.fetch`: the background checks it before fetching.
 *
 * @param connect Lower-case host names, as {@link connectOf} returns them.
 * @param url The requested URL.
 * @returns True for an `http:` or `https:` URL whose host is a listed one or a
 *   subdomain of one (`mail.google.com` for `google.com`, not
 *   `evilgoogle.com`); false for anything else, invalid URLs included.
 */
export function connectAllows(connect: readonly string[], url: string): boolean {
    let host: string;
    try {
        const u = new URL(url);
        if (u.protocol !== "https:" && u.protocol !== "http:") return false;
        host = u.hostname.toLowerCase();
    } catch {
        return false;
    }
    return connect.some((h) => host === h || host.endsWith("." + h));
}

/**
 * The JSON Schema the Editor's Monaco JSON support applies to every
 * {@link MANIFEST_FILE}: completions, hovers and checks for the
 * `"tangitweak"` block and the standard fields TangiTweak reads.
 *
 * It only guides editing; {@link parseManifest} is what enforces the rules.
 * Its `description`s are what the Editor shows on hover.
 */
export const MANIFEST_SCHEMA = {
    /** A package.json must be an object. */
    type: "object",
    /** The fields TangiTweak reads; other fields are allowed. */
    properties: {
        /** The npm `name` field. */
        name: {
            /** Must be a string. */
            type: "string",
            /** What the Editor shows on hover. */
            description: "The npm package name (the bundle's name when there's no tangitweak.displayName)",
        },
        /** The `version` field. */
        version: {
            /** Must be a string. */
            type: "string",
            /** What the Editor shows on hover. */
            description: 'Dotted version ("1.2.0"); an update to a lower one waits for review',
        },
        /** The `description` field. */
        description: {
            /** Must be a string. */
            type: "string",
            /** What the Editor shows on hover. */
            description: "One line about what the tweak does",
        },
        /** The `main` field: the bundle's entry. */
        main: {
            /** Must be a string. */
            type: "string",
            /** The file extensions allowed: `.ts`, `.tsx` or `.js`. */
            pattern: "\\.(tsx?|js)$",
            /** What the Editor shows on hover. */
            description: "The entry file (default index.ts, then index.tsx); the other files run only when imported",
        },
        /** The `homepage` field. */
        homepage: {
            /** Must be a string. */
            type: "string",
            /** What the Editor shows on hover. */
            description: "A link shown when installing",
        },
        /** The `author` field: a string or an object with a `name`. */
        author: {
            /** The two accepted shapes: `"Jane"` or `{ "name": "Jane" }`. */
            anyOf: [
                {
                    /** The string shape. */
                    type: "string",
                },
                {
                    /** The object shape. */
                    type: "object",
                    /** The object's fields TangiTweak reads. */
                    properties: {
                        /** The author's name: what TangiTweak shows. */
                        name: {
                            /** Must be a string. */
                            type: "string",
                        },
                    },
                },
            ],
        },
        /** The `license` field. */
        license: {
            /** Must be a string. */
            type: "string",
        },
        /** The `"tangitweak"` block: TangiTweak's own fields. */
        tangitweak: {
            /** Must be an object. */
            type: "object",
            /** What the Editor shows on hover. */
            description: "Makes this folder a tweak bundle",
            /** The block's fields. */
            properties: {
                /** `tangitweak.displayName`. */
                displayName: {
                    /** Must be a string. */
                    type: "string",
                    /** What the Editor shows on hover. */
                    description: "The name shown in the Explorer, the popup and when installing",
                },
                /** `tangitweak.icon`. */
                icon: {
                    /** Must be a string. */
                    type: "string",
                    /** What the Editor shows on hover. */
                    description: "Icon shown in the Explorer and popup: a relative .svg/.png/… file path in this folder, a data: or https:// URL, or inline <svg>",
                },
                /** `tangitweak.connect`. */
                connect: {
                    /** Must be an array. */
                    type: "array",
                    /** The list's entries. */
                    items: {
                        /** Each entry must be a string: a host name such as `"api.github.com"`. */
                        type: "string",
                    },
                    /** Whether entries must differ: the Editor flags a repeated host. */
                    uniqueItems: true,
                    /** What the Editor shows on hover. */
                    description: "Hosts the tweak's tweak.fetch calls reach (onPage code can reach only these, and their subdomains); an update that adds one waits for review",
                },
                /** `tangitweak.layer`. */
                layer: {
                    /** One of the layer names. */
                    enum: ["base", "site", "override"],
                    /** What the Editor shows on hover. */
                    description: "Where the tweak's handlers run in the stack: base first, override last, and the last word wins. Unset: base for routes on any host, site for named hosts",
                },
                /** `tangitweak.updateURL`. */
                updateURL: {
                    /** Must be a string. */
                    type: "string",
                    /** What the Editor shows on hover. */
                    description: "Where updates come from instead of where it was installed from: a package.json or .zip URL, a GitHub folder, a gist (an update that changes it waits for review)",
                },
                /** `tangitweak.minTangiTweakVersion`. */
                minTangiTweakVersion: {
                    /** Must be a string. */
                    type: "string",
                    /** The version shape {@link parseManifest} accepts: up to three dotted numbers, an optional leading `v` and an optional `-` or `+` suffix. */
                    pattern: "^v?\\d+(\\.\\d+){0,2}([-+][0-9A-Za-z.-]+)?$",
                    /** What the Editor shows on hover. */
                    description: 'Minimum TangiTweak version, when dependencies.tangitweak isn\'t a plain range (a file: or git dependency)',
                },
            },
        },
        /** The `dependencies` field. */
        dependencies: {
            /** Must be an object (package name → range). */
            type: "object",
            /** The type of each entry. */
            additionalProperties: {
                /** Each entry must be a string: an npm range, an `npm:` alias or a `file:` or git URL. */
                type: "string",
            },
            /** What the Editor shows on hover. */
            description: 'npm packages the tweak imports by name (downloaded from unpkg), "tangitweak": "^<version>" (the minimum TangiTweak version), and Node.js built-ins for packages that need them ("events": "npm:events@^3")',
        },
    },
};

/**
 * Compares dotted versions part by part: `"1.10.0"` is newer than `"1.9"`
 * and `"1.0"` equals `"1.0.0"`.
 *
 * Parts are split at `.`, `-` and `+`; a missing part counts as `"0"` and
 * `undefined` as `""`. Two numeric parts compare as numbers, anything else
 * as text, so a prerelease suffix counts as newer than none
 * (`"1.0.0-beta"` > `"1.0.0"`).
 *
 * @returns `-1` when `a` is older, `1` when it's newer, `0` when they're equal.
 *
 * @example
 * compareVersions("1.10.0", "1.9"); // 1
 * compareVersions(undefined, "0.1"); // -1
 */
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

/**
 * The running TangiTweak version, e.g. `"0.35.0-alpha"`: the extension
 * manifest's `version_name`, else its `version`.
 *
 * @returns `"0.0.0"` where there's no extension runtime (tests, the SDK's
 *   test runner under Node.js).
 */
export function currentTangiTweakVersion(): string {
    try {
        const m = (globalThis as any).chrome?.runtime?.getManifest?.();
        return m?.version_name || m?.version || "0.0.0";
    } catch {
        return "0.0.0";
    }
}

/**
 * The highest version in `versions`, compared by `major.minor.patch` only
 * (suffixes ignored); blank and `undefined` entries are skipped. The Editor
 * uses it to find the newest TangiTweak a tweak's files require.
 *
 * @returns The winning entry trimmed and without a leading `v` (the first of
 *   equal ones) or undefined when there's none.
 */
export function highestVersion(versions: Iterable<string | undefined>): string | undefined {
    let best: string | undefined;
    for (const raw of versions) {
        const v = raw?.trim().replace(/^v/i, "");
        if (!v) continue;
        if (!best || compareVersions(versionCore(v), versionCore(best)) > 0) best = v;
    }
    return best;
}

/**
 * The warning shown when a tweak needs a newer TangiTweak, comparing
 * `major.minor.patch` only (a suffix like `-alpha` is ignored).
 *
 * @param required The tweak's minimum version ({@link minTangiTweakOf}); a leading `v` is allowed.
 * @param current The running version; defaults to {@link currentTangiTweakVersion}.
 * @returns A sentence like `"Requires TangiTweak 0.41.0 or newer (you have
 *   0.40.0)."` or null when `current` is new enough or `required` is unset
 *   or not a version.
 */
export function minTangiTweakProblem(required: string | undefined, current = currentTangiTweakVersion()): string | null {
    const req = required?.trim().replace(/^v/i, "");
    if (!req || !VERSION_RE.test(req)) return null;
    if (compareVersions(versionCore(current), versionCore(req)) < 0) {
        return `Requires TangiTweak ${req} or newer (you have ${current}).`;
    }
    return null;
}
