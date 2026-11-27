/**
 * Shared E2E check (MV3): folders and JSON data files, driven by the
 * background messages the Explorer uses. A tweak `limiter` holds a
 * folder `mock` — itself a tweak — with a data file `mock/rate-limits.json`;
 * `limiter`'s entry imports `./mock/rate-limits.json` (rules strategy: a
 * request header from the JSON), `mock`'s entry imports `./rate-limits.json`
 * (page strategy: a replaced body from the JSON). Editing the JSON hot-applies
 * both; invalid JSON is a problem of its importers. checkExplorerUi drives
 * the Explorer tree and the Code view the same way a user does.
 *
 * `foldersServerRoute` serves the endpoints; call it in the suite's test
 * server.
 */
import type http from "node:http";
import { seedTweakPkg } from "./e2eTweak";

type Check = (name: string, ok: boolean, extra?: string) => void;

export function foldersServerRoute(req: http.IncomingMessage, res: http.ServerResponse, origin: string): boolean {
    const url = new URL(req.url || "/", origin);
    const json = (body: unknown): true => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return true;
    };
    if (url.pathname === "/folders-page") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body>FOLDERS-PAGE</body></html>");
        return true;
    }
    if (url.pathname === "/folders-echo") return json({ headers: req.headers });
    if (url.pathname === "/folders-api") return json({ original: true });
    return false;
}

