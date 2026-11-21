import { tweak } from "tangitweak";
import { Palette } from "./Palette";
import { palette, site, visit } from "./state";
import { greetings } from "../text/greet";

export function installPalette() {
    tweak.onPage("*://app.example.com/*", (ctx) => {
        site.lastUrl = location.href;
        visit.count++;
        document.documentElement.dataset.greet = greetings("ann");
        document.documentElement.dataset.visits = String(visit.count);
        ctx.shortcut("Alt+Shift+P", () => {
            palette.open = !palette.open;
        });
        ctx.mount(<Palette />);
    });
}
