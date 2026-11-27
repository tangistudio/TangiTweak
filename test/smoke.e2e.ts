/**
 * The cross-browser smoke suite: the same few checks on Chrome (dist-mv3)
 * and Firefox (dist-firefox), through the launcher in e2eBrowsers.ts.
 * It covers what each browser does its own way: the background, a save
 * (compile), the page strategy, the browser's network strategy, an overlay
 * frame and page code. The per-browser suites (mv3.e2e.ts and the others) go deep on
 * Chrome; this one keeps both browsers honest.
 *
 * Usage: npm run build && npx tsx test/smoke.e2e.ts
 *        E2E_BROWSERS=firefox npx tsx test/smoke.e2e.ts
 */
import http from "node:http";
import { browsersToRun, launchExtension, type ExtBrowser } from "./e2eBrowsers";
import { deleteTweak, saveTweak } from "./e2eTweak";

const PORT = 8911;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/data")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ value: "ORIGINAL" }));
    }
    if (req.url?.startsWith("/app.js")) {
        res.writeHead(200, { "content-type": "text/javascript" });
        return res.end('document.documentElement.dataset.app = "ORIGINAL";');
    }
    if (req.url?.startsWith("/fetch")) {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(`<html><body><script>setTimeout(()=>fetch('/data').then(r=>r.json()).then(j=>{document.title='DONE:'+j.value}),300)</script></body></html>`);
    }
    if (req.url?.startsWith("/script")) {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(`<html><body><script src="/app.js"></script></body></html>`);
    }
    if (req.url?.startsWith("/overlay")) {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(`<html><body><script>addEventListener("message",(e)=>{if(e.data==="TT-OVERLAY")document.documentElement.dataset.overlay="RAN"})</script></body></html>`);
    }
    if (req.url?.startsWith("/doc")) {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(`<html><body>doc</body></html>`);
    }
    res.writeHead(404);
    res.end();
});
await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
setTimeout(() => {
    console.log("FAIL  global watchdog timeout");
    process.exit(1);
}, 300000);

let failed = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function suite(ext: ExtBrowser): Promise<void> {
    const check = (name: string, ok: boolean, extra = ""): void => {
        if (!ok) failed++;
        console.log(`${ok ? "PASS" : "FAIL"}  [${ext.kind}] ${name}${extra && !ok ? " — " + extra : ""}`);
    };
    /** polls `read` in a fresh page at `url` until it returns `want` (or times out), returning the last value */
    const readPage = async (url: string, read: () => any, want: string): Promise<string> => {
        let last = "";
        for (let attempt = 0; attempt < 3 && last !== want; attempt++) {
            const page = await ext.newPage();
            await page.goto(url);
            for (let i = 0; i < 30 && last !== want; i++) {
                last = String(await page.evaluate(read).catch(() => ""));
                if (last !== want) await sleep(200);
            }
            await page.close();
        }
        return last;
    };

    const settings = await ext.send({ type: "getSettingsJson" });
    check("the background answers", typeof settings?.text === "string", JSON.stringify(settings));

    // a save compiles the tweak (sandbox on Chrome) and captures its route
    const saved = await saveTweak(ext.send, "s_smoke_page", "smoke page", `import { tweak } from "tangitweak"; tweak.onResponseBody({ url: "${ORIGIN}/data*", strategy: "page" }, (ctx, body) => body.replace("ORIGINAL", "PAGE"));`);
    check("a tweak saves and compiles", saved?.meta?.active === true && !saved?.error, JSON.stringify(saved?.meta ?? saved));
    const list = await ext.send({ type: "listScripts" });
    check("the tweak is listed", Array.isArray(list) && list.some((s: any) => s.id === "s_smoke_page"), JSON.stringify(list));

    const fetched = await readPage(`${ORIGIN}/fetch`, () => (document.title.startsWith("DONE:") ? document.title : ""), "DONE:PAGE");
    check("the page strategy rewrites a page fetch", fetched === "DONE:PAGE", fetched);
    await deleteTweak(ext.send, "smoke page");

    await saveTweak(ext.send, "s_smoke_net", "smoke net", `import { tweak } from "tangitweak"; tweak.onResponseBody({ url: "${ORIGIN}/app.js*", strategy: "${ext.networkStrategy}" }, (ctx, body) => body.replace("ORIGINAL", "NET"));`);
    const script = await readPage(`${ORIGIN}/script`, () => document.documentElement.dataset.app ?? "", "NET");
    check(`the ${ext.networkStrategy} strategy rewrites a script load`, script === "NET", script);
    await deleteTweak(ext.send, "smoke net");

    // an overlay frame (a sandbox page on both browsers) runs its code and reaches the page
    await saveTweak(ext.send, "s_smoke_ov", "smoke overlay", `import { tweak } from "tangitweak"; tweak.onOverlay("${ORIGIN}/overlay*", () => { parent.postMessage("TT-OVERLAY", "*"); });`);
    const overlay = await readPage(`${ORIGIN}/overlay`, () => document.documentElement.dataset.overlay ?? "", "RAN");
    check("onOverlay code runs in its frame", overlay === "RAN", overlay);
    await deleteTweak(ext.send, "smoke overlay");

    // the Editor asks for the permission once a tweak has page code
    await saveTweak(ext.send, "s_smoke_doc", "smoke doc", `import { tweak } from "tangitweak"; tweak.onPage("${ORIGIN}/doc*", () => { document.documentElement.dataset.onpage = "RAN"; }); tweak.onSite("${ORIGIN}/doc*", () => { (window as any).__ttSmokeSite = "RAN"; });`);
    const editor = await ext.extPage("editor.html");
    await ext.grantUserScripts(editor);
    const doc = await readPage(`${ORIGIN}/doc`, () => document.documentElement.dataset.onpage ?? "", "RAN");
    check("onPage code runs (user scripts granted)", doc === "RAN", doc);
    const site = await readPage(`${ORIGIN}/doc`, () => (window as any).__ttSmokeSite ?? "", "RAN");
    check("onSite code runs in the page's world", site === "RAN", site);
    await deleteTweak(ext.send, "smoke doc");
    await editor.close();
}

for (const kind of browsersToRun()) {
    let ext: ExtBrowser | null = null;
    try {
        ext = await launchExtension(kind);
        await suite(ext);
    } catch (e: any) {
        failed++;
        console.log(`FAIL  [${kind}] suite crashed — ${e?.stack || e}`);
    } finally {
        await ext?.close();
    }
}
server.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
