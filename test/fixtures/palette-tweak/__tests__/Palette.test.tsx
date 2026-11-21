// @vitest-environment happy-dom
import { fireEvent, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { renderTweak } from "tangitweak/test";
import { Palette } from "../features/palette/Palette";
import { choices, palette } from "../features/palette/state";

test("shows nothing while closed", () => {
    renderTweak(<Palette />);
    expect(screen.queryByRole("listbox")).toBeNull();
});

test("toggles compact", async () => {
    const { store } = renderTweak(<Palette />, {
        stores: [[palette, { open: true, filter: "" }]],
    });

    fireEvent.click(screen.getByText(/Compact: OFF/));

    await screen.findByText(/Compact: ON/);
    expect(store(choices).compact).toBe(true);
});

test("stores start over after each test", () => {
    expect(palette.open).toBe(false);
    expect(choices.compact).toBe(false);
});
