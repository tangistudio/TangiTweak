/**
 * unpkg.com served from disk: the test loader downloads a tweak's npm
 * packages through the extension's own resolver (background
 * packageImports.ts), and this answers its requests from the `node_modules`
 * folders above the bundle instead of the network. Packages are found by
 * their package.json `name` and `version`, so `npm:` aliases (installed
 * under the alias, named after the real package) resolve like on unpkg.
 */
import * as fsSync from "node:fs";
import * as nodePath from "node:path";
import { PACKAGE_ORIGIN } from "../shared/packageImports";

interface Installed {
    dir: string;
    version: string;
}

/** every installed package under `roots` (their node_modules, nested ones too), by name */
function scan(roots: string[]): Map<string, Installed[]> {
    const out = new Map<string, Installed[]>();
    const seen = new Set<string>();
    const add = (dir: string) => {
        let real: string;
        try {
            real = fsSync.realpathSync(dir);
        } catch {
            return;
        }
        if (seen.has(real)) return;
        seen.add(real);
        try {
            const pkg = JSON.parse(fsSync.readFileSync(nodePath.join(real, "package.json"), "utf8"));
            if (typeof pkg.name === "string" && typeof pkg.version === "string") {
                const list = out.get(pkg.name) ?? [];
                list.push({ dir: real, version: pkg.version });
                out.set(pkg.name, list);
            }
        } catch {}
        walk(nodePath.join(real, "node_modules"));
    };
    const walk = (nm: string) => {
        let names: string[];
        try {
            names = fsSync.readdirSync(nm);
        } catch {
            return;
        }
        for (const n of names) {
            if (n.startsWith(".")) continue;
            if (n.startsWith("@")) {
                let subs: string[] = [];
                try {
                    subs = fsSync.readdirSync(nodePath.join(nm, n));
                } catch {}
                for (const s of subs) add(nodePath.join(nm, n, s));
            } else add(nodePath.join(nm, n));
        }
    };
    for (const r of roots) walk(r);
    return out;
}

/** the `node_modules` folders a bundle in `dir` sees, nearest first */
export function nodeModulesAbove(dir: string): string[] {
    const out: string[] = [];
    for (let d = nodePath.resolve(dir); ; d = nodePath.dirname(d)) {
        const nm = nodePath.join(d, "node_modules");
        if (fsSync.existsSync(nm)) out.push(nm);
        if (nodePath.dirname(d) === d) return out;
    }
}

type Version = [number, number, number, string];

function parseVersion(v: string): Version | null {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
    return m ? [+m[1], +m[2], +m[3], m[4] ?? ""] : null;
}

function compare(a: Version, b: Version): number {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
    if (a[3] === b[3]) return 0;
    if (!a[3]) return 1;
    if (!b[3]) return -1;
    return a[3] < b[3] ? -1 : 1;
}

/** one comparator (`^1.2.3`, `~1.2`, `>=2`, `1.x`, `1.2.3`) as a test */
function comparator(c: string): ((v: Version) => boolean) | null {
    const m = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/.exec(c);
    if (!m) return null;
    const [, op = "", ...parts] = m;
    const wild = (p: string | undefined) => p === undefined || /^[xX*]$/.test(p);
    const nums = parts.slice(0, 3).map((p) => (wild(p) ? null : Number(p)));
    const pre = parts[3] ?? "";
    const known = nums.findIndex((n) => n === null);
    const fixed = known === -1 ? 3 : known;
    const lo: Version = [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0, pre];
    // the first version past a partial or caret/tilde range
    const bump = (at: number): Version => {
        const v: Version = [lo[0], lo[1], lo[2], ""];
        if (at < 0) return [Infinity, 0, 0, ""];
        (v[at] as number)++;
        for (let i = at + 1; i < 3; i++) v[i] = 0;
        return v;
    };
    if (op === "^") {
        const at = lo[0] > 0 || fixed <= 1 ? 0 : lo[1] > 0 || fixed <= 2 ? 1 : 2;
        const hi = bump(Math.min(at, fixed - 1));
        return (v) => compare(v, lo) >= 0 && compare(v, hi) < 0;
    }
    if (op === "~") {
        const hi = bump(Math.min(fixed <= 1 ? 0 : 1, fixed - 1));
        return (v) => compare(v, lo) >= 0 && compare(v, hi) < 0;
    }
    if (op === ">=") return (v) => compare(v, lo) >= 0;
    if (op === ">") return fixed === 3 ? (v) => compare(v, lo) > 0 : (v) => compare(v, bump(fixed - 1)) >= 0;
    if (op === "<") return (v) => compare(v, lo) < 0;
    if (op === "<=") return fixed === 3 ? (v) => compare(v, lo) <= 0 : (v) => compare(v, bump(fixed - 1)) < 0;
    if (fixed === 3) return (v) => compare(v, lo) === 0;
    const hi = bump(fixed - 1);
    return (v) => compare(v, lo) >= 0 && compare(v, hi) < 0;
}