export async function checkFoldersAndDataFiles(ctx: any, mgr: any, origin: string, check: Check, label = ""): Promise<void> {
    const t = (s: string) => `folders${label}: ${s}`;
    const send = (msg: any): Promise<any> => mgr.evaluate((m: any) => new Promise((r) => chrome.runtime.sendMessage(m, (x: any) => r(x ?? null))), msg);
    const O = JSON.stringify(origin);

    const made = await send({ type: "createFolder", path: "limiter/mock" });
    check(t("createFolder"), !!made && !made.error && (await send({ type: "listFolders" })).includes("limiter/mock"), JSON.stringify(made));
    const data = await send({ type: "saveDataFile", path: "limiter/mock/rate-limits.json", text: '{ "max": 5 }' });
    check(t("saveDataFile in the folder"), !!data?.id && data.path === "limiter/mock/rate-limits.json", JSON.stringify(data));
    const listed = await send({ type: "listDataFiles" });
    check(t("listDataFiles lists it"), listed?.some((d: any) => d.id === data?.id && d.text === '{ "max": 5 }'), JSON.stringify(listed));

    await seedTweakPkg(send, "limiter");
    await seedTweakPkg(send, "limiter/mock");
    const root = await send({
        type: "saveScript",
        id: "s_folders_root",
        name: "limiter/index",
        code: [`import limits from "./mock/rate-limits.json";`, `import { tweak } from "tangitweak"; tweak.onRequest({ url: ${O} + "/folders-echo*", strategy: "rules" }, () => ({ headers: { set: { "x-tt-limit": String(limits.max) } } }));`].join("\n"),
    });
    check(t("a tweak importing ./mock/rate-limits.json saves"), !!root && !root.error && root.meta?.active === true, JSON.stringify({ error: root?.error, active: root?.meta?.active }));
    const inner = await send({
        type: "saveScript",
        id: "s_folders_inner",
        name: "limiter/mock/index",
        code: [`import { max } from "./rate-limits.json";`, `import { tweak } from "tangitweak"; tweak.onRequest({ url: ${O} + "/folders-api", strategy: "page" }, () => ({ replaceResponse: { body: { max, from: "mock/api mock" } } }));`].join("\n"),
    });
    check(t("a tweak inside the folder saves under its path"), !!inner && !inner.error && inner.meta?.name === "limiter/mock/index", JSON.stringify({ error: inner?.error, name: inner?.meta?.name }));

    const probe = async (want: number): Promise<any> => {
        let r: any = {};
        for (let i = 0; i < 24; i++) {
            const page = await ctx.newPage();
            await page.goto(`${origin}/folders-page`, { waitUntil: "load" });
            await page.waitForTimeout(300); // the page hook gets its scripts asynchronously
            r = await page
                .evaluate(async () => ({
                    header: (await (await fetch("/folders-echo?x=1")).json()).headers["x-tt-limit"],
                    api: await (await fetch("/folders-api")).json(),
                }))
                .catch((e: any) => ({ error: String(e) }));
            await page.close();
            if (r.header === String(want) && r.api?.max === want) break;
            await new Promise((res) => setTimeout(res, 250));
        }
        return r;
    };
    let r = await probe(5);
    check(t("the outer tweak's effect comes from the JSON (rules: header)"), r.header === "5", JSON.stringify(r));
    check(t("the tweak inside the folder runs, with the JSON (page: replaced body)"), r.api?.max === 5 && r.api?.from === "mock/api mock", JSON.stringify(r));

    const edited = await send({ type: "saveDataFile", id: data.id, text: '{ "max": 9 }' });
    check(t("editing the data file saves"), edited?.text === '{ "max": 9 }', JSON.stringify(edited));
    r = await probe(9);
    check(t("editing the JSON hot-applies to its importers"), r.header === "9" && r.api?.max === 9, JSON.stringify(r));

    await send({ type: "saveDataFile", id: data.id, text: '{ "max": }' });
    const problem = await mgr
        .waitForFunction(
            () => [...document.querySelectorAll<HTMLElement>("#problems-list .pb-item.error")].filter((l) => /\blimiter\/index\.ts \[Ln 1\b/.test(l.title)).map((l) => l.textContent || "").find((x) => /limiter\/mock\/rate-limits\.json:1:\d+ is not valid JSON/.test(x)),
            null,
            { timeout: 10000 }
        )
        .then((h: any) => h.jsonValue(), () => null);
    const shown = problem ? "" : await mgr.evaluate(() => [...document.querySelectorAll<HTMLElement>("#problems-list .pb-row")].map((l) => `${l.textContent} | ${l.title}`).join("\n"));
    check(t("invalid JSON → a problem of its importer, naming the file and position, at the import line"), !!problem, String(problem ?? shown));
    const errs = (await send({ type: "listScripts" })).filter((s: any) => s.id.startsWith("s_folders_")).map((s: any) => !!s.error);
    check(t("both importers show the error"), errs.length === 2 && errs.every(Boolean), JSON.stringify(errs));

    await send({ type: "saveDataFile", id: data.id, text: '{ "max": 5 }' });
    const cleared = await mgr.waitForFunction(() => ![...document.querySelectorAll("#problems-list .pb-item.error")].some((l) => /rate-limits\.json/.test(l.textContent || "")), null, { timeout: 10000 }).then(() => true, () => false);
    const left = cleared ? "" : await mgr.evaluate(() => [...document.querySelectorAll<HTMLElement>("#problems-list .pb-row")].map((l) => `${l.textContent} | ${l.title}`).join("\n"));
    check(t("fixing the JSON clears the problem"), cleared, left);

    await checkExplorerUi(ctx, mgr, check, t, data.id);

    const renamed = await send({ type: "renameFolder", from: "limiter/mock", to: "limiter/fixtures" });
    const names = (await send({ type: "listScripts" })).map((s: any) => s.meta.name);
    const paths = (await send({ type: "listDataFiles" })).map((d: any) => d.path);
    check(t("renaming the folder moves its scripts and data files"), !renamed?.error && names.includes("limiter/fixtures/index") && paths.includes("limiter/fixtures/rate-limits.json") && !paths.includes("limiter/mock/rate-limits.json"), JSON.stringify({ renamed, names, paths }));
    const unresolved = (await send({ type: "listScripts" })).find((s: any) => s.id === "s_folders_root");
    check(t("an import specifier isn't rewritten: the outer importer now fails"), /no data file "limiter\/mock\/rate-limits\.json"/.test(unresolved?.error || ""), String(unresolved?.error));

    const del = await send({ type: "deleteFolder", path: "limiter/fixtures" });
    check(t("deleting the folder deletes what's inside"), del?.scripts === 1 && del?.dataFiles === 2 && !(await send({ type: "listFolders" })).includes("limiter/fixtures"), JSON.stringify(del));
    await send({ type: "deleteFolder", path: "limiter" });
}

/** the explorer's rows: data-id, aria-level and shown name */
const explorerRows = (mgr: any): Promise<{ id: string; level: string; name: string }[]> =>
    mgr.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("#script-list li.script-item")].map((li) => ({
            id: li.dataset.id || "",
            level: li.getAttribute("aria-level") || "",
            name: li.querySelector(".script-name")?.textContent || "",
        }))
    );

/**
 * The Explorer tree (order, collapse state, create / rename / delete from the
 * UI) and the Code view (JSON imports typed, JSON errors in the Problems view).
 */
