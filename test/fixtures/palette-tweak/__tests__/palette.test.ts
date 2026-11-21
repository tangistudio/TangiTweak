import { describe, expect } from "vitest";
import { test } from "tangitweak/test";
import { choices, palette, site, visit } from "../features/palette/state";

const APP = "https://app.example.com/home";

describe("fixtures: page, browser, tweak", () => {
    test("a shortcut opens the palette in a closed shadow root", async ({ page }) => {
        await page.goto(APP);
        expect(page.ui.queryByRole("listbox")).toBeNull();

        await page.press("Alt+Shift+P");

        await page.ui.findByRole("listbox");
        // the website's own document can't see into the tweak's closed shadow root
        expect(page.document.querySelector("[role=listbox]")).toBeNull();
    });

    test("click and type", async ({ page, tweak }) => {
        await page.goto(APP);
        await page.press("Alt+Shift+P");
        await page.click(await page.ui.findByText(/Compact: OFF/));
        await page.ui.findByText(/Compact: ON/);

        await page.type(page.ui.getByLabelText("Filter"), "nav");
        expect((page.ui.getByLabelText("Filter") as HTMLInputElement).value).toBe("nav");
        expect(tweak.store(palette, page).filter).toBe("nav");
        expect(tweak.store(choices).compact).toBe(true);
    });

    test("a reload keeps the tab's and global stores, not the page's", async ({ page, tweak }) => {
        await page.goto(APP);
        await page.press("Alt+Shift+P");
        await page.click(await page.ui.findByText(/Compact: OFF/));
        expect(tweak.store(visit, page).count).toBe(1);

        await page.reload();

        await page.ui.findByText(/Compact: ON/); // the palette is still open: tabStore
        expect(tweak.store(visit, page).count).toBe(1); // a new page: pageStore starts over
        expect(page.document.documentElement.dataset.visits).toBe("1");
        expect(tweak.store(site, page).lastUrl).toBe(APP);
    });

    test("tabs share global stores but not tab stores", async ({ page, browser }) => {
        await page.goto(APP);
        const other = await browser.newPage("https://app.example.com/other");

        await page.press("Alt+Shift+P");
        await page.click(await page.ui.findByText(/Compact: OFF/));

        expect(other.ui.queryByRole("listbox")).toBeNull(); // tabStore: per tab

        await other.press("Alt+Shift+P");
        await other.ui.findByText(/Compact: ON/); // globalStore: shared
    });

    test("npm packages come from the bundle's node_modules, with npm: aliases and the built-in fallback", async ({ page, tweak }) => {
        await page.goto(APP);
        expect(page.document.documentElement.dataset.greet).toBe("hello ann / HELLO ANN");
        expect(tweak.problems).toEqual([]);
    });
});

describe("Copy isolation: each concurrent test has its own copy of the stores", () => {
    for (const n of [1, 2, 3]) {
        test.concurrent(`copy ${n}`, async ({ page, tweak }) => {
            await page.goto(APP);
            expect(tweak.store(choices).compact).toBe(false);
            await page.press("Alt+Shift+P");
            await page.click(await page.ui.findByText(/Compact: OFF/));
            await page.ui.findByText(/Compact: ON/);
            expect(tweak.store(choices).compact).toBe(true);
        });
    }
});

describe("mount: one component, its own stores", () => {
    for (const n of [1, 2]) {
        test.concurrent(`toggles compact (${n})`, async ({ mount, tweak }) => {
            const ui = await mount("features/palette/Palette", {
                stores: [[palette, { open: true, filter: "" }]],
                props: { title: `Mount ${n}` },
            });
            ui.getByText(`Mount ${n}`);
            expect(tweak.store(choices).compact).toBe(false);

            await ui.click(ui.getByText(/Compact: OFF/));

            await ui.findByText(/Compact: ON/);
            expect(tweak.store(choices).compact).toBe(true);
        });
    }

    test("a closed palette renders nothing; a wrong path lists the files", async ({ mount }) => {
        const ui = await mount("./features/palette/Palette.tsx");
        expect(ui.queryByRole("listbox")).toBeNull();
        await expect(mount("features/palette/Nope")).rejects.toThrow(/no such file.*features\/palette\/Palette\.tsx/);
    });
});
