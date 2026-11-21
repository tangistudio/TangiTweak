import { describe, it, expect, vi } from "vitest";
import { crawl, fetchPackage, installTargetUrl, isRemote, parseSource, pickStart, sourceLabel, sourcePageUrl, stripInstallHash, webNet, ENTRY_URL_RE, type Net } from "../src/shared/packageSource";
import { writeZip } from "../src/shared/zip";

describe("parseSource", () => {
    it("GitHub file, folder and repository URLs", () => {
        expect(parseSource("https://github.com/me/s/blob/main/dark/dark.tangitweak.ts")).toEqual({ kind: "github", owner: "me", repo: "s", ref: "main", path: "dark/dark.tangitweak.ts", tree: false });
        expect(parseSource("https://github.com/me/s/tree/v1/dark")).toEqual({ kind: "github", owner: "me", repo: "s", ref: "v1", path: "dark", tree: true });
        expect(parseSource("https://github.com/me/s")).toEqual({ kind: "github", owner: "me", repo: "s", ref: "HEAD", path: "", tree: true });
        expect(parseSource("https://raw.githubusercontent.com/me/s/main/a%20b.tangitweak.ts")).toMatchObject({ ref: "main", path: "a b.tangitweak.ts", tree: false });
        expect(parseSource("https://raw.githubusercontent.com/me/s/refs/heads/dev/x.tangitweak.ts")).toMatchObject({ ref: "refs/heads/dev", path: "x.tangitweak.ts" });
    });
    it("GitLab file, folder, nested-subgroup and self-hosted URLs", () => {
        expect(parseSource("https://gitlab.com/team/sub/repo")).toEqual({ kind: "gitlab", origin: "https://gitlab.com", project: "team/sub/repo", ref: "HEAD", path: "", tree: true });
        expect(parseSource("https://gitlab.com/team/repo/-/tree/main/tools/kit")).toEqual({ kind: "gitlab", origin: "https://gitlab.com", project: "team/repo", ref: "main", path: "tools/kit", tree: true });
        expect(parseSource("https://gitlab.com/team/repo/-/blob/main/dark.tangitweak.ts")).toEqual({ kind: "gitlab", origin: "https://gitlab.com", project: "team/repo", ref: "main", path: "dark.tangitweak.ts", tree: false });
        expect(parseSource("https://git.corp.example/team/repo/-/tree/v1/kit")).toEqual({ kind: "gitlab", origin: "https://git.corp.example", project: "team/repo", ref: "v1", path: "kit", tree: true });
        expect(sourceLabel({ kind: "gitlab", origin: "https://gitlab.com", project: "team/sub/repo", ref: "main", path: "kit", tree: true })).toBe("gitlab.com/team/sub/repo/kit @ main");
        expect(installTargetUrl("https://gitlab.com/team/repo/-/blob/main/a.tangitweak.ts")).toBeNull();
        expect(installTargetUrl("https://gitlab.com/team/repo/-/raw/main/a.tangitweak.ts")).toBe("https://gitlab.com/team/repo/-/raw/main/a.tangitweak.ts");
        expect(installTargetUrl("https://gitlab.com/team/sub/repo#tangitweak:install")).toBe("https://gitlab.com/team/sub/repo");
    });
    it("gists", () => {
        expect(parseSource("https://gist.github.com/me/abc123")).toEqual({ kind: "gist", id: "abc123" });
        expect(parseSource("https://gist.githubusercontent.com/me/abc123/raw/def/x.tangitweak.ts")).toEqual({ kind: "gist", id: "abc123", file: "x.tangitweak.ts" });
    });
    it("plain and file URLs name a tweak's package.json or one of its files", () => {
        expect(parseSource("https://x.dev/p/a.tangitweak.ts#top")).toEqual({ kind: "url", url: "https://x.dev/p/a.tangitweak.ts" });
        expect(parseSource("file:///home/me/p/a.tangitweak.tsx")).toEqual({ kind: "url", url: "file:///home/me/p/a.tangitweak.tsx" });
        expect(parseSource("https://x.dev/p/a.ts")).toEqual({ kind: "url", url: "https://x.dev/p/a.ts" });
        expect(parseSource("https://x.dev/kit/package.json")).toEqual({ kind: "url", url: "https://x.dev/kit/package.json" });
        expect(typeof parseSource("https://x.dev/kit/metadata.json")).toBe("string");
        expect(typeof parseSource("https://x.dev/p/a.js")).toBe("string");
        expect(typeof parseSource("ftp://x/a.tangitweak.ts")).toBe("string");
    });
    it("zip URLs, GitHub's archives and release assets too", () => {
        expect(parseSource("https://x.dev/kit.zip#a")).toEqual({ kind: "zip", url: "https://x.dev/kit.zip" });
        expect(parseSource("https://github.com/me/s/archive/refs/heads/main.zip")).toEqual({ kind: "zip", url: "https://github.com/me/s/archive/refs/heads/main.zip" });
        expect(parseSource("https://github.com/me/s/releases/download/v1/kit.ZIP")).toMatchObject({ kind: "zip" });
        expect(isRemote({ kind: "zip", url: "https://x.dev/kit.zip" })).toBe(true);
        expect(isRemote({ kind: "zip", url: "file:///kit.zip" })).toBe(false);
    });
    it("labels and sourcePageUrl", () => {
        expect(sourceLabel({ kind: "github", owner: "me", repo: "s", ref: "HEAD", path: "", tree: true })).toBe("github.com/me/s");
        expect(sourcePageUrl("https://github.com/nima-taheri-mongodb/bonsai")).toBe("https://github.com/nima-taheri-mongodb/bonsai");
        expect(sourcePageUrl("https://github.com/me/s/tree/v1/dark")).toBe("https://github.com/me/s/tree/v1/dark");
        const ghFile = sourcePageUrl("https://raw.githubusercontent.com/me/s/refs/heads/main/a.tangitweak.ts")!;
        expect(ghFile).toBe("https://github.com/me/s/blob/main/a.tangitweak.ts");
        expect(installTargetUrl(ghFile)).toBeNull();
        const glFile = sourcePageUrl("https://gitlab.com/team/repo/-/raw/main/a.tangitweak.ts")!;
        expect(glFile).toBe("https://gitlab.com/team/repo/-/blob/main/a.tangitweak.ts");
        expect(installTargetUrl(glFile)).toBeNull();
        expect(sourcePageUrl("https://gist.githubusercontent.com/me/abc123/raw/def/x.tangitweak.ts")).toBe("https://gist.github.com/abc123");
        const plainEntry = sourcePageUrl("https://x.dev/p/a.tangitweak.ts")!;
        expect(plainEntry).toBe("https://x.dev/p/a.tangitweak.ts#tt-raw");
        expect(installTargetUrl(plainEntry)).toBeNull();
        expect(sourcePageUrl("file:///home/me/p/a.tangitweak.tsx")).toBeNull();
    });
    it("recognizes entry URLs and #tangitweak:install links opened in a tab", () => {
        expect(ENTRY_URL_RE.test("https://x.dev/a.tangitweak.ts?raw=1")).toBe(true);
        expect(ENTRY_URL_RE.test("file:///a/b.tangitweak.tsx")).toBe(true);
        expect(ENTRY_URL_RE.test("https://x.dev/a.tangitweak.ts.html")).toBe(false);
        expect(installTargetUrl("https://raw.githubusercontent.com/me/s/main/a.tangitweak.ts")).toBe("https://raw.githubusercontent.com/me/s/main/a.tangitweak.ts");
        expect(installTargetUrl("https://raw.githubusercontent.com/me/s/main/a.tangitweak.ts#tt-raw")).toBeNull();
        expect(installTargetUrl("https://github.com/me/s/blob/main/a.tangitweak.ts")).toBeNull();
        expect(installTargetUrl("https://github.com/nima-taheri-mongodb/bonsai/#tangitweak:install")).toBe("https://github.com/nima-taheri-mongodb/bonsai/");
        expect(installTargetUrl("https://github.com/nima-taheri-mongodb/bonsai#tangitweak:install")).toBe("https://github.com/nima-taheri-mongodb/bonsai");
        expect(stripInstallHash("https://github.com/nima-taheri-mongodb/bonsai#tangitweak:install")).toBe("https://github.com/nima-taheri-mongodb/bonsai");
    });
});

