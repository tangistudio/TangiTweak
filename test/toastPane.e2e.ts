/**
 * Standalone MV3 Chromium e2e: a `tweak.toastPane` toast dragged between
 * corners keeps its pane (it used to fall back to the default toast after
 * four moves) and its frame doesn't reload on each move.
 *
 * Usage: npm run build && PATH="$(mise where node@24.22.0)/bin:$PATH" npx tsx test/toastPane.e2e.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { chromium } from "playwright-core";
import { resolveBrowser } from "./browserSetup";
import { saveTweak, deleteTweak } from "./e2eTweak";

const EXT_ROOT = path.join(new URL("..", import.meta.url).pathname, "dist-mv3");
const EXT_ID = crypto.createHash("sha256").update(EXT_ROOT, "utf8").digest("hex").split("").map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("").slice(0, 32);

const PORT = 8921;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><head><title>Shop</title></head><body style="margin:0;height:100vh"><h1>SHOP</h1></body></html>`);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r as () => void));

const profile = mkdtempSync(path.join(tmpdir(), "tt-pane-e2e-"));
mkdirSync(path.join(profile, "Default"), { recursive: true });
writeFileSync(path.join(profile, "Default", "Preferences"), JSON.stringify({ extensions: { ui: { developer_mode: true } } }));
const proc = spawn(
    await resolveBrowser(),
    ["--headless=new", `--user-data-dir=${profile}`, `--load-extension=${EXT_ROOT}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "about:blank"],
    { stdio: "ignore" }
);
await new Promise((r) => setTimeout(r, 5000));

let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
};

let browser: any;
try {
    const [port] = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 60000 });
    const ctx = browser.contexts()[0];
    const mgr = await ctx.newPage();
    await mgr.goto(`chrome-extension://${EXT_ID}/editor.html`);
    const send = (msg: any): Promise<any> => mgr.evaluate((m: any) => new Promise((r) => chrome.runtime.sendMessage(m, (x: any) => r(x ?? null))), msg);

    const code = `
        import { tweak } from "tangitweak";
        tweak.toastPane("card", () => <div>PANE-OK</div>);
        tweak.onPage("*://127.0.0.1:${PORT}/*", () => {
            tweak.toast({ id: "r", title: "Plain title", message: "Plain message", pane: "card", duration: "sticky" });
        });
    `;
    await saveTweak(send, "s_pane", "Pane Drag", code);
    await send({ type: "settleScripts" });
    await mgr.bringToFront();
    const grant = mgr.locator("#userscripts-grant");
    if (await grant.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) await grant.click();
    const details = await ctx.newPage();
    await details.goto(`chrome://extensions/?id=${EXT_ID}`);
    const toggle = details.locator("extensions-toggle-row#allow-user-scripts");
    if ((await toggle.count()) && !(await toggle.evaluate((el: any) => el.checked))) await toggle.click();
    await details.close();
    await mgr.evaluate(() => window.dispatchEvent(new Event("focus")));
    await send({ type: "settleScripts" });

    const tab = await ctx.newPage();
    await tab.setViewportSize({ width: 1200, height: 800 });
    let paneLoads = 0;
    tab.on("framenavigated", (f: any) => {
        if (/overlay\.html/.test(f.url())) paneLoads++;
    });
    await tab.goto(`${ORIGIN}/`);
    const paneFrame = async () => {
        for (let i = 0; i < 50; i++) {
            for (const f of tab.frames()) {
                if (!/overlay\.html/.test(f.url())) continue;
                if (await f.getByText("PANE-OK").count().catch(() => 0)) return f;
            }
            await tab.waitForTimeout(100);
        }
        return null;
    };
    const first = await paneFrame();
    check("the pane draws in its toast", !!first);
    const loadsBefore = paneLoads;

    const corners = [
        [40, 40],
        [1160, 760],
    ];
    let moved = 0;
    for (let i = 0; i < 6; i++) {
        const f = await paneFrame();
        if (!f) break;
        const el = await f.frameElement();
        const box = await el.evaluate((n: Element) => {
            const r = (n.getRootNode() as ShadowRoot).querySelector("[part=source]")!.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        const [tx, ty] = corners[i % 2];
        await tab.mouse.move(box.x, box.y);
        await tab.mouse.down();
        await tab.mouse.move(tx, ty, { steps: 8 });
        await tab.mouse.up();
        await tab.waitForTimeout(600);
        moved++;
    }
    check("dragged the toast between corners 6 times", moved === 6, String(moved));
    check("the pane is still drawn after 6 moves", !!(await paneFrame()));
    check("moving the toast doesn't reload its pane frame", paneLoads === loadsBefore, `loads ${loadsBefore} → ${paneLoads}`);

    await deleteTweak(send, "Pane Drag");
} catch (err) {
    console.error("E2E ERROR:", err);
    failed++;
} finally {
    await browser?.close().catch(() => {});
    proc.kill();
    server.close();
    await new Promise((r) => setTimeout(r, 500));
    try {
        rmSync(profile, { recursive: true, force: true });
    } catch {}
}

if (failed > 0) {
    console.error(`\n${failed} checks failed`);
    process.exit(1);
}
console.log("\nAll toast pane e2e checks passed!");
