/**
 * Build: bundles TS entries with Rolldown, copies static assets.
 *
 * Two targets:
 *   dist/    + dist-mv2/ — MV2 (manifest_version 2, blocking webRequest,
 *                          persistent background page) — the primary build
 *   dist-mv3/            — MV3 (service worker, sandbox-based compile,
 *                          hook tier carries interception — webRequest/
 *                          cdp tiers disabled at runtime)
 *
 *   dist-firefox/        — the MV2 build for Firefox (the .xpi)
 *
 * The MV3 and Firefox manifests are derived from manifest.json at build time.
 */
import { rolldown } from "rolldown";
import { cp, mkdir, rm, writeFile, copyFile, readFile, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(new URL(".", import.meta.url).pathname, "..");

/** short commit hash (+ "-dirty" with uncommitted changes) for the About section */
function gitCommit() {
    try {
        const hash = execSync("git rev-parse --short HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
        const dirty = execSync("git status --porcelain --untracked-files=no", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
        return hash + (dirty ? "-dirty" : "");
    } catch {
        return "unknown";
    }
}
const WATCH = process.argv.includes("--watch");

/** @type {import('rolldown').InputOptions[]} */
function entriesFor(dist, mv3) {
    const list = [
        {
            input: path.join(root, "src/background/background.ts"),
            output: { file: path.join(dist, "background.js"), format: "iife" },
        },
        {
            input: path.join(root, "src/hook/hook.ts"),
            output: { file: path.join(dist, "hook.js"), format: "iife" },
        },
        {
            input: path.join(root, "src/hook/bridge.ts"),
            output: { file: path.join(dist, "bridge.js"), format: "iife" },
        },
        {
            input: path.join(root, "src/ui/editor.ts"),
            output: { file: path.join(dist, "editor.js"), format: "iife" },
            external: [/^lib\//],
        },
        {
            input: path.join(root, "src/ui/popup.tsx"),
            output: { file: path.join(dist, "popup.js"), format: "iife" },
        },
        {
            // installs a script from a URL, folder or zip; reviews updates (src/ui/install)
            input: path.join(root, "src/ui/install.tsx"),
            output: { file: path.join(dist, "install.js"), format: "iife" },
        },
        {
            // the built-in React for scripts, loaded only when one imports it (src/shared/builtins.ts)
            input: path.join(root, "src/builtins/react.ts"),
            output: { file: path.join(dist, "builtins-react.js"), format: "iife" },
        },
        {
            // a script's overlay frame (tweak.onOverlay), framed into pages by the bridge
            input: path.join(root, "src/overlay/overlayRuntime.ts"),
            output: { file: path.join(dist, "overlay.js"), format: "iife" },
        },
    ];
    if (!mv3) {
        list.push(
            {
                input: path.join(root, "src/ui/serve.ts"),
                output: { file: path.join(dist, "serve.js"), format: "iife" },
            }
        );
    } else {
        list.push(
            {
                // offscreen document: bridges the SW ⇄ sandbox iframe
                input: path.join(root, "src/background/offscreen.ts"),
                output: { file: path.join(dist, "offscreen.js"), format: "iife" },
            },
            {
                // sandbox page: the only MV3 context where eval is allowed
                input: path.join(root, "src/background/sandbox.ts"),
                output: { file: path.join(dist, "sandbox.js"), format: "iife" },
            },
            {
                // world: "isolated" onPage code, in a chrome.userScripts world (src/background/userScripts.ts)
                input: path.join(root, "src/hook/isolated.ts"),
                output: { file: path.join(dist, "isolated.js"), format: "iife" },
            }
        );
    }
    // MV3 content scripts: no code from strings (the page world gets onSite code as user scripts, src/shared/siteCode.ts)
    const noEval = (e) => mv3 && /[/\\](hook|bridge)\.js$/.test(e.output.file);
    for (const e of list) {
        e.transform = {
            define: { __MV3__: mv3 ? "true" : "false", __NO_EVAL__: noEval(e) ? "true" : "false", __COMMIT__: JSON.stringify(gitCommit()), __BUILD_TIME__: JSON.stringify(new Date().toISOString()), "process.env.NODE_ENV": JSON.stringify("production") },
            jsx: { runtime: "automatic", importSource: "react" },
        };
    }
    return list;
}

/**
 * The page hook as a MAIN-world content script, so it patches fetch/XHR
 * before the page's own scripts run. Chromium rejects `world` in MV2
 * manifests (it warns and ignores it), so manifest.json leaves it out and
 * the bridge injects hook.js with a <script> tag there; MV3 and Firefox
 * (128+) get it here.
 */
const HOOK_MAIN = { matches: ["*://*/*"], js: ["hook.js"], all_frames: true, match_about_blank: true, match_origin_as_fallback: true, run_at: "document_start", world: "MAIN" };

/** manifest.json → Firefox manifest object */
function firefoxManifest(mv2) {
    // Firefox has no manifest sandbox: overlay.html is a normal extension page there (overlayRuntime.ts checks its nonce with the background)
    // and no version_name (the xpi is named after the release tag instead)
    const { sandbox: _sandbox, version_name: _versionName, ...rest } = mv2;
    return { ...rest, content_scripts: [HOOK_MAIN, ...mv2.content_scripts] };
}

/** manifest.json → MV3 manifest object */
function mv3Manifest(mv2) {
    return {
        name: mv2.name,
        version: mv2.version,
        version_name: mv2.version_name,
        description: mv2.description,
        icons: mv2.icons,
        action: {
            default_title: mv2.browser_action.default_title,
            default_popup: mv2.browser_action.default_popup,
            default_icon: mv2.browser_action.default_icon,
        },
        options_ui: mv2.options_ui,
        background: { service_worker: "background.js" },
        content_scripts: [HOOK_MAIN, ...mv2.content_scripts],
        permissions: ["storage", "unlimitedStorage", "tabs", "debugger", "offscreen", "webNavigation", "webRequest", "alarms", "proxy", "declarativeNetRequestWithHostAccess"],
        host_permissions: ["<all_urls>"],
        // userScripts: world: "isolated" onPage code (src/background/userScripts.ts), asked for from the Editor;
        // nativeMessaging + browsingData: the local helper only, asked for from Settings → Local helper
        // (debugger and proxy can't be optional in Chrome)
        optional_permissions: [...mv2.optional_permissions, "userScripts", "nativeMessaging", "browsingData"],
        web_accessible_resources: [{ resources: mv2.web_accessible_resources, matches: ["<all_urls>"] }],
        // sandbox pages are exempt from the extension CSP — sandbox.html hosts
        // the script compiler/runner (see src/background/sandbox.ts), overlay.html
        // a script's overlay (src/overlay/overlayRuntime.ts)
        sandbox: { pages: ["sandbox.html", ...mv2.sandbox.pages] },
        minimum_chrome_version: "120",
        manifest_version: 3,
    };
}

async function buildOnce(dist, mv3) {
    const entries = entriesFor(dist, mv3);
    // the page hook first: MV2 Chromium's bridge injects its source inline
    const isHook = (e) => e.output.file === path.join(dist, "hook.js");
    const hook = entries.find(isHook);
    for (const entry of [hook, ...entries.filter((e) => !isHook(e))]) {
        if (entry !== hook) {
            entry.transform.define.__HOOK_SRC__ = JSON.stringify(await readFile(hook.output.file, "utf8"));
        }
        const bundle = await rolldown(entry);
        await bundle.write({ file: entry.output.file, format: entry.output.format });
        await bundle.close();
        console.log("built", path.relative(root, entry.output.file));
    }
    await copyStatic(dist, mv3);
}

/**
 * Monaco files the editor can load: models are only ever "typescript"
 * (scripts, diff editor), "json" (settings.json, stores.json, data files),
 * "xml" (.svg data files), "markdown" (.md files) and "plaintext" (raster
 * image data files) — see monacoSetup.ts and editor.ts — so other languages'
 * modes/workers are skipped. The
 * nls.messages.<locale> files load only when a locale is configured
 * (we don't), so the editor stays English.
 */
const MONACO_BASIC_LANGUAGES = new Set(["typescript", "javascript", "xml", "markdown"]);
const MONACO_SKIPPED_LANGUAGES = new Set(["css", "html"]);
function keepMonacoFile(rel) {
    const parts = rel.split(path.sep);
    if (parts.length === 1 && /^nls\.messages\..+\.js$/.test(parts[0])) return false;
    if (parts[0] === "basic-languages" && parts.length > 1 && !parts[1].startsWith("_") && !MONACO_BASIC_LANGUAGES.has(parts[1])) return false;
    if (parts[0] === "language" && parts.length > 1 && MONACO_SKIPPED_LANGUAGES.has(parts[1])) return false;
    return true;
}

/** node_modules-relative path → text of every .d.ts the built-in valtio and React need */
async function builtinTypes() {
    const out = {};
    const add = async (dir, test) => {
        for (const f of await readdir(path.join(root, "node_modules", dir), { recursive: true })) {
            if (test(f)) out[`${dir}/${f.split(path.sep).join("/")}`] = await readFile(path.join(root, "node_modules", dir, f), "utf8");
        }
    };
    await add("valtio/esm", (f) => f.endsWith(".d.mts"));
    await add("@types/react", (f) => ["index.d.ts", "global.d.ts", "jsx-runtime.d.ts", "jsx-dev-runtime.d.ts"].includes(f));
    await add("@types/react-dom", (f) => ["index.d.ts", "client.d.ts"].includes(f));
    await add("csstype", (f) => f === "index.d.ts");
    return out;
}

async function copyStatic(dist, mv3) {
    await mkdir(path.join(dist, "lib", "monaco"), { recursive: true });

    // storeIcon.png is for the store listing only — no manifest references it
    await cp(path.join(root, "icons"), path.join(dist, "icons"), { recursive: true, filter: (src) => path.basename(src) !== "storeIcon.png" });
    if (mv3) {
        const mv2 = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
        await writeFile(path.join(dist, "manifest.json"), JSON.stringify(mv3Manifest(mv2), null, 4) + "\n");
        await copyFile(path.join(root, "src/background/offscreen.html"), path.join(dist, "offscreen.html"));
        await copyFile(path.join(root, "src/background/sandbox.html"), path.join(dist, "sandbox.html"));
    } else {
        await copyFile(path.join(root, "manifest.json"), path.join(dist, "manifest.json"));
        await copyFile(path.join(root, "src/background/background.html"), path.join(dist, "background.html"));
        await copyFile(path.join(root, "src/ui/serve.html"), path.join(dist, "serve.html"));
    }
    await copyFile(path.join(root, "src/ui/editor.html"), path.join(dist, "editor.html"));
    await copyFile(path.join(root, "src/overlay/overlay.html"), path.join(dist, "overlay.html"));
    await copyFile(path.join(root, "src/ui/ui.css"), path.join(dist, "ui.css"));
    await copyFile(path.join(root, "src/ui/popup.html"), path.join(dist, "popup.html"));
    await copyFile(path.join(root, "src/ui/popup.css"), path.join(dist, "popup.css"));
    await copyFile(path.join(root, "src/ui/install.html"), path.join(dist, "install.html"));
    await copyFile(path.join(root, "src/ui/install.css"), path.join(dist, "install.css"));
    await copyFile(path.join(root, "src/ui/theme.css"), path.join(dist, "theme.css"));
    await copyFile(path.join(root, "src/ui/theme-boot.js"), path.join(dist, "theme-boot.js"));

    // Monaco classic AMD build
    const monacoSrc = path.join(root, "node_modules/monaco-editor/min/vs");
    const monacoDst = path.join(dist, "lib/monaco/vs");
    if (existsSync(monacoSrc)) {
        await rm(monacoDst, { recursive: true, force: true });
        await cp(monacoSrc, monacoDst, { recursive: true, filter: (src) => keepMonacoFile(path.relative(monacoSrc, src)) });
        await pruneTsWorkerLibs(path.join(monacoDst, "language/typescript/tsWorker.js"));
    }

    // tt-api typings for the editor + VS Code export
    await copyFile(
        path.join(root, "src/types/tt-api.d.ts"),
        path.join(dist, "lib/tt-api.d.ts")
    );

    // typings of the built-in modules (src/shared/builtins.ts), which the Editor loads when a script imports one
    await writeFile(path.join(dist, "lib/builtin-types.json"), JSON.stringify(await builtinTypes()));

    // the SDK (dist-sdk/), which Folder Sync writes to .tangitweak/sdk/tangitweak/
    await writeFile(path.join(dist, "lib/tangitweak-sdk.json"), await getSdkJson());

    console.log("static assets copied →", path.relative(root, dist));
}

/**
 * The SDK npm package `tangitweak` (docs/research/tweak-architecture-plan.md §8):
 *
 *   index.js / index.d.ts  `import { tweak } from "tangitweak"` outside the browser
 *                          (src/testing/standalone.ts) and the API typings
 *   test.js / test.d.ts    `tangitweak/test` (src/testing/test.ts)
 *   tsconfig.json          what a tweak's own tsconfig.json extends
 *   types/                 test.d.ts's declarations, and the built-ins' typings
 *                          (valtio, React) that tsconfig.json maps them to
 *
 * Folder Sync writes the same files to .tangitweak/sdk/tangitweak/ (§8.3):
 * lib/tangitweak-sdk.json holds them, except types/builtin/, which it
 * already has from lib/builtin-types.json.
 */
const SDK_DIR = path.join(root, "dist-sdk");
/** the SDK's runtime dependencies */
const SDK_DEPENDENCIES = ["re2js", "happy-dom", "@testing-library/dom"];
/**
 * Shared with the tweak's own tests and code: the test file's copies. All
 * optional, so a tweak that only type-checks (its package.json lists
 * `tangitweak`) doesn't install them; `tangitweak/test` needs all but
 * @testing-library/react, which only `renderTweak` needs.
 */
const SDK_PEERS = ["react", "react-dom", "valtio", "vitest", "@testing-library/react"];
/** peers whose range isn't package.json's: the fixtures need `test.extend` and `onTestFinished` (2.1.4); tested with Vitest 3 and 4 */
const SDK_PEER_RANGES = { vitest: "^2.1.4 || ^3.0.0 || ^4.0.0" };
const SDK_EXPORTS = {
    ".": { types: "./index.d.ts", default: "./index.js" },
    "./test": { types: "./test.d.ts", default: "./test.js" },
    "./tsconfig.json": "./tsconfig.json",
    "./package.json": "./package.json",
};

let cachedSdkJson = null;

/** src/shared/generatedFiles.ts, bundled to run here: Folder Sync's generator of the SDK's index.d.ts and tsconfig.json */
async function generatedFilesModule() {
    const bundle = await rolldown({ input: path.join(root, "src/shared/generatedFiles.ts"), platform: "node", logLevel: "silent" });
    const { output } = await bundle.generate({ format: "esm" });
    await bundle.close();
    return import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString("base64")}`);
}

/** test.d.ts's declarations (path under src/ → text), with `.js` on relative imports so any moduleResolution finds them */
async function sdkDeclarations() {
    const ts = (await import("typescript")).default;
    const cfg = ts.getParsedCommandLineOfConfigFile(path.join(root, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
    const src = path.join(root, "src");
    const program = ts.createProgram([path.join(src, "testing/test.ts"), path.join(src, "types/globals.d.ts"), path.join(src, "types/tt-api.d.ts")], {
        ...cfg.options,
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        rootDir: src,
        outDir: src,
    });
    const emitted = new Map();
    const res = program.emit(undefined, (file, text) => emitted.set(path.relative(src, file).split(path.sep).join("/"), text));
    if (res.emitSkipped || res.diagnostics.length) {
        throw new Error(`SDK typings: ${ts.formatDiagnostics(res.diagnostics, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => root, getNewLine: () => "\n" })}`);
    }
    const out = new Map();
    const queue = ["testing/test.d.ts"];
    while (queue.length) {
        const file = queue.pop();
        if (out.has(file)) continue;
        const text = emitted.get(file).replace(/((?:from|import)\s*\(?\s*")(\.\.?\/[^"]*)(")/g, (all, pre, spec, post) => {
            const base = path.posix.join(path.posix.dirname(file), spec);
            const hit = [".d.ts", "/index.d.ts"].map((ext) => base + ext).find((f) => emitted.has(f));
            if (!hit) throw new Error(`SDK typings: ${file} imports ${spec}, which has no declarations`);
            queue.push(hit);
            return pre + spec + (hit.endsWith("/index.d.ts") ? "/index.js" : ".js") + post;
        });
        out.set(file, text);
    }
    return out;
}

/** every file under `dir` (relative path, "/"-separated) → text */
async function readTree(dir) {
    const out = {};
    for (const f of await readdir(dir, { recursive: true, withFileTypes: true })) {
        if (!f.isFile()) continue;
        const full = path.join(f.parentPath, f.name);
        out[path.relative(dir, full).split(path.sep).join("/")] = await readFile(full, "utf8");
    }
    return out;
}

/** Build the SDK into dist-sdk/ (the npm package) and return lib/tangitweak-sdk.json's text. */
async function buildSdk() {
    await rm(SDK_DIR, { recursive: true, force: true });
    await mkdir(SDK_DIR, { recursive: true });
    const rootPkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
    const version = manifest.version_name || manifest.version;
    const rangeOf = (name) => {
        const range = rootPkg.dependencies?.[name] ?? rootPkg.devDependencies?.[name];
        if (!range) throw new Error(`SDK: ${name} isn't in package.json`);
        return range;
    };

    const external = [...SDK_DEPENDENCIES, ...SDK_PEERS];
    const bundle = await rolldown({
        input: { index: path.join(root, "src/testing/standalone.ts"), test: path.join(root, "src/testing/test.ts") },
        platform: "node",
        external: (id) => id.startsWith("node:") || external.some((name) => id === name || id.startsWith(`${name}/`)),
        transform: {
            define: {
                __MV3__: "false",
                __NO_EVAL__: "false",
                __COMMIT__: JSON.stringify(gitCommit()),
                __HOOK_SRC__: JSON.stringify(""),
                __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
            },
            jsx: { runtime: "automatic", importSource: "react" },
        },
    });
    await bundle.write({
        dir: SDK_DIR,
        format: "esm",
        entryFileNames: "[name].js",
        chunkFileNames: "lib/[name].js",
        // a chunk of its own so it runs before react-dom loads (which looks for a DOM once): imports of external packages go first
        codeSplitting: { groups: [{ name: "dom", test: /src[\\/]testing[\\/]dom\.ts$/ }] },
    });
    await bundle.close();

    for (const [file, text] of await sdkDeclarations()) {
        await mkdir(path.dirname(path.join(SDK_DIR, "types", file)), { recursive: true });
        await writeFile(path.join(SDK_DIR, "types", file), text);
    }
    await writeFile(path.join(SDK_DIR, "test.d.ts"), `export * from "./types/testing/test.js";\n`);

    const { sdkFiles } = await generatedFilesModule();
    for (const [file, text] of Object.entries(sdkFiles(await readFile(path.join(root, "src/types/tt-api.d.ts"), "utf8")))) {
        await writeFile(path.join(SDK_DIR, file), text);
    }
    await copyFile(path.join(root, "src/testing/README.md"), path.join(SDK_DIR, "README.md"));
    await copyFile(path.join(root, "LICENSE"), path.join(SDK_DIR, "LICENSE"));

    const pkg = {
        name: "tangitweak",
        version,
        description: "Write, type-check and test TangiTweak tweaks: the `tweak` API and `tangitweak/test`.",
        license: rootPkg.license,
        repository: rootPkg.repository,
        homepage: "https://github.com/tangistudio/TangiTweak#readme",
        keywords: ["tangitweak", "browser-extension", "userscript", "testing", "vitest"],
        type: "module",
        types: "./index.d.ts",
        exports: SDK_EXPORTS,
        files: ["*.js", "*.d.ts", "lib/", "types/", "tsconfig.json"],
        engines: { node: ">=23.8.0" },
        dependencies: Object.fromEntries(SDK_DEPENDENCIES.map((name) => [name, rangeOf(name)])),
        peerDependencies: Object.fromEntries(SDK_PEERS.map((name) => [name, SDK_PEER_RANGES[name] ?? rangeOf(name)])),
        peerDependenciesMeta: Object.fromEntries(SDK_PEERS.map((name) => [name, { optional: true }])),
    };
    await writeFile(path.join(SDK_DIR, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

    const files = await readTree(SDK_DIR);
    // the built-ins' typings, which the tsconfig maps valtio and React to (Folder Sync writes them from lib/builtin-types.json)
    for (const [p, text] of Object.entries(await builtinTypes())) {
        const file = path.join(SDK_DIR, "types/builtin", p);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, text);
    }
    await checkSdkPackage();

    const jsonText = JSON.stringify(files);
    const bytes = Buffer.byteLength(jsonText);
    if (bytes > 5 * 1024 * 1024) throw new Error(`tangitweak-sdk.json exceeds AMO's 5 MB per-file limit (${bytes} bytes)`);
    console.log(`built dist-sdk/ + tangitweak-sdk.json (${(bytes / 1024).toFixed(0)} KB)`);
    cachedSdkJson = jsonText;
    return jsonText;
}

/** what `npm pack` puts in the SDK has every file its exports name, with the typings they need */
async function checkSdkPackage() {
    const [{ files }] = JSON.parse(execSync("npm pack --dry-run --json --ignore-scripts", { cwd: SDK_DIR, stdio: ["ignore", "pipe", "pipe"] }).toString());
    const packed = new Set(files.map((f) => f.path));
    const targets = Object.values(SDK_EXPORTS).flatMap((t) => (typeof t === "string" ? [t] : Object.values(t)));
    const missing = targets.map((t) => t.replace(/^\.\//, "")).filter((t) => !packed.has(t));
    if (missing.length) throw new Error(`SDK package: exports name files npm pack leaves out: ${missing.join(", ")}`);
    const has = (file, re) => packed.has(file) && re.test(readFileSync(path.join(SDK_DIR, file), "utf8"));
    const checks = [
        ["index.d.ts", /declare module "tangitweak"/],
        ["types/testing/test.d.ts", /export declare function createTweakTest\b/],
        ["types/testing/test.d.ts", /export declare function renderTweak\b/],
        ["types/builtin/@types/react/index.d.ts", /\S/],
        ["types/builtin/valtio/esm/index.d.mts", /\S/],
    ];
    const bad = checks.filter(([file, re]) => !has(file, re)).map(([file]) => file);
    if (bad.length) throw new Error(`SDK package: typings missing from ${[...new Set(bad)].join(", ")}`);
    console.log(`dist-sdk/: npm pack has ${files.length} files, exports and typings present`);
}

async function getSdkJson() {
    return cachedSdkJson ?? buildSdk();
}

async function buildAll() {
    cachedSdkJson = null;
    await buildSdk();
    // MV2: dist/ (existing output, unchanged behavior) + dist-mv2/ copy
    await rm(path.join(root, "dist"), { recursive: true, force: true });
    await mkdir(path.join(root, "dist"), { recursive: true });
    await buildOnce(path.join(root, "dist"), false);
    await rm(path.join(root, "dist-mv2"), { recursive: true, force: true });
    await cp(path.join(root, "dist"), path.join(root, "dist-mv2"), { recursive: true });
    console.log("dist-mv2/ (copy of dist/) written");
    const firefox = path.join(root, "dist-firefox");
    await rm(firefox, { recursive: true, force: true });
    await cp(path.join(root, "dist"), firefox, { recursive: true });
    const mv2 = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
    await writeFile(path.join(firefox, "manifest.json"), JSON.stringify(firefoxManifest(mv2), null, 4) + "\n");
    console.log("dist-firefox/ (dist/ + MAIN-world hook) written");

    // MV3: service worker + sandbox compile host
    await rm(path.join(root, "dist-mv3"), { recursive: true, force: true });
    await mkdir(path.join(root, "dist-mv3"), { recursive: true });
    await buildOnce(path.join(root, "dist-mv3"), true);
}

await buildAll();

if (WATCH) {
    // lightweight rebuild loop using fs.watch on src + manifest
    const { watch } = await import("node:fs");
    let rebuilding = false;
    const rebuild = async () => {
        if (rebuilding) return;
        rebuilding = true;
        try {
            await buildAll();
            console.log("── rebuilt");
        } catch (e) {
            console.error(e);
        } finally {
            rebuilding = false;
        }
    };
    watch(path.join(root, "src"), { recursive: true }, rebuild);
    watch(path.join(root, "manifest.json"), rebuild);
    console.log("watching for changes…");
}

/**
 * Drop the TS lib .d.ts files the editor never loads from Monaco's
 * tsWorker.js (webworker, esnext, …). Keeps it under AMO's 5 MB
 * per-file limit so the Firefox build can be signed. The kept set is the
 * `lib:` list in monacoSetup.ts plus everything it `/// <reference lib>`s.
 */
async function pruneTsWorkerLibs(file) {
    const AMO_MAX_FILE = 5 * 1024 * 1024;
    if (!existsSync(file)) return;
    const setup = await readFile(path.join(root, "src/ui/monacoSetup.ts"), "utf8");
    const roots = [...(setup.match(/lib:\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (!roots.length) throw new Error("pruneTsWorkerLibs: no lib list in monacoSetup.ts");
    const src = await readFile(file, "utf8");
    const libs = new Map(); // name → [start, end) of `X["name"]=`…`;`
    for (const m of src.matchAll(/\w+\["(lib\.[\w.]+\.d\.ts)"\]=`/g)) {
        let i = m.index + m[0].length;
        while (src[i] !== "`") i += src[i] === "\\" ? 2 : 1;
        libs.set(m[1], [m.index, src[i + 1] === ";" ? i + 2 : i + 1, src.slice(m.index + m[0].length, i)]);
    }
    const keep = new Set();
    const queue = [...roots];
    while (queue.length) {
        const n = queue.pop();
        if (keep.has(n) || !libs.has(n)) continue;
        keep.add(n);
        for (const r of libs.get(n)[2].matchAll(/<reference lib=\\?"([\w.]+)\\?"/g)) queue.push(`lib.${r[1].toLowerCase()}.d.ts`);
    }
    if (roots.some((r) => !keep.has(r))) throw new Error(`pruneTsWorkerLibs: missing ${roots.filter((r) => !keep.has(r))}`);
    // back to front so earlier offsets stay valid: drop unused libs, and
    // strip line indentation from kept ones (irrelevant to the type checker
    // and to JSDoc hovers, and ~5% of the file)
    let out = src;
    let dropped = 0;
    for (const [n, [start, end]] of [...libs].sort((a, b) => b[1][0] - a[1][0])) {
        const repl = keep.has(n) ? src.slice(start, end).replace(/\n[ \t]+/g, "\n") : "";
        if (!keep.has(n)) dropped++;
        out = out.slice(0, start) + repl + out.slice(end);
    }
    const bytes = Buffer.byteLength(out);
    if (bytes > AMO_MAX_FILE) throw new Error(`pruneTsWorkerLibs: tsWorker.js is ${bytes} bytes, over AMO's ${AMO_MAX_FILE}-byte per-file limit — narrow the lib list in monacoSetup.ts`);
    await writeFile(file, out);
    console.log(`tsWorker.js: kept ${keep.size} TS libs, dropped ${dropped} (${(src.length / 1e6).toFixed(2)} → ${(out.length / 1e6).toFixed(2)} MB)`);
}
