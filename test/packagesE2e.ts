/**
 * Shared E2E check (MV2 + MV3): installing a tweak by opening its
 * package.json's install link. The tab goes to the install page, which lists
 * what the tweak can do; installing writes its package.json, entry, module and
 * JSON file into the tweak's folder and the entry runs. An update that
 * adds a route waits for review (the Explorer marks it; clicking the mark
 * reviews it in the Editor's Install dialog), applying it installs it, and
 * rolling back restores the first version. The Explorer's Install Tweak…
 * button opens the dialog, which takes a dropped file; a link dropped on the
 * Explorer opens the dialog on it; the modules a tweak imports install and
 * run with it. New Tweak… and Export Package… in the Explorer.
 *
 * `packagesServerRoute` serves the tweaks; call it in the suite's test server.
 */
import type http from "node:http";
import { readZip } from "../src/shared/zip";

type Check = (name: string, ok: boolean, extra?: string) => void;

let version = 1;

const entry = (origin: string) => `import { tweak } from "tangitweak"; import { shout } from "./lib";
import cfg from "./cfg.json";
tweak.onRequest({ url: "${origin}/pkg-api", strategy: "page" }, () => ({ replaceResponse: { body: shout(cfg.word) } }));
${version > 1 ? `tweak.onRequest({ url: "${origin}/pkg-other", strategy: "page" }, () => ({ replaceResponse: { body: "OTHER" } }));\n` : ""}`;

export function packagesServerRoute(req: http.IncomingMessage, res: http.ServerResponse, origin: string): boolean {
    const url = new URL(req.url || "/", origin);
    const send = (ct: string, body: string) => {
        res.writeHead(200, { "content-type": ct, "cache-control": "no-store" });
        res.end(body);
    };
    if (url.pathname === "/pkg/package.json") return send("application/json", JSON.stringify({ name: "demo", version: `${version}.0.0`, tangitweak: { displayName: "demo" } })), true;
    if (url.pathname === "/pkg/index.ts") return send("text/plain", entry(origin)), true;
    if (url.pathname === "/pkg/lib.ts") return send("text/plain", 'export const shout = (s: string) => s.toUpperCase() + "!";\n'), true;
    if (url.pathname === "/pkg/cfg.json") return send("application/json", '{ "word": "pkg-ok" }'), true;
    if (url.pathname === "/kit/package.json") return send("application/json", JSON.stringify({ name: "kit", version: "3.0.0", description: "Two modules", tangitweak: { displayName: "Kit" } })), true;
    if (url.pathname === "/kit/index.ts") return send("text/plain", 'import "./a";\nimport "./tools/b";\n'), true;
    if (url.pathname === "/kit/a.ts") return send("text/plain", `import { tweak } from "tangitweak"; import { tag } from "./shared";\ntweak.onRequest({ url: "${origin}/kit-a", strategy: "page" }, () => ({ replaceResponse: { body: tag("A") } }));\n`), true;
    if (url.pathname === "/kit/tools/b.ts") return send("text/plain", `import { tweak } from "tangitweak"; import { tag } from "../shared";\ntweak.onRequest({ url: "${origin}/kit-b", strategy: "page" }, () => ({ replaceResponse: { body: tag("B") } }));\n`), true;
    if (url.pathname === "/kit/shared.ts") return send("text/plain", 'export const tag = (s: string) => "KIT-" + s;\n'), true;
    if (url.pathname === "/pkg-page") return send("text/html", "<html><body>PKG</body></html>"), true;
    if (url.pathname === "/pkg-api") return send("text/plain", "REAL"), true;
    return false;
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10000): Promise<T> {
    const end = Date.now() + ms;
    let v = await fn();
    while (!ok(v) && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 200));
        v = await fn();
    }
    return v;
}

