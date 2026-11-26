/**
 * Browser-action popup: list the tweaks (bundle entries), toggle them, edit their parameters
 * inline, open the full manager on a specific script.
 */
import { scriptHealth } from "../../shared/scriptHealth";
import { setParamAtPath } from "../../shared/scriptDef";
import { useEffect, useState, type MouseEvent } from "react";
import { Switch } from "../components/Switch";
import { ParamTreeFields } from "../components/ParamField";
import { IconBell, IconPen } from "../components/icons";
import type { PopupApi, ScriptInfo, ScriptLayer, ScriptParams, SiteTabState, ToastActivity } from "./api";
import { TAB_NOTICE, type TabStatus } from "../../shared/tabStatus";

type Load = { state: "loading" } | { state: "ready"; scripts: ScriptInfo[] } | { state: "error" };

export function Popup({ api }: { api: PopupApi }) {
    const [load, setLoad] = useState<Load>({ state: "loading" });
    // scripts counted in the toolbar badge for the current tab
    const [active, setActive] = useState<ReadonlySet<string>>(new Set());
    const [toasts, setToasts] = useState<Record<string, ToastActivity>>({});
    const refreshToasts = () => api.toastActivity?.().then(setToasts, () => {});
    const refreshActive = () =>
        api.activeOnTab().then(
            (ids) => setActive((prev) => (sameIds(prev, ids) ? prev : new Set(ids))),
            () => {}
        );

    const refresh = async () => {
        void refreshActive();
        void refreshToasts();
        try {
            setLoad({ state: "ready", scripts: await api.listScripts() });
        } catch {
            setLoad({ state: "error" });
        }
    };
    // bumped on outside changes so open param folds re-fetch too
    const [version, setVersion] = useState(0);
    const [tab, setTab] = useState<TabStatus>("ok");
    const [siteTab, setSiteTab] = useState<SiteTabState | null>(null);
    const refreshSiteTab = () =>
        api.siteTabState?.().then(setSiteTab, () => {});
    useEffect(() => {
        void refresh();
        void refreshSiteTab();
        api.tabStatus().then(setTab, () => {});
        let t: ReturnType<typeof setTimeout> | undefined;
        const off = api.onChange?.(() => {
            clearTimeout(t);
            t = setTimeout(() => {
                void refresh();
                void refreshSiteTab();
                setVersion((v) => v + 1);
            }, 150);
        });
        // the page keeps making requests while the popup is open
        const poll = setInterval(() => (refreshActive(), refreshToasts()), 1500);
        return () => {
            clearTimeout(t);
            clearInterval(poll);
            off?.();
        };
    }, []);

    // a tweak is its bundle's entry: its modules (and files outside a bundle) have no switch or params of their own
    const visible = load.state === "ready" ? load.scripts.filter((s) => s.role === "entry") : [];
    const nActive = visible.filter((s) => active.has(s.id)).length;

    return (
        <>
            <div id="header">
                <span id="title">TangiTweak</span>
                {nActive > 0 && (
                    <span id="active-summary" title="Scripts counted in the toolbar badge: enabled, and matched this tab's page or one of its requests since it loaded">
                        <span className="active-dot" />
                        {nActive} active on this tab
                    </span>
                )}
                <button id="btn-manager" title="Open the Editor" onClick={() => api.openManager()}>
                    Open Editor
                </button>
            </div>
            {siteTab && (
                <div id="site-mode-bar" role="region" aria-label="Site mode">
                    <span className="site-mode-name" title={siteTab.scriptName}>
                        {siteTab.scriptName}
                    </span>
                    <div className="site-mode-toggle" role="group" aria-label="View mode">
                        <button
                            type="button"
                            className={siteTab.mode === "original" ? "active" : undefined}
                            aria-pressed={siteTab.mode === "original"}
                            onClick={async () => {
                                if (siteTab.mode === "original") return;
                                setSiteTab({ ...siteTab, mode: "original" });
                                await api.toggleSiteTab?.("original");
                            }}
                        >
                            Original
                        </button>
                        <button
                            type="button"
                            className={siteTab.mode === "custom" ? "active" : undefined}
                            aria-pressed={siteTab.mode === "custom"}
                            onClick={async () => {
                                if (siteTab.mode === "custom") return;
                                setSiteTab({ ...siteTab, mode: "custom" });
                                await api.toggleSiteTab?.("custom");
                            }}
                        >
                            Custom
                        </button>
                    </div>
                </div>
            )}
            {tab !== "ok" && (
                <div id="tab-notice" role="alert">
                    {TAB_NOTICE[tab].lines.map((l, i) => (
                        <div key={i} className={i ? undefined : "tab-notice-head"}>
                            {l}
                        </div>
                    ))}
                    <button onClick={() => void api.fixTab(tab)}>{TAB_NOTICE[tab].action}</button>
                </div>
            )}
            <ul id="script-list">
                {visible.map((s) => (
                    <ScriptRow key={s.id} script={s} api={api} onChanged={refresh} version={version} activeHere={active.has(s.id)} toasts={toasts[s.id]} />
                ))}
            </ul>
            {load.state === "error" && <div id="empty">Could not reach the extension — close and reopen the popup.</div>}
            {load.state === "ready" && visible.length === 0 && (
                <div id="empty">No tweaks yet — open the Editor to create one.</div>
            )}
            <ResizeGrip api={api} />
        </>
    );
}

