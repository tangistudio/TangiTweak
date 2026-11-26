/**
 * Standalone MV3 Chromium e2e verification for `tweak.site` and
 * `debuggerSafe: true` (both `tweak.site` and `tweak.onOverlay`) while a second
 * extension holds an active `chrome.debugger` session (simulating Playwriter).
 *
 * Usage: npm run build && PATH="$(mise where node@24.22.0)/bin:$PATH" npx tsx test/site.e2e.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { chromium } from "playwright-core";
import { resolveBrowser } from "./browserSetup";
import { saveTweak, deleteTweak } from "./e2eTweak";

const EXT_ROOT = path.join(new URL("..", import.meta.url).pathname, "dist-mv3");
const EXT_ID = crypto.createHash("sha256").update(EXT_ROOT, "utf8").digest("hex").split("").map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("").slice(0, 32);

// Create a minimal second MV3 extension with the `debugger` permission to
// simulate Playwriter attaching chrome.debugger to the tab.
const dbgExtDir = realpathSync(mkdtempSync(path.join(tmpdir(), "tt-playwriter-sim-")));
const DBG_EXT_ID = crypto.createHash("sha256").update(dbgExtDir, "utf8").digest("hex").split("").map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("").slice(0, 32);
writeFileSync(
    path.join(dbgExtDir, "manifest.json"),
    JSON.stringify({
        manifest_version: 3,
        name: "Playwriter Simulator",
        version: "1.0.0",
        permissions: ["debugger", "tabs"],
        background: { service_worker: "bg.js" },
    })
);
writeFileSync(
    path.join(dbgExtDir, "bg.js"),
    `chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg.type === "attach") {
            chrome.debugger.attach({ tabId: msg.tabId }, "1.3", () => {
                sendResponse({ ok: !chrome.runtime.lastError, err: chrome.runtime.lastError?.message });
            });
            return true;
        }
        if (msg.type === "detach") {
            chrome.debugger.detach({ tabId: msg.tabId }, () => {
                sendResponse({ ok: !chrome.runtime.lastError, err: chrome.runtime.lastError?.message });
            });
            return true;
        }
    });`
);
writeFileSync(path.join(dbgExtDir, "ctl.html"), `<!doctype html><meta charset="utf-8"><title>dbg</title>`);

const PORT = 8919;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const server = http.createServer((req, res) => {
    const u = req.url || "/";
    if (u.startsWith("/seed")) {
        res.writeHead(200, { "content-type": "text/html", "set-cookie": "session=orig-cookie; Path=/" });
        return res.end(`<!doctype html><html><head><title>Seed</title></head><body><script>localStorage.setItem("cart", "orig-cart"); document.title = "SEEDED";</script></body></html>`);
    }
    if (u.startsWith("/checkout")) {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(`<!doctype html><html><head><title>Real Checkout</title></head><body><h1>REAL CHECKOUT</h1><script>window.__origRan = "CHECKOUT"; document.body.dataset.orig = "CHECKOUT";</script></body></html>`);
    }
    if (u.startsWith("/overlay-target")) {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(`<!doctype html><html><head><title>Overlay Target</title></head><body><h1 id="host-h1">HOST PAGE</h1></body></html>`);
    }
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<!doctype html><html><head><title>Original Shop</title></head><body><h1 id="orig-h1">ORIGINAL SITE</h1><script>window.__origRan = "SHOP"; document.body.dataset.orig = "SHOP";</script></body></html>`);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r as () => void));

const profile = mkdtempSync(path.join(tmpdir(), "tt-site-e2e-"));
mkdirSync(path.join(profile, "Default"), { recursive: true });
writeFileSync(path.join(profile, "Default", "Preferences"), JSON.stringify({ extensions: { ui: { developer_mode: true } } }));

const proc = spawn(
    await resolveBrowser(),
    [
        "--headless=new",
        `--user-data-dir=${profile}`,
        `--load-extension=${EXT_ROOT},${dbgExtDir}`,
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
    ],
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
    const mgrSend = (msg: any): Promise<any> =>
        mgr.evaluate((m: any) => new Promise((r) => chrome.runtime.sendMessage(m, (x: any) => r(x ?? null))), msg);

    const dbgCtl = await ctx.newPage();
    await dbgCtl.goto(`chrome-extension://${DBG_EXT_ID}/ctl.html`);
    const dbgSend = (msg: any): Promise<any> =>
        dbgCtl.evaluate((m: any) => new Promise((r) => chrome.runtime.sendMessage(m, (x: any) => r(x ?? null))), msg);

    // Grant userScripts permission + enable "Allow User Scripts" on chrome://extensions
    const grantUserScripts = async () => {
        // Save a temporary onPage script so the Editor displays #userscripts-grant
        await saveTweak(mgrSend, "s_us_seed", "US Seed", `import { tweak } from "tangitweak"; tweak.onPage("*://127.0.0.1:${PORT}/*", () => {});`);
        await mgrSend({ type: "settleScripts" });
        await mgr.bringToFront();
        const grantBtn = mgr.locator("#userscripts-grant");
        if (await grantBtn.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
            await grantBtn.click();
        }
        const details = await ctx.newPage();
        await details.goto(`chrome://extensions/?id=${EXT_ID}`);
        const toggle = details.locator("extensions-toggle-row#allow-user-scripts");
        if ((await toggle.count()) && !(await toggle.evaluate((el: any) => el.checked))) await toggle.click();
        await details.close();
        await mgr.bringToFront();
        await mgr.evaluate(() => window.dispatchEvent(new Event("focus")));
        await deleteTweak(mgrSend, "US Seed");
        await mgrSend({ type: "settleScripts" });
    };
    await grantUserScripts();

    // Seed localStorage and cookie on the target origin first
    const tab = await ctx.newPage();
    await tab.goto(`${ORIGIN}/seed`);
    await tab.waitForFunction(() => document.title === "SEEDED", null, { timeout: 5000 });

    // 1. Default tweak.site
    const siteCode = `
        import { tweak } from "tangitweak";
        tweak.site({ url: "*://127.0.0.1:${PORT}/*", exclude: ["*://127.0.0.1:${PORT}/checkout*"] }, async (ctx) => {
            ctx.setTitle("Custom Shop");
            const cart = await ctx.origin.localStorage.get("cart");
            const sess = await ctx.origin.cookies.get("session");
            const root = document.createElement("div");
            root.id = "custom-app";
            const locEl = document.createElement("div");
            locEl.id = "loc";
            const dataEl = document.createElement("div");
            dataEl.id = "origin-data";
            dataEl.textContent = cart + "|" + sess;
            const navBtn = document.createElement("button");
            navBtn.id = "go-deals";
            navBtn.textContent = "Go Deals";
            navBtn.onclick = () => ctx.navigate("/deals?sort=price");
            const outBtn = document.createElement("button");
            outBtn.id = "go-checkout";
            outBtn.textContent = "Go Checkout";
            outBtn.onclick = () => ctx.navigate("/checkout");
            root.append(locEl, dataEl, navBtn, outBtn);
            document.body.replaceChildren(root);
            const render = () => { locEl.textContent = ctx.location.pathname + ctx.location.search; };
            render();
            ctx.onNavigate(render);
        });
    `;
    const saved = await saveTweak(mgrSend, "s_site", "Shop Site", siteCode);
    await mgrSend({ type: "settleScripts" });
    check("tweak.site compiles and saves", saved?.meta?.active === true && saved?.meta?.routes?.[0]?.api === "site", JSON.stringify(saved?.meta?.routes));

    await tab.goto(`${ORIGIN}/shop`);
    await tab.waitForFunction(() => document.title === "Custom Shop", null, { timeout: 10000 });
    const origSilenced = await tab.evaluate(() => (window as any).__origRan === undefined && !document.body.dataset.orig);
    check("default tweak.site silences original page inline script via DNR CSP", origSilenced);

    // Find the overlay iframe and inspect its rendered app
    const findSiteFrame = async () => {
        for (let i = 0; i < 40; i++) {
            for (const f of tab.frames()) {
                const el = await f.locator("#origin-data").textContent({ timeout: 200 }).catch(() => null);
                if (el !== null) return f;
            }
            await tab.waitForTimeout(100);
        }
        return null;
    };
    const siteFrame = await findSiteFrame();
    check("default tweak.site mounts custom app iframe", !!siteFrame, siteFrame?.url() ?? "none");
    if (siteFrame) {
        const originData = await siteFrame.locator("#origin-data").textContent();
        check("ctx.origin reads host page localStorage and cookie", originData === "orig-cart|orig-cookie", String(originData));

        // Click SPA navigation inside the site app
        await siteFrame.locator("#go-deals").click();
        await tab.waitForFunction(() => location.pathname === "/deals" && location.search === "?sort=price", null, { timeout: 5000 });
        await siteFrame.waitForFunction(() => document.getElementById("loc")?.textContent === "/deals?sort=price", null, { timeout: 5000 }).catch(() => {});
        const locText = await siteFrame.locator("#loc").textContent();
        check("ctx.navigate updates real address bar and live ctx.location", locText === "/deals?sort=price", String(locText));

        // Test popup siteTabState + toggleSiteTab (Original -> Custom)
        const activeTabId = await mgr.evaluate(async (orig: string) => {
            const tabs = await chrome.tabs.query({ url: `${orig}/*` });
            return tabs[0]?.id ?? -1;
        }, ORIGIN);
        const st1 = await mgrSend({ type: "siteTabState", tabId: activeTabId });
        check("siteTabState reports active custom site", st1?.mode === "custom" && st1?.scriptId === "s_site", JSON.stringify(st1));

        await mgrSend({ type: "toggleSiteTab", tabId: activeTabId, mode: "original" });
        await tab.waitForFunction(() => (window as any).__origRan === "SHOP", null, { timeout: 10000 });
        check("toggleSiteTab(original) restores original site and runs its scripts", true);

        await mgrSend({ type: "toggleSiteTab", tabId: activeTabId, mode: "custom" });
        await tab.waitForFunction(() => document.title === "Custom Shop", null, { timeout: 10000 });
        check("toggleSiteTab(custom) restores custom site", true);

        // Navigate into excluded path -> real navigation & original page runs
        const siteFrame2 = await findSiteFrame();
        if (siteFrame2) {
            await siteFrame2.locator("#go-checkout").click();
            await tab.waitForFunction(() => location.pathname === "/checkout" && (window as any).__origRan === "CHECKOUT", null, { timeout: 10000 });
            check("exclude route exits custom site via real navigation and runs original page", true);
        } else {
            check("exclude route exits custom site via real navigation and runs original page", false, "frame not found after toggle");
        }
    }

    await deleteTweak(mgrSend, "Shop Site");
    await mgrSend({ type: "settleScripts" });

    // 2. debuggerSafe: true for tweak.site (srcdoc host) WITH active chrome.debugger from Playwriter simulator
    const safeSiteCode = `
        import { tweak } from "tangitweak";
        tweak.site({ url: "*://127.0.0.1:${PORT}/shop*", debuggerSafe: true }, async (ctx) => {
            ctx.setTitle("DebuggerSafe Site");
            const cart = await ctx.origin.localStorage.get("cart");
            const el = document.createElement("div");
            el.id = "safe-site-app";
            el.textContent = "SAFE|" + cart + "|" + ctx.location.pathname;
            document.body.replaceChildren(el);
            ctx.onNavigate(() => {
                el.textContent = "SAFE|" + cart + "|" + ctx.location.pathname;
            });
        });
    `;
    const savedSafe = await saveTweak(mgrSend, "s_safe_site", "Safe Site", safeSiteCode);
    await mgrSend({ type: "settleScripts" });
    check("tweak.site({ debuggerSafe: true }) compiles and saves", savedSafe?.meta?.active === true && savedSafe?.meta?.routes?.[0]?.debuggerSafe === true);

    await tab.goto(`${ORIGIN}/shop`);
    await tab.waitForFunction(() => document.title === "DebuggerSafe Site", null, { timeout: 10000 });

    const tabId = await mgr.evaluate(async (orig: string) => {
        const tabs = await chrome.tabs.query({ url: `${orig}/*` });
        return tabs[0]?.id ?? -1;
    }, ORIGIN);

    // Attach chrome.debugger from the second extension (simulating Playwriter!)
    const attached = await dbgSend({ type: "attach", tabId });
    check("Playwriter simulator attaches chrome.debugger to tab", attached?.ok === true, JSON.stringify(attached));

    // Verify srcdoc iframe is STILL alive and NOT chrome-extension:// while debugger is attached!
    const safeFrameInfo = await (async () => {
        for (const f of tab.frames()) {
            const text = await f.locator("#safe-site-app").textContent({ timeout: 500 }).catch(() => null);
            if (text) return { url: f.url(), text };
        }
        return null;
    })();
    check(
        "tweak.site({ debuggerSafe: true }) uses srcdoc (not chrome-extension://) and survives chrome.debugger",
        !!safeFrameInfo && !safeFrameInfo.url.startsWith("chrome-extension://") && safeFrameInfo.text === "SAFE|orig-cart|/shop",
        JSON.stringify(safeFrameInfo)
    );

    await dbgSend({ type: "detach", tabId });
    await deleteTweak(mgrSend, "Safe Site");
    await mgrSend({ type: "settleScripts" });

    // 3. debuggerSafe: true for tweak.onOverlay (isolated-world closed shadow root) WITH active chrome.debugger
    const safeOverlayCode = `
        import { tweak } from "tangitweak";
        tweak.onOverlay({ url: "*://127.0.0.1:${PORT}/overlay-target*", debuggerSafe: true }, (ctx) => {
            const badge = document.createElement("div");
            badge.id = "safe-overlay-badge";
            badge.textContent = "SAFE-OVERLAY-LIVE";
            document.body.appendChild(badge);
            document.title = "SAFE-OVERLAY-MOUNTED";
        });
    `;
    const savedOv = await saveTweak(mgrSend, "s_safe_ov", "Safe Overlay", safeOverlayCode);
    await mgrSend({ type: "settleScripts" });
    check("onOverlay({ debuggerSafe: true }) compiles and saves", savedOv?.meta?.active === true && savedOv?.meta?.routes?.[0]?.debuggerSafe === true);

    await tab.goto(`${ORIGIN}/overlay-target`);
    const attachedOv = await dbgSend({ type: "attach", tabId });
    check("Playwriter simulator attaches chrome.debugger on overlay tab", attachedOv?.ok === true, JSON.stringify(attachedOv));

    // Wait for the debuggerSafe overlay to mount (note: shadow root is closed so page DOM does NOT see #safe-overlay-badge,
    // and there is NO chrome-extension:// iframe in tab.frames(); the overlay signals readiness via document.title)
    const mountedTitle = await tab
        .waitForFunction(() => document.title === "SAFE-OVERLAY-MOUNTED", null, { timeout: 10000 })
        .then(() => true)
        .catch(() => false);
    const hasExtIframe = tab.frames().some((f: any) => f.url().startsWith("chrome-extension://"));
    check("onOverlay({ debuggerSafe: true }) mounts with no chrome-extension:// iframe under chrome.debugger", mountedTitle && !hasExtIframe, `mounted=${mountedTitle} extIframe=${hasExtIframe}`);

    await dbgSend({ type: "detach", tabId });
    await deleteTweak(mgrSend, "Safe Overlay");
} catch (err) {
    console.error("E2E ERROR:", err);
    failed++;
} finally {
    await browser?.close().catch(() => {});
    proc.kill();
    server.close();
    await new Promise((r) => setTimeout(r, 500));
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    try { rmSync(dbgExtDir, { recursive: true, force: true }); } catch {}
}

if (failed > 0) {
    console.error(`\n${failed} checks failed`);
    process.exit(1);
}
console.log("\nAll site & debuggerSafe e2e checks passed!");
