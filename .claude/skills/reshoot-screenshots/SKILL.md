---
name: reshoot-screenshots
description: Re-capture the pgCowboy docs figures under docs/src/assets by driving the real app with docs/scripts/shots/capture.ps1. Use when asked to reshoot, re-capture or update the docs screenshots, to add a figure to the manifest, or to fix an audit.mjs failure. Windows only.
---

# Reshooting the docs screenshots

Every figure in the docs is a **light/dark pair** under `docs/src/assets/<dir>/`, captured from the
real app. There is no runner: `capture.ps1` is a dot-sourced library, `shots.json` is the manifest a
human or an agent works through, and `audit.mjs` is the regression test. This skill is the process;
**the manifest is the data** — never hardcode a figure list, a size or a rect here.

## Preflight

1. **Build the branch being documented.** A capture of a stale binary documents code that no longer
   exists — check `build/bin/pgCowboy.exe` against the last frontend commit before trusting it.
   `make build` is the documented route; capture runs on Windows, where `make` is often absent and
   the Makefile's only additions are the Linux webkit tag and the `wails.json` productVersion sync,
   so a bare `wails build` is equivalent there **provided `wails.json`'s productVersion already
   matches `VERSION`** (check it; commit the sync separately if it does not).
2. **Launch that binary** and confirm the baseline in `shots.json`'s `baseline` block: the role, the
   target selection, `ui.theme: system`. Read `baseline.note` — it lists per-session gotchas.
3. **Snapshot the OS theme before touching anything**: `$saved = Get-OsTheme`. Those two
   `HKCU\…\Themes\Personalize` DWORDs are the only system state the session touches, and they must
   be restored at the end even if the run is abandoned.
4. Check `git status`. Commit or stash unrelated churn first — a reshoot commit should be assets
   plus pipeline files, nothing else.

```powershell
. docs/scripts/shots/capture.ps1
$saved = Get-OsTheme
```

## Sizes come from the manifest

`shots.json` holds `canonical` (the client size every figure uses) and, per figure, an optional
`size` that overrides it — the four Clusters figures declare one because that tab is a short table
above a pinned footer. `crop` is a *different* field: it keeps the top N rows of a full-size
capture, and it tells `audit.mjs` to waive the bottom-edge check. A short **window** has a real
client edge, so it takes `size`, never `crop`.

The app persists whatever size it is left at (its `resize` listener calls `App.SaveWindowSize`), so
**leave the window at the canonical size when the session ends** or the next launch comes up wrong.

## Session order

1. **Figures needing a fresh app, first.** `clusters-tab` wants a virgin Status column and statuses
   survive a tab switch, so it is captured on a just-launched app before anything else.
2. **Group figures by window size**, so `Set-ClientSize` is called once per group rather than per
   figure: the short Clusters set, then everything at the canonical size.
3. Inside a group, follow `shots.json` order — consecutive figures usually share app state
   (Settings scrolled to the bottom serves three; the Alter-role form serves a dozen).

## Per-figure loop

Figures that share one app state (a Settings scroll position, a loaded role) differ only by the
callout drawn on them: capture the whole group in the current theme, flip once, capture the group
again. That halves the theme flips and guarantees the two themes show identical state.

Shell state does not persist between tool calls — dot-source `capture.ps1` in every one.

```powershell
Set-ClientSize 1670 1163           # only when the size changes
# …navigate: Invoke-ClientClick / Invoke-ClientScroll / Send-ClientKey…
Invoke-ClientClick 700 549         # click a dialog HEADING to blur any [autofocus] field
Reset-Cursor                       # no hover state in the shot
Save-ClientShot docs/src/assets/<dir>/<name>-light.png -Callout $c -Redact $r
Set-OsTheme dark
Save-ClientShot docs/src/assets/<dir>/<name>-dark.png  -Callout $c -Redact $r
Set-OsTheme light
```

The pair must differ by **nothing but the theme** — same size, same scroll position, same open
dialog, no caret, no hover. That is why the theme is flipped in place instead of re-navigating.

Coordinates everywhere are client-relative physical pixels, i.e. the PNG's own pixel grid: a control
at (x,y) in a capture is clicked at the same (x,y).

## Deriving callout and redaction rects

Rects are valid only for the app version and capture size they were derived against, so re-derive
them after any layout change instead of nudging numbers:

```bash
node docs/scripts/shots/contentbox.mjs <probe.png> --band <y0>:<y1> --scan <minX>:<maxX> --anchor <x>
node docs/scripts/shots/controlbox.mjs <probe.png> <x> <y>
```

Take a throwaway probe capture of the state, derive from it, **write the rect back into
`shots.json`**, then take the real capture with it — `audit.mjs` compares the drawn rect to the
manifest exactly. Every callout on a tab shares one left x (`callout.anchorX`), and a frame may
cross the scrollbar lane; it is empty space.

**Always pass `--scan` to `contentbox.mjs`.** Its bound is on the MEASUREMENT only, and without one
the scrollbar thumb is measured as content, so the frame spans the whole window. `shots.json`'s
callout `$comment` records the bounds in use. Find a band by scanning the probe for rows of
non-background pixels between the section dividers, rather than reading them off a screenshot.

`controlbox.mjs` returns a control's inner box; a redaction is that box inset by 2. For a monospace
raw-comment textarea the character pitch is constant, so a character offset locates the rect
exactly. Do not redact where the figure has a dialog over the data — drop the rect from the
manifest instead, and say why in `state`.

## Never

- **Never run `optimize.mjs` unless the user asks.** It is not wired into any make target or npm
  script, and some users re-encode with their own tool.
- **Never confirm a destructive dialog.** `remove-role-confirm` is captured and then **Cancelled** —
  the figures come from a live deployment with real clusters.
- **Never hand-crop.** Every size comes from `Set-ClientSize` + `Save-ClientShot -Crop`.
- **Never leave** the OS theme flipped or the window at a non-canonical size.

## Verification

```bash
cd docs && node scripts/shots/audit.mjs        # every figure: size, edges, callout, clearance, alignX, redaction, no scrollbar
node scripts/shots/audit.mjs <one.png>          # ad-hoc probe: edges + callout rects only
make docs-shots-status                          # nothing fell back to a placeholder
```

`audit.mjs` proves a redaction stayed inside its control, **not** that it covers the right thing —
eyeball every figure with a `redact` block against `shots.json`'s `redactPolicy` before committing.
