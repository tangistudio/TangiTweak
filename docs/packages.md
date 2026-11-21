# Installing and sharing tweaks

[<img src="../icons/icon.svg" width="16" height="16" align="absmiddle" alt=""> README](../README.md) · [Glossary](../GLOSSARY.md)

A **tweak** is a folder whose `package.json` has a `"tangitweak"` block.
Its **entry** is the file `main` names, or else `index.ts`, or else
`index.tsx`. The entry is the tweak: it has the enable switch, the params
and the stores. The folder's other files are its **modules**. They run when
the entry imports them, and what they register (handlers, params, stores)
belongs to the tweak. You install, update, roll back and share the folder
as one.

Single `.ts` files and folders described by a `metadata.json` no longer
load. The Editor lists them in Problems as needing a rewrite and keeps their
files. To rewrite one, make a tweak with **New Tweak…** and move the code
into its `index.ts`.

## package.json

A tweak describes itself in its `package.json`, in npm's format. The install
page shows it before anything is installed:

```json
{
    "name": "pr-tools",
    "version": "2.0.0",
    "description": "Review helpers for GitHub pull requests",
    "author": "me",
    "license": "MIT",
    "homepage": "https://github.com/me/scripts",
    "main": "pr-tools.ts",
    "tangitweak": {
        "displayName": "PR tools",
        "icon": "icon.svg",
        "connect": ["api.github.com"],
        "updateURL": "https://github.com/me/scripts/blob/main/pr-tools/package.json"
    },
    "dependencies": {
        "tangitweak": "^0.40.0-alpha",
        "dayjs": "^1.11.0"
    }
}
```

