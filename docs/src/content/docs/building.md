---
title: Building from source
description: Build and run pgCowboy locally
---

## Prerequisites

- Go 1.22+
- [Wails v2](https://wails.io/docs/gettingstarted/installation)
- Platform WebView dependencies: Xcode Command Line Tools (macOS), WebView2 (Windows), or `webkit2gtk` (Linux).

## Clone and run

```bash
git clone https://github.com/michal-bartak/pgcowboy.git
cd pgcowboy
go mod tidy

# Development window with live reload:
make dev
```

:::caution[Use `make dev`, not `wails dev`]
Wails' cgo asks for `webkit2gtk-4.0`. On a distribution that ships only 4.1 (Ubuntu 24.04+,
Fedora) a bare `wails dev` therefore fails to compile even where `make build` succeeds — the
`make` targets detect the installed version and pass `-tags webkit2_41` for you.
:::

## Build a release installer

`make package` builds the app and then the native installer for the machine you are on, under `dist/`:

| Host | Artifact | Extra tooling |
|------|----------|---------------|
| macOS | `pgCowboy-v*-macos-<arch>.dmg` | none (`hdiutil`; Pillow only to draw the DMG background) |
| Windows | `pgCowboy-v*-windows-amd64.msi` | [WiX Toolset](https://wixtoolset.org/) v3 — `choco install wixtoolset` |
| Linux | `pgCowboy-v*-linux-amd64.deb` and `.rpm` | `sudo apt install rpm ruby-dev && sudo gem install fpm` |

```bash
go install github.com/wailsapp/wails/v2/cmd/wails@latest
make package                            # host platform
make package PLATFORM=darwin/universal  # Intel + Apple silicon in one bundle
```

The per-platform recipes live in `build/scripts/` (`make-dmg.sh`, `make-msi.ps1`, `make-linux-packages.sh`) and are the same scripts the release workflow runs, so a local package matches a released one.

Other useful targets:

```bash
make test               # go test ./... -count=1
make test-vet           # tests + frontend checks + go vet
make version            # print the app version
make build              # build the app bundle (with tests)
make sync-wails-version # align wails.json with VERSION
```

## Running the tests

```bash
make test
```

CI runs the same checks on every push and pull request. The suite covers call-template SQL generation, comment parsing, command validation, config migration and batch target resolution. Database calls need a live server, so those paths are exercised against a throwaway PostgreSQL when needed.

## Working on these docs

The docs are an [Astro](https://astro.build/) + [Starlight](https://starlight.astro.build/) site under `docs/`. To preview them offline:

```bash
make docs-install   # one-time: install the docs dependencies
make docs-dev       # live-reload dev server (http://localhost:4321/pgcowboy)
# or:
make docs-build     # static build into docs/dist/
make docs-preview   # serve the built site locally
```

On push to `main`, the `deploy-docs` workflow builds the site and publishes it to GitHub Pages.

### Screenshots

Every figure is a light/dark pair under `docs/src/assets/<section>/`, named after the figure:

```text
docs/src/assets/usage/target-selection-light.png
docs/src/assets/usage/target-selection-dark.png
```

Starlight's theme toggle picks one, so **replacing a screenshot is just overwriting the file and rebuilding** — no markdown to edit.

Capture is scripted, under [`docs/scripts/shots/`](https://github.com/michal-bartak/pgcowboy/tree/main/docs/scripts/shots) (Windows only — it drives the real app):

| file | what it does |
|------|--------------|
| `capture.ps1` | Dot-source it, then `Set-ClientSize 1670 1938` and `Save-ClientShot <path>`. Captures the window's **client rect in physical pixels**, so a figure is framed by the app's own content edge. Also flips the OS light/dark setting in place (`Set-OsTheme`), drives clicks and scrolling, draws callout boxes and pixelates personal data. |
| `shots.json` | One entry per figure: how to reach it, plus any crop, own capture size, callout rect and redaction rects. |
| `contentbox.mjs` | Derives a callout rect from a capture instead of eyeballing one. |
| `controlbox.mjs` | Derives a control's inner rect, so a redaction fits inside the field rather than over its border. |
| `audit.mjs` | Checks size, edge cleanliness, callout geometry and alignment, redaction containment and the absence of a scrollbar. |
| `optimize.mjs` | Re-encodes the PNGs losslessly (~14% smaller), verifying each is pixel-identical first. |

Why scripted: the first generation of assets was cropped by hand in an image editor, which left six
different sizes across figures and a 1–2px rim of desktop bleeding through the window edge — visible
as a teal last row in the dark shots. A computed client rect removes both.

The green callout frames follow two rules, both enforced by `audit.mjs`:

- **Left and right clearance are equal.** A frame is derived from its group's content box, padded
  by 20px on each side.
- **Every frame on a tab starts at the same x** — 14 on Settings, 474 on Operations — whatever its
  width. Narrower groups get narrower frames, not shifted ones.

A frame **may cross the scrollbar lane**; it is empty space. Treating the scrollbar as a boundary is
what previously ate the right-hand padding on the widest groups and put the stroke on top of the
row action buttons.

:::caution
Capture both themes with the same window size and scroll position, or the swap reads as a page jump
instead of a theme change. `Set-OsTheme` exists for exactly this: the app follows the OS setting
(`ui.theme: system`) via a `prefers-color-scheme` listener, so flipping it repaints the window
**in place** — no scroll position, staged edit or open dialog is lost between the two shots.
:::

:::caution
Callout and redaction rects are pixel coordinates, valid only for the app version they were derived
against. Re-derive them after a layout change — `contentbox.mjs` for callouts, `controlbox.mjs` for
redactions — rather than nudging them by hand. `audit.mjs` proves a redaction stayed inside its
control, but not that it covers the right thing: check every redacted figure by eye before committing.
:::

To re-shoot the set: build and launch the app, `. docs/scripts/shots/capture.ps1`, snapshot the OS
theme with `Get-OsTheme`, work through `shots.json`, restore the theme, then:

```bash
cd docs && node scripts/shots/optimize.mjs && node scripts/shots/audit.mjs
```

The canonical window size lives in the app's own `config.yaml` (`window_width` / `window_height`),
so resize the window until the Operations page no longer scrolls and the app will restore that size
on the next launch. `audit.mjs` fails any figure showing a scrollbar unless it declares `scrolls`.

A figure may declare its own `size` instead, and the four Clusters figures do -- that tab is a short
table above a pinned footer, so at the canonical height it published some 900px of empty space. They
are captured at 60% of it (`Set-ClientSize 1670 1163`), and `audit.mjs` holds them to that size. This
is not what `crop` is for: `crop` slices the top rows off a full-size capture, so it also waives the
bottom-edge check, while a short window has a real client edge that must still be clean.

Files not captured yet hold a generated placeholder that names itself, so a missing shot never breaks the build:

```bash
make docs-shots-status   # which screenshots are real, which are still placeholders
make docs-shots          # generate placeholders for newly referenced images
```

`docs-shots` also runs automatically before `docs-dev` and `docs-build`, so adding a figure to a page and rebuilding is enough to get its placeholder.
