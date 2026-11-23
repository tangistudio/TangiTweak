/**
 * Package imports: the rules and the runtime loader for the npm packages a
 * tweak imports.
 *
 * A tweak imports an npm package by name (`import dayjs from "dayjs"`) from
 * its package.json `dependencies`. The import goes to the package's unpkg
 * URL ({@link rangeUrl}, used by `shared/tweakBundle.ts`). The background
 * (`background/engine/packageImports.ts`) downloads the package's module
 * graph and its typings at save time and stores them under
 * {@link PACKAGE_MODULES_KEY} and {@link PACKAGE_TYPINGS_KEY}.
 *
 * This module holds the pure parts shared by the background, the sandbox,
 * the page hook and the Editor:
 *
 * - URL validation: {@link parsePackageUrl}, {@link isUrlSpec}.
 * - The rules for a library's own `require`s: {@link classifyNested},
 *   {@link requireTarget} and the Node.js built-in fallbacks.
 * - Where typings live and which declaration files to look for:
 *   {@link TYPINGS_ROOT}, {@link typesCandidates}.
 * - The runtime loader: {@link makePackageLoader}.
 *
 * @see docs/packages.md for the user-facing description.
 *
 * @module
 */

import type { PackageFn } from "./siteCode";
import { scriptScope } from "./scriptScope";

/** The origin every package URL starts with: packages are downloaded from unpkg only. */
export const PACKAGE_ORIGIN = "https://unpkg.com/";
/** Where package typings live: Monaco's `file:///<root>/…` and the synced folder's `<root>/…`. */
export const TYPINGS_ROOT = ".tangitweak/types";
/**
 * The tsconfig `paths` that map package URLs onto the typings mirror.
 *
 * @param target The typings root, without a trailing slash.
 * @returns One entry mapping `<origin>*` ({@link PACKAGE_ORIGIN}) to `<target>/unpkg.com/*`.
 */
export function packagePaths(target: string): Record<string, string[]> {
    return { [`${PACKAGE_ORIGIN}*`]: [`${target}/unpkg.com/*`] };
}

/** A validated package URL, `https://unpkg.com/<name>@<version>[/<sub>]`, in parts. */
export interface PackageUrl {
    /** The npm package name, scoped or not (`dayjs`, `@scope/x`). */
    name: string;
    /** The exact pinned version, e.g. `"1.2.3"` (a prerelease or build suffix is allowed). */
    version: string;
    /** The path inside the package or `""` for the package itself. */
    sub: string;
}

/** A downloaded module: CommonJS code plus where each of its `require` specifiers goes. */
export interface PackageModule {
    /** The module's code as CommonJS, run by {@link makePackageLoader}. */
    js: string;
    /**
     * Maps each specifier the code requires to the module's final URL or to
     * `"!"` followed by why it can't be required.
     *
     * A Node.js built-in the package doesn't depend on also has an entry per
     * tweak dependency range it falls back to ({@link fallbackKey}): the
     * module is shared, so which tweak requires it isn't known here.
     */
    requires: Record<string, string>;
}

/** The downloaded package modules as the compilers and the page hook see them. */
export interface PackageModules {
    /** Maps a requested URL to its final (redirected) URL. */
    aliases: Record<string, string>;
    /** Maps a final URL to its module. */
    modules: Record<string, PackageModule>;
    /** Maps a requested URL a script imports to why its download failed. */
    failed?: Record<string, string>;
}

/**
 * The `chrome.storage.local` key of the downloaded {@link PackageModules}.
 * The background writes it and loads it back on start; the Editor watches it.
 */
export const PACKAGE_MODULES_KEY = "resPackageModules";
/**
 * The `chrome.storage.local` key of the {@link StoredTypings}. The background
 * writes it; the Editor and the synced folder read and watch it.
 */
export const PACKAGE_TYPINGS_KEY = "resPackageTypings";

/** The package typings the background stores under {@link PACKAGE_TYPINGS_KEY}. */
export interface StoredTypings {
    /** Maps a path under the typings root ({@link TYPINGS_ROOT}) to the file's text. */
    files: Record<string, string>;
    /** Maps a package URL a script imports to the paths its typings need. */
    tops: Record<string, string[]>;
    /** The typings resolution that stored them; see {@link TYPINGS_FORMAT}. */
    v?: number;
}

