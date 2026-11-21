# tangitweak

The SDK for [TangiTweak](https://github.com/tangistudio/TangiTweak) tweaks: the typings of the `tweak` API, the `tsconfig.json` tweaks extend, and `tangitweak/test` for testing tweaks with Vitest.

Your tweaks still run in the extension. This package lets you type-check and test them on your machine and in CI.

## Install

```sh
npm install --save-dev tangitweak vitest react react-dom valtio
# only if you use renderTweak:
npm install --save-dev @testing-library/react
```

Needs Node.js 23.8 or later.

## Type-check a tweak

In the tweak's `tsconfig.json`:

```json
{ "extends": "tangitweak/tsconfig.json" }
```

Then `import { tweak } from "tangitweak"` is typed, and so are the built-ins TangiTweak provides (valtio, React).

## Test a tweak

```ts
// __tests__/palette.test.ts
import { expect } from "vitest";
import { test } from "tangitweak/test";

test("a shortcut opens the palette", async ({ page }) => {
    await page.goto("https://app.example.com/home");
    await page.press("Alt+Shift+P");
    await page.ui.findByRole("listbox");
});
```

Run it with `npx vitest`.

See [Testing tweaks](https://github.com/tangistudio/TangiTweak/blob/main/docs/testing.md) for fixtures, `renderTweak` and `mount`.

## Without npm

Folder Sync writes this same package to `.tangitweak/sdk/tangitweak/` in your synced folder and links it from the folder's `package.json` (`"tangitweak": "file:.tangitweak/sdk/tangitweak"`), so `npm install` there works offline.

## Versions

The package's version is the extension's. A tweak's `package.json` asks for a minimum one in `dependencies.tangitweak` (for example `"^0.40.0-alpha"`); see [Tweak packages](https://github.com/tangistudio/TangiTweak/blob/main/docs/packages.md).
