import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { Popup } from "../src/ui/popup/Popup";
import type { PopupApi, ScriptInfo, ScriptParams } from "../src/ui/popup/api";
import type { TabStatus } from "../src/shared/tabStatus";
import type { UserScriptsStatus } from "../src/shared/userScriptsStatus";

afterEach(cleanup);

function fakeApi(scripts: ScriptInfo[], params: Record<string, ScriptParams> = {}, active: string[] = [], tab: TabStatus = "ok", us: UserScriptsStatus = "ok"): PopupApi & { calls: any[] } {
    const calls: any[] = [];
    let list = scripts.map((s) => ({ ...s }));
    return {
        calls,
        listScripts: vi.fn(async () => list.map((s) => ({ ...s }))),
        activeOnTab: vi.fn(async () => [...active]),
        tabStatus: vi.fn(async () => tab),
        fixTab: vi.fn(async (s: TabStatus) => void calls.push(["fixTab", s])),
        userScripts: vi.fn(async () => us),
        fixUserScripts: vi.fn(async (s: UserScriptsStatus) => {
            calls.push(["fixUserScripts", s]);
            if (s === "no-permission") us = "off";
        }),
        setEnabled: vi.fn(async (id: string, enabled: boolean) => {
            calls.push(["setEnabled", id, enabled]);
            list = list.map((s) => (s.id === id ? { ...s, enabled } : s));
        }),
        clearError: vi.fn(async (id: string) => {
            calls.push(["clearError", id]);
            list = list.map((s) => (s.id === id ? { ...s, runtimeError: null } : s));
        }),
        getParams: vi.fn(async (id: string) => params[id]),
        setParam: vi.fn(async (...a: any[]) => void calls.push(["setParam", ...a])),
        openManager: vi.fn((id?: string) => void calls.push(["openManager", id])),
        loadSize: vi.fn(async () => null),
        saveSize: vi.fn(),
    };
}

const script = (id: string, name: string, extra: Partial<ScriptInfo> = {}): ScriptInfo => ({
    id,
    enabled: true,
    error: null,
    meta: { name, active: true },
    role: "entry",
    ...extra,
});

const names = (c: Element) => [...c.querySelectorAll("#script-list .script-name")].map((n) => n.textContent);

