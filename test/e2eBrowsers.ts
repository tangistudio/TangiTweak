/**
 * One launcher for the cross-browser e2e suites: Chrome (dist-mv3) over CDP
 * and Firefox (dist-firefox) over WebDriver BiDi, both through puppeteer.
 * Each suite then talks to the extension the same way, whichever browser
 * it runs in: open an extension page, message the background, open web
 * pages and grant the user scripts permission. What differs per browser
 * (the network strategy for browser-initiated loads, how the user scripts
 * permission is granted) lives here.
 *
 * Browsers: E2E_CHROMIUM (see browserSetup.ts) and E2E_FIREFOX (else
 * Firefox's usual install path) override the binaries.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveBrowser } from "./browserSetup";
import type { Strategy } from "../src/shared/route";

export type BrowserKind = "chrome" | "firefox";

export interface ExtBrowser {
    kind: BrowserKind;
    browser: Browser;
    /** `chrome-extension://<id>` or `moz-extension://<uuid>` */
    origin: string;
    /** the strategy that carries browser-initiated loads (script tags, navigations) here */
    networkStrategy: Strategy;
    /** opens one of the extension's pages (`"editor.html"`), loaded */
    extPage(file: string): Promise<Page>;
    /** messages the background from an extension page, resolving its response */
    send(msg: any): Promise<any>;
    newPage(): Promise<Page>;
    /** grants the optional user scripts permission the way a user would, from the Editor (`editor`) */
    grantUserScripts(editor: Page): Promise<void>;
    close(): Promise<void>;
}

const ROOT = new URL("..", import.meta.url).pathname;
/** Firefox's moz-extension:// host for the extension, fixed so a suite knows it up front */
const FIREFOX_UUID = "7e57e2e0-0000-4000-8000-00000000e2e0";

function firefoxBinary(): string {
    const found = [process.env.E2E_FIREFOX, "/Applications/Firefox.app/Contents/MacOS/firefox", "/usr/bin/firefox", "/usr/lib/firefox/firefox"].find((p) => p && existsSync(p));
    if (!found) throw new Error("Firefox not found: set E2E_FIREFOX to its binary");
    return found;
}

/** the browsers a run covers: E2E_BROWSERS="chrome,firefox" (the default) */
export function browsersToRun(): BrowserKind[] {
    const want = (process.env.E2E_BROWSERS || "chrome,firefox").split(",").map((s) => s.trim());
    return want.filter((b): b is BrowserKind => b === "chrome" || b === "firefox");
}

export async function launchExtension(kind: BrowserKind): Promise<ExtBrowser> {
    return kind === "chrome" ? launchChrome() : launchFirefox();
}

async function launchChrome(): Promise<ExtBrowser> {
    const profile = mkdtempSync(path.join(tmpdir(), "tt-e2e-chrome-"));
    // chrome.userScripts needs Developer mode before Chrome 138
    mkdirSync(path.join(profile, "Default"), { recursive: true });
    writeFileSync(path.join(profile, "Default", "Preferences"), JSON.stringify({ extensions: { ui: { developer_mode: true } } }));
    const browser = await puppeteer.launch({
        browser: "chrome",
        executablePath: await resolveBrowser(),
        headless: true,
        pipe: true,
        enableExtensions: true,
        userDataDir: profile,
        args: ["--no-first-run", "--no-default-browser-check"],
    });
    const id = await browser.installExtension(path.join(ROOT, "dist-mv3"));
    const origin = `chrome-extension://${id}`;
    return common(browser, "chrome", origin, "debugger", {
        async grantUserScripts(editor) {
            await editor.bringToFront();
            await (await editor.waitForSelector("#userscripts-grant", { timeout: 10000 }))!.click();
            // Chrome 138+: also the per-extension "Allow User Scripts" switch
            const details = await browser.newPage();
            await details.goto(`chrome://extensions/?id=${id}`);
            const toggle = await details.waitForSelector("pierce/extensions-toggle-row#allow-user-scripts", { timeout: 5000 }).catch(() => null);
            if (toggle && !(await toggle.evaluate((el: any) => el.checked))) await toggle.click();
            await details.close();
            await editor.bringToFront();
            // headless fires no focus event on its own: the Editor re-checks on focus
            await editor.evaluate(() => window.dispatchEvent(new Event("focus")));
        },
        cleanup: () => rmSync(profile, { recursive: true, force: true }),
    });
}

async function launchFirefox(): Promise<ExtBrowser> {
    const dist = path.join(ROOT, "dist-firefox");
    const geckoId = JSON.parse(readFileSync(path.join(dist, "manifest.json"), "utf8")).browser_specific_settings.gecko.id;
    const browser = await puppeteer.launch({
        browser: "firefox",
        executablePath: firefoxBinary(),
        headless: true,
        // lets WebDriver BiDi open moz-extension:// pages (refused otherwise)
        env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" },
        extraPrefsFirefox: {
            "extensions.webextensions.uuids": JSON.stringify({ [geckoId]: FIREFOX_UUID }),
            // optional permissions granted without the doorhanger, as if the user accepted
            "extensions.webextOptionalPermissionPrompts": false,
        },
    });
    await browser.installExtension(dist);
    return common(browser, "firefox", `moz-extension://${FIREFOX_UUID}`, "extension", {
        async grantUserScripts(editor) {
            // MV2: page code needs no permission. MV3: the Editor's banner asks for it
            const banner = await editor.waitForSelector("#userscripts-grant", { timeout: 3000 }).catch(() => null);
            await banner?.click();
        },
    });
}

function common(
    browser: Browser,
    kind: BrowserKind,
    origin: string,
    networkStrategy: Strategy,
    extra: { grantUserScripts(editor: Page): Promise<void>; cleanup?: () => void }
): ExtBrowser {
    let sender: Page | null = null;
    const extPage = async (file: string): Promise<Page> => {
        const page = await browser.newPage();
        const url = `${origin}/${file}`;
        if (kind === "firefox") {
            // the tab moves to the extension process, and puppeteer never
            // sees that navigation settle: start it, then wait for the page
            await page.goto(url, { timeout: 1500 }).catch(() => {});
            for (let i = 0; i < 100; i++) {
                const at = await page.evaluate(() => (document.readyState === "complete" ? location.href : "")).catch(() => "");
                if (at.startsWith(url)) return page;
                await new Promise((r) => setTimeout(r, 100));
            }
            throw new Error(`${url} didn't load`);
        }
        await page.goto(url);
        return page;
    };
    return {
        kind,
        browser,
        origin,
        networkStrategy,
        extPage,
        async send(msg) {
            sender ??= await extPage("popup.html");
            return sender.evaluate((m: any) => new Promise((r) => chrome.runtime.sendMessage(m, (x: any) => r(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : (x ?? null)))), msg);
        },
        newPage: () => browser.newPage(),
        grantUserScripts: extra.grantUserScripts,
        async close() {
            await browser.close().catch(() => {});
            extra.cleanup?.();
        },
    };
}
