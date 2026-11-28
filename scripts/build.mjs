/**
 * Build: bundles TS entries with Rolldown, copies static assets.
 *
 * Two targets, both Manifest V3 with the sandbox-based compile:
 *   dist-chrome/         Chrome (service worker and an offscreen document)
 *   dist-firefox/        Firefox, the .xpi (event page that frames the
 *                        sandbox host, blocking webRequest), built with
 *                        __FIREFOX__ so Chromium-only APIs are left out
 *
 * Both manifests are derived from manifest.json at build time.
 */
import { rolldown } from "rolldown";
import { cp, mkdir, rm, writeFile, copyFile, readFile, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { sdkDeclarations, undocumented } from "./sdkTypings.mjs";

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

/**
 * `firefox`: the Firefox build, where `__FIREFOX__` drops what Firefox lacks
 * (chrome.debugger, chrome.offscreen, webRequest.onActionIgnored) so AMO's linter doesn't flag it
 * @type {import('rolldown').InputOptions[]}
 */
function entriesFor(dist, firefox = false) {
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
            input: path.join(root, "src/overlay/overlayBoot.ts"),
            output: { file: path.join(dist, "overlay.js"), format: "iife" },
        },
        {
            // a toast pane drawn in the page ("Debugger-friendly overlays"), injected by the background
            input: path.join(root, "src/overlay/paneWorld.ts"),
            output: { file: path.join(dist, "pane.js"), format: "iife" },
        },
    ];
    list.push(
        {
            // offscreen document: bridges the SW ⇄ sandbox iframe
            input: path.join(root, "src/background/offscreen.ts"),
            output: { file: path.join(dist, "offscreen.js"), format: "iife" },
        },
        {
            // sandbox page: the only extension context where eval is allowed
            input: path.join(root, "src/background/sandbox.ts"),
            output: { file: path.join(dist, "sandbox.js"), format: "iife" },
        },
        {
            // world: "isolated" onPage code, in a chrome.userScripts world (src/background/userScripts.ts)
            input: path.join(root, "src/hook/isolated.ts"),
            output: { file: path.join(dist, "isolated.js"), format: "iife" },
        }
    );
    // content scripts: no code from strings (the page world gets onSite code as user scripts, src/shared/siteCode.ts)
    const noEval = (e) => /[/\\](hook|bridge)\.js$/.test(e.output.file);
    for (const e of list) {
        e.transform = {
            define: { __FIREFOX__: firefox ? "true" : "false", __NO_EVAL__: noEval(e) ? "true" : "false", __COMMIT__: JSON.stringify(gitCommit()), __BUILD_TIME__: JSON.stringify(new Date().toISOString()), "process.env.NODE_ENV": JSON.stringify("production") },
            jsx: { runtime: "automatic", importSource: "react" },
        };
    }
    return list;
}

/**
 * The page hook as a MAIN-world content script, so it patches fetch/XHR
 * before the page's own scripts run (Firefox 128+, Chrome MV3).
 */
/**
 * The sandbox pages' CSP in Firefox, which (unlike Chrome) doesn't let them
 * eval by default: they compile and run scripts
 */
const FIREFOX_SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals; script-src 'self' 'unsafe-inline' 'unsafe-eval'; child-src 'self';";

/*
 * manifest.json is the Chrome manifest, with Firefox's browser_specific_settings. In it:
 * - optional userScripts: onPage/onSite code (src/background/userScripts.ts), asked for
 *   from the Editor; nativeMessaging + browsingData: the local helper only, asked for
 *   from Settings → Local helper (debugger and proxy can't be optional in Chrome)
 * - sandbox pages are exempt from the extension CSP: sandbox.html hosts the script
 *   compiler/runner (src/background/sandbox.ts), overlay.html a script's overlay
 *   (src/overlay/overlayRuntime.ts)
 */

/** manifest.json → Chrome manifest object (Chrome warns about browser_specific_settings) */
function chromeManifest(m) {
    const { browser_specific_settings: _gecko, ...chrome } = m;
    return chrome;
}

