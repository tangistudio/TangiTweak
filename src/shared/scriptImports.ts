/**
 * Import resolution for scripts, shared by the compilers (`compile.ts`), the
 * page side (hook, bridge and overlay, through {@link makeLibRequire}),
 * dependency tracking (`scriptStore.ts`) and the Editor (TypeScript markers,
 * the import/export checklist).
 *
 * Specifiers resolve like TypeScript ({@link importPath},
 * {@link importResolver}):
 *
 * - A relative specifier (`./x`, `../lib/x`) resolves from the importing
 *   script's folder; a bare one (`utils`) from the root.
 * - A specifier ending in a data file extension ({@link isDataSpec}: `.json`,
 *   `.md`, `.svg` or a raster image) names a data file by its path,
 *   case-insensitively. Importing one gives {@link dataFileValue}.
 * - Anything else names a script: the path with an optional `.ts` or `.js`,
 *   matched case-insensitively against script names (which are paths), else
 *   (as TypeScript does) the `.tsx` script of that path (`./Panel` and
 *   `./Panel.tsx` find "Panel.tsx").
 * - A URL is never a script path and a tweak can't import one: it imports
 *   npm packages by name (its package.json `dependencies`, see
 *   `tweakBundle.ts`). Only the built-ins' esm.sh URLs are accepted.
 *
 * The specifiers are found with a regular expression (`from "…"`,
 * `import "…"`, `import("…")`, `require("…")`), not a parser, so ones in
 * comments and strings count too.
 *
 * The module also holds the data file helpers (image `data:` URLs, SVG
 * markup, icons) the import rules depend on.
 *
 * @module
 */

import { builtinSpec, jsxImportSource, usesJsx } from "./builtinSpecs";
import { scriptFrame } from "./scriptError";
import { isUrlSpec, makePackageLoader, urlImportMessage, type PackageModule, type PackageModules } from "./packageImports";
import type { PackageFn } from "./siteCode";
import { bareImport, dataReader, dependenciesOf } from "./tweakBundle";

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']/g;

function specKey(spec: string): string {
    return spec.replace(/^\.\//, "").replace(/\.(ts|js)$/, "").toLowerCase();
}

/**
 * The import specifiers in `code`, normalized for comparison: lowercased,
 * without a leading `./` or a `.ts`/`.js` extension.
 */
export function importKeys(code: string): Set<string> {
    const out = new Set<string>();
    for (const m of code.matchAll(IMPORT_RE)) out.add(specKey(m[1]));
    return out;
}

/**
 * The import specifiers in `code`, as written, plus the JSX runtime
 * (`<source>/jsx-runtime`) that a file with JSX imports once compiled.
 */
export function importSpecs(code: string): Set<string> {
    const out = new Set<string>();
    for (const m of code.matchAll(IMPORT_RE)) out.add(m[1]);
    if (usesJsx(code)) out.add(`${jsxImportSource(code)}/jsx-runtime`);
    return out;
}

/** A URL import in a script's code (unsupported), as the Editor marks it. */
export interface BadPackageImport {
    /** Offset of the specifier's first character in the code (inside the quotes), in UTF-16 code units. */
    offset: number;
    /** The specifier's length, in UTF-16 code units. */
    length: number;
    /** The specifier, as written. */
    spec: string;
    /** Why it can't be imported and what to do instead. */
    message: string;
}

/** The URL imports in `code`, for the Editor's markers; the built-ins' esm.sh URLs are allowed and not listed. */
export function badPackageImports(code: string): BadPackageImport[] {
    const out: BadPackageImport[] = [];
    for (const m of code.matchAll(IMPORT_RE)) {
        const spec = m[1];
        if (!isUrlSpec(spec) || builtinSpec(spec)) continue;
        out.push({ offset: m.index! + m[0].length - 1 - spec.length, length: spec.length, spec, message: urlImportMessage(spec) });
    }
    return out;
}

/**
 * Whether a TypeScript "Cannot find module" error is about an unsupported
 * URL import, whose own marker ({@link badPackageImports}) explains it
 * better: the Editor then hides the TypeScript one.
 */
export function coveredMissingModule(message: string): boolean {
    const spec = /^Cannot find module '([^']+)'/.exec(message)?.[1];
    return !!spec && isUrlSpec(spec) && !builtinSpec(spec);
}

