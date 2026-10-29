# Changelog

All notable changes to pgCowboy. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

> **Feeds releases:** the section matching `VERSION` is extracted by
> [`.github/workflows/release.yml`](.github/workflows/release.yml) into the GitHub release
> description. Keep `[Unreleased]` current; at release time rename it to `## [X.Y.Z] - YYYY-MM-DD`.
> See [RELEASING.md](RELEASING.md).

## [Unreleased]

## [1.2.0] - 2026-10-29

### Added

- **Rename role** - incl pre-flight check
- **MD5 password warning** when renaming - can be suppressed (see Settings → General).

### Fixed

- **Alter role comment** — changing a comment alone did not activate the Save button.
- **Focus ring on toggle buttons** (Appearance, Fields/Raw) — corners no longer cut off.

## [1.1.2] - 2026-08-20

### Fixed

- **Scrollbars** — Fixed on linux, redesigned to render in margin area rather than in content
- **Tables** — column headers stay fixed
- **Appearance "System" on Linux** — follows the desktop's light/dark setting
- **Dropdowns on Linux** — follows the theme
- **Application icon on Linux** — the window, task bar and app switcher now show the pgCowboy icon.

### Changed

- **Clusters actions moved to the tab bar** — Add cluster, Test connections and Cluster groups now sit beside the page tabs, like Create/Alter role.

## [1.1.1] - 2026-08-19

### Fixed

- **pre-flight no longer needs a superuser** — the default `role_dependencies` queries `pg_roles` instead of the `pg_authid`.

## [1.1.0] - 2026-08-18

### Changed

- **Comment view preference is always respected** — Raw stays Raw, whatever the comment holds.
- **New comment defaults (new installations only)** — no comment fields, Raw editor, plain comment in search results.

### Fixed

- **Leftover "Category" renamed to "Group".**
- **Comment fields can be emptied** — removing every field now sticks.
- **Layout polishing** in the Settings panel.
- **Clusters Save** was active on app start when no clusters file existed

## [1.0.0] - 2026-08-14

### Added

- **Configurable role additional info** — choose what shows next to a role name when searching.
- **Comment fields fill the width** — they flow into columns depending on window width.
- **A picked cluster visible after a restart** — the collapsed cluster list opens itself to show your selection.

### Changed

- **Clusters now live in their own file** — `clusters.yaml`, next to `config.yaml`, holds your clusters, groups and last target selection.
- **"Privileges" renamed to "Role Parents"** — any role can be a parent, not just a group, so the wording finally says so.
- **Assign several parents at once** — type a comma-separated list instead of one name at a time.
- **Denser UI** — about 12% smaller text and controls, so more fits on screen.
- **Breaking: comment placeholders use double braces** — `${{full_name}}`, in opposite to `${full_name}`.
- **An unknown `${key}` in a template is now reported**, instead of silently rendering empty.

### Fixed

- **Settings save is atomic** — a rejected template no longer leaves part of the page already saved, and a new comment field can be used in a template in the same save.
- **A comment containing `${` no longer breaks the operation.**
- Minor positioning adjustements.

## [0.9.0] - 2026-08-12

### Added

- **Alter role** — search a role across clusters and edit privileges, attributes and settings per cluster or group.
- **Presence editor** — add or remove a role on individual clusters.
- **Dependency pre-flight** — removing a role checks for dependencies first; clusters with dependencies default to Skip.
- **Transactional runs** — each cluster's changes commit or roll back together.
- **Live run status** — per-cluster progress, duration, message and executed SQL.
- **Flexible role comments** — plain text or JSON, editable as fields or raw text, with configurable labeled fields.
- **Preconfigured parent groups** — pick-list chips when granting.
- **Role settings** — view, set and reset per-role GUCs.
- **Templatable introspection queries** — point searches and reads at your own views or functions.
- **Password generator** — configurable length and character classes, with copy and reveal.
- **Per-cluster password** — optional, stored privately in your config.
- **Cluster groups** — color-coded, with an optional production confirm gate.
- **Check for updates** — from the About dialog, or automatically on startup.
- Window size and target selection now survive restarts.

### Changed

- **Default templates work out of the box** — vanilla PostgreSQL DDL, no setup required.
- **Redesigned interface** — one form for creating and editing roles, with independently scrolling panels.
- **Feedback moved out of toasts** — buttons flash, errors show inline, runs report in a status chip.
- **Clusters and Settings are now staged** — edits are drafts until you Save; Discard reverts them.
- Cluster groups moved from Settings to the Clusters tab.

### Fixed

- Role names are quoted, so special characters and mixed case work.
- A failed run keeps your pending edits instead of clearing the form.
- Focus rings only appear for keyboard navigation.
- The Find-role dialog no longer opens showing stale results.
- An unreachable cluster is reported on its own, instead of failing the whole search.

## [0.2.0] - 2026-06-05

### Added

- New application icon.

## [0.1.2] - 2026-06-05

First tagged release: cluster config, target selection, and create/remove roles via SQL call
templates. Earlier history:
[git tags](https://github.com/michal-bartak/pgcowboy/tags).