const sameIds = (a: ReadonlySet<string>, b: string[]) => a.size === b.length && b.every((id) => a.has(id));

const hasParams = (s: ScriptInfo) => !!s.paramDefs && Object.keys(s.paramDefs).length > 0;
const NET_KINDS = new Set(["onRequest", "onResponseHeaders", "onResponseBody"]);
/** network handlers run in a layer the user can set */
const hasLayer = (s: ScriptInfo) => !!s.meta.routes?.some((r) => NET_KINDS.has(r.kind));

function ScriptRow({ script, api, onChanged, version, activeHere, toasts }: { script: ScriptInfo; api: PopupApi; onChanged: () => void; version: number; activeHere: boolean; toasts?: ToastActivity }) {
    const [open, setOpen] = useState(false);
    const [iconBroken, setIconBroken] = useState(false);
    useEffect(() => setIconBroken(false), [script.iconUrl]);
    const health = scriptHealth(script);
    const icon = script.iconUrl && !iconBroken ? script.iconUrl : undefined;
    const desc = script.bundleDescription;
    return (
        <>
            <li className={"script-item" + (activeHere ? " active-here" : "")}>
                <Switch
                    on={script.enabled}
                    title={script.enabled ? "Disable" : "Enable"}
                    onToggle={async (next) => {
                        await api.setEnabled(script.id, next);
                        onChanged();
                    }}
                />
                <span
                    className="active-ind"
                    role="img"
                    aria-label={activeHere ? "active on this tab" : "not active on this tab"}
                    title={activeHere ? "Active on this tab — matched the page or one of its requests (counted in the badge)" : "Not active on this tab"}
                />
                {icon && <img className="script-icon" src={icon} alt="" title={desc} data-tt-icon={icon} onError={() => setIconBroken(true)} />}
                <span className={health ? "script-name error" : "script-name"} title={desc} data-tt-icon={icon}>
                    {script.bundleName || script.meta.name}
                </span>
                {health && (
                    <span
                        className={`err-ind ${health.kind}`}
                        role="img"
                        aria-label={`${health.kind === "types" ? "type" : health.kind} error`}
                        title={health.tooltip}
                        onClick={
                            health.kind === "runtime"
                                ? async () => {
                                      await api.clearError(script.id);
                                      onChanged();
                                  }
                                : undefined
                        }
                    >
                        ⚠
                    </span>
                )}
                <button className="btn-icon" title="Open in the Editor" aria-label="Edit" onClick={() => api.openManager(script.id)}>
                    <IconPen />
                </button>
                {toasts && api.muteToasts && (
                    <button
                        className={"btn-icon btn-mute" + (toasts.muted ? " muted" : "")}
                        title={toasts.muted ? "Toasts are muted. Click to unmute" : "Mute this tweak's toasts"}
                        aria-label={toasts.muted ? "Unmute toasts" : "Mute toasts"}
                        aria-pressed={toasts.muted}
                        onClick={async () => {
                            await api.muteToasts!(script.id, !toasts.muted);
                            onChanged();
                        }}
                    >
                        <IconBell off={toasts.muted} />
                    </button>
                )}
                {(hasParams(script) || hasLayer(script) || !!toasts) && (
                    <button
                        className="btn-fold"
                        title={open ? "Hide settings" : "Show settings"}
                        aria-label={toasts ? "Toggle details" : "Toggle parameters"}
                        aria-expanded={open}
                        onClick={() => setOpen(!open)}
                    >
                        {open ? "▾" : "▸"}
                    </button>
                )}
            </li>
            {open && (hasParams(script) || hasLayer(script)) && <ParamFold scriptId={script.id} api={api} version={version} layered={hasLayer(script)} />}
            {open && toasts && <ToastFold scriptId={script.id} toasts={toasts} api={api} onChanged={onChanged} />}
        </>
    );
}