Every field but the `"tangitweak"` block is optional. `name` names the
tweak's folder when it's installed, and `displayName` (else `name`) is what
the Explorer, the popup and the install page show. `description` is also the
tweak's tooltip in the popup.
`icon` sets the tweak's icon, shown in the Explorer and the popup: pass a relative file path (`.svg`, `.png`, `.webp`, `.jpg`, `.gif`, `.ico`, `.avif`), a `data:` or `https://` URL, or inline `<svg>` markup.
`version` is compared part by part (`1.10.0` is newer than `1.9`).
`dependencies.tangitweak` sets the oldest TangiTweak the tweak runs on: the
lowest version of its range (`^0.40.0-alpha` means 0.40.0 or newer). Only
`major.minor.patch` is compared; a suffix like `-alpha` is ignored. On an
older TangiTweak the tweak doesn't run and says which version it needs; the
install page warns, and background auto-updates wait for review. When the
dependency isn't a version range (a `file:` path, a git URL), set
`"minTangiTweakVersion"` in the `"tangitweak"` block instead. Without either,
any version will do.
`connect` lists the hosts its `tweak.fetch` calls reach. An update that
adds one waits for your approval.
`updateURL` is where updates come from, instead of where the tweak was
installed from. It takes any URL the install page reads, as listed in the table under
[Install a tweak](#install-a-tweak): a `package.json`, `.ts` or `.zip` URL, a GitHub
file or folder, a gist, or a gist's raw file. See [Updates](#updates).
`dependencies` also lists the [npm packages](scripting.md#packages-from-unpkg)
the tweak imports by name.

The Editor marks a `main` that names no file in the folder as an error.
Files outside the tweak's folder can't be imported.

## Install a tweak

- **Open its URL.** A tab that opens a URL ending in `.tangitweak.ts` (or
  `.tangitweak.tsx`), or any supported URL ending in
  `#tangitweak:install` (for example
  `https://github.com/me/my-tweak#tangitweak:install` in a GitHub `README.md`
  or `https://example.com/kit/package.json#tangitweak:install`),
  goes to TangiTweak's install page. That covers a link on
  a site, a GitHub repository or folder, a raw GitHub or gist file, a URL you type, or a local `file://`
  path. For local files, turn on **Allow access to file URLs** for
  TangiTweak in the browser's extension settings. Without `#tangitweak:install`, GitHub's own page for a file
  (`github.com/…/blob/…`) stays as it is. Add `#tt-raw` to any URL to just
  view the file. A `.ts` URL installs the tweak whose `package.json` is in
  the same folder.
- **From the Explorer.** The **Install Tweak…** button (a document with a down arrow), or
  right-click the empty area → **Install Tweak…**, opens the install dialog
  in the Editor. There you can paste a URL, choose a folder or choose a
  `.zip`.
- **Drag and drop.** Drop a link, a folder or a `.zip` onto the install dialog or the install page. Dropping one
  onto the Explorer opens the dialog with it. A dropped folder's
  `node_modules` and `.git` are skipped.

The install dialog and page accept:

| Source | Example | Updates from |
| --- | --- | --- |
| A GitHub file | `https://github.com/me/scripts/blob/main/dark/package.json`, `https://raw.githubusercontent.com/me/scripts/main/kit/package.json` | the branch or tag (each update is pinned to a commit) |
| A GitHub folder or repo | `https://github.com/me/scripts/tree/main/kit`, `https://github.com/me/dark-mode` (public, or private when signed in to GitHub in this browser) | the same |
| A GitLab file, folder or repo | `https://gitlab.com/team/sub/kit`, `https://gitlab.com/team/scripts/-/tree/main/kit`, `https://git.corp.example/team/scripts/-/blob/main/dark/package.json` (public, or private when signed in) | the same |
| A gist | `https://gist.github.com/me/0123abcd` | the gist's latest revision |
| A gist's file | `https://gist.githubusercontent.com/me/0123abcd/raw/package.json` | the same |
| Any other URL of a `package.json` or a tweak's `.ts` file | `https://example.com/tools/dark/package.json`, `file:///home/me/kit/index.ts` | the same URL; the tweak's files are read next to it |
| A `.zip` URL | `https://example.com/kit.zip`, a release asset, `https://github.com/me/kit/archive/refs/heads/main.zip` | the same URL |
| A folder | **Choose a folder…** | its `updateURL`, if any |
| A `.zip` file | **Choose a .zip…** | its `updateURL`, if any |

A tweak's `updateURL` overrides the **Updates from** column.

A zip of a single folder counts as that folder. A folder, gist or zip
installs the tweak of its shallowest `package.json` with a `"tangitweak"`
block; without one there's nothing to install. The page reads the
`package.json`, the entry, and every file they import by a relative path. A
tweak holds at most 200 files and 5 MB.

Before anything is written, the page shows:

- its `package.json`: name, version, description, author, license and homepage,
  and where it updates from when `updateURL` names another place;
- **what it can do**, riskiest first:
  - running on every site;
  - the `debugger` strategy;
  - running code in the site's JavaScript world (`tweak.onSite`);
  - the `helper` strategy;
  - the sites it runs on;
  - the other strategies;
  - overlays;
  - the hosts it fetches from (`connect`);
  - the [unpkg packages](scripting.md#packages-from-unpkg) it imports;
- warnings: a compile error (it can't be installed), a newer TangiTweak
  it needs, imports it couldn't find, and bare imports its `dependencies`
  don't list (below);
- the files, each one expandable.

**Install** writes the files and turns the tweak on. **Install turned
off** writes them with the tweak off. **Keep it up to date** (on by default
for URL installs) turns on auto-update.

If a tweak with the same name (or source) already exists in the
Explorer, the review shows the installed vs. incoming version and a line-by-line
diff of every changed, added, or removed file, and asks whether to **Upgrade**
it in place (preserving your settings and parameter values, with **Roll Back**
available afterwards) or **Install as “… (2)”** alongside it.

## Where it goes

A tweak lands in a folder named after its `package.json`'s `name`
(`pr-tools/`, or `pr-tools (2)/` when the name is taken). The files keep
their paths in the tweak:

```text
pr-tools/
├── package.json
├── pr-tools.ts
├── review/
│   └── diff.ts
└── lib/
    └── github.ts
```

They are ordinary files: open, edit, rename and move them as usual. The
Explorer shows a tweak's folder with a box icon. Hover it for the source,
version and update state.

Imports that don't start with `./` or `../` (bare imports like `"dayjs"`)
resolve through the tweak's `dependencies` and are downloaded from unpkg
([Packages from unpkg](scripting.md#packages-from-unpkg)). The install page
warns about each bare import its `dependencies` don't list.

## Updates

A package installed from a URL with auto-update on is checked once a day. It
is also checked when the browser starts, if the last check is more than a
day old. Right-click the tweak's folder → **Check for Updates**
checks it now. A `file://` tweak is read again whenever the Editor's window
gains focus. A tweak updates as one: all its files, or none.

When the installed version's `package.json` has an `updateURL`, updates come from
there instead of from where the package was installed from. A package
installed from a folder or zip updates only this way. Without an
`updateURL`, it doesn't update. If the files at the new place match the installed ones,
nothing changes.

An update applies by itself only when all of these hold:

- it can't do more than the installed version: no new sites, strategies,
  `tweak.onSite` code, overlays, `connect` hosts or unpkg packages;
- you haven't edited, renamed or deleted any of the tweak's files;
- its `version` doesn't go down;
- it doesn't change where updates come from (its `updateURL`);
- it doesn't need a newer TangiTweak;
- it compiles.

Otherwise it waits for review. The Explorer shows ⬆ on the package (click
it, or right-click → **Review Update…**) and the Log says why. The review
(a dialog in the Editor) lists what the update adds and why it waited, and shows each changed
file as a diff. **Update** applies it. **Skip this version** keeps the
installed one, and later checks don't offer that revision again. An update
that doesn't compile is never applied; the package's tooltip says why.

Updating keeps each file's identity, so parameter values and enabled state
stay. Files the new version no longer has are deleted. Files you edited are
replaced by the update's, so review the diff before you apply it.

Right-click a tweak's folder for:

- **Review Update…**, when one waits;
- **Check for Updates**;
- **Turn Auto-Update On/Off**;
- **Roll Back to …**, which restores the version before the last update and
  turns auto-update off (turn it back on to take updates again);
- **Open Source Page**, for URL packages;
- **Forget Package (Keep Files)**, which stops tracking it; the files stay
  as an ordinary tweak. Deleting the tweak's files forgets it too.

## Sharing tweaks

Put the tweak's folder anywhere with a URL (a GitHub repository, a gist, any
web server) and share the folder's URL, its `package.json`'s URL, or either
with `#tangitweak:install` added so that opening the link installs it.
Whoever installs it gets all its files and their updates together. A zip of
the folder works for people installing from local files.

**New Tweak…** (the Explorer's **+** button, or right-click a folder) asks
for a name and creates a tweak in a new folder:

```text
my-tweak/
├── package.json     the "tangitweak" block, and "dependencies": { "tangitweak": "^<this version>" }
├── tsconfig.json    { "extends": "tangitweak/tsconfig.json" }
├── index.ts         a small example
└── .gitignore       node_modules/ and .tweak/
```

The `tsconfig.json` extends the one in the `tangitweak` npm package (the
SDK), so editors check `tweak` and the built-ins (valtio, React) the way
TangiTweak does. `npm install` in the tweak's folder fetches it, since its
`package.json` lists `tangitweak`. In a [synced folder](editor.md#synced-folder),
Folder Sync writes the running extension's copy of the SDK to
`.tangitweak/sdk/tangitweak/` and links it from the folder's root
`package.json`, so `npm install` at the root works without npm's copy. The
same package has `tangitweak/test` for [testing tweaks](testing.md#setup).

**Export Package…** (right-click a tweak's folder) downloads the tweak as
saved, as a `.zip` of its folder. It installs with **Install Tweak…**.

A [synced folder](editor.md#synced-folder) holds your tweaks as files, so a
tweak's folder there can be committed to a repository as is.
