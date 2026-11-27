/**
 * E2E regression: the real "Go to Definition" editor action on an imported
 * library function must switch the Code view to the library script.
 * Cold Editor load (the library is never opened before navigation).
 *
 * Usage: npm run build && npx tsx test/definition-nav.e2e.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { resolveBrowser, unpackedExtensionId } from "./browserSetup";
import { saveTweak } from "./e2eTweak";

const EXT_ROOT = path.join(new URL("..", import.meta.url).pathname, "dist-mv3");
const profile = mkdtempSync(path.join(tmpdir(), "reso-defnav-"));
const proc = spawn(await resolveBrowser(), [
    "--headless=new",
    `--user-data-dir=${profile}`,
    `--load-extension=${EXT_ROOT}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 5000));

let failed = 0;
const check = (name: string, ok: boolean, extra = ""): void => {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
};
const finish = async (browser?: any): Promise<never> => {
    await browser?.close().catch(() => {});
    proc.kill();
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 }); } catch {}
    process.exit(failed ? 1 : 0);
};

let browser: any;
try {
const [port] = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n");
browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 90000 });
const ctx = browser.contexts()[0];

const extId = unpackedExtensionId(EXT_ROOT);
const openManager = async (): Promise<any> => {
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${extId}/editor.html`);
    return p;
};

// seed through a throwaway manager page, then cold-load a fresh one
const seed = await openManager();
const seedSend = (msg: any): Promise<any> => seed.evaluate((m: any) => new Promise((r) => chrome.runtime.sendMessage(m, r)), msg);
// the tweak "main script": its entry (index.ts) imports its module utilities.ts
await saveTweak(seedSend, "s_main", "main script", 'import { tweak } from "tangitweak"; import { helper } from "./utilities";\ntweak.onRequest({ url: "*://example.invalid/*", strategy: "page" }, () => {});\nfunction local() {}\nhelper(1);\nlocal();\n');
await saveTweak(seedSend, "u_util", "main script", "export function helper(x: number) {\n    return x + 1;\n}\n", { file: "utilities" });
await seed.close();

let dialogs = 0;
let answer = true;
const mgr = await openManager();
mgr.on("dialog", async (d: any) => { dialogs++; await (answer ? d.accept() : d.dismiss()); });
await mgr.waitForFunction(() => (window as any).monaco?.editor.getEditors().length === 1 && document.querySelectorAll(".script-item").length >= 2, null, { timeout: 20000 });

const state = () => mgr.evaluate(() => {
    const ed = (window as any).monaco.editor.getEditors()[0];
    const s = ed.getSelection();
    return {
        uri: ed.getModel()?.uri.toString(),
        sel: s && [s.startLineNumber, s.startColumn, s.endLineNumber, s.endColumn],
        selected: document.querySelector(".script-item.selected")?.textContent ?? "",
    };
});
// a script's row by its id, its tweak's folder expanded first
const IDS: Record<string, [string, string]> = {
    "main script": ["s_main", "main script"], utilities: ["u_util", "main script"],
    "uses lib": ["s_sp", "uses-lib"], "my lib (v2)": ["u_sp", "uses-lib"],
};
const clickScript = async (name: string) => {
    const [id, dir] = IDS[name];
    const dirRow = `#script-list li.script-item[data-id="dir:${dir}"]`;
    await mgr.waitForSelector(dirRow, { timeout: 8000 });
    if ((await mgr.getAttribute(dirRow, "aria-expanded")) === "false") await mgr.click(dirRow);
    await mgr.click(`#script-list li.script-item[data-id="${id}"]`);
    await mgr.waitForTimeout(300);
};
const setCursor = (line: number, column: number) => mgr.evaluate(([l, c]: number[]) => {
    const ed = (window as any).monaco.editor.getEditors()[0];
    ed.setPosition({ lineNumber: l, column: c });
    ed.focus();
}, [line, column]);
// the real user path: F12 runs editor.action.revealDefinition
const goToDefinition = () => mgr.keyboard.press("F12");

// cold: main is the initially auto-selected script; utilities was never displayed
const initial = await state();
check("cold: initial model is main (utilities never opened)", initial.uri === "file:///main%20script/index.ts" && initial.selected.includes("index"), JSON.stringify(initial));
await setCursor(4, 2);
// on `helper(1)`
const deadline = Date.now() + 15000;
let st = await state();
while (Date.now() < deadline && !st.uri?.endsWith("/utilities.ts")) {
    await goToDefinition();
    await mgr.waitForTimeout(700);
    st = await state();
}
check("cold: Go to Definition switches to utilities model", !!st.uri?.endsWith("/utilities.ts"), st.uri);
check("cold: cursor at definition name (helper)", JSON.stringify(st.sel) === "[1,17,1,17]", JSON.stringify(st.sel));
check("cold: sidebar selects utilities", st.selected.includes("utilities"), st.selected);

// view-state memory: park the cursor in main, switch away and back → restored
await clickScript("main script");
await setCursor(5, 2);
await clickScript("utilities");
await setCursor(2, 1);
await clickScript("main script");
const vsRestored = await state();
check("view state: cursor restored after switching back", vsRestored.uri === "file:///main%20script/index.ts" && JSON.stringify(vsRestored.sel) === "[5,2,5,2]", JSON.stringify(vsRestored));
await clickScript("utilities");
const vsUtil = await state();
check("view state: utilities cursor restored too", vsUtil.uri === "file:///main%20script/utilities.ts" && JSON.stringify(vsUtil.sel) === "[2,1,2,1]", JSON.stringify(vsUtil));

// unsaved edit in utilities, then navigate to main: canceled confirm keeps everything
await clickScript("main script");
await setCursor(1, 1);
await mgr.evaluate(() => { (window as any).monaco.editor.getEditors()[0].trigger("t", "type", { text: "// dirty\n" }); });
await setCursor(5, 2); // helper(1) moved down one line
const before = await state();
const beforeText = await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].getValue());
answer = false; dialogs = 0;
await goToDefinition();
await mgr.waitForTimeout(1500);
const after = await state();
const afterText = await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].getValue());
check("cancel: confirm was shown", dialogs === 1, `dialogs=${dialogs}`);
check("cancel: stays on main, selection untouched", after.uri === before.uri && JSON.stringify(after.sel) === JSON.stringify(before.sel), JSON.stringify(after));
check("cancel: unsaved edit preserved", afterText === beforeText && afterText.includes("// dirty"));

// accepted: navigates (discarding edits)
answer = true; dialogs = 0;
await goToDefinition();
await mgr.waitForTimeout(1500);
const acc = await state();
check("accept: confirm shown and navigation happens", dialogs === 1 && !!acc.uri?.endsWith("/utilities.ts") && JSON.stringify(acc.sel) === "[1,17,1,17]", JSON.stringify(acc) + ` dialogs=${dialogs}`);

// same-file definition: no dialog, selection moves, unsaved edit kept
await clickScript("main script");
await setCursor(1, 1);
await mgr.evaluate(() => { (window as any).monaco.editor.getEditors()[0].trigger("t", "type", { text: "// dirty\n" }); });
await setCursor(6, 2); // local()
dialogs = 0;
await goToDefinition();
await mgr.waitForTimeout(1000);
const same = await state();
const sameText = await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].getValue());
check("same-file: stays, selects local, no dialog, edit kept", dialogs === 0 && !!same.uri?.endsWith("/main%20script/index.ts") && JSON.stringify(same.sel) === "[4,10,4,10]" && sameText.includes("// dirty"), JSON.stringify(same) + ` dialogs=${dialogs}`);

// view-state restore must not litter the log with Monaco's benign Canceled
// rejections — filter proof first (a real rejection must still be logged)
const logHas = (needle: string) => mgr.evaluate((n: string) => [...document.querySelectorAll("#log-entries .log-line")].some((l) => (l.textContent || "").includes(n)), needle);
await mgr.evaluate(() => { void Promise.reject(Object.assign(new Error("Canceled"), { name: "Canceled" })); });
await mgr.waitForTimeout(400);
check("Canceled rejection is filtered from the log", !(await logHas("unhandled rejection: Canceled")));
await mgr.evaluate(() => { void Promise.reject(new Error("real boom")); });
await mgr.waitForTimeout(400);
check("real rejections still log", (await logHas("real boom")) === true);

// rapid switching (as with quick Cmd+P jumps): no Canceled litter surfaces
await mgr.evaluate(() => {
    const items = [...document.querySelectorAll('.script-item[data-id="s_main"], .script-item[data-id="u_util"]')];
    for (let i = 0; i < 12; i++) items[i % items.length].dispatchEvent(new MouseEvent("click", { bubbles: true }));
});
await mgr.waitForTimeout(1500);
check("rapid switching: no Canceled litter", !(await logHas("Canceled")));

// dirty-state: reverting to the exact original clears the prompt
await clickScript("main script"); // re-select resets the editor to stored code
const orig = await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].getValue());
await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].trigger("t", "type", { text: "// dirty\n" }));
answer = false; dialogs = 0;
await mgr.evaluate((o: string) => (window as any).monaco.editor.getEditors()[0].setValue(o), orig);
await clickScript("utilities");
check("revert to original: no discard prompt", dialogs === 0, `dialogs=${dialogs}`);
// truly dirty → prompt still appears
await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].trigger("t", "type", { text: "// dirty\n" }));
dialogs = 0;
await clickScript("main script");
check("truly dirty: prompt appears", dialogs === 1, `dialogs=${dialogs}`);

// inline rename of the open script keeps its content (editor + storage),
// including unsaved edits
const listScripts = () => mgr.evaluate(() => new Promise<any[]>((r) => chrome.runtime.sendMessage({ type: "listScripts" }, r)));
await clickScript("utilities");
await mgr.waitForTimeout(500);
const savedCode = (await listScripts()).find((s: any) => s.id === "u_util")?.code;
const utilText = await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].getValue());
await mgr.evaluate(() => {
    const label = [...document.querySelectorAll<HTMLElement>(".script-item .script-name")].find((e) => e.textContent?.includes("utilities"))!;
    label.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
});
await mgr.waitForSelector(".script-rename");
await mgr.fill(".script-rename", "main script/utils renamed"); // the input holds its path: a / moves it
await mgr.press(".script-rename", "Enter");
await mgr.waitForTimeout(1500);
const renamedText = await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].getValue());
const util = (await listScripts()).find((s: any) => s.id === "u_util");
check("rename: editor keeps content", renamedText === utilText && utilText.length > 0, JSON.stringify(renamedText.slice(0, 40)));
check("rename: stored name changed, code intact", util?.meta.name === "main script/utils renamed" && util?.code === savedCode, `${util?.meta.name}`);
await mgr.evaluate(() => (window as any).monaco.editor.getEditors()[0].focus());
await mgr.keyboard.press("ControlOrMeta+s");
await mgr.waitForTimeout(800);
check("rename then save: editor content saved", (await listScripts()).find((s: any) => s.id === "u_util")?.code === utilText);

// rename only accepts file-name-safe characters; clashing names are refused
const renameTo = async (from: string, typed: string): Promise<void> => {
    await mgr.evaluate((from: string) => {
        const label = [...document.querySelectorAll<HTMLElement>(".script-item .script-name")].find((e) => e.textContent?.includes(from))!;
        label.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    }, from);
    await mgr.waitForSelector(".script-rename");
    await mgr.fill(".script-rename", "");
    await mgr.type(".script-rename", typed);
    await mgr.press(".script-rename", "Enter");
    await mgr.waitForTimeout(1200);
};
await renameTo("utils renamed", "main script/myutil: v2.x (beta) é_1");
check("rename: only forbidden characters dropped", (await listScripts()).find((s: any) => s.id === "u_util")?.meta.name === "main script/myutil v2.x (beta) é_1", (await listScripts()).find((s: any) => s.id === "u_util")?.meta.name);
await renameTo("myutil v2.x", "main script/Index");
check("rename: clashing name refused", (await listScripts()).find((s: any) => s.id === "u_util")?.meta.name === "main script/myutil v2.x (beta) é_1");
await renameTo("myutil v2.x", "main script/con");
check("rename: reserved name refused", (await listScripts()).find((s: any) => s.id === "u_util")?.meta.name === "main script/myutil v2.x (beta) é_1");

// an import by the exact (spaced) name resolves in the editor
const mgrSend = (msg: any): Promise<any> => mgr.evaluate((m: any) => new Promise((r) => chrome.runtime.sendMessage(m, r)), msg);
await saveTweak(mgrSend, "u_sp", "uses-lib", "export const answer = 42;\n", { file: "my lib (v2)" });
// (a module with a space in a folder with one does not resolve in the editor yet)
await saveTweak(mgrSend, "s_sp", "uses-lib", 'import { answer } from "./my lib (v2)";\nexport const n: number = answer;\n');
answer = true;
await mgr.reload();
await mgr.waitForFunction(() => (window as any).monaco?.editor?.getEditors?.().length);
await clickScript("uses lib");
await mgr.waitForTimeout(3000);
const markers = await mgr.evaluate(() => {
    const m = (window as any).monaco;
    return m.editor.getModelMarkers({ resource: m.editor.getEditors()[0].getModel().uri }).map((x: any) => x.message);
});
check("spaced import resolves (no diagnostics)", markers.length === 0, JSON.stringify(markers));

// breaking the library flags its importer; fixing it clears the importer
const usesLibMarkers = () => mgr.evaluate(() => {
    const m = (window as any).monaco;
    const u = m.editor.getModels().find((x: any) => x.uri.toString().includes("uses-lib/index"));
    return m.editor.getModelMarkers({ resource: u.uri }).length;
});
const setLib = async (code: string) => {
    await clickScript("my lib (v2)");
    await mgr.evaluate((c: string) => (window as any).monaco.editor.getEditors()[0].setValue(c), code);
    await mgr.waitForTimeout(3000);
};
await setLib("export const answer = \"42\";\n");
check("dependant: importer flagged when the library breaks it", (await usesLibMarkers()) > 0);
await setLib("export const answer = 42;\n");
check("dependant: importer cleared when the library is fixed", (await usesLibMarkers()) === 0);

// scripts run in current browsers: newer JS/web APIs type-check (the TS 6
// compiler's dom and esnext libs). The deliberate type error proves
// diagnostics are live.
await clickScript("main script");
await mgr.evaluate((c: string) => (window as any).monaco.editor.getEditors()[0].setValue(c), [
    'import { tweak } from "tangitweak"; tweak.onRequest({ url: "*://example.invalid/*", strategy: "helper" }, () => {});',
    'const p = new URLPattern("https://example.com/users/:id");',
    'const id: string | undefined = p.exec("https://example.com/users/42")?.pathname.groups.id;',
    "const last = [1, 2, 3].findLast((n) => n > 1);",
    "const sorted = [3, 1].toSorted();",
    "const deep = structuredClone({ id, last, sorted });",
    'const wrong: number = "not a number";',
    "navigation.addEventListener(\"navigate\", (e) => console.log(e.destination.url));",
    "scheduler.postTask(() => {}, { priority: \"background\" });",
    "console.log(new Uint8Array([1]).toBase64(), deep);",
    "",
].join("\n"));
await mgr.waitForTimeout(3000);
const modern = await mgr.evaluate(() => {
    const m = (window as any).monaco;
    return m.editor.getModelMarkers({ resource: m.editor.getEditors()[0].getModel().uri })
        .filter((x: any) => x.severity === m.MarkerSeverity.Error).map((x: any) => `${x.startLineNumber}: ${x.message}`);
});
check("newer browser APIs (URLPattern, navigation, scheduler, toBase64, findLast, toSorted) type-check", modern.length === 1 && modern[0].startsWith("7:"), JSON.stringify(modern));

} catch (e) {
    failed++;
    console.error("FATAL", e);
} finally {
    await finish(browser);
}