/**
 * manifest.json → Firefox manifest object, where
 * - the background is an event page (Firefox has no background service
 *   worker) that frames offscreen.html itself (no chrome.offscreen)
 * - blocking webRequest stays, for the extension strategy
 * - chrome.debugger and version_name don't exist (the xpi is named after the release tag instead)
 */
function firefoxManifest(m) {
    const { version_name: _versionName, minimum_chrome_version: _minChrome, background: _background, ...ff } = m;
    return {
        ...ff,
        background: { scripts: ["background.js"] },
        permissions: ff.permissions.filter((p) => p !== "debugger" && p !== "offscreen").concat("webRequestBlocking", "webRequestFilterResponse"),
        content_security_policy: { sandbox: FIREFOX_SANDBOX_CSP },
    };
}

async function buildOnce(dist, firefox = false) {
    for (const entry of entriesFor(dist, firefox)) {
        const bundle = await rolldown(entry);
        await bundle.write({ file: entry.output.file, format: entry.output.format });
        await bundle.close();
        console.log("built", path.relative(root, entry.output.file));
    }
    await copyStatic(dist, firefox);
}

/**
 * lib/monaco/: Monaco's ESM build, bundled.
 *
 *   editor.main.js/.css  src/ui/monacoBundle.ts (window.monaco), and the codicon font
 *   *.worker.js          its module workers (monacoSetup.ts's getWorker)
 *   ts.libs.js           the TS worker's lib .d.ts files
 *
 * The TS worker's compiler is our typescript (6.x), not the TS 5.9 Monaco bundles,
 * so newer web APIs (navigation, URLPattern, …) type-check. Its libs are
 * the `lib:` list in monacoSetup.ts plus everything that `/// <reference lib>`s,
 * in their own file so every file stays under AMO's 5 MB per-file limit and
 * the Firefox build can be signed.
 *
 * Built once per change of its inputs (into node_modules/.cache) and copied
 * into each dist.
 */
const MONACO_ESM = path.join(root, "node_modules/monaco-editor/esm/vs");
const MONACO_CACHE = path.join(root, "node_modules/.cache/tangitweak-monaco");
const AMO_MAX_FILE = 5 * 1024 * 1024;
let monacoBuild = { key: "", done: null };