function ParamFold({ scriptId, api, version, layered }: { scriptId: string; api: PopupApi; version: number; layered: boolean }) {
    const [params, setParams] = useState<ScriptParams | null>(null);
    const [layer, setLayer] = useState<ScriptLayer | null>(null);
    useEffect(() => {
        let live = true;
        api.getParams(scriptId).then((p) => live && setParams(p));
        if (layered && api.getLayer) api.getLayer(scriptId).then((l) => live && setLayer(l));
        return () => void (live = false);
    }, [scriptId, version, layered]);

    if (!params) return <li className="param-fold">Loading…</li>;
    const entries = Object.entries(params.defs);
    return (
        <li className="param-fold">
            {entries.length === 0 ? (
                layer ? null : "This script declares no parameters."
            ) : (
                <ParamTreeFields
                    defs={params.defs}
                    values={params.values}
                    onChange={(path, v) => {
                        setParams({ ...params, values: setParamAtPath(params.values, path, v) });
                        void api.setParam(scriptId, path.join("."), v);
                    }}
                />
            )}
            {layer && (
                <div className="param-row">
                    <div className="param-label">
                        <span>Layer</span>
                    </div>
                    <div className="param-desc">Handlers run base first, then site, then override. The last word wins.</div>
                    <select
                        aria-label="Layer"
                        value={layer.layer ?? ""}
                        onChange={(e) => {
                            const v = (e.currentTarget.value || undefined) as ScriptLayer["layer"];
                            setLayer({ ...layer, layer: v });
                            void api.setLayer?.(scriptId, v);
                        }}
                    >
                        <option value="">{layer.auto}</option>
                        <option value="base">base</option>
                        <option value="site">site</option>
                        <option value="override">override</option>
                    </select>
                </div>
            )}
        </li>
    );
}

const ago = (t: number): string => {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
};

const STATUS: Record<string, string> = { shown: "", queued: "waiting for a tab", expired: "expired", dropped: "not shown" };

/** A tweak's recent toasts and its schedules. */
function ToastFold({ scriptId, toasts, api, onChanged }: { scriptId: string; toasts: ToastActivity; api: PopupApi; onChanged: () => void }) {
    const { history, schedules } = toasts;
    const allPaused = schedules.length > 0 && schedules.every((r) => r.paused);
    return (
        <li className="param-fold toast-fold">
            {schedules.length > 0 && (
                <div className="toast-fold-head">
                    <span>{schedules.length === 1 ? "1 schedule" : `${schedules.length} schedules`}{allPaused ? ", paused" : ""}</span>
                    {api.pauseSchedules && (
                        <button
                            className="btn-fold"
                            onClick={async () => {
                                await api.pauseSchedules!(scriptId, !allPaused);
                                onChanged();
                            }}
                        >
                            {allPaused ? "Resume" : "Pause"}
                        </button>
                    )}
                </div>
            )}
            {history.length === 0 ? (
                <div className="toast-none">No toasts yet.</div>
            ) : (
                <ul className="toast-history">
                    {history.map((h, i) => {
                        const why = h.status === "dropped" && h.reason ? `not shown: ${h.reason}` : STATUS[h.status];
                        const text = (
                            <>
                                <span className={`toast-kind ${h.kind ?? "info"}`} />
                                <span className="toast-text">{h.title || h.message || h.id}</span>
                                <span className="toast-when">{why ? `${ago(h.at)}, ${why}` : ago(h.at)}</span>
                            </>
                        );
                        return (
                            <li key={`${h.id}:${i}`} title={h.title && h.message ? h.message : undefined}>
                                {h.url ? <a href={h.url} target="_blank" rel="noreferrer">{text}</a> : text}
                            </li>
                        );
                    })}
                </ul>
            )}
        </li>
    );
}

// Chrome ignores CSS resize on the popup viewport; dragging the grip sets
// an explicit body size and the window follows.
const MIN_W = 320;
const MIN_H = 160;
const MAX_W = 780; // Chrome popup ceiling
const MAX_H = 580;
const clampSize = (w: number, h: number) => ({
    w: Math.max(MIN_W, Math.min(MAX_W, w)),
    h: Math.max(MIN_H, Math.min(MAX_H, h)),
});
function applySize(w: number, h: number): void {
    const s = clampSize(w, h);
    document.body.style.width = `${s.w}px`;
    document.body.style.height = `${s.h}px`;
}

function ResizeGrip({ api }: { api: PopupApi }) {
    useEffect(() => {
        api.loadSize().then((s) => s && applySize(s.w, s.h));
    }, []);
    const onMouseDown = (e: MouseEvent) => {
        e.preventDefault();
        const body = document.body;
        body.classList.add("resizing");
        const [x0, y0, w0, h0] = [e.clientX, e.clientY, body.offsetWidth, body.offsetHeight];
        const move = (ev: globalThis.MouseEvent) => applySize(w0 + ev.clientX - x0, h0 + ev.clientY - y0);
        const up = (ev: globalThis.MouseEvent) => {
            body.classList.remove("resizing");
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
            api.saveSize(clampSize(w0 + ev.clientX - x0, h0 + ev.clientY - y0));
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
    };
    return <div id="resize-grip" title="Drag to resize" onMouseDown={onMouseDown} />;
}