/**
 * The version of the typings resolution. Bump it when typings resolution
 * improves: the background then drops the packages stored as stubs
 * ({@link withoutStubs}) so they get another try.
 */
export const TYPINGS_FORMAT = 2;

/**
 * Removes the packages stored as stubs ({@link typingsStub}) from stored
 * typings, with the files only they used.
 *
 * @param t The stored typings.
 * @returns A copy without them; its `v` is left out.
 */
export function withoutStubs(t: StoredTypings): StoredTypings {
    const stub = (p: string) => t.files[p]?.startsWith(STUB_HEADER);
    const tops = Object.fromEntries(Object.entries(t.tops).filter(([, ps]) => !ps.some(stub)));
    const used = new Set(Object.values(tops).flat());
    return { files: Object.fromEntries(Object.entries(t.files).filter(([p]) => used.has(p))), tops };
}

/**
 * Where a tweak's package URL stands in the background, for the install
 * page: being downloaded, its types being fetched, ready or failed (with why).
 */
export type PackageStatus =
    | {
          /** The package is being downloaded. */
          state: "downloading";
      }
    | {
          /** The package is downloaded; its typings are being fetched. */
          state: "typing";
      }
    | {
          /** The package and its typings are stored. */
          state: "ready";
      }
    | {
          /** The package isn't downloaded and nothing is under way. */
          state: "missing";
      }
    | {
          /** The package's download failed. */
          state: "failed";
          /** Why the download failed. */
          reason: string;
      }
    | {
          /** The package is downloaded but fetching its typings failed. */
          state: "untyped";
          /** Why fetching the typings failed. */
          reason: string;
      };

/** The regex source of one npm name segment (a package name or a scope without its `@`). */
export const NAME = "[a-z0-9~-][a-z0-9._~-]*";

/**
 * Whether a specifier is a URL (any `scheme://`). URL specifiers are package
 * imports, never script paths.
 *
 * Self-contained: the ESLint plugin embeds its source (`shared/generatedFiles.ts`).
 */
export function isUrlSpec(spec: string): boolean {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(spec);
}

/**
 * Says why a URL import in a tweak's own code fails: packages are imported
 * by name.
 *
 * Self-contained: the ESLint plugin embeds its source (`shared/generatedFiles.ts`).
 *
 * @param spec The URL the code imports.
 * @returns The message, starting with `cannot import "<spec>"`.
 */
export const urlImportMessage = (spec: string): string => `cannot import "${spec}": URL imports aren't supported — add the package to "dependencies" in package.json and import it by name`;

/**
 * Parses a package URL or says why it can't be imported.
 *
 * A package URL is `https://unpkg.com/<name>@<version>[/<path>]` with an
 * exact version (no range or tag), no query string or hash and a normalized
 * path.
 *
 * @param spec The URL.
 * @returns The parts or a message starting with `cannot import "<spec>"`.
 * @example
 * parsePackageUrl("https://unpkg.com/dayjs@1.11.10/plugin/utc.js");
 * // → { name: "dayjs", version: "1.11.10", sub: "plugin/utc.js" }
 */
export function parsePackageUrl(spec: string): PackageUrl | string {
    return packageUrlCore(spec, PACKAGE_ORIGIN, NAME);
}

/**
 * Does {@link parsePackageUrl} with its constants passed in, so it doesn't
 * depend on anything else in this module.
 *
 * @param spec The URL.
 * @param origin The package origin, {@link PACKAGE_ORIGIN}.
 * @param namePattern The npm name segment regex source, {@link NAME}.
 * @returns The parts or a message starting with `cannot import "<spec>"`.
 */