/** does `version` satisfy the npm range (exact, `^`, `~`, comparators, `x`, `*`, `||`, hyphen ranges)? */
export function satisfies(version: string, range: string): boolean {
    const v = parseVersion(version);
    if (!v) return false;
    const r = range.trim();
    if (!r || r === "*" || r === "latest" || r === "x") return !v[3];
    return r.split("||").some((alt) => {
        const hy = /^\s*(\S+)\s+-\s+(\S+)\s*$/.exec(alt);
        const parts = hy ? [`>=${hy[1]}`, `<=${hy[2]}`] : alt.trim().replace(/(\^|~|>=|<=|>|<|=)\s+/g, "$1").split(/\s+/).filter(Boolean);
        if (!parts.length) return !v[3];
        return parts.every((p) => {
            const test = comparator(p);
            return !!test && test(v);
        });
    });
}

function isFile(p: string): boolean {
    try {
        return fsSync.statSync(p).isFile();
    } catch {
        return false;
    }
}

/** a path inside a package the way unpkg resolves it: as is, `.js`, `.json`, `/index.js` */
function resolveFile(dir: string, sub: string): string | null {
    const base = nodePath.join(dir, sub);
    for (const p of [base, `${base}.js`, `${base}.json`, nodePath.join(base, "index.js")]) if (isFile(p)) return p;
    return null;
}

/** a package's root file on unpkg: `unpkg`, then a string `browser`, then `main`, then index.js */
function mainFile(dir: string): string | null {
    let pkg: any = {};
    try {
        pkg = JSON.parse(fsSync.readFileSync(nodePath.join(dir, "package.json"), "utf8"));
    } catch {}
    for (const f of [pkg.unpkg, typeof pkg.browser === "string" ? pkg.browser : undefined, pkg.main]) {
        if (typeof f === "string" && f) {
            const hit = resolveFile(dir, f.replace(/^\.\//, ""));
            if (hit) return hit;
        }
    }
    return resolveFile(dir, "index");
}

function response(status: number, url: string, body: string, type: string): Response {
    const res = new Response(body, { status, headers: { "content-type": type } });
    Object.defineProperty(res, "url", { value: url });
    return res;
}

/**
 * A `fetch` answering `https://unpkg.com/<name>@<range>[/<path>]` from the
 * packages installed under `roots()` — a 404 for anything else, never the
 * network.
 */
export function localUnpkg(roots: () => string[]): typeof fetch {
    let cache: { key: string; index: Map<string, Installed[]> } | null = null;
    const index = () => {
        const r = roots();
        const key = r.join("\n");
        if (cache?.key !== key) cache = { key, index: scan(r) };
        return cache.index;
    };
    return (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const notFound = () => response(404, url, "Not found", "text/plain");
        if (!url.startsWith(PACKAGE_ORIGIN)) return notFound();
        const m = /^((?:@[^/@]+\/)?[^/@]+)(?:@([^/]*))?(?:\/(.*))?$/.exec(url.slice(PACKAGE_ORIGIN.length).replace(/[?#].*$/, ""));
        if (!m) return notFound();
        const [, name, rawRange = "", sub = ""] = m;
        const range = decodeURIComponent(rawRange);
        const hits = (index().get(name) ?? []).filter((p) => satisfies(p.version, range));
        const pick = hits.sort((a, b) => compare(parseVersion(b.version)!, parseVersion(a.version)!))[0];
        if (!pick) return notFound();
        const file = sub ? resolveFile(pick.dir, sub) : mainFile(pick.dir);
        if (!file) return notFound();
        const rel = nodePath.relative(pick.dir, file).split(nodePath.sep).join("/");
        const type = file.endsWith(".json") ? "application/json" : "application/javascript";
        return response(200, `${PACKAGE_ORIGIN}${name}@${pick.version}/${rel}`, fsSync.readFileSync(file, "utf8"), type);
    }) as typeof fetch;
}