/**
 * Returns `code` with each import specifier replaced by what `to` returns
 * for it; a specifier for which `to` returns undefined is kept.
 */
export function rewriteImports(code: string, to: (spec: string) => string | undefined): string {
    return code.replace(IMPORT_RE, (m, spec: string) => {
        const next = to(spec);
        return next === undefined ? m : m.slice(0, m.length - spec.length - 1) + next + m.slice(-1);
    });
}

/** The 1-based line of the first import of exactly `spec` in `code` (undefined when it has none). */
export function importLine(code: string, spec: string): number | undefined {
    for (const m of code.matchAll(IMPORT_RE)) if (m[1] === spec) return code.slice(0, m.index).split("\n").length;
    return undefined;
}

/** The raster image data file extensions (lowercase) and their MIME types. */
const IMAGE_MIMES: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    ico: "image/x-icon",
    avif: "image/avif",
};

/** Whether the path names a raster image data file (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.ico` or `.avif`, any case). */
export function isImageDataPath(path: string): boolean {
    const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
    return !!ext && Object.prototype.hasOwnProperty.call(IMAGE_MIMES, ext);
}

/**
 * Encodes an image file's bytes as a `data:<mime>;base64,…` URL, the form
 * image data files are stored in.
 *
 * The MIME type comes from the path's extension: `image/png` when it has
 * none, `application/octet-stream` when it isn't an image one.
 */
export function bytesToImageDataUrl(path: string, bytes: Uint8Array): string {
    const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "png";
    const mime = IMAGE_MIMES[ext] ?? "application/octet-stream";
    let bin = "";
    for (let i = 0; i < bytes.length; i += 8192) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return `data:${mime};base64,${btoa(bin)}`;
}

/**
 * Decodes a stored image data file (a `data:…;base64,…` URL) back into its
 * bytes, for folder sync and zip export. Text that isn't a base64 `data:`
 * URL is returned as its UTF-8 bytes.
 */