describe("Popup", () => {
    it("lists the tweaks (bundle entries), not their modules", async () => {
        const mod = script("m", "t/lib", { meta: { name: "t/lib", active: true }, role: "module", entry: "t/index" });
        const { container } = render(<Popup api={fakeApi([script("a", "Alpha"), mod, script("r", "solo", { role: "rewrite" })])} />);
        await waitFor(() => expect(names(container)).toEqual(["Alpha"]));
        expect(container.querySelector("#empty")).toBeNull();
    });

    it("keeps an entry's switch while its current params register no handlers", async () => {
        const defs = { on: { type: "boolean", default: false, description: "Turn interception on" } } as any;
        const values: any = { on: false };
        const api = fakeApi([script("a", "Alpha"), script("g", "gate", { meta: { name: "gate", active: false }, paramDefs: defs })]);
        api.getParams = vi.fn(async () => ({ defs, values }));
        const { container } = render(<Popup api={api} />);
        await waitFor(() => expect(names(container)).toEqual(["Alpha", "gate"]));
        const row = container.querySelectorAll("#script-list .script-item")[1];
        expect(row.querySelector(".switch.on")).not.toBeNull();

        fireEvent.click(row.querySelector(".btn-fold")!);
        await screen.findByText("Turn interception on");
        fireEvent.click(container.querySelector(".param-fold .switch")!);
        expect(api.calls).toContainEqual(["setParam", "g", "on", true]);
    });

    it("marks the scripts counted in the badge for this tab", async () => {
        const { container } = render(<Popup api={fakeApi([script("a", "Alpha"), script("b", "Beta"), script("c", "Gamma")], {}, ["a", "c", "gone"])} />);
        await screen.findByText("2 active on this tab");
        const rows = [...container.querySelectorAll(".script-item")];
        expect(rows.map((r) => r.classList.contains("active-here"))).toEqual([true, false, true]);
        expect(rows[0].querySelector('.active-ind[aria-label="active on this tab"]')).not.toBeNull();
        expect(rows[1].querySelector('.active-ind[aria-label="not active on this tab"]')).not.toBeNull();
    });

    it("shows no summary when nothing is active on the tab", async () => {
        const { container } = render(<Popup api={fakeApi([script("a", "Alpha")])} />);
        await screen.findByText("Alpha");
        expect(container.querySelector("#active-summary")).toBeNull();
        expect(container.querySelector("#tab-notice")).toBeNull();
        expect(container.querySelector("#userscripts-notice")).toBeNull();
    });

    it("explains a tab TangiTweak isn't running in and reloads it", async () => {
        const api = fakeApi([script("a", "Alpha")], {}, [], "reload");
        render(<Popup api={api} />);
        await screen.findByText("TangiTweak isn't running on this tab.");
        fireEvent.click(screen.getByRole("button", { name: "Reload tab" }));
        expect(api.calls).toContainEqual(["fixTab", "reload"]);
    });

    it("explains user scripts being off and walks through turning them on", async () => {
        const api = fakeApi([script("a", "Alpha")], {}, [], "ok", "no-permission");
        const { container } = render(<Popup api={api} />);
        await screen.findByText(/until TangiTweak has the "user scripts" permission/);
        fireEvent.click(screen.getByRole("button", { name: "Grant permission" }));
        // granted: the next step is the browser's switch
        await screen.findByRole("button", { name: "Open extension details" });
        expect(container.querySelector("#userscripts-notice")?.getAttribute("data-status")).toBe("off");
        fireEvent.click(screen.getByRole("button", { name: "Open extension details" }));
        expect(api.calls).toEqual([["fixUserScripts", "no-permission"], ["fixUserScripts", "off"]]);
    });

    it("shows the empty state", async () => {
        render(<Popup api={fakeApi([])} />);
        await screen.findByText(/No tweaks yet/);
    });

    it("shows a reach error when listing fails", async () => {
        const api = fakeApi([]);
        api.listScripts = async () => {
            throw new Error("Receiving end does not exist");
        };
        render(<Popup api={api} />);
        await screen.findByText(/Could not reach the extension/);
    });

    it("toggles a script and re-renders from the extension's state", async () => {
        const api = fakeApi([script("a", "Alpha")]);
        const { container } = render(<Popup api={api} />);
        await waitFor(() => expect(container.querySelector(".switch.on")).not.toBeNull());
        fireEvent.click(container.querySelector(".switch")!);
        await waitFor(() => expect(container.querySelector(".switch.on")).toBeNull());
        expect(api.calls).toContainEqual(["setEnabled", "a", false]);
    });

    it("refreshes the list and an open param fold when storage changes elsewhere", async () => {
        const defs = { port: { type: "string", default: "1" } } as any;
        let values: any = { port: "1" };
        const api = fakeApi([script("a", "Alpha", { paramDefs: defs })]);
        api.getParams = vi.fn(async () => ({ defs, values }));
        let fire = () => {};
        api.onChange = (fn) => ((fire = fn), () => {});
        const { container } = render(<Popup api={api} />);
        await waitFor(() => expect(names(container)).toEqual(["Alpha"]));
        fireEvent.click(await screen.findByLabelText("Toggle parameters"));
        await waitFor(() => expect((container.querySelector(".param-fold input") as HTMLInputElement)?.value).toBe("1"));
        values = { port: "9" };
        (api.listScripts as any).mockImplementation(async () => [script("a", "Alpha", { paramDefs: defs }), script("b", "Beta")]);
        fire();
        await waitFor(() => expect(names(container)).toEqual(["Alpha", "Beta"]));
        await waitFor(() => expect((container.querySelector(".param-fold input") as HTMLInputElement).value).toBe("9"));
    });

    it("marks scripts with compile errors", async () => {
        const { container } = render(<Popup api={fakeApi([script("a", "Alpha", { error: "boom" })])} />);
        await waitFor(() => expect(container.querySelector(".err-ind.compile")?.getAttribute("title")).toContain("boom"));
        expect(container.querySelector(".script-name.error")).not.toBeNull();
    });

    it("marks scripts with runtime errors; clicking dismisses", async () => {
        const api = fakeApi([script("a", "Alpha", { runtimeError: { message: "[Alpha] onRequest threw: x", at: Date.now(), count: 3 } }), script("b", "Beta")]);
        const { container } = render(<Popup api={api} />);
        await waitFor(() => expect(container.querySelector(".err-ind.runtime")?.getAttribute("title")).toContain("onRequest threw"));
        expect(container.querySelector(".err-ind")!.getAttribute("title")).toContain("3×");
        expect(container.querySelectorAll(".err-ind").length).toBe(1);
        fireEvent.click(container.querySelector(".err-ind")!);
        await waitFor(() => expect(container.querySelector(".err-ind")).toBeNull());
        expect(api.calls).toContainEqual(["clearError", "a"]);
    });

    it("marks scripts with TypeScript errors", async () => {
        const api = fakeApi([script("a", "Alpha", { typeErrors: ["line 3: Type 'string' is not assignable to type 'number'."] })]);
        const { container } = render(<Popup api={api} />);
        await waitFor(() => expect(container.querySelector(".err-ind.types")?.getAttribute("title")).toContain("line 3: Type 'string'"));
        expect(container.querySelector(".err-ind")!.getAttribute("aria-label")).toBe("type error");
    });

    it("opens the manager (all, and on a script)", async () => {
        const api = fakeApi([script("a", "Alpha")]);
        render(<Popup api={api} />);
        fireEvent.click(await screen.findByLabelText("Edit"));
        fireEvent.click(screen.getByText("Open Editor"));
        expect(api.calls).toEqual([["openManager", "a"], ["openManager", undefined]]);
    });

    it("folds parameters open, edits each type, and folds closed", async () => {
        const params: ScriptParams = {
            defs: {
                flag: { type: "boolean", description: "A flag" },
                count: { type: "number", min: 1, max: 10 },
                mode: { type: "enum", choices: ["a", "b"] },
                hosts: { type: "stringList" },
                note: { type: "string" },
            },
            values: { flag: false, count: 5, mode: "a", hosts: ["x"], note: "hi" },
        };
        const api = fakeApi([script("a", "Alpha", { paramDefs: params.defs })], { a: params });
        const { container } = render(<Popup api={api} />);
        const fold = await screen.findByLabelText("Toggle parameters");
        expect(container.querySelector(".param-fold")).toBeNull();
        fireEvent.click(fold);
        await screen.findByText("A flag");
        expect(fold.textContent).toBe("▾");

        fireEvent.click(container.querySelector(".param-fold .switch")!);
        const num = container.querySelector<HTMLInputElement>('.param-fold input[type="number"]')!;
        num.value = "99";
        fireEvent.change(num);
        expect(num.value).toBe("10");
        const sel = container.querySelector<HTMLSelectElement>(".param-fold select")!;
        sel.value = "b";
        fireEvent.change(sel);
        const ta = container.querySelector<HTMLTextAreaElement>(".param-fold textarea")!;
        ta.value = " one \n\n two ";
        fireEvent.change(ta);
        const txt = container.querySelector<HTMLInputElement>('.param-fold input[type="text"]')!;
        txt.value = "bye";
        fireEvent.change(txt);

        expect(api.calls).toEqual([
            ["setParam", "a", "flag", true],
            ["setParam", "a", "count", 10],
            ["setParam", "a", "mode", "b"],
            ["setParam", "a", "hosts", ["one", "two"]],
            ["setParam", "a", "note", "bye"],
        ]);
        expect(container.querySelector(".param-fold .switch.on")).not.toBeNull();

        fireEvent.click(fold);
        expect(container.querySelector(".param-fold")).toBeNull();
    });

    it("records a shortcut param by pressing it; clears it and resets it to the default", async () => {
        const params: ScriptParams = { defs: { toggle: { type: "shortcut", default: "Alt+Shift+H" } }, values: { toggle: "Alt+Shift+H" } };
        const api = fakeApi([script("a", "Alpha", { paramDefs: params.defs })], { a: params });
        const { container } = render(<Popup api={api} />);
        fireEvent.click(await screen.findByLabelText("Toggle parameters"));
        const rec = await waitFor(() => {
            const el = container.querySelector<HTMLButtonElement>(".param-fold .shortcut-rec");
            if (!el) throw new Error("fold not loaded");
            return el;
        });
        const caps = () => [...rec.querySelectorAll("kbd")].map((k) => k.textContent);
        expect(caps()).toEqual(["Alt", "Shift", "H"]);
        expect(container.querySelector('.param-fold [aria-label="Reset to default"]')).toBeNull();

        fireEvent.click(rec);
        expect(rec.textContent).toMatch(/Press keys/);
        fireEvent.keyDown(rec, { key: "Control", code: "ControlLeft", ctrlKey: true });
        expect(caps()).toEqual(["Ctrl"]);
        fireEvent.keyDown(rec, { key: "J", code: "KeyJ", ctrlKey: true, shiftKey: true });
        expect(caps()).toEqual(["Ctrl", "Shift", "J"]);

        fireEvent.click(rec);
        fireEvent.keyDown(rec, { key: "Escape", code: "Escape" }); // cancels
        expect(caps()).toEqual(["Ctrl", "Shift", "J"]);

        fireEvent.click(container.querySelector('.param-fold [aria-label="Remove shortcut"]')!);
        expect(rec.textContent).toMatch(/None/);
        fireEvent.click(container.querySelector('.param-fold [aria-label="Reset to default"]')!);
        expect(caps()).toEqual(["Alt", "Shift", "H"]);

        expect(api.calls).toEqual([
            ["setParam", "a", "toggle", "Mod+Shift+J"],
            ["setParam", "a", "toggle", ""],
            ["setParam", "a", "toggle", "Alt+Shift+H"],
        ]);
    });

    it("keeps edited param values when the list re-renders", async () => {
        const params: ScriptParams = { defs: { note: { type: "string" } }, values: { note: "hi" } };
        const api = fakeApi([script("a", "Alpha", { paramDefs: params.defs })], { a: params });
        const { container } = render(<Popup api={api} />);
        fireEvent.click(await screen.findByLabelText("Toggle parameters"));
        const txt = await waitFor(() => {
            const el = container.querySelector<HTMLInputElement>('.param-fold input[type="text"]');
            if (!el) throw new Error("fold not loaded");
            return el;
        });
        txt.value = "edited";
        fireEvent.change(txt);
        fireEvent.click(container.querySelector(".script-item .switch")!); // triggers a list refresh
        await waitFor(() => expect(api.calls.some((c) => c[0] === "setEnabled")).toBe(true));
        await new Promise((r) => setTimeout(r, 20));
        expect(container.querySelector<HTMLInputElement>('.param-fold input[type="text"]')!.value).toBe("edited");
    });

    it("shows just the bundle name and renders custom iconUrl on the popup menu", async () => {
        const api = fakeApi([
            script("s1", "redwood/devtools.tsx", { bundleName: "Redwood", bundleDescription: "Atlas bundle", iconUrl: "data:image/png;base64,AAAA" }),
            script("s2", "multi/a"),
            script("s3", "multi/b"),
        ]);
        const { container } = render(<Popup api={api} />);
        await waitFor(() => expect(names(container)).toEqual(["Redwood", "multi/a", "multi/b"]));
        expect(container.querySelector(".script-name")?.getAttribute("title")).toBe("Atlas bundle");
        expect(container.querySelector(".script-name")?.getAttribute("data-tt-icon")).toBe("data:image/png;base64,AAAA");
        expect(container.querySelectorAll(".script-name")[1]?.hasAttribute("data-tt-icon")).toBe(false);
        expect(container.querySelector<HTMLImageElement>("img.script-icon")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
        expect(container.querySelector<HTMLImageElement>("img.script-icon")?.getAttribute("data-tt-icon")).toBe("data:image/png;base64,AAAA");
        expect(container.querySelectorAll("img.script-icon")).toHaveLength(1);
    });

    it("renders nested tweak.params objects as collapsible sections and updates dotted paths", async () => {
        const params: ScriptParams = {
            defs: {
                enabled: { type: "boolean", default: true },
                network: {
                    host: { type: "string", default: "api.example.com", description: "Target host" },
                    retries: {
                        max: { type: "number", default: 3, min: 0, max: 10 },
                    },
                },
            },
            values: { enabled: true, network: { host: "api.example.com", retries: { max: 3 } } },
        };
        const api = fakeApi([script("a", "Alpha", { paramDefs: params.defs })], { a: params });
        const { container } = render(<Popup api={api} />);
        fireEvent.click(await screen.findByLabelText("Toggle parameters"));
        await screen.findByText("Target host");

        const sections = [...container.querySelectorAll(".param-section-title")].map((el) => el.textContent);
        expect(sections).toEqual(["network", "retries"]);
        expect(container.querySelectorAll("details.param-section[open]")).toHaveLength(2);

        const hostInput = container.querySelector<HTMLInputElement>('.param-section input[type="text"]')!;
        hostInput.value = "staging.example.com";
        fireEvent.change(hostInput);
        const maxInput = container.querySelector<HTMLInputElement>('.param-section input[type="number"]')!;
        maxInput.value = "7";
        fireEvent.change(maxInput);

        expect(api.calls).toEqual([
            ["setParam", "a", "network.host", "staging.example.com"],
            ["setParam", "a", "network.retries.max", 7],
        ]);
    });

    it("renders Original | Custom site mode toggle bar when a tweak.site matches the active tab", async () => {
        const api = fakeApi([script("s1", "Costco Site")]);
        api.siteTabState = vi.fn(async () => ({
            scriptId: "s1",
            scriptName: "Costco Site",
            mode: "custom" as const,
            defaultMode: "custom" as const,
            debuggerSafe: false,
        }));
        api.toggleSiteTab = vi.fn(async (mode) => void api.calls.push(["toggleSiteTab", mode]));

        const { container } = render(<Popup api={api} />);
        const bar = await waitFor(() => {
            const el = container.querySelector("#site-mode-bar");
            if (!el) throw new Error("site mode bar not rendered");
            return el;
        });
        const origBtn = bar.querySelectorAll("button")[0];
        const customBtn = bar.querySelectorAll("button")[1];
        expect(customBtn.getAttribute("aria-pressed")).toBe("true");
        expect(origBtn.getAttribute("aria-pressed")).toBe("false");

        fireEvent.click(origBtn);
        expect(api.calls).toContainEqual(["toggleSiteTab", "original"]);
        expect(origBtn.getAttribute("aria-pressed")).toBe("true");
    });
});

describe("Popup toasts", () => {
    it("mutes a tweak's toasts and lists its recent toasts and schedules", async () => {
        const api = fakeApi([script("s1", "Price watch"), script("s2", "Quiet")]);
        let muted = false;
        let paused = false;
        api.toastActivity = vi.fn(async () => ({
            s1: {
                muted,
                history: [{ id: "drop", title: "Price dropped", kind: "success" as const, at: Date.now(), status: "dropped" as const, reason: "muted" }],
                schedules: [{ scriptId: "s1", name: "Price watch", index: 0, running: false, failures: 0, rev: 1, paused }],
            },
        }));
        api.muteToasts = vi.fn(async (_s: string, m: boolean) => void (muted = m));
        api.pauseSchedules = vi.fn(async (_s: string, p: boolean) => void (paused = p));
        render(<Popup api={api} />);
        fireEvent.click(await screen.findByLabelText("Mute toasts"));
        await waitFor(() => expect(api.muteToasts).toHaveBeenCalledWith("s1", true));
        await screen.findByLabelText("Unmute toasts");
        expect(screen.getAllByLabelText(/mute toasts/i).length).toBe(1);
        fireEvent.click(screen.getByLabelText("Toggle details"));
        expect(await screen.findByText("Price dropped")).toBeTruthy();
        expect(screen.getByText(/not shown: muted/)).toBeTruthy();
        fireEvent.click(screen.getByText("Pause"));
        await waitFor(() => expect(api.pauseSchedules).toHaveBeenCalledWith("s1", true));
        expect(await screen.findByText("Resume")).toBeTruthy();
    });
});