export async function checkPackages(ctx: any, mgr: any, origin: string, check: Check, opts: { label?: string } = {}): Promise<void> {
    const t = (s: string) => `packages${opts.label ?? ""}: ${s}`;
    const send = (msg: any): Promise<any> => mgr.evaluate((m: any) => new Promise((r) => chrome.runtime.sendMessage(m, (x: any) => r(x ?? null))), msg);
    version = 1;
    const src = `${origin}/pkg/package.json`;

    // opening the package.json's install link lands on the install page
    const tab = await ctx.newPage();
    await tab.goto(`${src}#tangitweak:install`, { timeout: 15000 }).catch(() => {});
    const landed = await waitFor<string>(async () => tab.url(), (u) => u.includes("install.html"), 10000);
    check(t("opening a package.json's install link opens the install page"), landed.includes("install.html?url=") && landed.includes(encodeURIComponent(src)), landed);

    const confirm = await tab.waitForSelector("#install-confirm:not([disabled])", { timeout: 15000 }).then(() => true, () => false);
    const review = await tab.evaluate(() => document.body.innerText);
    check(
        t("the review shows the name, what it can do and its files"),
        confirm && review.includes("demo") && review.includes(`${origin}/pkg-api`) && review.includes("lib.ts") && review.includes("cfg.json"),
        review.slice(0, 400)
    );
    if (confirm) await tab.click("#install-confirm");
    const done = await tab.waitForSelector("text=Open in the Editor", { timeout: 15000 }).then(() => true, () => false);

    const pkgs = (await send({ type: "listPackages" })) || {};
    const pkg: any = Object.values(pkgs).find((p: any) => p.source === src);
    const scripts: any[] = (await send({ type: "listScripts" })) || [];
    const data: any[] = (await send({ type: "listDataFiles" })) || [];
    const names = scripts.filter((s) => s.meta.name.startsWith("demo/")).map((s) => s.meta.name).sort();
    check(
        t("installing writes the package.json, the entry, its module and its JSON into the tweak's folder"),
        done && !!pkg && JSON.stringify(names) === '["demo/index","demo/lib"]' && data.some((d) => d.path === "demo/cfg.json") && data.some((d) => d.path === "demo/package.json") && pkg.autoUpdate === true,
        JSON.stringify({ done, names, data: data.map((d) => d.path), pkg: pkg && { folder: pkg.folder, autoUpdate: pkg.autoUpdate } })
    );
    await tab.close();
    if (!pkg) return;

    const page = await ctx.newPage();
    await page.goto(`${origin}/pkg-page`, { waitUntil: "load", timeout: 15000 });
    const fetchApi = (): Promise<string> => page.evaluate(() => fetch("/pkg-api").then((r) => r.text())).catch(() => "");
    const out = await waitFor(fetchApi, (v) => v === "PKG-OK!", 10000);
    check(t("the installed entry runs with its library and JSON"), out === "PKG-OK!", out);

    await mgr.bringToFront();
    const badge = await mgr.waitForSelector('#script-list li.script-item[data-id="dir:demo"] .file-icon.package', { timeout: 8000 }).then(() => true, () => false);
    check(t("the Explorer shows the package's folder with the package icon"), badge);

    // an update that adds a route waits for review
    version = 2;
    const checked = await send({ type: "packageCheck", id: pkg.id });
    const held = checked?.[pkg.id];
    check(
        t("an update that can do more waits for review"),
        !!held?.pending && held.revision === pkg.revision && held.pending.added.some((a: string) => a.includes("/pkg-other")),
        JSON.stringify({ pending: held?.pending && { added: held.pending.added, reasons: held.pending.reasons }, error: held?.lastError })
    );
    const pendingBadge = await mgr.waitForSelector("#script-list .pkg-ind.pending", { timeout: 8000 }).then(() => true, () => false);
    check(t("the Explorer marks the waiting update"), pendingBadge);

    // clicking the mark reviews the update in the Install dialog
    await mgr.click("#script-list .pkg-ind.pending").catch(() => {});
    const applyShown = await mgr.waitForSelector("#install-dialog #update-apply", { timeout: 15000 }).then(() => true, () => false);
    const rvText = await mgr.evaluate(() => (document.querySelector("#install-dialog") as HTMLElement | null)?.innerText || "");
    check(t("the update review (a dialog in the Editor) shows what the update adds"), applyShown && rvText.includes("Review Update") && rvText.includes("/pkg-other"), rvText.slice(0, 400));
    if (applyShown) await mgr.click("#update-apply");
    await mgr.waitForSelector("#install-dialog >> text=Open in the Editor", { timeout: 15000 }).catch(() => {});
    await mgr.keyboard.press("Escape");
    const updated = (await send({ type: "listPackages" }))?.[pkg.id];
    const other = await waitFor(() => page.evaluate(() => fetch("/pkg-other").then((r) => r.text())).catch(() => ""), (v) => v === "OTHER", 10000);
    check(t("applying the update installs it"), updated?.revision === held?.pending?.revision && !updated.pending && other === "OTHER", JSON.stringify({ revision: updated?.revision, other }));

    const back = await send({ type: "packageRollback", id: pkg.id });
    check(t("rolling back restores the previous version and turns auto-update off"), back?.revision === pkg.revision && back.autoUpdate === false, JSON.stringify({ revision: back?.revision, autoUpdate: back?.autoUpdate, error: back?.error }));
    await page.close();

    for (const s of (await send({ type: "listScripts" })) || []) if (s.meta.name.startsWith("demo/")) await send({ type: "deleteScript", id: s.id });
    for (const d of (await send({ type: "listDataFiles" })) || []) if (d.path.startsWith("demo/")) await send({ type: "deleteDataFile", id: d.id });
    await send({ type: "packageForget", id: pkg.id });

    // the Explorer's Install Tweak… button opens the dialog on the picker; a lone script file dropped on it isn't a tweak
    await mgr.click("#btn-install");
    const picker = await mgr.waitForSelector("#install-dialog #install-drop", { timeout: 8000 }).then(() => true, () => false);
    const dropOn = (sel: string, what: { file?: [string, string]; link?: string }) =>
        mgr.evaluate(
            async ([sel, what]: [string, any]) => {
                const dt = new DataTransfer();
                if (what.file) dt.items.add(new File([what.file[1]], what.file[0]));
                if (what.link) dt.setData("text/uri-list", what.link);
                const el = document.querySelector(sel)!;
                el.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
                await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50)));
                const lit = !!document.querySelector("#sidebar.install-drop, .install-dialog.dropping");
                el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
                return lit;
            },
            [sel, what]
        );
    const fileLit = await dropOn("#install-drop", { file: ["dropped.ts", 'import { tweak } from "tangitweak"; tweak.onPage("*://dropped.test/*", () => {});\n'] });
    const fileText = await waitFor(() => mgr.evaluate(() => (document.querySelector("#install-dialog") as HTMLElement | null)?.innerText || ""), (v: string) => v.includes("no tweak to install"), 8000);
    check(t("Install Tweak… opens a dialog; a lone file dropped on it has no tweak to install"), picker && fileLit && fileText.includes("dropped.ts has no tweak to install"), JSON.stringify({ picker, fileLit, text: fileText.slice(0, 300) }));
    await mgr.click("#install-dialog .btn-close");
    const closed = await mgr.waitForSelector("#install-dialog", { state: "detached", timeout: 5000 }).then(() => true, () => false);
    check(t("the Install dialog closes"), closed);

    // a tweak whose entry imports two modules that register handlers: they install (and run) together. Its link dropped on the Explorer opens the dialog on it.
    const kitSrc = `${origin}/kit/package.json`;
    const linkLit = await dropOn("#script-list", { link: kitSrc });
    const kitConfirm = await mgr.waitForSelector("#install-dialog #install-confirm:not([disabled])", { timeout: 15000 }).then(() => true, () => false);
    const kitReview = await mgr.evaluate(() => (document.querySelector("#install-dialog") as HTMLElement | null)?.innerText || "");
    check(
        t("a link dropped on the Explorer opens its review: the tweak's name, version and what its modules do"),
        linkLit && kitConfirm && kitReview.includes("Kit") && kitReview.includes("3.0.0") && kitReview.includes(`${origin}/kit-a`) && kitReview.includes(`${origin}/kit-b`),
        JSON.stringify({ linkLit, review: kitReview.slice(0, 400) })
    );
    if (kitConfirm) await mgr.click("#install-confirm");
    const kitDone = await mgr.waitForSelector("#install-dialog >> text=Open in the Editor", { timeout: 15000 }).then(() => true, () => false);
    if (kitDone) await mgr.click("#install-dialog >> text=Open in the Editor");
    const kitOpened = await mgr.waitForSelector("#install-dialog", { state: "detached", timeout: 8000 }).then(() => true, () => false);
    const kitIds = (((await send({ type: "listScripts" })) || []) as any[]).filter((s) => s.meta.name.startsWith("kit/")).map((s) => s.id);
    const kitSel = await waitFor(() => mgr.evaluate(() => document.querySelector("#script-list li.script-item.selected")?.getAttribute("data-id") || ""), (v: string) => kitIds.includes(v), 8000);
    check(t("Open in the Editor closes the dialog and selects the installed script"), kitOpened && kitIds.includes(kitSel), JSON.stringify({ kitDone, kitOpened, kitSel, kitIds }));
    const kit: any = Object.values((await send({ type: "listPackages" })) || {}).find((p: any) => p.source === kitSrc);
    const kitNames = (((await send({ type: "listScripts" })) || []) as any[]).filter((s) => s.meta.name.startsWith("kit/")).map((s) => s.meta.name).sort();
    const kp = await ctx.newPage();
    await kp.goto(`${origin}/pkg-page`, { waitUntil: "load", timeout: 15000 });
    const kitOut = await waitFor(() => kp.evaluate(() => Promise.all(["/kit-a", "/kit-b"].map((u) => fetch(u).then((r) => r.text()))).then((x) => x.join())).catch(() => ""), (v) => v === "KIT-A,KIT-B", 10000);
    await kp.close();
    check(
        t("installing a tweak writes and runs its modules as part of it"),
        !!kit && kit.metadata?.version === "3.0.0" && JSON.stringify(kitNames) === '["kit/a","kit/index","kit/shared","kit/tools/b"]' && kitOut === "KIT-A,KIT-B",
        JSON.stringify({ kit: kit && { folder: kit.folder, entries: kit.entries }, kitNames, kitOut })
    );
    await send({ type: "deleteFolder", path: "kit" });
    if (kit) await send({ type: "packageForget", id: kit.id });

    // Explorer → New Tweak…: a folder with a package.json, tsconfig.json, .gitignore and an index.ts
    await mgr.bringToFront();
    // at the root: the focused row is the root settings.json (not a file inside another tweak)
    await mgr.click('#script-list li.script-item[data-id="__settings__"] .script-name');
    await mgr.hover("#explorer-section");
    await mgr.click("#btn-new");
    await mgr.fill("#script-list li.creating input.script-rename", "mkpkg");
    await mgr.press("#script-list li.creating input.script-rename", "Enter");
    const made = await waitFor(
        async () => ({ scripts: ((await send({ type: "listScripts" })) || []) as any[], data: ((await send({ type: "listDataFiles" })) || []) as any[] }),
        ({ scripts, data }) => scripts.some((x) => x.meta.name === "mkpkg/index") && ["package.json", "tsconfig.json", ".gitignore"].every((f) => data.some((d) => d.path === `mkpkg/${f}`)),
    );
    const madeEntry = made.scripts.find((x) => x.meta.name === "mkpkg/index");
    const manifest = JSON.parse(made.data.find((d) => d.path === "mkpkg/package.json")?.text || "{}");
    check(
        t("New Tweak… creates a folder with a package.json (its tangitweak block), tsconfig.json, .gitignore and an index.ts that runs as the tweak"),
        manifest.name === "mkpkg" && manifest.tangitweak?.displayName === "mkpkg" && /^\^/.test(manifest.dependencies?.tangitweak || "") && !!madeEntry && !madeEntry.error && madeEntry.meta.active === true,
        JSON.stringify({ manifest, entry: madeEntry && { error: madeEntry.error, active: madeEntry.meta.active }, data: made.data.map((d) => d.path) }),
    );

    // its package.json: a `main` that names no file is an error in the file
    const manifestId = made.data.find((d) => d.path === "mkpkg/package.json")?.id;
    const manifestRow = `#script-list li.script-item[data-id="${manifestId}"]`;
    if (!(await mgr.$(manifestRow))) await mgr.click('#script-list li.script-item[data-id="dir:mkpkg"]').catch(() => {});
    await mgr.click(manifestRow, { timeout: 5000 }).catch(() => {});
    await mgr.waitForFunction(() => (window as any).monaco.editor.getEditors()[0].getModel()?.uri.path.endsWith("/mkpkg/package.json"), null, { timeout: 8000 }).catch(() => {});
    const manifestOrig = await mgr.evaluate(() => {
        const m = (window as any).monaco.editor.getEditors()[0].getModel();
        const v = m.getValue();
        m.setValue(v.replace('"version"', '"main": "gone.ts",\n    "version"'));
        return v;
    });
    const missingMarker = await waitFor(
        () => mgr.evaluate(() => { const w = window as any; const m = w.monaco.editor.getEditors()[0].getModel(); return w.monaco.editor.getModelMarkers({ resource: m.uri, owner: "tt-manifest" }).map((x: any) => [x.message, m.getValueInRange(x)]); }),
        (v: any[]) => v.length > 0,
        5000
    );
    await mgr.evaluate((v: string) => (window as any).monaco.editor.getEditors()[0].getModel().setValue(v), manifestOrig);
    const missingCleared = await waitFor(() => mgr.evaluate(() => { const w = window as any; return w.monaco.editor.getModelMarkers({ resource: w.monaco.editor.getEditors()[0].getModel().uri, owner: "tt-manifest" }).length; }), (n: number) => n === 0, 5000);
    check(
        t("package.json: a `main` that names no file is an error"),
        JSON.stringify(missingMarker) === JSON.stringify([['this tweak\'s entry "gone.ts" isn\'t in its folder — it doesn\'t run until it is', '"main": "gone.ts"']]) && missingCleared === 0,
        JSON.stringify({ missingMarker, missingCleared })
    );

    // the tweak's folder has the package icon, and Export Package… downloads a zip of it
    const pkgRow = '#script-list li.script-item[data-id="dir:mkpkg"]';
    const icon = await mgr.waitForSelector(`${pkgRow} .file-icon.package`, { timeout: 8000 }).then(() => true, () => false);
    await mgr.evaluate(() => {
        const w = window as any;
        w.__ttDownload = null;
        w.__ttClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
            if (!this.download) return w.__ttClick.call(this);
            const name = this.download;
            void fetch(this.href)
                .then((r) => r.arrayBuffer())
                .then((b) => (w.__ttDownload = { name, bytes: Array.from(new Uint8Array(b)) }));
        };
    });
    await mgr.click(`${pkgRow} .script-name`, { button: "right" });
    await mgr.click('.ctx-menu li:has-text("Export Package…")');
    const dl = await waitFor(() => mgr.evaluate(() => (window as any).__ttDownload), (v: any) => !!v, 8000);
    await mgr.evaluate(() => void (HTMLAnchorElement.prototype.click = (window as any).__ttClick));
    const zipped = dl ? await readZip(new Uint8Array(dl.bytes).buffer) : {};
    check(
        t("a tweak's folder has the package icon, and Export Package… downloads its files as a zip"),
        icon && dl?.name === "mkpkg.zip" && ["mkpkg/index.ts", "mkpkg/package.json", "mkpkg/tsconfig.json"].every((f) => f in zipped),
        JSON.stringify({ icon, name: dl?.name, files: Object.keys(zipped) })
    );
    await send({ type: "deleteFolder", path: "mkpkg" });
}