export function imageDataUrlToBytes(text: string): Uint8Array {
    const m = /^data:[^,]*;base64,([\s\S]*)$/.exec(text);
    if (!m) return new TextEncoder().encode(text);
    const bin = atob(m[1].replace(/\s+/g, ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** Encodes SVG markup (trimmed) as a percent-encoded `data:image/svg+xml` URL, usable as an `<img src>`. */
export function svgToDataUrl(svg: string): string {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.trim())}`;
}

/** Whether the specifier (or path) names a data file: `.json`, `.md`, `.svg` or a raster image ({@link isImageDataPath}), any case. */
export function isDataSpec(spec: string): boolean {
    return /\.(json|svg|md|png|jpe?g|gif|webp|ico|avif)$/i.test(spec);
}

/** Whether the path names an `.svg` data file; importing one gives its markup, a string. */
export function isSvgPath(path: string): boolean {
    return /\.svg$/i.test(path);
}

/** Whether the path names a `.md` data file, shown and edited as Markdown; importing one gives its text, a string. */
export function isMarkdownPath(path: string): boolean {
    return /\.md$/i.test(path);
}

/**
 * What importing a data file gives: an `.svg`'s markup, a `.md`'s text, a
 * raster image's `data:` URL (its stored text) or a `.json`'s parsed value.
 *
 * @throws SyntaxError from `JSON.parse` when a `.json` file isn't valid JSON.
 */
export function dataFileValue(path: string, text: string): any {
    return isSvgPath(path) || isMarkdownPath(path) || isImageDataPath(path) ? text : JSON.parse(text);
}

/**
 * Whether `icon` names a file path in the workspace or package, rather than a
 * URL (`data:`, `http(s):` or any other scheme) or inline `<svg>` markup.
 * Blank or undefined: false.
 */
export function isRelativeIconSpec(icon: string | undefined): icon is string {
    const s = icon?.trim();
    return !!s && !/^(data:|https?:\/\/|<svg[\s>])/i.test(s) && !/^[a-z][a-z0-9+.-]*:/i.test(s);
}

/**
 * Resolves a script's or package's `icon` into an `<img src>` URL.
 *
 * - A `data:image/…` or `http(s)://` URL is returned as is; inline
 *   `<svg>…</svg>` markup becomes a `data:` URL. Any other scheme: undefined.
 * - A path (`./icon.svg`, `icon.png`) is looked up in `dataFiles`
 *   (case-insensitively) relative to `baseFolder`; a path without `./` or
 *   `../` that isn't there is also tried from the root. An `.svg` gives its
 *   markup as a `data:` URL, a raster image its stored `data:` URL; any other
 *   file: undefined.
 *
 * @param baseFolder The folder relative paths resolve from (`""`: the root).
 * @param dataFiles The data files to look in: each one's `path` and stored `text`.
 * @returns The URL; undefined when `icon` is unset or doesn't resolve.
 */
export function resolveIconSrc(
    icon: string | undefined,
    baseFolder: string,
    dataFiles: readonly {
        /** The file's path, with its extension. */
        path: string;
        /** The file's stored text (an image's `data:` URL). */
        text: string;
    }[]
): string | undefined {
    const raw = icon?.trim();
    if (!raw) return undefined;
    if (/^data:image\//i.test(raw) || /^https?:\/\//i.test(raw)) return raw;
    if (/^<svg[\s>]/i.test(raw)) return svgToDataUrl(raw);
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return undefined;
    const relSpec = /^\.\.?(\/|$)/.test(raw) ? raw : `./${raw}`;
    const target = importPath(baseFolder ? `${baseFolder}/_` : "_", relSpec);
    const find = (p: string | null) => (p ? dataFiles.find((d) => d.path.toLowerCase() === p.toLowerCase()) : undefined);
    const hit = find(target) ?? (!/^\.\.?(\/|$)/.test(raw) && baseFolder ? find(importPath("_", `./${raw}`)) : undefined);
    if (!hit) return undefined;
    if (isSvgPath(hit.path)) return svgToDataUrl(hit.text);
    if (isImageDataPath(hit.path) || /^data:image\//i.test(hit.text)) return hit.text;
    return undefined;
}

/** The folder part of a path: everything before its last `/` (`""` at the root). */
export function folderOf(path: string): string {
    const i = path.lastIndexOf("/");
    return i < 0 ? "" : path.slice(0, i);
}

/**
 * The path `spec` points at when imported by the script named `importer`: a
 * relative specifier resolves from the importer's folder, a bare one from
 * the root. Null when it climbs above the root or names the root itself.
 */
export function importPath(importer: string, spec: string): string | null {
    const out = /^\.\.?(\/|$)/.test(spec) ? folderOf(importer).split("/").filter(Boolean) : [];
    for (const seg of spec.split("/")) {
        if (!seg || seg === ".") continue;
        if (seg !== "..") out.push(seg);
        else if (!out.pop()) return null;
    }
    return out.length ? out.join("/") : null;
}

/** What an import resolves to: a script (by its stored name) or a data file (by its stored path). */
export type ResolvedImport =
    | {
          /** A script. */
          kind: "script";
          /** The script's stored name. */
          name: string;
      }
    | {
          /** A data file. */
          kind: "data";
          /** The data file's stored path. */
          path: string;
      };

/**
 * Makes a resolver over these script names and data file paths: it returns
 * what `spec`, imported by the script named `importer`, refers to (with the
 * stored name or path). Undefined for a URL, a path above the root or
 * nothing by that name.
 *
 * Matching is case-insensitive, so when several names differ only in case
 * the first one wins.
 */
export function importResolver(scriptNames: Iterable<string>, dataPaths: Iterable<string> = []): (importer: string, spec: string) => ResolvedImport | undefined {
    const scripts = new Map<string, string>();
    for (const n of scriptNames) if (!scripts.has(n.toLowerCase())) scripts.set(n.toLowerCase(), n);
    const data = new Map<string, string>();
    for (const p of dataPaths) if (!data.has(p.toLowerCase())) data.set(p.toLowerCase(), p);
    return (importer, spec) => {
        if (isUrlSpec(spec)) return undefined;
        const path = importPath(importer, spec);
        if (path === null) return undefined;
        if (isDataSpec(path)) {
            const p = data.get(path.toLowerCase());
            return p === undefined ? undefined : { kind: "data", path: p };
        }
        const key = path.replace(/\.(ts|js)$/, "").toLowerCase();
        const name = scripts.get(key) ?? (/\.tsx$/.test(key) ? undefined : scripts.get(key + ".tsx"));
        return name === undefined ? undefined : { kind: "script", name };
    };
}

/**
 * The ids of the scripts that import the script named `target` (or, with
 * `kind` `"data"`, the data file at that path), directly or through other
 * scripts. The target needn't exist any more (a rename's old name).
 *
 * @param scripts The scripts to search, each with its id, name and code.
 */
export function dependantsOf<
    T extends {
        /** The script's id, as returned. */
        id: string;
        /** The script's name (its path). */
        name: string;
        /** The script's source. */
        code: string;
    }
>(target: string, scripts: T[], kind: "script" | "data" = "script"): string[] {
    const names = scripts.map((s) => s.name);
    const resolve = kind === "data" ? importResolver(names, [target]) : importResolver([...names, target]);
    const specs = new Map(scripts.map((s) => [s.id, [...importSpecs(s.code)]]));
    const found = new Set<string>();
    const queue: ResolvedImport[] = [kind === "data" ? { kind, path: target } : { kind, name: target }];
    while (queue.length) {
        const t = queue.shift()!;
        for (const s of scripts) {
            if (found.has(s.id)) continue;
            const hit = specs.get(s.id)!.some((spec) => {
                const r = resolve(s.name, spec);
                return r?.kind === "data" ? t.kind === "data" && r.path.toLowerCase() === t.path.toLowerCase() : r?.kind === "script" && t.kind === "script" && r.name === t.name;
            });
            if (!hit) continue;
            found.add(s.id);
            queue.push({ kind: "script", name: s.name });
        }
    }
    return [...found];
}

/**
 * The indices of the `items` that the `chosen` ones import (directly or
 * through other scripts) but that aren't chosen, sorted: the libraries and
 * data files a partial export or import would leave dangling.
 *
 * @param chosen Indices into `items`.
 * @param items The scripts and data files on offer.
 */
export function missingImports<
    T extends {
        /** A script's name or a data file's path. */
        name: string;
        /** A script's source (not read for data files). */
        code: string;
        /** Whether the item is a data file. */
        data?: boolean;
    }
>(chosen: number[], items: T[]): number[] {
    const resolve = importResolver(
        items.filter((i) => !i.data).map((i) => i.name),
        items.filter((i) => i.data).map((i) => i.name)
    );
    const index = new Map<string, number>();
    items.forEach((it, i) => {
        const k = `${it.data ? "d" : "s"}:${it.data ? it.name.toLowerCase() : it.name}`;
        if (!index.has(k)) index.set(k, i);
    });
    const picked = new Set(chosen);
    const missing = new Set<number>();
    const queue = [...chosen];
    while (queue.length) {
        const it = items[queue.shift()!];
        if (it.data) continue;
        for (const spec of importSpecs(it.code)) {
            const r = resolve(it.name, spec);
            const i = r && index.get(r.kind === "data" ? `d:${r.path.toLowerCase()}` : `s:${r.name}`);
            if (i === undefined || picked.has(i) || missing.has(i)) continue;
            missing.add(i);
            queue.push(i);
        }
    }
    return [...missing].sort((a, b) => a - b);
}

/**
 * A module the background ships with a script to the page or overlay (the
 * hook bundle's and overlay runs' `libs`), for {@link makeLibRequire}.
 *
 * Exactly one of `src`, `json`, `pkg` and `alias` is set: it says what the
 * entry is.
 */
export interface ShippedLib {
    /** A library script's id (when `src` is set), so its `tweak.globalStore` and `tweak.pageStore` belong to it. */
    id?: string;
    /** A library's script name, a data file's path, a package module's final URL or (with `alias`) the package URL a script imports. */
    name: string;
    /** A library's runnable JavaScript (already transpiled). */
    src?: string;
    /** A data file's stored text (`name` is its path). */
    json?: string;
    /** A library's parameter values: its stored values over its `tweak.params` defaults. */
    params?: Record<string, any>;
    /** A package module (`name` is its final URL). */
    pkg?: PackageModule;
    /** The final URL of the module that the package URL `name` resolves to. */
    alias?: string;
    /** MV3 onSite: the key of a library's or package module's user-script unit (`siteCode.ts`). */
    fk?: string;
}

/**
 * What onSite code gets for a built-in it doesn't have (all but valtio's
 * core, see `siteBuiltin.ts`): a stand-in that imports fine, so the module
 * graph still loads; it throws when used.
 */
export function pageBuiltin(spec: string): any {
    return unusable(spec, `of the built-in modules it only has valtio's core ("valtio", "valtio/vanilla") — use the others in onPage or onOverlay code`);
}

/** The ids of the shipped library scripts (the entries with an `id`). */
export const shippedLibIds = (libs: readonly ShippedLib[]): string[] => libs.flatMap((l) => (l.id ? [l.id] : []));

/**
 * The script modules whose top level is running ({@link makeLibRequire}),
 * outermost first, after the script that imported the first one. Empty
 * when none is.
 */
const loading: string[] = [];

/**
 * Whether a library module's top level is running ({@link makeLibRequire}):
 * what it registers then is its own script's, not the importer's.
 */
export const libBodyRunning = (): boolean => loading.length > 0;

/**
 * A module stand-in: importing it works, using it throws. Reading
 * `__esModule` (the CommonJS interop does at import) gives true, `then` and
 * symbols give undefined; any other read, write or call throws.
 *
 * When it is used while an imported module's top level runs
 * (`const Item = memo(…)`), the error says where and through which
 * imports, so the user can split the module.
 */
function unusable(spec: string, why: string): any {
    const fail = (): never => {
        if (loading.length < 2) throw new Error(`cannot use "${spec}" in onSite code: ${why}`);
        const at = String(new Error().stack || "")
            .split("\n")
            .map(scriptFrame)
            .find((f) => f);
        const where = at ? `${at.name}:${at.line}` : loading[loading.length - 1];
        throw new Error(`cannot use "${spec}" in onSite code: ${where} uses it at its top level, and onSite code imports it (${loading.join(" → ")}) — move what onSite code needs into a module that doesn't use "${spec}"`);
    };
    return new Proxy(Object.create(null), {
        // The CommonJS interop reads __esModule at import; anything else is a use.
        get: (_t, p) => (p === "__esModule" ? true : p === "then" || typeof p === "symbol" ? undefined : fail()),
        set: fail,
        has: () => false,
        ownKeys: () => [],
        apply: fail,
    });
}

/** How {@link makeLibRequire} serves what isn't a shipped library or data file. */
export interface LibRequireOptions<L extends ShippedLib = ShippedLib> {
    /**
     * Gives a built-in import (`react`, `valtio`, …) from `importer`; a
     * downloaded package's own `require` of one gets it too, unless the
     * package is React, ReactDOM, scheduler or valtio itself.
     * Default: a module that throws when used ({@link pageBuiltin}).
     */
    builtin?: (spec: string, importer: string) => any;
    /** Receives a `.css` package import's text and URL (the overlay adds a `<style>`). Default: ignored. */
    style?: (css: string, url: string) => void;
    /**
     * Whether this is the site's world (onSite code): a package that can't
     * load there (one needing React) still imports and using it throws,
     * like the built-ins there. The script's onPage and onOverlay code
     * imports it too.
     */
    onSite?: boolean;
    /** Gives a package module's function. Default: compiled from its code. The MV3 hook, which can't compile, passes the module's registered user-script unit. */
    packageFn?: (lib: L) => PackageFn;
}

/**
 * Makes the page-side `require` over the shipped libraries, data files and
 * package modules, for the hook, the bridge and the overlay.
 *
 * The result, `requireFrom(importer)`, is the `require` of the script named
 * `importer` and resolves like the background does. Each library runs once
 * per `makeLibRequire` (through `run`) and a circular import gets the
 * partially initialized exports; package modules load once; data files
 * parse fresh per import.
 *
 * The returned `require` throws when the specifier is a URL, a bare
 * package import that isn't a declared dependency or fails to load (outside
 * onSite code) or a library or data file that wasn't shipped ("is the
 * library script saved?").
 *
 * @param run Runs a library's code with its `require` and `module`, filling `module.exports`.
 */
export function makeLibRequire<L extends ShippedLib>(
    libs: L[],
    run: (
        lib: L,
        require: (spec: string) => any,
        module: {
            /** The library's exports, set or filled by its code. */
            exports: any;
        }
    ) => void,
    opts: LibRequireOptions<L> = {}
): (importer: string) => (spec: string) => any {
    const pkgs: PackageModules = { aliases: {}, modules: {} };
    const pkgLibs = new Map<string, L>();
    for (const l of libs) {
        if (l.pkg) {
            pkgs.modules[l.name] = l.pkg;
            pkgLibs.set(l.name, l);
        }
        else if (l.alias !== undefined) pkgs.aliases[l.name] = l.alias;
    }
    const builtin = opts.builtin;
    // A downloaded package's own `require("react")` gets the built-in too (one React copy), unless it's React itself.
    const loadPackage = makePackageLoader(
        pkgs,
        builtin ? (spec, from) => (builtinSpec(spec) && !/^https:\/\/unpkg\.com\/(react|react-dom|scheduler|valtio)@/.test(from) ? { module: builtin(spec, from) } : undefined) : undefined,
        { style: opts.style, shared: opts.onSite ? "site" : "page", compile: opts.packageFn ? (url) => opts.packageFn!(pkgLibs.get(url)!) : undefined }
    );
    const scriptLibs = libs.filter((l) => !l.pkg && l.alias === undefined);
    const resolve = importResolver(
        scriptLibs.filter((l) => l.json === undefined).map((l) => l.name),
        scriptLibs.filter((l) => l.json !== undefined).map((l) => l.name)
    );
    const read = dataReader(scriptLibs.filter((l) => l.json !== undefined).map((l) => ({ path: l.name, text: l.json! })));
    const modules = new Map<string, any>();
    const requireFrom =
        (importer: string) =>
        (spec: string): any => {
            const r = resolve(importer, spec);
            if (!r && builtinSpec(spec)) return builtin ? builtin(spec, importer) : pageBuiltin(spec);
            if (isUrlSpec(spec)) throw new Error(urlImportMessage(spec));
            // A bundle's bare import: its package.json dependency's download.
            const bare = r ? undefined : bareImport(importer, spec, read);
            if (bare && "error" in bare) throw new Error(bare.error);
            if (bare) {
                const deps = dependenciesOf(importer, read);
                spec = bare.url;
                if (!opts.onSite) return loadPackage(spec, deps);
                try {
                    return loadPackage(spec, deps);
                } catch (e: any) {
                    const why = String(e?.message ?? e).replace(/^cannot import "[^"]*": /, "");
                    return unusable(spec, `it doesn't load there (${why}) — a package that needs React works in onPage or onOverlay code`);
                }
            }
            if (!r) throw new Error(`cannot import "${spec}" — is the ${isDataSpec(spec) ? "data file" : "library script"} saved?`);
            if (r.kind === "data") return dataFileValue(r.path, scriptLibs.find((l) => l.json !== undefined && l.name === r.path)!.json!);
            if (modules.has(r.name)) return modules.get(r.name);
            const lib = scriptLibs.find((l) => l.json === undefined && l.name === r.name)!;
            const moduleObj = { exports: {} as any };
            modules.set(r.name, moduleObj.exports); // Early, for cycles.
            if (!loading.length) loading.push(importer);
            loading.push(lib.name);
            try {
                run(lib, requireFrom(lib.name), moduleObj);
            } finally {
                loading.pop();
                if (loading.length === 1) loading.pop();
            }
            modules.set(r.name, moduleObj.exports);
            return moduleObj.exports;
        };
    return requireFrom;
}