export function packageUrlCore(spec: string, origin: string, namePattern: string): PackageUrl | string {
    const fail = (why: string) => `cannot import "${spec}": ${why}`;
    if (!spec.startsWith(origin)) return fail(`only pinned ${origin}<package>@<version> URLs can be imported`);
    if (/[?#]/.test(spec)) return fail("package URLs can't have a query string or hash");
    const m = new RegExp(`^((?:@${namePattern}/)?${namePattern})(?:@([^/]*))?(?:/(.*))?$`, "i").exec(spec.slice(origin.length));
    if (!m) return fail(`not a package URL — expected ${origin}<package>@<version>[/<path>]`);
    const [, name, version, sub = ""] = m;
    if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
        const rest = sub ? `/${sub}` : "";
        return fail(`pin an exact version, e.g. ${origin}${name}@1.2.3${rest} (ranges and tags like "latest" can change under the script)`);
    }
    if (sub && sub.split("/").some((seg) => !seg || seg === "." || seg === "..")) return fail("the path inside the package isn't normalized");
    return { name, version, sub };
}

/**
 * The URL of a package version's root, `https://unpkg.com/<name>@<version>`.
 *
 * @param p The package, e.g. a {@link PackageUrl}.
 */
export function packageRoot(p: {
    /** The npm package name. */
    name: string;
    /** The exact version. */
    version: string;
}): string {
    return `${PACKAGE_ORIGIN}${p.name}@${p.version}`;
}

const BUILTINS = new Set(
    "assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib".split(
        " "
    )
);

/** Whether a specifier names a Node.js built-in module (`fs`, `fs/promises`, `node:path`). */
export function isNodeBuiltin(spec: string): boolean {
    return spec.startsWith("node:") || BUILTINS.has(spec.split("/")[0]);
}

// Each Node.js built-in's browser version on npm (none: it can't work in a browser).
const BROWSER_BUILTINS: Record<string, string> = {
    events: "events",
    buffer: "buffer",
    util: "util",
    process: "process",
    assert: "assert",
    url: "url",
    string_decoder: "string_decoder",
    punycode: "punycode",
    path: "path-browserify",
    crypto: "crypto-browserify",
    stream: "stream-browserify",
    os: "os-browserify",
    http: "stream-http",
    https: "https-browserify",
    zlib: "browserify-zlib",
    querystring: "querystring-es3",
    timers: "timers-browserify",
    tty: "tty-browserify",
    vm: "vm-browserify",
    constants: "constants-browserify",
};

/**
 * Says why a Node.js built-in can't be imported, plus the tweak dependency
 * that would provide its browser version when npm has one.
 *
 * @param spec The built-in's specifier, e.g. `"node:path"`.
 */
export function builtinMessage(spec: string): string {
    const name = splitBare(spec.replace(/^node:/, "")).name;
    const pkg = BROWSER_BUILTINS[name];
    const fix = pkg ? ` — add "${name}": "${pkg === name ? "latest" : `npm:${pkg}`}" to the tweak's package.json "dependencies" to use npm's browser version` : "";
    return `"${spec}" is a Node.js built-in — not available in tweaks${fix}`;
}

/** The name of the tweak dependency a Node.js built-in falls back to (`node:events` → `events`). */
export const builtinName = (spec: string): string => splitBare(spec.replace(/^node:/, "")).name;

/**
 * The {@link PackageModule.requires} key for where a module's require of a
 * Node.js built-in goes, for a tweak whose dependency gives it `range`.
 */
export const fallbackKey = (spec: string, range: string): string => `${spec} ${range}`;

/**
 * Picks the dependencies a tweak's packages may fall back to: those named
 * like a Node.js built-in.
 *
 * @param deps The tweak's package.json `dependencies`.
 * @returns Those dependencies sorted by name or undefined when there are none.
 */
export function builtinFallbacks(deps: Record<string, string> | undefined): Record<string, string> | undefined {
    const out = Object.entries(deps ?? {}).filter(([n]) => isNodeBuiltin(n));
    return out.length ? Object.fromEntries(out.sort(([a], [b]) => (a < b ? -1 : 1))) : undefined;
}

/** Splits a bare specifier into its package name and the path inside it (`@s/x/a/b` → `@s/x`, `a/b`). */
export function splitBare(spec: string): {
    /** The package name, with its scope. */
    name: string;
    /** The path inside the package or `""`. */
    sub: string;
} {
    const parts = spec.split("/");
    const n = spec.startsWith("@") ? 2 : 1;
    return { name: parts.slice(0, n).join("/"), sub: parts.slice(n).join("/") };
}

/**
 * Says where a library module's `require(spec)` goes, before package.json
 * lookups: a URL, a bare package or an error.
 *
 * Relative specifiers resolve against the module's final URL; root-relative
 * ones against {@link PACKAGE_ORIGIN}. URLs elsewhere are errors.
 *
 * @param spec The required specifier.
 * @param from The requiring module's final URL.
 */
export function classifyNested(
    spec: string,
    from: string
):
    | {
          /** The module's URL. */
          url: string;
      }
    | {
          /** The package name; the caller resolves it from the importing package's dependencies. */
          bare: string;
          /** The path inside the package or `""`. */
          sub: string;
      }
    | {
          /** Why it can't be required, starting with `cannot import "<spec>"`. */
          error: string;
      } {
    if (/^\.\.?(\/|$)/.test(spec)) return { url: new URL(spec, from).href };
    if (isUrlSpec(spec) || spec.startsWith("/")) {
        const url = spec.startsWith("/") ? new URL(spec, PACKAGE_ORIGIN).href : spec;
        return url.startsWith(PACKAGE_ORIGIN) ? { url } : { error: `cannot import "${spec}": only ${PACKAGE_ORIGIN} modules can be imported` };
    }
    if (!new RegExp(`^(?:@${NAME}/)?${NAME}(?:/.*)?$`, "i").test(spec)) return { error: `cannot import "${spec}": not a package name` };
    const { name, sub } = splitBare(spec);
    return { bare: name, sub };
}

/**
 * The package a dependency names: an `npm:` alias's target
 * (`"path": "npm:path-browserify@^1"` → `path-browserify`, `^1`), else itself.
 *
 * @param name The dependency's name.
 * @param range Its range in package.json.
 */
export function aliasTarget(
    name: string,
    range: string | undefined
): {
    /** The package to download. */
    name: string;
    /** Its range: `"latest"` for an alias without one, else unchanged. */
    range: string | undefined;
} {
    const m = /^npm:((?:@[^/@\s]+\/)?[^/@\s]+)(?:@(.*))?$/.exec((range ?? "").trim());
    return m ? { name: m[1], range: m[2] || "latest" } : { name, range };
}

/**
 * The URL a dependency range downloads from, `https://unpkg.com/<name>@<range>[/<sub>]`.
 *
 * `npm:<name>@<range>` aliases are followed; an empty range or `*` becomes `latest`.
 *
 * @param name The dependency's name.
 * @param range Its range in package.json.
 * @param sub The path inside the package or `""`.
 * @returns The URL or null for a range not from the registry (git, `file:`, …).
 */
export function rangeUrl(name: string, range: string | undefined, sub: string): string | null {
    ({ name, range } = aliasTarget(name, range));
    const r = (range ?? "").trim() || "latest";
    if (/[:/]/.test(r) || /^[\w.-]+\/[\w.-]+/.test(r)) return null;
    return `${PACKAGE_ORIGIN}${name}@${encodeURIComponent(r === "*" ? "latest" : r)}${sub ? `/${sub}` : ""}`;
}

/**
 * A package.json's range for a dependency, from `dependencies`, then
 * `peerDependencies`, then `optionalDependencies`.
 *
 * @param pkg The parsed package.json.
 * @param dep The dependency's name.
 */
export function dependencyRange(pkg: any, dep: string): string | undefined {
    for (const k of ["dependencies", "peerDependencies", "optionalDependencies"]) {
        const r = pkg?.[k]?.[dep];
        if (typeof r === "string") return r;
    }
    return undefined;
}

/** Whether code (CommonJS or an ES module) uses ES module syntax: an `import` or `export` statement at the start of a line or after another statement. */
export function isEsModule(code: string): boolean {
    return /(?:^|[;})\]]|\*\/)[ \t]*(?:import(?![\w$])[ \t]*(?:[\w$*{]|["'])|export(?![\w$])[ \t]*[\w$*{])/m.test(code);
}

/** The string specifiers CommonJS code `require`s, each once. */
export function requireSpecs(js: string): string[] {
    const out = new Set<string>();
    for (const m of js.matchAll(/(?<![.\w$])require\s*\(\s*(["'])([^"'\n\\]+)\1\s*\)/g)) out.add(m[2]);
    return [...out];
}

/**
 * Lists the references in a declaration file.
 *
 * Comments are skipped. `declare module "x"` declares an ambient module, so
 * only a relative one counts (it augments another file).
 *
 * @param text The declaration file's text.
 */
export function declarationRefs(text: string): {
    /** The module specifiers it imports, requires or augments. */
    specs: string[];
    /** Its `/// <reference path>`s, relative to the file. */
    paths: string[];
    /** Its `/// <reference types>`s. */
    types: string[];
} {
    const specs = new Set<string>();
    const paths = new Set<string>();
    const types = new Set<string>();
    for (const m of text.matchAll(/\/\/\/\s*<reference\s+(path|types)\s*=\s*["']([^"']+)["']/g)) (m[1] === "path" ? paths : types).add(m[2]);
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
    const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bdeclare\s+module\s+)(["'])([^"'\n]+)\1/g;
    for (const m of code.matchAll(re)) {
        // `declare module "x"` declares x (ambient): only a relative one augments another file.
        if (/declare\s+module\s+$/.test(m[0].slice(0, -m[2].length - 2)) && !/^\.\.?\//.test(m[2])) continue;
        specs.add(m[2]);
    }
    return { specs: [...specs], paths: [...paths], types: [...types] };
}

/** The conditions TypeScript's bundler resolution matches for an import. */
const TS_CONDITIONS = new Set(["types", "import", "default"]);

/**
 * The `types` a package.json `exports` entry gives an import: conditions
 * in order, nested ones too, as TypeScript matches them; else the first
 * `types` under any condition (e.g. `require` only).
 */
function exportsTypes(v: any): string | undefined {
    return exportsTypesWith(v, (k) => TS_CONDITIONS.has(k)) ?? exportsTypesWith(v, () => true);
}

function exportsTypesWith(v: any, accept: (condition: string) => boolean): string | undefined {
    if (typeof v === "string") return /\.d\.[mc]?ts$/.test(v) ? v : undefined;
    if (Array.isArray(v)) {
        for (const x of v) {
            const t = exportsTypesWith(x, accept);
            if (t) return t;
        }
        return undefined;
    }
    if (!v || typeof v !== "object") return undefined;
    if (typeof v.types === "string") return v.types;
    for (const [k, x] of Object.entries(v)) {
        if (k === "types" || !accept(k)) continue;
        const t = exportsTypesWith(x, accept);
        if (t) return t;
    }
    return undefined;
}

/** The `exports` entry for subpath `"."` or `"./sub"`: exact keys first, then patterns with one `*`. */
function exportsEntry(exp: any, key: string): any {
    if (exp === undefined || exp === null) return undefined;
    const isMap = typeof exp === "object" && !Array.isArray(exp) && Object.keys(exp).some((k) => k.startsWith("."));
    if (!isMap) return key === "." ? exp : undefined;
    if (key in exp) return exp[key];
    for (const [k, v] of Object.entries(exp)) {
        const star = k.indexOf("*");
        if (star < 0) continue;
        const [pre, post] = [k.slice(0, star), k.slice(star + 1)];
        if (!key.startsWith(pre) || !key.endsWith(post) || key.length < pre.length + post.length) continue;
        const hit = key.slice(pre.length, key.length - post.length);
        return JSON.parse(JSON.stringify(v).split("*").join(hit));
    }
    return undefined;
}

/** The conditions a library's runtime import matches in `exports`: a production browser build, an ES module or CommonJS. */
const RUN_CONDITIONS = new Set(["browser", "production", "import", "module", "require", "default"]);

/**
 * The file its package.json `exports` gives a runtime import of a subpath,
 * with conditions matched in the map's order. Declaration files don't count.
 *
 * @param pkg The parsed package.json.
 * @param sub The path inside the package or `""` for the root.
 * @returns The path inside the package or undefined when `exports` doesn't map it.
 */
export function exportsFile(pkg: any, sub: string): string | undefined {
    const pick = (v: any): string | undefined => {
        if (typeof v === "string") return /\.d\.[mc]?ts$/.test(v) ? undefined : clean(v);
        if (Array.isArray(v)) {
            for (const x of v) {
                const f = pick(x);
                if (f) return f;
            }
            return undefined;
        }
        if (!v || typeof v !== "object") return undefined;
        for (const [k, x] of Object.entries(v)) {
            if (!RUN_CONDITIONS.has(k)) continue;
            const f = pick(x);
            if (f) return f;
        }
        return undefined;
    };
    return pick(exportsEntry(pkg?.exports, sub ? `./${sub}` : "."));
}

function clean(p: string): string {
    return p.replace(/^\.\//, "").replace(/^\//, "");
}

function swapJs(p: string): string[] {
    const m = /\.([mc]?)js$/.exec(p);
    return m ? [p.slice(0, -m[0].length) + `.d.${m[1]}ts`] : [];
}

/**
 * The declaration files to try for a package URL's subpath, in order, per
 * its package.json.
 *
 * @param pkg The parsed package.json.
 * @param sub The path inside the package or `""` for the root.
 * @returns Paths inside the package.
 */
export function typesCandidates(pkg: any, sub: string): string[] {
    const out: string[] = [];
    const add = (p: string | undefined) => {
        if (typeof p === "string" && p && !out.includes(clean(p))) out.push(clean(p));
    };
    if (!sub) {
        add(pkg?.types);
        add(pkg?.typings);
        add(exportsTypes(exportsEntry(pkg?.exports, ".")));
        // Like TypeScript: the declaration beside the file `exports` runs.
        for (const p of swapJs(exportsFile(pkg, "") ?? "")) add(p);
        if (typeof pkg?.main === "string") {
            const main = clean(pkg.main);
            for (const p of /\.d\.[mc]?ts$/.test(main) ? [main] : swapJs(main).length ? swapJs(main) : [`${main}.d.ts`, `${main}/index.d.ts`]) add(p);
        }
        add("index.d.ts");
        return out;
    }
    const bareSub = sub.replace(/\.[mc]?js$/, "");
    add(exportsTypes(exportsEntry(pkg?.exports, `./${sub}`)));
    if (bareSub !== sub) add(exportsTypes(exportsEntry(pkg?.exports, `./${bareSub}`)));
    for (const p of swapJs(exportsFile(pkg, sub) ?? (bareSub !== sub ? exportsFile(pkg, bareSub) : undefined) ?? "")) add(p);
    if (/\.d\.[mc]?ts$/.test(sub)) add(sub);
    for (const p of swapJs(sub)) add(p);
    add(`${sub}.d.ts`);
    add(`${sub}/index.d.ts`);
    add(`${bareSub}.d.mts`);
    add(`${bareSub}.d.cts`);
    return out;
}

/** The declaration files TypeScript would look for at `path`: a file's relative import, joined to its folder. */
export function declarationCandidates(path: string): string[] {
    if (/\.d\.[mc]?ts$/.test(path)) return [path];
    const swapped = swapJs(path);
    if (swapped.length) return swapped;
    if (/\.json$/.test(path)) return [];
    return [`${path}.d.ts`, `${path}/index.d.ts`, `${path}.d.mts`, `${path}.d.cts`];
}

/**
 * The declaration files TypeScript finds by itself for a subpath, with no
 * package.json pointer needed.
 *
 * @param sub The path inside the package.
 * @returns The candidates or an empty list for the package root (`""`).
 */
export function naturalDeclaration(sub: string): string[] {
    if (!sub) return [];
    if (/\.d\.[mc]?ts$/.test(sub)) return [sub];
    const swapped = swapJs(sub);
    if (swapped.length) return swapped;
    return [`${sub}.d.ts`, `${sub}/index.d.ts`];
}

/** The first line of every {@link typingsStub}, which {@link withoutStubs} looks for. */
const STUB_HEADER = "// TangiTweak found no TypeScript declarations for ";

/**
 * The declaration stub for a module without typings: its export is `any`.
 *
 * @param spec The package URL, named in the stub's first comment line.
 */
export function typingsStub(spec: string): string {
    return `${STUB_HEADER}${spec}\ndeclare const mod: any;\nexport = mod;\n`;
}

/** Where a {@link typingsStub} for a subpath goes, as a path inside the package folder. */
export function stubPath(sub: string): string {
    if (!sub) return "index.d.ts";
    if (/\.json$/.test(sub)) return sub.replace(/\.json$/, ".d.json.ts");
    return swapJs(sub)[0] ?? `${sub}.d.ts`;
}

/** The `@types` package name for a package (`@s/x` → `@types/s__x`). */
export function typesPackageName(name: string): string {
    return `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;
}

/** Normalizes a `/`-separated path: drops empty and `.` segments and applies `..` ones, without a leading or trailing `/`. */
export function normalizePath(path: string): string {
    const out: string[] = [];
    for (const seg of path.split("/")) {
        if (!seg || seg === ".") continue;
        if (seg === "..") out.pop();
        else out.push(seg);
    }
    return out.join("/");
}

/**
 * The relative path from a folder to a path, both root-relative.
 *
 * @returns A path starting with `./` or `../`.
 */
export function relativePath(from: string, to: string): string {
    const a = from.split("/").filter(Boolean);
    const b = to.split("/").filter(Boolean);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    const up = a.length - i;
    return (up ? "../".repeat(up) : "./") + b.slice(i).join("/");
}

/**
 * A package import failed: a URL import, a download failure or the library
 * threw while loading.
 *
 * Never stubbed: the importer fails to compile, positioned at its import
 * line, like a data file error.
 */
export class PackageImportError extends Error {
    /** Always true: `shared/compile.ts` never stubs an import that fails with it. */
    fatalImport = true;
}

/**
 * Maps a requested or final URL to the module's final URL.
 *
 * @returns The final URL or undefined when the module wasn't downloaded.
 */
export function finalUrl(pkgs: PackageModules | undefined, url: string): string | undefined {
    if (!pkgs) return undefined;
    return pkgs.aliases[url] ?? (pkgs.modules[url] ? url : undefined);
}

/** The final URLs of the modules package URLs load: themselves and their requires, transitively. */
export function packageClosure(pkgs: PackageModules, urls: Iterable<string>): Set<string> {
    const out = new Set<string>();
    const queue = [...urls].map((u) => finalUrl(pkgs, u)).filter((u): u is string => !!u);
    while (queue.length) {
        const u = queue.pop()!;
        if (out.has(u) || !pkgs.modules[u]) continue;
        out.add(u);
        for (const t of Object.values(pkgs.modules[u].requires)) if (!t.startsWith("!")) queue.push(t);
    }
    return out;
}

/** The package modules shared loaders ran in this realm, by cache and URL. */
const sharedModules = new Map<string, { js: string; exports: any }>();

/** The functions packages export, two levels deep (`Command.Input` too). */
const packageFns = new WeakSet<Function>();

function markPackageExports(v: any, depth = 0): void {
    if (typeof v === "function") packageFns.add(v);
    else if (!v || typeof v !== "object") return;
    if (depth > 1) return;
    let keys: string[];
    try {
        keys = Object.keys(v);
    } catch {
        return;
    }
    for (const k of keys) {
        let x: any;
        try {
            x = v[k];
        } catch {
            continue;
        }
        if (typeof x === "function" || (x && typeof x === "object")) markPackageExports(x, depth + 1);
    }
}

/**
 * Whether a function is exported by a downloaded package. Hot refresh leaves
 * such functions alone: the package may compare `element.type` with them.
 */
export function isPackageExport(fn: Function): boolean {
    return packageFns.has(fn);
}

/**
 * Where a module's `require(spec)` goes for a tweak.
 *
 * @param mod The requiring module.
 * @param spec The required specifier.
 * @param fb The tweak's built-in fallbacks ({@link builtinFallbacks}).
 * @returns A final URL, `"!"` followed by why it can't be required or undefined when the module never requires `spec`.
 */
export function requireTarget(mod: PackageModule, spec: string, fb?: Record<string, string>): string | undefined {
    const to = mod.requires[spec];
    const range = fb && to?.startsWith("!") && isNodeBuiltin(spec) ? fb[builtinName(spec)] : undefined;
    return (range !== undefined && mod.requires[fallbackKey(spec, range)]) || to;
}

const evalPackage = (url: string, js: string, scope = scriptScope()): PackageFn => {
    const params = ["require", "module", "exports", "process", "global", "__ttStyle"];
    const body = `${js}\n//# sourceURL=${url}`;
    // eslint-disable-next-line no-new-func
    if (!scope) return new Function(...params, body) as PackageFn;
    // eslint-disable-next-line no-new-func
    return new Function("__ttScope", `with (__ttScope) return function (${params.join(", ")}) {${body}\n}`)(scope.vars) as PackageFn;
};
const noEval = (url: string): never => {
    throw new Error(`cannot run ${url} here`);
};

const PROCESS = { env: { NODE_ENV: "production" }, browser: true, versions: {}, argv: [], platform: "browser" };

/**
 * Makes a `require` of package URLs over downloaded modules.
 *
 * Each module runs once per loader, as CommonJS like Node.js does
 * (`this` is `module.exports`, sloppy mode, `process.env.NODE_ENV` is
 * `"production"`); cyclic requires get the partial exports.
 *
 * A library's failed nested require throws a plain Error when it runs, so an
 * optional `try { require("x") } catch {}` works. A script's import that
 * can't load throws a {@link PackageImportError}.
 *
 * The loader's second argument, `deps`, is the importing tweak's
 * package.json dependencies: where a Node.js built-in a package requires
 * without depending on it comes from. Modules run once per distinct set of
 * such fallbacks.
 *
 * @param pkgs The downloaded modules; undefined when none are.
 * @param builtin Answers a nested require first, e.g. a package's
 *   `require("react")` gets the built-in React. Returns undefined to let the
 *   module's own require map decide.
 * @param opts How modules load and run.
 * @returns The loader: a package URL (and the tweak's dependencies) to the module's exports.
 */
export function makePackageLoader(
    pkgs: PackageModules | undefined,
    builtin?: (
        spec: string,
        from: string
    ) =>
        | {
              /** What `require(spec)` returns. */
              module: any;
          }
        | undefined,
    opts?: {
        /** Called for a `.css` module with its text and URL; the overlay adds a `<style>`. */
        style?: (css: string, url: string) => void;
        /**
         * Names a cache: a module whose code didn't change since another
         * loader with that cache ran it in this realm is reused. A page
         * runtime's saves then keep the same package components and their
         * state (`shared/hotRefresh.ts`). Loaders whose `builtin` differ use
         * different caches.
         */
        shared?: string;
        /**
         * Turns a module into its function. Defaults to `new Function`; the
         * MV3 hook can't use that, so it gets the functions as user scripts
         * (`shared/siteCode.ts`).
         */
        compile?: (url: string, js: string) => PackageFn;
    }
): (url: string, deps?: Record<string, string>) => any {
    const style = opts?.style ?? (() => {});
    const scope = scriptScope();
    const compile = opts?.compile ?? (__NO_EVAL__ ? noEval : (url: string, js: string) => evalPackage(url, js, scope));
    const shared = opts?.shared && scope ? `${opts.shared} ${scope.key}` : opts?.shared;
    const cache = new Map<string, { exports: any }>();
    const run = (url: string, fb: Record<string, string> | undefined, fbKey: string): any => {
        const key = fbKey + url;
        const hit = cache.get(key);
        if (hit) return hit.exports;
        const mod = pkgs?.modules[url];
        if (!mod) throw new Error(`cannot import "${url}": it wasn't downloaded`);
        const kept = shared ? sharedModules.get(shared + " " + key) : undefined;
        if (kept && kept.js === mod.js) {
            cache.set(key, kept);
            return kept.exports;
        }
        const module = { exports: {} as any };
        cache.set(key, module);
        const require = (spec: string): any => {
            const b = builtin?.(spec, url);
            if (b) return b.module;
            const to = requireTarget(mod, spec, fb);
            if (to === undefined) throw new Error(`cannot find module "${spec}" (required by ${url})`);
            if (to.startsWith("!")) throw new Error(to.slice(1));
            return run(to, fb, fbKey);
        };
        try {
            const fn = compile(url, mod.js);
            fn.call(module.exports, require, module, module.exports, PROCESS, scope?.global ?? globalThis, style);
        } catch (e) {
            cache.delete(key);
            throw e;
        }
        markPackageExports(module.exports);
        if (shared) sharedModules.set(shared + " " + key, { js: mod.js, exports: module.exports });
        return module.exports;
    };
    return (spec, deps) => {
        const p = parsePackageUrl(spec);
        // A dependency's range URL (a bundle's bare import) loads through its download's alias.
        if (typeof p === "string" && !finalUrl(pkgs, spec) && pkgs?.failed?.[spec] === undefined) throw new PackageImportError(p);
        const failed = pkgs?.failed?.[spec];
        if (failed !== undefined) throw new PackageImportError(`cannot import "${spec}": ${failed}`);
        const url = finalUrl(pkgs, spec);
        if (!url) throw new PackageImportError(`cannot import "${spec}": not downloaded yet — save the script to download it`);
        try {
            const fb = builtinFallbacks(deps);
            return run(url, fb, fb ? JSON.stringify(fb) + " " : "");
        } catch (e: any) {
            if (e instanceof PackageImportError) throw e;
            throw new PackageImportError(`cannot import "${spec}": ${e?.message ?? e}`);
        }
    };
}