async function checkExplorerUi(ctx: any, mgr: any, check: Check, t: (s: string) => string, dataId: string): Promise<void> {
    const send = (msg: any): Promise<any> => mgr.evaluate((m: any) => new Promise((r) => chrome.runtime.sendMessage(m, (x: any) => r(x ?? null))), msg);
    const row = (id: string): string => `#script-list li.script-item[data-id="${id}"]`;
    await mgr.waitForSelector(row(dataId), { timeout: 10000 }).catch(() => {});

    // order: folder → its scripts → its data files, then the parent's scripts
    let rows = await explorerRows(mgr);
    const at = (id: string): number => rows.findIndex((r) => r.id === id);
    const [dir, inner, json, root] = ["dir:limiter/mock", "s_folders_inner", dataId, "s_folders_root"].map(at);
    check(
        t("explorer: folder, then its script, then its data file, then the parent's scripts"),
        dir >= 0 && dir < inner && inner < json && json < root && rows[inner].level === "3" && rows[json].level === "3" && rows[root].level === "2" && rows[inner].name === "index.ts" && rows[json].name === "rate-limits.json",
        JSON.stringify(rows)
    );

    // the Code view: a JSON import is typed from the data file, no TS errors
    await mgr.click(`${row("s_folders_root")} .script-name`);
    const ts = await mgr.evaluate(async () => {
        const monaco = (window as any).monaco;
        const out: any = {};
        for (let i = 0; i < 40; i++) {
            const m = monaco.editor.getModels().find((x: any) => x.uri.path === "/limiter/index.ts");
            const mi = monaco.editor.getModels().find((x: any) => x.uri.path === "/limiter/mock/index.ts");
            if (m && mi) {
                const w = await (await monaco.typescript.getTypeScriptWorker())(m.uri);
                // (no named helpers in here: tsx would wrap them in __name)
                for (const [key, x] of [["root", m], ["inner", mi]]) {
                    const all = [...(await w.getSyntacticDiagnostics(x.uri.toString())), ...(await w.getSemanticDiagnostics(x.uri.toString()))];
                    out[key] = all.map((d: any) => (typeof d.messageText === "string" ? d.messageText : d.messageText.messageText));
                }
                const info = await w.getQuickInfoAtPosition(m.uri.toString(), m.getValue().indexOf("limits.max") + "limits.m".length);
                out.type = (info?.displayParts || []).map((p: any) => p.text).join("");
                out.markers = monaco.editor.getModelMarkers({ resource: m.uri }).map((mk: any) => mk.message);
                if (!out.root.length && !out.inner.length && /max: number/.test(out.type)) break;
            }
            await new Promise((r) => setTimeout(r, 250));
        }
        return out;
    });
    check(t("Code view: JSON imports resolve with the data file's types (no TS errors)"), !ts.root?.length && !ts.inner?.length && /max: number/.test(ts.type) && !ts.markers?.some((x: string) => /Cannot find module/.test(x)), JSON.stringify(ts));

    // collapse state persists (a second Editor tab reads it)
    await mgr.click(`${row("dir:limiter/mock")} .script-name`);
    const hidden = await mgr.waitForFunction(() => !document.querySelector('#script-list li[data-id="s_folders_inner"]') && document.querySelector('#script-list li[data-id="dir:limiter/mock"]')?.getAttribute("aria-expanded") === "false", null, { timeout: 5000 }).then(() => true, () => false);
    check(t("explorer: clicking a folder collapses it"), hidden);
    const other = await ctx.newPage();
    await other.goto(mgr.url());
    const persisted = await other
        .waitForFunction(() => document.querySelector('#script-list li[data-id="dir:limiter/mock"]')?.getAttribute("aria-expanded") === "false" && !document.querySelector('#script-list li[data-id="s_folders_inner"]'), null, { timeout: 15000 })
        .then(() => true, () => false);
    await other.close();
    check(t("explorer: a collapsed folder stays collapsed (persisted)"), persisted);
    await mgr.click(`${row("dir:limiter/mock")} .script-name`);
    await mgr.waitForSelector(row("s_folders_inner"), { timeout: 5000 }).catch(() => {});

    // New Folder (header button, at the root: the focused row is the root settings.json)
    await mgr.click(`${row("__settings__")} .script-name`);
    await mgr.hover("#explorer-section");
    await mgr.click("#btn-new-folder");
    await mgr.fill("#script-list li.creating input.script-rename", "ui-folder");
    await mgr.press("#script-list li.creating input.script-rename", "Enter");
    const folderRow = await mgr.waitForSelector(row("dir:ui-folder"), { timeout: 5000 }).then(() => true, () => false);
    check(t("explorer: New Folder creates a folder from the inline input"), folderRow && (await send({ type: "listFolders" })).includes("ui-folder"));

    // New JSON File… from the folder's context menu: created inside it, opened
    await mgr.click(`${row("dir:ui-folder")} .script-name`, { button: "right" });
    await mgr.click('.ctx-menu li:has-text("New JSON File…")');
    await mgr.fill("#script-list li.creating input.script-rename", "ui-data");
    await mgr.press("#script-list li.creating input.script-rename", "Enter");
    const created = await mgr
        .waitForFunction(() => (window as any).monaco.editor.getEditors()[0].getModel()?.uri.path === "/ui-folder/ui-data.json", null, { timeout: 5000 })
        .then(() => true, () => false);
    const uiData = (await send({ type: "listDataFiles" })).find((d: any) => d.path === "ui-folder/ui-data.json");
    rows = await explorerRows(mgr);
    check(t("explorer: New JSON File… in a folder creates and opens it there"), created && !!uiData && uiData.text === "{}\n" && rows.some((r) => r.id === uiData.id && r.level === "2"), JSON.stringify({ created, uiData, rows }));

    // invalid JSON: a JSON marker in the Code view + a problem under the data file (with its line), saved with ⌘S
    await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].getModel().setValue('{\n  "a": 1,\n  "b": \n}\n'));
    await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].focus());
    await mgr.keyboard.press("ControlOrMeta+KeyS");
    const saved = await mgr.waitForFunction(() => document.querySelector("#btn-save")?.getAttribute("data-state") === "saved", null, { timeout: 5000 }).then(() => true, () => false);
    const stored = (await send({ type: "listDataFiles" })).find((d: any) => d.id === uiData?.id)?.text;
    check(t("⌘S saves a data file"), saved && stored === '{\n  "a": 1,\n  "b": \n}\n', JSON.stringify({ saved, stored }));
    const pb = await mgr
        .waitForFunction(
            () => {
                const head = [...document.querySelectorAll<HTMLElement>("#problems-list .pb-head")].find((h) => h.querySelector(".pb-file")?.textContent === "ui-folder/ui-data.json");
                const item = [...document.querySelectorAll<HTMLElement>("#problems-list .pb-item.error")].find((l) => /^ui-folder\/ui-data\.json \[Ln [34]\b/m.test(l.title.split("\n\n")[1] || ""));
                const json = (window as any).monaco.editor.getModelMarkers({ owner: "json" }).filter((m: any) => m.resource.path === "/ui-folder/ui-data.json").length;
                return head && item && json && !head.querySelector(".file-icon.ts") ? { icon: head.querySelector(".file-icon")?.textContent, item: item.title } : null;
            },
            null,
            { timeout: 10000 }
        )
        .then((h: any) => h.jsonValue(), () => null);
    const pbShown = pb ? "" : await mgr.evaluate(() => [...document.querySelectorAll<HTMLElement>("#problems-list .pb-row")].map((l) => `${l.textContent} | ${l.title}`).join("\n"));
    check(t("invalid JSON: a JSON error in the Code view and the Problems view, under the data file with its line"), !!pb && pb.icon === "{}", JSON.stringify(pb) + pbShown);
    const red = await mgr.evaluate((id: string) => !!document.querySelector(`#script-list li[data-id="${id}"] .script-name.error`), uiData?.id);
    check(t("explorer: a data file with JSON errors shows red"), red);
    await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].getModel().setValue('{ "a": 1 }\n'));
    await mgr.keyboard.press("ControlOrMeta+KeyS");
    await mgr.waitForFunction(() => document.querySelector("#btn-save")?.getAttribute("data-state") === "saved", null, { timeout: 5000 }).catch(() => {});

    // F2 with a / moves it into another folder; the open file follows
    // the list can still re-render after the save and drop the rename input: retry F2
    const input = "#script-list input.script-rename";
    let before = "";
    for (let i = 0; i < 3; i++) {
        await mgr.click(`${row(uiData?.id)} .script-name`);
        await mgr.keyboard.press("F2");
        before = await mgr.inputValue(input, { timeout: 3000 }).catch(() => "");
        const ok = await mgr.fill(input, "moved/ui-data.json", { timeout: 3000 }).then(() => mgr.press(input, "Enter", { timeout: 3000 })).then(() => true, () => false);
        if (ok) break;
    }
    const moved = await mgr.waitForSelector(row("dir:moved"), { timeout: 5000 }).then(() => true, () => false);
    const movedData = (await send({ type: "listDataFiles" })).find((d: any) => d.id === uiData?.id);
    const shown = await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].getModel()?.uri.path);
    check(t("explorer: F2 rename with a / moves the item"), before === "ui-folder/ui-data.json" && moved && movedData?.path === "moved/ui-data.json" && shown === "/moved/ui-data.json", JSON.stringify({ before, moved, movedData, shown }));

    // an .svg data file: New JSON File… named x.svg, opens as XML, imports as its markup (typed string)
    await mgr.click(`${row("dir:ui-folder")} .script-name`, { button: "right" });
    await mgr.click('.ctx-menu li:has-text("New JSON File…")');
    await mgr.fill("#script-list li.creating input.script-rename", "icon.svg");
    await mgr.press("#script-list li.creating input.script-rename", "Enter");
    const svgLang = await mgr
        .waitForFunction(() => (window as any).monaco.editor.getEditors()[0].getModel()?.uri.path === "/ui-folder/icon.svg" && (window as any).monaco.editor.getEditors()[0].getModel().getLanguageId(), null, { timeout: 5000 })
        .then((h: any) => h.jsonValue(), () => null);
    const svg = (await send({ type: "listDataFiles" })).find((d: any) => d.path === "ui-folder/icon.svg");
    const svgIcon = await mgr.evaluate((id: string) => document.querySelector(`#script-list li[data-id="${id}"] .file-icon`)?.className, svg?.id);
    check(t("explorer: a new .svg data file opens as XML with its own icon"), svgLang === "xml" && /^<svg /.test(svg?.text || "") && /\bsvg\b/.test(svgIcon || ""), JSON.stringify({ svgLang, svg, svgIcon }));
    await seedTweakPkg(send, "ui-folder");
    const svgUser = await send({ type: "saveScript", id: "s_folders_svg", name: "ui-folder/index", code: `import { tweak } from "tangitweak"; import logo from "./icon.svg";\nconst markup: string = logo;\ntweak.params({ markup: { type: "string", default: markup } });\n` });
    const svgDefault = (await send({ type: "listScripts" })).find((s: any) => s.id === "s_folders_svg")?.paramDefs?.markup?.default;
    const svgTs = await mgr.evaluate(async () => {
        const monaco = (window as any).monaco;
        let out: any = null;
        for (let i = 0; i < 40; i++) {
            const m = monaco.editor.getModels().find((x: any) => x.uri.path === "/ui-folder/index.ts");
            if (m) {
                const w = await (await monaco.typescript.getTypeScriptWorker())(m.uri);
                const all = [...(await w.getSyntacticDiagnostics(m.uri.toString())), ...(await w.getSemanticDiagnostics(m.uri.toString()))];
                const info = await w.getQuickInfoAtPosition(m.uri.toString(), m.getValue().indexOf("logo;") + 1);
                out = { diags: all.map((d: any) => (typeof d.messageText === "string" ? d.messageText : d.messageText.messageText)), type: (info?.displayParts || []).map((p: any) => p.text).join("") };
                if (!out.diags.length && /string/.test(out.type)) break;
            }
            await new Promise((r) => setTimeout(r, 250));
        }
        return out;
    });
    check(t("a script imports the .svg as its markup (a string, no TS errors)"), !svgUser?.error && svgDefault === svg?.text && !svgTs?.diags.length && /: string/.test(svgTs?.type || ""), JSON.stringify({ error: svgUser?.error, svgDefault, svgTs }));

    // optional: a picture of the tree (E2E_EXPLORER_SHOT=<png path>)
    if (process.env.E2E_EXPLORER_SHOT) {
        await mgr.bringToFront();
        await mgr.hover("#explorer-section").catch(() => {});
        const clip = await mgr.locator("#sidebar").boundingBox();
        if (clip) await mgr.screenshot({ path: process.env.E2E_EXPLORER_SHOT, clip, animations: "disabled", timeout: 10000 }).catch((e: Error) => console.log("  explorer screenshot failed:", e.message));
    }

    // Delete (asks, with the folder's contents counted)
    let asked = "";
    mgr.once("dialog", (d: any) => {
        asked = d.message();
        void d.accept();
    });
    await mgr.click(`${row("dir:moved")} .script-name`);
    await mgr.keyboard.press("Delete");
    const gone = await mgr.waitForFunction(() => !document.querySelector('#script-list li[data-id="dir:moved"]'), null, { timeout: 5000 }).then(() => true, () => false);
    check(t("explorer: Delete on a folder asks (counting its contents) and deletes it"), gone && /folder "moved" and everything in it \(1 data file\)/.test(asked) && !(await send({ type: "listDataFiles" })).some((d: any) => d.id === uiData?.id), asked);
    await send({ type: "deleteFolder", path: "ui-folder" });
}