function buildMonaco() {
    const setup = readFileSync(path.join(root, "src/ui/monacoSetup.ts"), "utf8");
    const libRoots = [...(setup.match(/lib:\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (!libRoots.length) throw new Error("buildMonaco: no lib list in monacoSetup.ts");
    const key = JSON.stringify([libRoots, readFileSync(path.join(root, "src/ui/monacoBundle.ts"), "utf8"), readFileSync(new URL(import.meta.url), "utf8")]);
    if (monacoBuild.key !== key) monacoBuild = { key, done: buildMonacoTo(MONACO_CACHE, libRoots) };
    return monacoBuild.done;
}

async function buildMonacoTo(out, libRoots) {
    await rm(out, { recursive: true, force: true });
    // TS's compiler uses eval; Monaco's `new URL("…worker.js", import.meta.url)` fallbacks never run (getWorker wins)
    const quiet = { logLevel: "warn", onLog: (level, log, handler) => log.code !== "EVAL" && log.code !== "EMPTY_IMPORT_META" && handler(level, log) };

    const fonts = new Set();
    const css = new Map();
    const main = await rolldown({
        input: path.join(root, "src/ui/monacoBundle.ts"),
        ...quiet,
        plugins: [
            {
                // CSS imports → one editor.main.css, in import order; url()s → files beside it
                name: "monaco-css",
                load(id) {
                    if (!id.endsWith(".css")) return null;
                    css.set(id, readFileSync(id, "utf8").replace(/url\((['"]?)(\.[^'")]+)\1\)/g, (_, _q, rel) => {
                        const file = path.resolve(path.dirname(id), rel);
                        fonts.add(file);
                        return `url(${path.basename(file)})`;
                    }));
                    return { code: "", moduleType: "js", moduleSideEffects: true };
                },
                generateBundle() {
                    // ES module evaluation order: imports (then dynamic imports) before the importer
                    const order = [];
                    const seen = new Set();
                    const visit = (id) => {
                        if (seen.has(id)) return;
                        seen.add(id);
                        const info = this.getModuleInfo(id);
                        for (const d of [...(info?.importedIds ?? []), ...(info?.dynamicallyImportedIds ?? [])]) visit(d);
                        if (css.has(id)) order.push(css.get(id));
                    };
                    visit([...this.getModuleIds()].find((id) => this.getModuleInfo(id)?.isEntry));
                    if (order.length !== css.size) throw new Error(`buildMonaco: ordered ${order.length} of ${css.size} CSS files`);
                    this.emitFile({ type: "asset", fileName: "editor.main.css", source: order.join("\n") });
                },
            },
        ],
    });
    await main.write({ dir: out, entryFileNames: "editor.main.js", format: "iife", codeSplitting: false, minify: true });
    await main.close();
    for (const f of fonts) await copyFile(f, path.join(out, path.basename(f)));

    const tsLib = path.join(MONACO_ESM, "languages/features/typescript/lib");
    const workers = await rolldown({
        input: {
            "editor.worker": path.join(MONACO_ESM, "editor/editor.worker.js"),
            "json.worker": path.join(MONACO_ESM, "language/json/json.worker.js"),
            "ts.worker": path.join(MONACO_ESM, "language/typescript/ts.worker.js"),
        },
        ...quiet,
        plugins: [
            {
                name: "our-typescript",
                resolveId(source, importer) {
                    if (!importer) return null;
                    const file = source.startsWith(".") ? path.resolve(path.dirname(importer), source) : null;
                    if (file === path.join(tsLib, "typescriptServices.js")) return "\0ts-services";
                    if (file === path.join(tsLib, "lib.js")) return { id: "./ts.libs.js", external: true };
                    // TS reaches for Node modules only when it runs in Node
                    if (importer.startsWith(path.join(root, "node_modules/typescript/lib")) && !source.startsWith(".")) return "\0empty";
                    return null;
                },
                load(id) {
                    if (id === "\0empty") return "export default {};";
                    if (id === "\0ts-services") {
                        return `import ts from "typescript";
export const { EndOfLineState, IndentStyle, ScriptKind, ScriptTarget, TokenClass, createClassifier, createLanguageService, displayPartsToString, flattenDiagnosticMessageText } = ts;
export { ts as typescript };`;
                    }
                    return null;
                },
            },
        ],
    });
    await workers.write({ dir: out, entryFileNames: "[name].js", chunkFileNames: "[name]-[hash].js", format: "esm", minify: true });
    await workers.close();
    await writeFile(path.join(out, "ts.libs.js"), await tsLibsModule(libRoots));

    for (const f of await readdir(out)) {
        const bytes = (await readFile(path.join(out, f))).length;
        if (bytes > AMO_MAX_FILE) throw new Error(`buildMonaco: lib/monaco/${f} is ${bytes} bytes, over AMO's ${AMO_MAX_FILE}-byte per-file limit`);
    }
    console.log(`lib/monaco built (TypeScript ${JSON.parse(readFileSync(path.join(root, "node_modules/typescript/package.json"), "utf8")).version})`);
}

/** `export const libFileMap` of our typescript's lib files the roots need, line indentation stripped (irrelevant to the checker and hovers) */
async function tsLibsModule(roots) {
    const dir = path.join(root, "node_modules/typescript/lib");
    const keep = {};
    const queue = [...roots];
    while (queue.length) {
        const n = queue.pop();
        if (n in keep) continue;
        if (!existsSync(path.join(dir, n))) throw new Error(`buildMonaco: no ${n} in typescript`);
        keep[n] = (await readFile(path.join(dir, n), "utf8")).replace(/\n[ \t]+/g, "\n");
        for (const r of keep[n].matchAll(/<reference lib="([\w.]+)"/g)) queue.push(`lib.${r[1].toLowerCase()}.d.ts`);
    }
    return `export const libFileMap = ${JSON.stringify(keep)};\n`;
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

async function copyStatic(dist, firefox = false) {
    await mkdir(path.join(dist, "lib", "monaco"), { recursive: true });

    // storeIcon.png is for the store listing only — no manifest references it
    await cp(path.join(root, "icons"), path.join(dist, "icons"), { recursive: true, filter: (src) => path.basename(src) !== "storeIcon.png" });
    const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
    await writeFile(path.join(dist, "manifest.json"), JSON.stringify(firefox ? firefoxManifest(manifest) : chromeManifest(manifest), null, 4) + "\n");
    await copyFile(path.join(root, "src/background/offscreen.html"), path.join(dist, "offscreen.html"));
    await copyFile(path.join(root, "src/background/sandbox.html"), path.join(dist, "sandbox.html"));
    await copyFile(path.join(root, "src/ui/editor.html"), path.join(dist, "editor.html"));
    await copyFile(path.join(root, "src/overlay/overlay.html"), path.join(dist, "overlay.html"));
    await copyFile(path.join(root, "src/ui/ui.css"), path.join(dist, "ui.css"));
    await copyFile(path.join(root, "src/ui/popup.html"), path.join(dist, "popup.html"));
    await copyFile(path.join(root, "src/ui/popup.css"), path.join(dist, "popup.css"));
    await copyFile(path.join(root, "src/ui/install.html"), path.join(dist, "install.html"));
    await copyFile(path.join(root, "src/ui/install.css"), path.join(dist, "install.css"));
    await copyFile(path.join(root, "src/ui/theme.css"), path.join(dist, "theme.css"));
    await copyFile(path.join(root, "src/ui/theme-boot.js"), path.join(dist, "theme-boot.js"));

    await buildMonaco();
    await cp(MONACO_CACHE, path.join(dist, "lib/monaco"), { recursive: true });

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
                __FIREFOX__: "false",
                __NO_EVAL__: "false",
                __COMMIT__: JSON.stringify(gitCommit()),
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

    const declarations = await sdkDeclarations();
    const missing = undocumented({
        "index.d.ts": await readFile(path.join(root, "src/types/tt-api.d.ts"), "utf8"),
        ...Object.fromEntries([...declarations].map(([file, text]) => [`types/${file}`, text])),
    });
    if (missing.length) {
        throw new Error(`SDK typings: ${missing.length} undocumented (docs/development.md#documenting-the-sdk):\n  ${missing.join("\n  ")}`);
    }
    for (const [file, text] of declarations) {
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

/** Firefox lacks these: AMO's linter flags each call (UNSUPPORTED_API), so `__FIREFOX__` must leave them out */
const CHROMIUM_ONLY_CALL = /\bchrome\.debugger\.\w|\bonActionIgnored\??\.addListener|\bchrome\.offscreen\b|\.offscreen\.(createDocument|closeDocument)/;

async function checkFirefoxBuild(dir) {
    const bad = [];
    for (const name of await readdir(dir)) {
        if (name.endsWith(".js") && CHROMIUM_ONLY_CALL.test(await readFile(path.join(dir, name), "utf8"))) bad.push(name);
    }
    if (bad.length) throw new Error(`dist-firefox/: Chromium-only API calls in ${bad.join(", ")} (guard them with __FIREFOX__)`);
    console.log("dist-firefox/: no Chromium-only API calls");
}

async function buildAll() {
    cachedSdkJson = null;
    await buildSdk();
    const firefox = path.join(root, "dist-firefox");
    await rm(firefox, { recursive: true, force: true });
    await mkdir(firefox, { recursive: true });
    await buildOnce(firefox, true);
    await checkFirefoxBuild(firefox);

    await rm(path.join(root, "dist-chrome"), { recursive: true, force: true });
    await mkdir(path.join(root, "dist-chrome"), { recursive: true });
    await buildOnce(path.join(root, "dist-chrome"));
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

