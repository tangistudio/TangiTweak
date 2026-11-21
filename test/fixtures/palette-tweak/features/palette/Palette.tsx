import { useSnapshot } from "valtio";
import { choices, palette } from "./state";

export function Palette({ title = "Tweaks" }: { title?: string }) {
    const open = useSnapshot(palette);
    const chosen = useSnapshot(choices);
    if (!open.open) return null;
    return (
        <div>
            <h2>{title}</h2>
            <input aria-label="Filter" value={open.filter} onChange={(e) => (palette.filter = e.target.value)} />
            <ul role="listbox">
                <li role="option" aria-selected={chosen.compact} onClick={() => (choices.compact = !choices.compact)}>
                    Compact: {chosen.compact ? "ON" : "OFF"}
                </li>
            </ul>
        </div>
    );
}