const pkg = (name: string, extra: object = {}) => JSON.stringify({ name, version: "1.0.0", tangitweak: {}, ...extra });

describe("pickStart", () => {
    it("a folder's package.json; single files and metadata.json bundles say why they don't install", () => {
        expect(pickStart(["a.ts", "package.json"], "x")).toBe("package.json");
        expect(() => pickStart(["a.ts", "metadata.json"], "x")).toThrow(/no package\.json in x.*metadata\.json bundles no longer install/);
        expect(() => pickStart(["a.ts", "b.ts"], "x")).toThrow(/single-file scripts no longer install/);
        expect(() => pickStart(["c.json"], "x")).toThrow(/no package\.json in x — a tweak is a folder/);
    });
});

describe("crawl", () => {
    const fs: Record<string, string> = {
        "repo/pkg/package.json": pkg("pkg", { dependencies: { react: "^18.0.0" } }),
        "repo/pkg/index.ts": `import { a } from "./lib/a";\nimport cfg from "./cfg.json";\nimport React from "react";\nimport u from "https://unpkg.com/x@1.0.0";\nimport g from "globalutil";\nimport m from "./nope";`,
        "repo/pkg/lib/a.ts": `import { P } from "./Panel";\nexport const a = 1;`,
        "repo/pkg/lib/Panel.tsx": `export const P = () => <div/>;`,
        "repo/pkg/lib/unused.ts": "",
        "repo/pkg/cfg.json": `{"a":1}`,
        "repo/main/package.json": pkg("main", { main: "src/app.tsx" }),
        "repo/main/src/app.tsx": "export {};",
        "repo/tsx/package.json": pkg("tsx"),
        "repo/tsx/index.tsx": "export {};",
        "repo/out/package.json": pkg("out"),
        "repo/out/index.ts": `import "../shared/x";`,
        "repo/shared/x.ts": "export {};",
        "repo/plain/package.json": JSON.stringify({ name: "plain" }),
        "repo/plain/index.ts": "",
        "repo/lone/a.ts": "",
        "repo/dot/package.json": pkg("dot"),
        "repo/dot/index.ts": `import s from "./.tweak/stores/cart.json";`,
        "repo/dot/.tweak/stores/cart.json": `{"n":1}`,
    };
    const read = async (p: string) => fs[p] ?? null;
    it("reads the package.json, its entry and what it imports by relative path; bare imports must be dependencies", async () => {
        const c = await crawl("repo/pkg/package.json", read);
        expect(c.entries).toEqual(["index.ts"]);
        expect(c.manifest.name).toBe("pkg");
        expect(Object.keys(c.files).sort()).toEqual(["cfg.json", "index.ts", "lib/Panel.tsx", "lib/a.ts", "package.json"]);
        expect(c.missing).toEqual([{ from: "index.ts", spec: "./nope" }]);
        expect(c.bare).toEqual([{ from: "index.ts", spec: "globalutil" }]);
    });
    it("a file next to a package.json opens it", async () => {
        const c = await crawl("repo/pkg/index.ts", read);
        expect(c.entries).toEqual(["index.ts"]);
        await expect(crawl("repo/lone/a.ts", read)).rejects.toThrow(/isn't in a tweak.*single-file scripts no longer install/);
        await expect(crawl("repo/plain/index.ts", read)).rejects.toThrow(/isn't in a tweak/);
    });
    it("the entry is main, else index.ts, else index.tsx", async () => {
        expect((await crawl("repo/main/package.json", read)).entries).toEqual(["src/app.tsx"]);
        expect((await crawl("repo/tsx/package.json", read)).entries).toEqual(["index.tsx"]);
    });
    it("never reads a dot folder (a tweak's data folder), even when imported", async () => {
        const c = await crawl("repo/dot/package.json", read);
        expect(Object.keys(c.files).sort()).toEqual(["index.ts", "package.json"]);
        expect(c.missing).toEqual([{ from: "index.ts", spec: "./.tweak/stores/cart.json" }]);
    });
    it("a bundle's files must be in its folder", async () => {
        await expect(crawl("repo/out/package.json", read)).rejects.toThrow(/outside/);
    });
    it("a missing entry fails", async () => {
        await expect(crawl("nope/package.json", read)).rejects.toThrow("can't read");
    });
});

describe("fetchPackage", () => {
    const calls: string[] = [];
    const zip = writeZip({ "kit-1.0/package.json": pkg("kit", { main: "a.ts" }), "kit-1.0/a.ts": 'import "./lib/b";', "kit-1.0/lib/b.ts": "export {};", "kit-1.0/README.md": "hi", "kit-1.0/lib/c.ts": "export {};" });
    const net: Net = {
        async bytes(url) {
            calls.push(url);
            return url === "https://x.dev/kit.zip" ? (zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer) : null;
        },
        async text(url) {
            calls.push(url);
            const files: Record<string, string> = {
                "https://raw.githubusercontent.com/me/s/abc/dark/package.json": pkg("dark"),
                "https://raw.githubusercontent.com/me/s/abc/dark/index.ts": `import "./util";`,
                "https://raw.githubusercontent.com/me/s/abc/dark/util.ts": `export {};`,
                "https://x.dev/p/package.json": pkg("p"),
                "https://x.dev/p/index.ts": `export {};`,
                "https://x.dev/p/a.tangitweak.ts": `export {};`,
            };
            return files[url] ?? null;
        },
        async json(url) {
            calls.push(url);
            if (url === "https://api.github.com/repos/me/s/commits/main") return { sha: "abc" };
            if (url === "https://api.github.com/repos/me/s/git/trees/abc?recursive=1")
                return { tree: [{ path: "dark", type: "tree" }, { path: "dark/package.json", type: "blob" }, { path: "dark/index.ts", type: "blob" }, { path: "dark/sub/package.json", type: "blob" }, { path: "dark/util.ts", type: "blob" }] };
            if (url === "https://api.github.com/gists/g1") return { history: [{ version: "rev1" }], files: { "package.json": { content: pkg("g") }, "index.ts": { content: "export {};" }, "b.ts": { content: "" } } };
            throw new Error("unexpected " + url);
        },
    };
    it("GitHub folder: pinned to the commit, the folder's package.json", async () => {
        const p = await fetchPackage({ kind: "github", owner: "me", repo: "s", ref: "main", path: "dark", tree: true }, net);
        expect(p.revision).toBe("abc");
        expect(p.entries).toEqual(["index.ts"]);
        expect(Object.keys(p.files).sort()).toEqual(["index.ts", "package.json", "util.ts"]);
    });
    it("gist: its package.json, entry and revision", async () => {
        const p = await fetchPackage({ kind: "gist", id: "g1" }, net);
        expect(p).toMatchObject({ entries: ["index.ts"], revision: "rev1", files: { "index.ts": "export {};" } });
    });
    it("plain URL (a share link to a file of the tweak): the revision is the files' hash", async () => {
        const p = await fetchPackage({ kind: "url", url: "https://x.dev/p/a.tangitweak.ts" }, net);
        expect(p.entries).toEqual(["index.ts"]);
        expect(p.revision).toMatch(/^[0-9a-f]{24}$/);
    });
    it("zip URL: its one folder's package.json and what the entry imports", async () => {
        const p = await fetchPackage({ kind: "zip", url: "https://x.dev/kit.zip" }, net);
        expect(p.entries).toEqual(["a.ts"]);
        expect(Object.keys(p.files).sort()).toEqual(["a.ts", "lib/b.ts", "package.json"]);
        expect(p.revision).toMatch(/^[0-9a-f]{24}$/);
        await expect(fetchPackage({ kind: "zip", url: "https://x.dev/none.zip" }, net)).rejects.toThrow(/can't read/);
    });
    it("reports monotonic file and byte download progress", async () => {
        const fileEvents: any[] = [];
        await fetchPackage({ kind: "github", owner: "me", repo: "s", ref: "main", path: "dark", tree: true }, net, (p) => fileEvents.push(p));
        expect(fileEvents[0]).toEqual({});
        expect(fileEvents[fileEvents.length - 1]).toEqual({ done: 3, total: 3, detail: "3 / 3 files" });

        const zipEvents: any[] = [];
        const streamingNet: Net = {
            ...net,
            async bytes(url, onBytes) {
                onBytes?.(120, 240);
                onBytes?.(240, 240);
                return net.bytes(url);
            },
        };
        await fetchPackage({ kind: "zip", url: "https://x.dev/kit.zip" }, streamingNet, (p) => zipEvents.push(p));
        expect(zipEvents).toContainEqual({ done: 120, total: 240, detail: "120 B / 240 B" });
        expect(zipEvents[zipEvents.length - 1]).toEqual({ done: 240, total: 240, detail: "240 B / 240 B" });
    });

    it("falls back to cookie-authenticated github.com archive zip for private repos (root, subfolder, and SSO/404 errors)", async () => {
        const sha = "9d3dc7db2e7800a90c97ef6c9c72d78771b464b4";
        const repoZip = writeZip(
            {
                [`priv-${sha}/package.json`]: pkg("priv-root"),
                [`priv-${sha}/index.tsx`]: `import "./lib/store";`,
                [`priv-${sha}/lib/store.ts`]: `export const s = 1;`,
                [`priv-${sha}/dark/package.json`]: pkg("dark"),
                [`priv-${sha}/dark/index.ts`]: `import "./util";`,
                [`priv-${sha}/dark/util.ts`]: `export {};`,
            },
            new Date(),
            sha
        );
        const authCalls: { url: string; auth?: boolean }[] = [];
        const privNet: Net = {
            async json(url) {
                throw new Error(`${url}: HTTP 404`);
            },
            async text() {
                return null;
            },
            async bytes(url, onBytes, auth) {
                authCalls.push({ url, auth });
                if (!auth) return null;
                if (url === "https://github.com/me/priv/archive/HEAD.zip" || url === "https://github.com/me/priv/archive/refs/heads/dev.zip") {
                    onBytes?.(repoZip.byteLength, repoZip.byteLength);
                    return repoZip.buffer.slice(repoZip.byteOffset, repoZip.byteOffset + repoZip.byteLength) as ArrayBuffer;
                }
                if (url === "https://github.com/me/sso-locked/archive/HEAD.zip") {
                    return new TextEncoder().encode("<!doctype html><html><body>Sign in to SSO</body></html>").buffer as ArrayBuffer;
                }
                return null;
            },
        };

        const rootPkg = await fetchPackage(parseSource("https://github.com/me/priv") as any, privNet);
        expect(authCalls[0]).toEqual({ url: "https://github.com/me/priv/archive/HEAD.zip", auth: true });
        expect(rootPkg.revision).toBe(sha);
        expect(rootPkg.manifest?.name).toBe("priv-root");
        expect(Object.keys(rootPkg.files).sort()).toEqual(["index.tsx", "lib/store.ts", "package.json"]);

        const subPkg = await fetchPackage({ kind: "github", owner: "me", repo: "priv", ref: "refs/heads/dev", path: "dark", tree: true }, privNet);
        expect(authCalls[1]).toEqual({ url: "https://github.com/me/priv/archive/refs/heads/dev.zip", auth: true });
        expect(subPkg.revision).toBe(sha);
        expect(Object.keys(subPkg.files).sort()).toEqual(["index.ts", "package.json", "util.ts"]);

        // Subfolder URL on a slash-containing branch (e.g. tree/refs/heads/dev/dark parsed from github.com)
        const slashBranchUrl = parseSource("https://github.com/me/priv/tree/refs/heads/dev/dark") as any;
        const slashPkg = await fetchPackage(slashBranchUrl, privNet);
        expect(slashPkg.revision).toBe(sha);
        expect(Object.keys(slashPkg.files).sort()).toEqual(["index.ts", "package.json", "util.ts"]);

        await expect(fetchPackage(parseSource("https://github.com/me/sso-locked") as any, privNet)).rejects.toThrow(/sign in or authorize SSO/);
        await expect(fetchPackage(parseSource("https://github.com/me/no-access") as any, privNet)).rejects.toThrow(/sign in to GitHub/);
    });

    it("fetches GitLab repositories and ?path= subfolders (including slash branches, self-hosted, and SSO errors)", async () => {
        const sha = "4e1a9110ad7fbe4a30fcf8c35c616b09c5e09220";
        const rootZip = writeZip(
            {
                [`repo-HEAD-${sha}/package.json`]: pkg("gitlab-root"),
                [`repo-HEAD-${sha}/index.ts`]: `export {};`,
            },
            new Date(),
            sha
        );
        const subZip = writeZip(
            {
                [`repo-feat-auth-${sha}-tools-kit/tools/kit/package.json`]: pkg("kit"),
                [`repo-feat-auth-${sha}-tools-kit/tools/kit/index.ts`]: `import "./helper";`,
                [`repo-feat-auth-${sha}-tools-kit/tools/kit/helper.ts`]: `export const h = 1;`,
            },
            new Date(),
            sha
        );
        const seen: { url: string; auth?: boolean }[] = [];
        const glNet: Net = {
            async json() {
                throw new Error("unused");
            },
            async text() {
                return null;
            },
            async bytes(url, _onBytes, auth) {
                seen.push({ url, auth });
                if (!auth) return null;
                if (url === "https://gitlab.com/team/sub/repo/-/archive/HEAD/archive.zip") {
                    return rootZip.buffer.slice(rootZip.byteOffset, rootZip.byteOffset + rootZip.byteLength) as ArrayBuffer;
                }
                if (url === "https://git.corp.example/team/repo/-/archive/feat/auth/archive.zip?path=tools%2Fkit") {
                    return subZip.buffer.slice(subZip.byteOffset, subZip.byteOffset + subZip.byteLength) as ArrayBuffer;
                }
                if (url === "https://gitlab.com/team/locked/-/archive/HEAD/archive.zip") {
                    return new TextEncoder().encode("<!doctype html><html><body>Sign in · GitLab</body></html>").buffer as ArrayBuffer;
                }
                return null;
            },
        };

        const rPkg = await fetchPackage(parseSource("https://gitlab.com/team/sub/repo") as any, glNet);
        expect(seen[0]).toEqual({ url: "https://gitlab.com/team/sub/repo/-/archive/HEAD/archive.zip", auth: true });
        expect(rPkg.revision).toBe(sha);
        expect(rPkg.manifest?.name).toBe("gitlab-root");

        const sPkg = await fetchPackage(parseSource("https://git.corp.example/team/repo/-/tree/feat/auth/tools/kit") as any, glNet);
        expect(sPkg.revision).toBe(sha);
        expect(Object.keys(sPkg.files).sort()).toEqual(["helper.ts", "index.ts", "package.json"]);

        await expect(fetchPackage(parseSource("https://gitlab.com/team/locked") as any, glNet)).rejects.toThrow(/sign in or authorize SSO/);
    });

    it("webNet retries 404 https fetches with credentials: include, and honors explicit auth=true", async () => {
        const creds: string[] = [];
        const origFetch = globalThis.fetch;
        globalThis.fetch = vi.fn(async (_url: any, init?: RequestInit) => {
            creds.push(String(init?.credentials));
            if (init?.credentials === "include") return new Response("private-ok", { status: 200 });
            return new Response("not found", { status: 404 });
        }) as any;
        try {
            expect(await webNet.text("https://github.com/me/priv/raw/main/a.ts")).toBe("private-ok");
            expect(creds).toEqual(["omit", "include"]);
            creds.length = 0;
            expect(await webNet.text("https://github.com/me/priv/raw/main/a.ts", true)).toBe("private-ok");
            expect(creds).toEqual(["include"]);
        } finally {
            globalThis.fetch = origFetch;
        }
    });
});
