# CLAUDE.md — pgCowboy

AI/agent guide for this repo. Human docs: [README.md](README.md) (features/usage),
[sql/README.md](sql/README.md) (call-template DSL), [RELEASING.md](RELEASING.md).
A parallel Cursor rules file lives at
[.cursor/rules/pgcowboy-project.mdc](.cursor/rules/pgcowboy-project.mdc); keep the
two consistent when documenting architecture changes.

## What this is

Cross-platform desktop app (**Wails v2** + embedded WebView, vanilla HTML/CSS/JS
frontend, **pgx/v5** backend) for maintaining **PostgreSQL roles across many
clusters**. Real DDL/privilege changes are performed by **user-defined SQL call
templates** run against each cluster — the app does not hardcode DDL. Module:
`github.com/michal-bartak/pgcowboy`. Current version: read [VERSION](VERSION) — don't copy it
into prose, it goes stale.

## Product decisions (don't regress)

- **Two config files, one directory** ([internal/config/paths.go](internal/config/paths.go)):
  **`config.yaml`** = app configuration (templates, reads, parent roles, comment fields, search
  columns, batch, ui, window size, seen version); **`clusters.yaml`** = `categories`, `clusters`,
  `targets`. The directory resolution is unchanged and hand-rolled per OS (macOS
  `~/Library/Application Support/pgCowboy`, Linux `~/.config/pgcowboy`, Windows
  `%APPDATA%\pgCowboy`) — **`os.UserConfigDir` is deliberately not used**, and there is no
  env/XDG override.
  **The split is one tag, not a copy of the field list**: `model.Config` embeds
  **`model.ClusterSet`** (Categories/Clusters/Targets) anonymously with **`yaml:"-"`**, and
  `model.ClustersFile` is `{Version, ClusterSet \`yaml:",inline"\`}`. So a new *cluster-scoped*
  field added to `ClusterSet` lands in clusters.yaml automatically and a new *app-scoped* field
  added to `Config` lands in config.yaml automatically — **don't** replace this with per-field
  `yaml:"-"` tags plus a parallel struct, which is exactly the drift this avoids. The embed is
  transparent to the wire format: `encoding/json` **and** the Wails generator flatten it, so
  `models.ts`'s `Config` keeps `categories`/`clusters`/`targets` top-level and the frontend still
  reads `state.clusters` etc. (same precedent as `RunRequest`/`OperationSpec`).
  `Store` keeps **one** `path` field and *derives* `clustersPath()` from `filepath.Dir(s.path)` —
  that is what lets every `&Store{path: …}` test literal keep working. It returns `""` for a
  path-less store (`NewStoreFromConfig`), and `atomicWriteFile` **rejects an empty path**, because
  `filepath.Dir("")` is `"."` and a relative `clusters.yaml` would otherwise be written into the
  process CWD — passwords included. Writers partition cleanly (no method touches both halves), so
  each file stays atomic on its own and there is no cross-file transaction: the eight cluster /
  category / target writers call `saveClusters()`, every other writer calls `save()`.
  `Load` is a **pure reader** (a missing file yields that half's defaults in memory; `NewStore`'s
  `writeMissingFiles` does the seeding), so `ReloadConfig` never creates anything; a file that
  exists but doesn't parse is a hard error rather than a silent empty state.
  **First run must never error**: with neither file present, `Load` yields the built-in defaults and
  `writeMissingFiles` writes both at `0600` — pinned by `TestNewStoreFirstRun`, which redirects
  `HOME`/`APPDATA` so it exercises `ConfigDir`'s real per-OS branch and its `MkdirAll`.
  **There is deliberately no migration and no legacy-key guard.** A pre-split `config.yaml` still
  carrying `categories`/`clusters`/`targets` simply has them ignored (`yaml.Unmarshal` leaves
  `KnownFields` off) and dropped by the next write; the app was never released with the old layout,
  so nothing needs rescuing. Don't add a probe back.
- **Auth resolution** ([internal/pg/auth.go](internal/pg/auth.go)): user (`ResolveUser`) =
  cluster `connect_user` → `PGUSER` → **OS login user** (`user.Current()`, like psql/libpq) →
  error; password (`ResolvePassword`) = **cluster `password`** → `AuthContext.Password` (unused by
  the UI) → `PGPASSWORD` → `~/.pgpass` → empty (trust, like psql). The `AuthContext` from the run
  dialog is still always empty from the UI. **The one credential in config is the optional
  per-cluster `password`** — an opt-in, plain-text field on `model.Cluster`/`ClusterInput`
  (`yaml:"password,omitempty"`), stored in the private **`clusters.yaml`** (`saveClusters()` writes
  mode `0600`) and
  editable in the Clusters cluster editor as a **masked field with a 👁 reveal toggle** next to
  Connect user (the two share a `.form-row`, borrowing the Host/Port width mechanism). When set it
  is used directly; when blank the app falls back to `PGPASSWORD`/`~/.pgpass` as before. It rides on
  `ClusterInput` (not `AuthContext`), so `TestConnectionInput` tests an unsaved password too.
- **Production gate is a per-group `confirm` flag**, surfaced only as the confirm popup
  (`askConfirm('Production', …)`); no checkbox. `commands.RequiresProductionConfirm`
  and the frontend `hasProductionTargets`/`categoryConfirm` read the flag (not the id
  `"production"`). The frontend sends `confirmProduction: true` after the dialog.
- **All writes go through configurable call templates** (`db_functions.<op>`) executed by
  `pg.ExecuteOperation`, driven by the batched `RunRoleBatch` (per-cluster transaction; see the
  two-data-paths section). This now includes `set_config`/`reset_config` (role GUCs) — there is no
  longer a hardcoded-SQL exception in `pg.ExecuteOperation`. **Template defaults are vanilla
  PostgreSQL DDL** (`CREATE ROLE`, `DROP ROLE`, `GRANT/REVOKE … `, `ALTER ROLE … PASSWORD/WITH/SET/RESET`,
  `COMMENT ON ROLE`), all **statement** mode (`config.DefaultConfig`); deployments that need privileged
  wrapper functions override per-op in config or the Settings editor. Loading an existing config never
  force-overwrites a user's templates (`migrateOne` keeps a non-empty `call`); the editor's **Default**
  button is how a user reverts one template to the vanilla built-in.
- **Categories = cluster groups**, edited from the **Clusters** tab (a *Cluster groups* button in
  the tabs bar's Clusters action group opens the `#groups-dialog` list popup; *Add group*
  opens the `#group-dialog` form — label + base `color` + `confirm`). Group id is a slug of the
  label, immutable on edit; delete blocked while a cluster uses it. Group colours are applied
  by a generated `<style id="cat-colors">` keyed on `data-cat`; there are no hardcoded
  production/uat colours.
- **The Clusters tab is STAGED** (like Settings): add/edit/delete of clusters *and* groups mutate
  in-memory drafts (`clustersDraft`/`categoriesDraft`, seeded once from saved `state` in
  `loadConfig`, kept across other `loadConfig` calls), and nothing persists until the footer
  **Save** (`btn-save-clusters` → `App.SaveClusters(ClustersConfig)` →
  `Store.SaveClustersAndCategories`, an atomic validate-and-replace: category label required /
  slug id / no dup ids, cluster fields validated + port/sslmode defaulted + UUID minted for new,
  and referential integrity — every `cluster.category` must exist). **Discard** reverts drafts to
  saved. Save is **enabled only when dirty, disabled (inert) when clean**
  (`clustersDirty`/`refreshClustersDirty` → `setDirty`). New
  draft clusters carry a `tmp_<n>` id (sent as `""` so the backend mints a UUID); new groups get
  their slug id immediately so clusters can reference them pre-save. **Only the Clusters editor
  reads the drafts** — Operations target selection / run resolution keep reading saved `state`, so
  unsaved cluster edits never affect what a run targets. `Test connections` tests the on-screen
  draft values via `TestConnectionInput`, writing a short per-row Status **and** its own footer
  status chip (see the Test-connections decision below).
- **No corner toast — feedback goes to the action button or inline.** There is no `showToast`.
  Simple confirmations **flash the action button** ("Saved"/"Created", green, ~1.2 s via
  `flashButton`); Save buttons are **enabled only when there are changes, disabled (inert) when
  clean** — no marker (`setDirty` toggles `disabled`; disabled buttons are `pointer-events:none`
  so they don't react to hover) — Settings (`btn-save-settings`, `settingsDirty`), the role form
  (`btn-alter-save`, dirty = `buildAlterClusterOps().length>0`, in `updateOpsFooter`), and the
  Clusters Save. All right-aligned action buttons + the op-tabs share one right margin (the
  `.tabs`, `.ops-footer`, and Settings/Clusters footers all align to the `--page-pad` panel edge). Errors/validation render **inline** in a `.form-error` next to the control
  (`showInlineError`/`clearInlineError`) — `#ops-error` (Operations footer), `#settings-error`,
  `#clusters-error`, `#scope-error`, `#group-error`, `#cluster-test-error`, `#alter-search-errors`
  (a **one-liner** only — see the search-status decision below)
  — plus a red button flash. Run/batch outcomes stay in the **run-status chip** (unchanged); rare
  clipboard failures log to the console.
- **Preconfigured role parents** (`Config.ParentRoles`, YAML `parent_roles`) are a
  Settings-managed list of bare-identifier role names, saved via `SaveParentRoles`
  (`Store.UpdateParentRoles` validates identifier syntax, dedupes). They are offered as
  pick-list choices (toggle **chips**) in both the Create-role and Alter-role
  **Assign-parents** dialogs, several at once. **The UI wording is "role parents", never
  "privileges" or "parent groups"** — any role can be a parent, so the old labels were wrong (the
  Settings section is *Preconfigured role parents* / *Add parent…*, the role-form section is
  *Role Parents* — title case, as the user specified — with *Assign parents…*, and the dialog is
  *Assign parents* with a *Role names* field). Only the labels changed: the YAML/JSON contract
  (`parent_roles`, `parentRoles`, `grant_parents`) is untouched, so don't "fix" it to match.
  The dialog's *Role names* field takes a **comma-separated list** (`parseRoleNameList`: split on
  `,`, trim, drop blanks, dedupe; the only rejection left is a NUL, since `ROLE_NAME_RE` excludes
  commas by design) which merges with the picked chips, then goes to `addParentScope`.
  Create-role uses the **same `${parent_roles}`
  placeholder as grant/revoke** (there is no singular `${parent_role}`): statement mode → a
  double-quoted identifier list (`"a", "b"`), function mode → an inline `ARRAY['a', 'b']` literal
  (values verbatim, `'`-bearing values rejected; empty → `NULL`). The selected parents are published
  to **both** the `create_role` op's `${parent_roles}` **and** the follow-up `grant_parents` op (per
  cluster, same value) — `buildCreateClusterOps` copies each cluster's `grant_parents.parentRoles`
  into its `create_role`, and the Alter presence-add path sets `create_role.parentRoles =
  toGrant.join(',')`. The default `create_role` (`CREATE ROLE ${loginname}`) ignores it and
  `grant_parents` does the actual grant; a custom `create_role` that grants via `${parent_roles}`
  will re-grant (a harmless PostgreSQL NOTICE).
- **Role comments are format-agnostic** (plain text **or** arbitrary JSON — no forced keys).
  The role form's inline comment editor (`#role-comment-editor`) has a **Fields ↔ Raw**
  toggle: *Fields* edits string values only (never adds/removes keys); *Raw* edits the whole
  comment as free text. Which JSON keys get friendly labels is a Settings-managed list
  **`Config.CommentFields`** (YAML `comment_fields`, ordered `{key,label}`), **empty by default**
  and saved via `SaveCommentFields` (`Store.UpdateCommentFields` validates identifier keys,
  dedupes, defaults blank labels). Which keys a comment carries is a site convention, so the app
  ships none and **nothing refills the list** — no `defaultCommentFields()`, no `len == 0` gate in
  `readMainFile`, and `commentFields()` in the frontend has **no fallback** either (it now mirrors
  `searchColumns()`; there is no `DEFAULT_COMMENT_FIELDS`). That is the whole fix for "an emptied
  field list came back on restart" — don't reintroduce a default at any of those four layers.
  With no fields configured and none in the comment, `commentFieldInputsHtml` renders a muted
  `.rce-empty` one-liner instead of a blank box.
  Configured fields always render; **every other key** in the comment also renders (labeled by
  raw key) — string values are editable, non-string values (number/bool/array/object) render
  **read-only** (shown as JSON, edited via Raw; `e.readonly`) so their type is preserved via
  `baseObj`. A **`null`** value is the exception: it is treated as an empty **editable** string
  field (no read-only / no ⚠), and on save an empty value for a key that was already in the loaded
  comment serializes back as JSON **`null`** (so a loaded null round-trips and clearing a field
  stores null); a key that was never in the comment stays absent, so an all-blank/empty comment
  still assembles to `''` (load stays idempotent — opening a role never marks it dirty).
  `editorFromComment`
  builds the model, and **the configured `ui.comment_default_view` decides the mode** —
  `fields`|`raw`, `preferredCommentView()`, **defaulting to `raw`**. It is the *only* place the
  mode is chosen, so the role form, the Comments dialog's per-version boxes, *Use in all clusters*
  and `commitCommentsDialog`'s fold-back all agree for free. The one override is structural: a
  **plain-text** comment has no fields, so it always lands in Raw (same reason `commentFieldsBlocked`
  disables the toggle). It deliberately does **not** auto-detect JSON into Fields any more — picking
  Raw and then being shown Fields read as a bug. Raw mode assembles `e.raw.trim()`, which is the
  loaded comment verbatim, and the dirty check compares `canonicalComment`s, so load idempotence
  holds (it in fact *improves*: fields mode rewrites `{"k":""}`→`{"k":null}` and trims values on
  open);
  `assembleComment`/`assembleCommentFrom` serialize it (empty value → null for existing keys, else
  drops the key; preserves
  unknown keys); `parseCommentObject` is the shared reader; `switchEditorMode` round-trips
  Fields↔Raw. The **Fields** toggle is disabled whenever the raw text is non-empty and not a
  JSON object (`commentFieldsBlocked`) — Fields can't represent plain text, so switching would
  drop it; edit such comments in Raw. A non-JSON comment saves as plain text with an inline note. The backend
  `set_comment` op stays an opaque quoted literal. The comment UI **mode follows the staged state**
  (`commentEditor.varies`), not the DB baseline: while comments vary the inline editor is hidden and
  reconciliation moves to the **Comments dialog**, whose per-version boxes reuse the
  same Fields/Raw editor (`commentVersionEditors`). Each version box (when there is >1) also has a
  **Use in all clusters** button (left of the Fields/Raw toggle, `data-cv-useall`) that broadcasts
  that version's comment to every version editor. The dialog **stages** edits locally: **OK**
  (`commitCommentsDialog`) commits each version's assembled comment into `commentOverrides`
  (`Map<clusterId,string>`); **Cancel** discards. **OK also folds a now-consistent result**: if the
  reconciled comments are all canonically equal (via Use-in-all or manual editing), it loads that one
  comment into the inline editor (`commentEditor.varies=false`) and clears `commentOverrides`, so the
  "Comments differ" banner clears on **OK** (before Save) and the inline editor takes over. Nothing is
  sent from the dialog — staged comments publish with the rest of the edits on **Save changes**
  (`buildAlterClusterOps` prefers a cluster's override, else the inline editor's comment).
  `commentOverrides` is cleared by `resetEditMaps` (pick / save / mode switch).
- **Search-result columns are configured, never hardcoded.** What shows next to the rolename in
  the Find-role popup is **`Config.SearchColumns`** (YAML `search_columns`, ordered
  `{label,template}`), a Settings-managed list (**Role Details** group, `#search-columns-editor`,
  `searchColumnsDraft`) saved via `SaveSearchColumns` (`Store.UpdateSearchColumns` →
  `validateSearchColumns`: trims, drops blank-template rows, keeps a blank label, and applies
  `checkSearchTemplate`). The rolename column is fixed and not configurable. A **template is display
  text, never SQL**, rendered **frontend-side** by `renderSearchTemplate(tmpl, comment)` from the
  comment `RoleMatch` already carries — so no read query, column contract, or `pg` change is
  involved, and a Settings change takes effect without re-searching. It uses **the same two
  namespaces as the call templates** (see the placeholder-namespace decision below):
  `${{<key>}}` = any key of the JSON comment (not just `comment_fields`); the bare namespace is a
  **closed** set whose only member is `${comment}` = the raw comment (the only way to show a
  plain-text one). Unknown key / JSON `null` / non-JSON comment → `''`; non-strings typed
  via `commentValueString` (`42`/`true`/`["a"]`); the result is whitespace-collapsed so
  `${{first}} ${{last}}` with no last name is `John`, not `John ` (literal separators are kept).
  An unknown **bare** name renders **as itself** (not `''`), so the mistake is visible in the row,
  and `checkSearchTemplate` refuses to save it with a message naming the `${{…}}` form;
  `searchTemplateError` in the frontend mirrors that check to flag the row live and block Save with
  a **row-numbered** message the backend error cannot carry. Load-time `sanitizeSearchColumns` uses
  the weaker `checkSearchTemplateSyntax` on purpose: a stale bare name is **kept and shown broken**
  rather than silently deleted from the user's config. Comment KEYS stay unvalidated beyond that —
  they are arbitrary JSON keys (`e-mail`) and the output is HTML-escaped.
  `search_columns` carries **no `omitempty`**: an
  absent key (older config) gets the default `Comment = ${comment}` — the whole comment verbatim,
  which says something useful whatever the comment holds, where a `${{key}}` default would assume a
  JSON convention the site may not have — while an explicit
  `search_columns: []` means "rolename only" and must survive a restart — hence `Load` keys the
  default off `== nil` and `sanitizeSearchColumns` preserves nil-ness. The frontend `searchColumns()`
  therefore has **no default fallback**, or an explicit empty list would
  resurrect the default (`commentFields()` is now the same shape, but for the simpler reason that it
  has no default at all). `searchCellValues` returns one **string** per column — the first non-empty
  value in `byGroupThenAlias` order (results arrive in completion order). Clusters disagreeing about a
  value is deliberately **not** flagged in a search row (a `≠` marker was tried and read as an
  unexplained artifact): the popup is for finding a role, and reconciliation is reported once the role
  is loaded, by the "Comments differ" banner and the Comments dialog.
  **Layout — CSS subgrid, no measuring.** Rows stay single-line clickable `<button>`s. The
  CONTAINER `#alter-results` owns the column tracks (`--search-cols`, set by
  `searchGridTemplate(colCount)`); the header (`.alter-result-head`) and every row set
  `grid-column: 1 / -1` + `grid-template-columns: subgrid`, so the browser sizes each column to its
  widest cell across all rows and they align for free. Tracks are
  `fit-content(40ch)` (rolename), one **`minmax(4ch, max-content)`** per configured column, then
  `minmax(8ch, auto)` for the chips. **The chips track is the only flexible one**, and both halves of
  that are measured decisions — a column's max must be neither `fit-content(<cap>)` nor `auto`:
  a **cap** made a long value (a raw `${comment}` above all) ellipsize while hundreds of px sat
  unused further right; an **`auto`** max stretched every column past its content, because grid's
  final step hands leftover space to each auto-max track — with short values that padded each column
  by ~240px, so a name and the email beside it sat a quarter of a row apart. `max-content` stops a
  column at its text, so the values read as a table and the slack collects in the chips track, which
  is last and `justify-self: end` — the chips stay flush right and the gap lands in the one place it
  looks deliberate. The chips' `8ch` floor lets them shrink (and wrap) under real pressure instead of
  forcing a horizontal scrollbar and crushing the rolename.
  Two constraints, don't undo them: (1) a subgrid child's own border+padding **insets its tracks**,
  so `.alter-result-head`'s horizontal padding must stay `calc(0.7rem + 1px)` = the row's
  padding + border, or header and rows fall out of alignment; (2) the column gap lives on the
  CONTAINER (`gap: 0.4rem 0.6rem`) and subgridded children inherit it — a child must not set its own.
  Cells keep `min-width: 0` so a track can shrink below its content instead of overflowing, every
  cell carries a `title` (any column is squeezed in a narrow enough window), and `.alter-results` is
  `overflow:auto` as the last resort.
  This **replaced ~165 lines** that measured text with canvas `measureText` against fonts read from
  throwaway DOM probes, plus a second render pass to pin the chip track. It is why the app requires
  **WebKit 16 / macOS 12+ / WebKitGTK 2.38+** (WebView2 is evergreen) — see the platform note in
  [docs installation](docs/src/content/docs/installation.md). A column still ellipsizes — but only
  once the free space is actually used up, not at a fixed cap. `pg.ParseFullName` / `RoleMatch.FullName` /
  `ClusterRoleDetail.FullName` were **removed** earlier with this feature — don't reintroduce a
  hardcoded key.
- **One shared role form for Create and Alter.** Both modes render through
  `renderAlterDetail` over `alterDetails` and the same edit maps (`alterAdd`/`alterRevoke`,
  `alterAttrAdd`/`alterAttrRemove`, `alterConfigSet`/`alterConfigReset`, password). Mode =
  `isCreateMode()` (`currentOp === 'create_role'`). **Create** = editing a not-yet-existing
  role over the selected clusters with an **empty synthetic baseline**
  (`synthCreateBaseline()` builds `alterDetails` rows `{exists:false, parents:[], …}` from
  `resolveSelectedClusters()`); every edit is therefore a pure grant/enable/set. **Alter** =
  search → `pickUser` → `reloadDetails` loads the real per-cluster baseline. The **static**
  `#role-identity` block above `#alter-detail` holds login (editable+required in create,
  readonly in edit) plus an inline **comment editor** (`#role-comment-editor`) — see the
  comment-handling decision below. The op-tab buttons are mode switches: Create resets to an
  empty form; Alter opens the search popup and enters edit only on pick. `updateTargetPreview`
  re-synthesizes + reconciles pending edits when the selection changes in create mode
  (`reconcilePendingWithUniverse`).
- **Per-cluster presence editor (Alter).** The static **Present on** block (`#role-present`, a
  sibling of `#alter-detail` with its own click listener) shows existing clusters (plain chips),
  pending-**add** (`chip-add`: a leading `+`, group colour kept via `data-cat`) and
  pending-**remove** (`chip-strike`: red strikethrough, `data-cat` dropped) plus a **✎** button
  (`#btn-present-edit`) that opens the scope dialog with `ctx.kind === 'presence'`. Adding a
  cluster inserts a **synthetic `exists:false` row** into `alterDetails` (empty baseline, like
  `synthCreateBaseline`) so the whole form (privileges/attributes/settings/comment editors) targets
  it; dropping a cluster records it in **`roleRemoveClusters`** (`Set<clusterId>`, reset in
  `resetEditMaps`). The presence editor's universe is `alterScopeClusters` (the searched scope, so a
  cluster must have been in Target selection at search time to be addable); `confirmPresenceScope`
  recomputes remove/add sets from the real `exists:true` rows. `buildAlterClusterOps` emits a lone
  `remove_role` for removed clusters and **prepends `create_role`** for `exists:false` rows *in
  Alter mode only* (`!isCreateMode()`, so Create's `buildCreateClusterOps` doesn't double-prepend);
  the consistent inline comment then flows to new clusters as a `set_comment` (varies ⇒ created
  bare). All of it publishes on the one **Save changes** pass. `removeRole` (red button) targets
  only `exists:true` rows.
- **Every `remove_role` is pre-flighted.** Before a role is dropped — by the red **Remove role**
  button *and* by a presence removal published on **Save changes** — the frontend runs the
  `role_dependencies` read on every targeted cluster (`App.LoadRoleDependencies` →
  `batch.Runner.LoadRoleDependencies` → `pg.RoleDependencies`, same `scanClusters` fan-out and
  errors-as-data as `LoadRoleDetails`) and shows `#deps-dialog`. **The popup IS the confirmation** —
  it replaced the old `askConfirm('Remove role', …)`; the production gate still fires afterwards
  inside `executeRoleBatch`. Rules: a cluster with **no dependencies** is dropped without asking; a
  cluster with dependencies **or a failed check** defaults to **Skip** and is excluded from the
  batch entirely; **Try anyway** sends the normal `remove_role`.
  **Popup layout — three ordered sections** (`depsTier`: 0 clean / 1 check failed / 2 has
  dependencies; empty ones omitted), each under a small-uppercase `.alter-privs-label` subheader,
  ordered inside by **group name then alias** (`depsSortRows` over the shared
  `byGroupThenAlias` — the same rule `renderClustersTable` and the status table use; the *chips* of
  one row keep `describeScope`'s configured-category order instead): **No dependencies** = a
  `.deps-chips` row of chips only; **Could not be checked** = a `Cluster | Error | Skip/Try` table;
  **Dependencies found** = per cluster a header line (chip + count + toggle) plus its own table.
  A cluster is identified by ONE group-coloured chip via the shared `scopeLabelsHtml` — there is no
  alias text and no separate badge class (see the ONE `.chip` decision). Every dependency table is `table-layout:fixed` and shares one
  `depsColgroup(rows)` — the three short columns sized in `ch` to the widest value across **all**
  clusters (capped, + `1.5rem` cell padding), Object left bare to absorb the rest — so columns line
  up across clusters. The `<h2>` carries, after the `?`: **Reload** (`#deps-reload` → `reloadDeps`,
  re-reads the same `depsClusterIds` in place — for when the user has just gone and fixed the
  dependencies elsewhere — keeping the picks that still apply via `mergeDepsChoices`; `depsBusy`
  spins the icon by reusing the `run-status-spin` keyframes and holds `#deps-ok`, Cancel stays
  live), then **one magnifier** (`#deps-view-sql`) showing the SQL via `showQueriesDialog`, because
  every cluster runs the identical query — `LoadRoleDependencies` therefore sets `Queries` on its
  **error** path too, so the SQL is available even when every cluster failed. The dialog goes
  **wide** (`#deps-dialog.wide`, 98vw) only when some cluster reports rows. Frontend pieces (all in
  [frontend/app.js](frontend/app.js)): `preflightRemoval` (records `depsClusterIds`, loads, opens
  the dialog, resolves to a `Set` of allowed cluster ids or `null` on cancel), the shared
  `loadDepsRows`, `depsSortRows`, `initialDepsChoices`/`mergeDepsChoices`, `depsAllowedSet`,
  `filterSkippedRemovals` (drops the skipped remove_role-only entries from a
  `buildAlterClusterOps()` batch, leaving every other cluster's edits intact). Cancelling aborts the
  whole action. **A thrown read is rendered as all-clusters-failed** (`depsErrorRowsFor`, carrying
  each cluster's identity and any SQL a previous load reported) rather than an `#ops-error` the
  modal would hide — which keeps the safe default, every cluster on Skip, so a role that could not
  be checked is still never dropped without an explicit *Try anyway*.
- **Run/build.** Both modes build **per-cluster ordered op lists** and send ONE
  `app.RunRoleBatch({clusters, auth, confirmProduction})` via `executeRoleBatch`; the backend runs
  each cluster's ops as a single transaction. `buildAlterClusterOps()` produces
  `[{clusterId, operations:[{operation, <paramKey>:{…}}]}]` (order per cluster: grant → revoke →
  password → **attributes (all keywords combined into one `set_attribute`)** → set_config →
  reset_config → set_comment). **Create**: `runOperation` validates the login, pre-flight-warns via
  `LoadRoleDetails`, then `buildCreateClusterOps(base)` prepends a `create_role` op (its
  `${parent_roles}` = that cluster's `grant_parents.parentRoles`; comment-field placeholders via
  `commentFieldArgs(assembleComment())`) to each cluster's diff. **Update**: `saveAlterations` uses `buildAlterClusterOps()`. `removeRole` sends one
  `remove_role` op per cluster. The comment persists via **`set_comment`** (per-cluster
  `commentOverrides` wins, else the inline editor's `assembleComment()`). Everything publishes
  together, atomically per cluster, on the one **Save changes** / **Create role** pass. Progress
  shows **live** in a footer status chip (`#run-status`) fed by `role-batch-progress` Wails events
  (one per cluster start/finish); clicking it opens `#run-status-dialog` with one row per cluster.
  **Errors never mutate the role form.** `executeRoleBatch` returns the results array (or `null`
  when blocked/cancelled/threw); on `null` **or any per-cluster failure** the Save/Create/Remove
  paths leave the form and pending edits untouched (chip + popup are the sole error surface). Only
  a **fully clean** outcome refreshes the form — Save re-reads the baseline via `fetchRoleDetails`
  and adopts it *only* when the reload itself is clean (no empty/error, so a transient unreachable
  cluster can't wipe it). On a **fully successful** Save, though, the comment we sent is known-live,
  so `saveAlterations` **optimistically reconciles the local comment baseline** (from
  `commentOverrides` / the inline editor) and clears the staged overrides *before* the reload, then
  always re-renders — so the "Comments differ" banner reflects what was written even when a cluster
  is momentarily unreachable on reload (a clean reload still overrides with DB truth + resets the
  other edit maps). Create resets to an empty form; Remove calls `reloadDetails` (empty-state
  reset). The genuine "not found" state still renders for an actual search `pickUser`.
  **Role-load reachability** is reported the same way as runs: `reloadDetails` → `reportRoleLoad`
  feeds the per-cluster load results (reachable = ok, unreachable = error) into the shared
  **run-status chip** (`beginRunStatus`/`finishRunStatus`), so the bottom bar shows OK/Error and
  the `#run-status-dialog` shows per-cluster status/duration/message + the executed introspection
  SQL on click — `ClusterRoleDetail` now carries `DurationMs`/`Queries` (from `LoadRoleDetails`
  timing + `pg.RoleDetailQueries`), mirroring `ClusterResult`. The form no longer renders an
  "Unreachable clusters" block (`renderDetailErrors` is gone). `updateOpsFooter` keeps the footer
  visible while `runState` is set so the chip shows even in the empty (not-found) state.
- Frontend is **vanilla JS** reached through `window.go.main.App` (`backend()` in
  [frontend/app.js](frontend/app.js)). No framework. `frontend/wailsjs/` is
  Wails-generated (regenerated by `make dev`/`make build`); a running dev watcher
  keeps it in sync, but hand-edit it only to stay consistent between builds.

## Two data paths

1. **Write (per-cluster transaction), template-driven.** `App.RunRoleBatch(RoleBatchRequest)` →
   [internal/batch/runner.go](internal/batch/runner.go) `RunRoleBatch` → `commands.ValidateRoleBatch`
   → resolve each `ClusterID` → production gate → per cluster (concurrent, bounded by
   `batch.max_concurrency` default 5) `runClusterTx`: `pg.Connect` → `conn.Begin` → for each op
   `commands.BuildArgs(OperationSpec)` + `pg.ExecuteOperation(tx, …)` → **Commit on success /
   Rollback on the first error** (message names the failing op). `RoleBatchRequest` carries
   per-cluster **ordered** op lists (`[]ClusterOps{ClusterID, []OperationSpec}`); each cluster's
   change is atomic and never interleaved with another's (separate connections). One
   `ClusterResult` per cluster (incl. `Queries []string` — the executed SQL per op, from
   `pg.ExecuteOperation`'s `(sql, msg, err)` return; function-mode binds are inlined for display,
   and `runClusterTx` records each op's SQL before the error check so a failing op's SQL is kept);
   timeout scales with op count. `RunRoleBatch` also takes an optional
   `func(model.ClusterProgress)` callback, invoked from each goroutine on cluster start ("running")
   and finish ("done"); `App.RunRoleBatch` passes a closure that `wailsruntime.EventsEmit`s each as
   a `role-batch-progress` event (the runner stays Wails-free per the import table). `pg.ExecuteOperation`/`execRoleConfig`/
   `runQuery` take a `pg.Querier` (satisfied by `*pgx.Conn` and `pgx.Tx`). This is the ONLY write
   path — the legacy single-op `App.RunOperation`/`batch.Run`/`batch.runOne`/`pg.CallFunction`/
   `commands.ValidateRequest` were deleted (the UI never called them; `model.RunRequest` stays,
   `PreviewTargets` uses it).
2. **Read (introspection), catalog queries — added for "Alter role".**
   [internal/pg/introspect.go](internal/pg/introspect.go): `SearchRoles` (matches
   `rolname` or `COMMENT ON ROLE` via `pg_shdescription`), `RoleDetail` (existence,
   comment, attribute flags, parent memberships from `pg_auth_members`, and role GUCs
   from `pg_roles.rolconfig` → `Settings` map), `likePattern` (escaped ILIKE). The package parses
   **no** comment keys — a search result's extra columns are rendered frontend-side from
   `RoleMatch.Comment` (see the search-columns decision). `batch.Runner.SearchRoles` /
   `LoadRoleDetails` / `LoadRoleDependencies` fan out over the **resolved selected clusters** (not
   all) and collect per-cluster errors instead of failing. All three return **one entry per
   cluster** — `ClusterRoleMatches` / `ClusterRoleDetail` / `ClusterRoleDependencies`, each with
   `Error`/`DurationMs`/`Queries` so the read reports through a status chip. For the search that
   also means a cluster scanned successfully with **no** matches is still represented (a flat match
   list could not distinguish it from a cluster that was never scanned). **These four queries are templatable**
   (`Config.DBReads`, YAML `db_reads.<search_roles|role_detail|role_parents|role_dependencies>.query`; vanilla
   catalog defaults + migrate/validate in [internal/config/dbreads.go](internal/config/dbreads.go)).
   The SQL is no longer hardcoded in `pg` — `batch.Runner` reads `cfg.DBReads` and passes each
   query into `pg.SearchRoles(…, query, term)` / `pg.RoleDetail(…, detailQuery, parentsQuery, login)`
   (import rules: `pg` still doesn't import `config`). Each read takes a single named bind written
   as **`${rolename}`** (search pattern / role name); `pg.bindRoleName` rewrites `${rolename}` → `$1`
   before the pgx `Query` so it stays a bind (a legacy raw `$1` still works). Result columns are
   scanned **BY NAME** against a fixed contract
   via `pgx.RowToStructByNameLax` into `db`-tagged structs (`searchRoleRow`/`roleDetailRow`/
   `roleParentRow`/`roleDependencyRow`): column **order is irrelevant**, a NULL `comment`/`rolconfig` scans cleanly
   (`*string` → `""`, nil `[]string`), an **omitted** contract column leaves its field zero-valued
   (lax), and an **extra** returned column with no matching struct field is **rejected** with a
   clear pgx error. So a deployment can point a read at a privileged wrapper function/view (e.g.
   `SELECT rolname, comment FROM admin.search_roles(${rolename})`) as long as it returns the
   contract's named columns. Contracts: `search_roles` → `rolname, comment`; `role_detail` → the 7
   `rol*` bools + `comment` + `rolconfig`; `role_parents` → `rolname`; `role_dependencies` →
   `database, dependency, class, object`. Editable in Settings →
   **Introspection queries** (same `#fn-dialog` in read mode; **Default** button reverts to the
   vanilla built-in). `validateDBReads` only checks non-empty + references `${rolename}` (or legacy
   `$1`); the column contract is enforced at scan time. This was the planned **Step 2**, now done.
   **`role_dependencies` is a pre-flight, not a display read** — see the remove-role decision below.

## Bound methods (`app.go` → `window.go.main.App`)

Config/clusters/groups: `GetConfig`, `GetConfigPath`, `GetClustersPath` (the two file paths, shown
as a *Config files* pair in the Settings meta block), `GetDefaultTemplates` (the built-in call
templates + introspection queries, so the Settings editor's **Default** button has no second copy
of the SQL — see the DB-templates section), `ReloadConfig`, `AddCluster`,
`UpdateCluster`, `DeleteCluster`, `AddCategory`, `UpdateCategory`, `DeleteCategory`,
**`SaveSettings(SettingsPayload)`** (the whole Settings page in ONE atomic write — role parents,
comment fields, search columns, db_functions, db_reads, batch, ui; everything validates before
anything is assigned, and command templates are validated against the comment fields *in the same
payload*, so no call ordering is required). The per-section `SaveDBFunctions`, `SaveDBReads`,
`SaveBatchSettings`, `SaveUISettings`, `SaveParentRoles`, `SaveCommentFields`, `SaveSearchColumns`
are kept but no longer used by the UI — the Settings page was previously seven sequential calls,
each writing config.yaml, which left the file half-updated when a later one was rejected. Also
`SaveTargetSelection`, `SaveClusters`
(staged Clusters editor — replaces the whole clusters+categories set at once via
`Store.SaveClustersAndCategories`; the per-item `Add/Update/Delete Cluster/Category` are kept
but no longer used by the UI), `GetAppVersion`, `CheckForUpdate` (GitHub-Releases version check →
`internal/update`; opt-in auto-check on startup gated by `ui.check_for_updates`, default ON via
`UISettings.AutoCheck()`), `SetUpdateSeenVersion` (persists the seen release version —
`UpdateSeenVersion` — so the startup popup isn't re-shown for it; written by **both** the auto
path and a **manual** About check via the frontend `persistSeenVersion`), `GetPendingUpdate`
(`update.Pending`: reconstructs the pending `UpdateInfo` from `UpdateSeenVersion` **without a
network call** — used on startup by `restorePendingUpdate` to **light the header About-button
badge + About line across restarts**, incl. when auto-check is off; reports "not available" once
the running version catches up). **Update-available badge**: a small `--primary` dot
(`#update-badge`, `.update-badge`) on `#btn-about`, driven by `renderUpdateBadge()` from module
`updateState`; lit by the auto check, the manual check, and the startup pending-restore alike.
Run/test: `TestConnection` (by saved cluster id), `TestConnectionInput` (ad-hoc
`ClusterInput`+`Auth`, used by the cluster editor to test on-screen values),
`PreviewTargets`, `RunRoleBatch(RoleBatchRequest)` (per-cluster transactional batch; the UI's
create/update/remove path, and now the only write path).
Introspection (Alter role): `SearchRoles(RoleSearchRequest)` (→ `[]ClusterRoleMatches`, one per
cluster),
`LoadRoleDetails(RoleDetailsRequest)`, `LoadRoleDependencies(RoleDependenciesRequest)` (the
pre-flight dependency check run before any `remove_role`).

## Operations (call templates, `internal/calltemplate/`)

`db_functions.<op>.call` + optional `.execution` (`function` | `statement` | `block`).
Defaults in [internal/config/store.go](internal/config/store.go); examples in
[config.example.yaml](config.example.yaml) / [clusters.example.yaml](clusters.example.yaml);
DSL in [sql/README.md](sql/README.md).

**Two placeholder namespaces, and they never overlap** (`internal/calltemplate`): **`${name}`** is a
built-in from the **closed** per-op set (`AllowedPlaceholders`), **`${{name}}`** is always a
configured comment field. One `tokenRE` matches both in a single pass; both inner name classes
exclude braces, so the bare branch **cannot** swallow a `${{…}}` token — the precedence is
structural, not the order of the alternatives. `scanTokens` yields `rawToken{ns,start,end}`,
`parsedPlaceholder.ns` carries it, and **`placeholderKindFor` is the single source of truth**: both
the emitted SQL shape and the bound value derive from the kind it returns. That is not cosmetic —
`buildFunctionQuery` used to take the shape from a built-ins-first lookup and the value from
comment-field-set membership, which disagreed on exactly the colliding names, so `${comment}` on
`set_comment` bound the whole comment through the comment-field JSON decoder (keys reordered,
`""`→NULL, `42`→float64). Because the args map is keyed by bare name, a comment field's value is
namespaced with **`model.CommentArgKey` (`cf:`)** inside `commands.BuildArgs`, so `${comment}` and
`${{comment}}` can both resolve for one call; the **Wails wire format is unchanged** (the
`CommentFields` maps stay keyed by the bare key). Malformed forms (`${x`, `${{x}`, `${a{b}`) are
rejected by `leftoverPlaceholder` **on the template before substitution** — which replaced a
post-substitution `strings.Contains(out, "${")` guard that also tripped on a *value* containing
`${`. `fieldBind` and its statement-mode guard were deleted as unreachable. This **breaks** any
template that referenced a comment key in single braces, and there is deliberately **no migration**
for it (the app is pre-release, so a rewrite-on-load would be permanent clutter) — a stale template
is simply rejected on save with a message naming the `${{…}}` form.

All defaults are **statement** mode, vanilla PostgreSQL DDL:

| op | placeholders | default template |
|----|--------------|------------------|
| `create_role` | loginname, parent_roles, **`${{<comment field>}}`** (one per `Config.CommentFields`) | `CREATE ROLE ${loginname}` (parent_roles + comment fields unused by the vanilla default; a `function`-mode override can consume them, e.g. `admin.create(${loginname}, ${parent_roles})`) |
| `remove_role` | loginname (rolename alias) | `DROP ROLE ${loginname}` |
| `grant_parents` | loginname, parent_roles | `GRANT ${parent_roles} TO ${loginname}` |
| `revoke_parents` | loginname, parent_roles | `REVOKE ${parent_roles} FROM ${loginname}` |
| `change_password` | loginname, new_password | `ALTER ROLE ${loginname} PASSWORD ${new_password}` |
| `set_comment` | loginname, **comment**, **`${{<comment field>}}`** (one per `Config.CommentFields`) | `COMMENT ON ROLE ${loginname} IS ${comment}` |
| `set_attribute` | loginname, **attributes** (space-separated keyword list; `attribute` singular kept as an alias) | `ALTER ROLE ${loginname} WITH ${attributes}` |
| `set_config` | loginname, **config_name**, config_value | `ALTER ROLE ${loginname} SET ${config_name} = ${config_value}` |
| `reset_config` | loginname, **config_name** | `ALTER ROLE ${loginname} RESET ${config_name}` |

Field kinds when embedding (statement/block): role names → **double-quoted identifiers**
(`quoteSQLIdentifier` → `"name"` with `"`→`""`, so case is preserved and special chars are safe;
rejects only empty/comma/NUL — comma is the list delimiter); `parent_roles`
(`fieldIdentifierList`, used by create_role/grant_parents/revoke_parents) → **statement/block**: a
comma-separated, each-element-double-quoted identifier list (`"a", "b"`); **function**:
`buildFunctionQuery` special-cases it into an inline `ARRAY['a', 'b']` literal (verbatim single
quotes via `renderRoleArrayVerbatim`, `'`-bearing values rejected, empty → `NULL`) rather than a
`$n` bind (the `ARRAY[fixed] || ${parent_roles}` concat form still binds `$n::text[]` via
`preprocessArrayOrNull`);
`new_password`/`comment`/**`config_value`** → quoted **literals**
(`quoteSQLLiteral`, `E'…'` for backslash-bearing values);
`new_password`/`comment`/**`config_value`** → quoted **literals**
(`quoteSQLLiteral`, `E'…'` for backslash-bearing values);
a **comment-field** placeholder (create_role / set_comment; `fieldCommentValue`) → **typed by the
JSON value** carried in its arg: string → quoted literal, number/bool → bare typed literal
(`42`/`TRUE`), array/object → JSON text as a quoted literal, and **empty string / JSON `null` /
absent key → bare `NULL`** (never quoted); in function mode the same value is bound as its Go type
(nil/string/float64/bool). The configured keys are threaded into `calltemplate.Build` /
`ValidateCallTemplateWithExecution` as a variadic `commentFields ...string` (calltemplate must not
import config), sourced from `Config.CommentFieldKeys()` in the batch runner / `validateDBFunctions`;
the per-cluster JSON-encoded values are built by the frontend `commentFieldArgs(effectiveComment)`
and carried in `CreateRoleParams.CommentFields` / `SetCommentParams.CommentFields`;
`config_name` → a **bare, unquoted GUC name** (`fieldConfigName`, validated by `gucNameRE` in
`calltemplate/execution.go` — GUC names are case-insensitive, optionally namespaced, so they are
not double-quoted; validation is the injection guard);
`attributes` (alias `attribute`) → a **space-separated keyword list** (`fieldKeywordList`) so the
frontend combines all of a cluster's attribute changes into ONE `ALTER ROLE … WITH kw1 kw2 …`; each keyword is
whitelisted (`SUPERUSER`/`NOSUPERUSER`, `CREATEROLE`/…, `LOGIN`, `REPLICATION`, `BYPASSRLS`) in
`commands.ValidateOperation`.

### Adding a new operation
Extend all of: `calltemplate.AllowedPlaceholders` + `placeholderKindFor` (+ a new
`fieldKind` and `buildEmbedded` case if the value needs non-standard embedding, e.g.
`fieldConfigName` for unquoted GUC names); `commands` op const + `BuildArgs` +
`ValidateOperation`; `model.DBFunctions` + `*Params` + `OperationSpec`;
`config.store.DefaultConfig` + `dbfunctions.go` migrate/validate lists; the `DB_FUNCTIONS`
table in `frontend/app.js` — each entry is `{key, title, prop, placeholders, contract}`, where
`contract` is the one-sentence description shown in the dialog; example config; and tests in
`calltemplate`/`commands`/`config`.

**The frontend holds NO copy of the default SQL.** `DB_FUNCTIONS`/`DB_READS` carry only UI
metadata; the `#fn-dialog` **Default** button reverts from `defaultTemplates`, fetched once at
startup via `App.GetDefaultTemplates()` (= `config.DefaultConfig()`). So a default changes in
exactly one place. What is left of the cross-language contract — that every op key is a real
operation and every `prop` a real `model.DBFunctions`/`DBReads` field — is pinned by
[frontend_contract_test.go](frontend_contract_test.go), which parses the two tables out of
`app.js`; it fails loudly if their literal shape changes rather than silently passing.

## Frontend (`frontend/`)

**UI density is one knob: `html { font-size: 87.5% }`** (= 14px; [styles.css](frontend/styles.css),
just above `html, body { height:100% }`). Every content-sized value in the stylesheet is a `rem`,
so that single declaration scales text, `--fs-*`, `--control-h`/`--control-pad-*`, padding, gaps,
table row heights and the `ch`-based grid tracks together. **Keep it that way**: new CSS uses `rem`
for anything content-sized and `px` only for hairline borders (`1px`), radii, and sub-10px
decorations (scrollbar, `.update-badge`) — a `px` width or `min-width` on a box that holds content
is the bug, because it stays full-size while everything around it shrinks. **No icon carries a
`width`/`height`** — not in `index.html`, not from `svgIcon` (its `size:` option was removed); every
container sizes its glyph in rem, so a hand-written SVG with `width="14"` is the thing that drifts
out of step. Two rem values are hand-synced and must not drift:
`th, td { padding: .55rem .75rem }` with the `1.5rem` in `depsColgroup`, and
`.alter-result-head`'s `calc(0.7rem + 1px)` with the search-result row's border+padding.

**Three things WebKitGTK gets wrong, fixed once each — don't undo them.**
1. **`prefers-color-scheme` is a lie on Linux**: WebKitGTK answers "light" whatever the desktop is
   set to, so the *System* appearance could never resolve dark there. The frontend therefore asks
   the **backend** — `App.IsSystemDark()`
   ([system_theme_linux.go](system_theme_linux.go), a `!linux` stub in
   [system_theme_other.go](system_theme_other.go)) probes GNOME `gsettings`
   (`color-scheme`, then the pre-42 `gtk-theme`) then KDE (`kreadconfig6`, then `5`), each step
   returning a `(dark, known)` pair so "no gsettings" is *unknown* rather than *light*. Only Linux
   calls it (`onLinux()` caches `runtime.Environment().platform`); macOS/Windows keep `matchMedia`,
   which they answer correctly. `applyTheme` is **async** because of this — every call site is
   fire-and-forget, and a **generation counter** (`themeGeneration`, bumped per call, re-checked
   after every `await`) makes a slow probe from a superseded preference bail instead of repainting.
   Linux also gets a **5 s poll** (`systemThemePoll`), since the media query never fires `change`
   for a desktop switch the engine cannot see; it is torn down by the next `applyTheme`. Mirrors
   the same fix in the `osc` and `audits` projects.
2. **A `<select>` takes two separate fixes, because it is two separate things.** The CLOSED
   control needs BOTH `appearance: none` and `-webkit-appearance: none` — WebKitGTK honours only
   the prefixed one for form controls, so the unprefixed property alone leaves Linux drawing the
   native GTK combo (system background, GTK's own text centring that ignores our height).
   `input[type="checkbox"]` already carried both prefixes; a new `appearance` user must too.
   The **drop-down LIST is a different story: no CSS reaches it at all.** WebKitGTK draws it as a
   native GTK widget, so `appearance` never applies and neither does `select option {…}` —
   **the option rule is kept for the platforms where it does work, but it is NOT what fixes
   Linux**, and reaching for more CSS there is wasted effort. The only knob is GTK's own
   **`gtk-application-prefer-dark-theme`**, set through `App.SetNativeDarkTheme(bool)`
   ([native_theme_linux.go](native_theme_linux.go), cgo/`gtk+-3.0`). **Its build constraint is
   `linux && cgo && (dev || production)`, and that is load-bearing**: Wails gates its own cgo the
   same way — untagged, `internal/app` resolves to a stub that refuses to run — so a bare
   `go build ./...` / `go test ./...` has never needed the GTK headers, and CI installs none. A
   plain `linux && cgo` tag broke both workflows (`release.yml`'s build job `needs: test`). The
   stub in [native_theme_other.go](native_theme_other.go) carries the exact complement,
   `!linux || !cgo || (!dev && !production)`, so exactly one definition always exists. `wails build`
   passes `production`, `wails dev` passes `dev`. The corollary to keep in mind: **the CI test
   workflow compiles none of this** — the first thing that type-checks the cgo is
   [release.yml](.github/workflows/release.yml)'s Linux build job (it installs the GTK/WebKit
   headers and runs a real `wails build`), or a local `make build` on Linux. So a change here
   wants a Linux build before it is tagged.
   GTK is not thread-safe and bound methods do not run on the main loop, so the `g_object_set` is
   deferred onto it with `g_idle_add`. `applyTheme`'s `paint()` drives page and GTK **together** —
   including from the poll tick, or a live desktop switch would darken the page and leave the
   drop-downs white. It also fixes the other natively drawn surfaces (context menus, file dialogs);
   a GTK theme with no dark variant simply ignores it.
3. **Wails sets no GTK window icon**, so the window/task bar/switcher fall back to the desktop's
   generic icon. `main.go` embeds `build/appicon.png` (the same drawing the packaged hicolor icon is
   resized from — one source) and passes it as `linux.Options.Icon`, with
   **`ProgramName: "pgcowboy"`** — `g_set_prgname()`, which is the Wayland `app_id` and the X11
   `res_name`, and must equal the installed **`pgcowboy.desktop`** basename or the compositor can't
   match window to entry; it otherwise defaults to the executable name `pgCowboy`, which doesn't.
   [pgcowboy.desktop](build/linux/pgcowboy.desktop)'s `StartupWMClass` is kept in step with it.
   Passing a non-nil `linux.Options` at all means **`WebviewGpuPolicy` must be set explicitly**:
   Wails applies its `Never` default (the wailsapp/wails#2977 rendering workaround) *only* when the
   struct is nil, so leaving the field at its zero value would silently flip it to `Always`.

**Scrollbars are styled ONLY through `::-webkit-scrollbar`** (one universal block in
[styles.css](frontend/styles.css), just below the user-select rule) — the standard
`scrollbar-width`/`scrollbar-color` properties live inside a
`@supports not selector(::-webkit-scrollbar)` guard and **must not be re-added outside it**. When
they are set to anything but `auto`, Chromium 121+ and WebKit/WebKitGTK *ignore every
`::-webkit-scrollbar` rule on the element* (spec'd precedence), which hands the bar back to the
platform's **overlay** scrollbar: on Fedora/WebKitGTK that was a hair-thin Adwaita indicator that
hid itself unless you were actively scrolling, went native grey when pressed, and — being
zero-width in layout — painted over the content it scrolled. Giving `::-webkit-scrollbar` an
explicit `width` is also what force-renders an overlay scrollbar as a classic, space-taking one, so
the pseudo-element block is what makes the three engines agree. The guarded standard properties are
there only for the Firefox smoke-test path.
**Every scroll container reserves the bar's lane** via ONE grouped `overflow-y: scroll` rule
(`.ops-body, .settings-body, .cluster-list, .table-scroll, .run-queries-content, .deps-list,
.scope-targets, #comments-list, .search-dialog-body .alter-results, textarea`), so content is never
shrunk and shifted sideways the moment the bar appears. That rule **owns the vertical axis**: no
container declares its own `overflow-y` any more (an equal-specificity `overflow-y: auto` later in
the sheet would quietly win), each keeps only its `overflow-x` where the horizontal safety valve
matters, and a new scroll container is added by extending that selector list. It is
`overflow-y: scroll` rather than `scrollbar-gutter: stable` because the latter needs Safari 18.2 / a
very recent WebKitGTK, above the app's WebKit 16 / macOS 12 floor. Nothing is painted while a
container cannot scroll (transparent track, no thumb), so a reserved-but-unused lane is invisible.

**The bar rides in the right margin, and content keeps EQUAL left/right margins.** Three tokens:
**`--page-pad`** (1.4rem) is the horizontal edge of the whole app — `.app-header`, `.tabs`,
`.ops-layout`, `#panel-clusters, #panel-settings` and `dialog > div, dialog > form` all read it, so
the content edge, the right-aligned action buttons and the op-tabs sit on one vertical line (that
`1.25rem` used to be hand-repeated in five rules, which is how the tabs bar got left behind when the
margin changed) — plus **`--scrollbar-w`** (8px, deliberately repeated as a literal in the
`::-webkit-scrollbar` rule: a `var()` in a scrollbar pseudo-element is not worth risking on
WebKitGTK) and **`--scrollbar-gap`**, which is **derived, not picked**: `calc((var(--page-pad) - var(--scrollbar-w)) / 2)`, i.e. half of what the bar leaves over, so the bar sits **centred in the margin** — equal air between the content (or the box's frame line) and the bar, and between the bar and the window/dialog edge. Written as a relation so changing `--page-pad` or the bar width re-centres it instead of silently shifting it; it is 5.8px at 1.4rem, and a centred 6.5px each side would mean `--page-pad: 1.5rem`.
**Invariant: `--scrollbar-w` + `--scrollbar-gap` ≤ `--page-pad`.** A second grouped rule gives the
borderless scroll containers `margin-right: calc(-1 * (var(--scrollbar-w) + var(--scrollbar-gap)))`
+ `padding-right: var(--scrollbar-gap)`: the box grows into the surrounding padding, the gap lands
between content and bar, so the content edge falls back exactly on the panel's content edge — level
with *Create role* / *Save changes*, the footer divider, a dialog's own `<menu>` — while the bar sits
in the margin. Two things not to undo: none of those selectors may take a `padding`/`margin`
**shorthand** later in the sheet (it silently drops these longhands — hence `.ops-body`'s
`padding-block`), and no ancestor may gain an `overflow` value (it would clip the bar; `.ops-main`
and `.table-wrap` are deliberately `overflow: visible`).
**`.ops-sidebar` is the one exception**: it is a bordered panel, so its bar cannot leave the box, and
reserving a lane inside its padding is what made its rows sit further from the right border than from
the left. It keeps `overflow-y: auto` and hands the right margin to the nested **`.cluster-list`**,
which uses the same shared formula as every other scroller — that works because the panel's padding is
**`--page-pad`, not a bespoke `1rem`**: the clearing between the target rows and the panel frame is
then the same as the window margin, and the budget (19.6px) is wide enough for bar + gap (15px), so
the bar sits centred in that padding instead of flush against the frame (which is what the old 14px
budget forced — 8 + gap did not fit in it). A scroll container clips at its padding box, so the sidebar's
`auto` does not clip that bar. Trade-off: if the sidebar itself overflows (many groups, list
collapsed) its own bar appears and shifts its content.

**Tables are split: header table + scrolling body table.** `.table-wrap` is a bordered,
**non-scrolling** flex column holding `.table-head-clip > table.table-head` (thead only) and
`.table-scroll > table` (tbody only) — so headers stay visible, the bar sits **outside** the border in
the panel margin, its track spans exactly the data rows, and the box's border (the edge aligned with
*Save*) never moves. It is the one scroller that grows past a **border** rather than out of a padding
box, so its own `margin-right`/`padding-right` pair adds `--hairline` to the gap: the table's cells end
on the inner border edge, so the nearest painted edge left of the bar is the frame LINE, and without
that extra the bar keeps 5.85px on one side and 5.74px on the other — reading as centred in the margin
instead of centred in it like every other scroller — the frame line would eat into the gap on one side
only. This replaced both alternatives the user rejected: a lane reserved *inside* the
box leaves the header band and row rules stopping 8px short of the border, and an on-demand lane moves
the columns instead. `overflow: visible` on the wrap is load-bearing (any other value clips the bar
away) and is why `.table-wrap thead th:first-child/:last-child` re-apply the corner radii the box no
longer clips. The two tables align because both get the **same generated colgroup** under
`table-layout: fixed` — `tableColgroup`/`applyTableColumns` in [app.js](frontend/app.js), character
counts only (`calc(<n>ch + 1.5rem)`, a chip adds its own padding), the same approach as
`depsColgroup`; **not** the `measureText` machinery this codebase deleted. `applyTableColumns` also
sets each pair's `min-width` from those same tracks (`tableMinWidth`, with `FLEX_COL_MIN_CH` for the
flexible column) — without it a window narrower than the fixed tracks makes fixed layout collapse the
flexible column to zero width; with it the body scrolls sideways and the header follows via the
`scrollLeft` sync. Fixed layout means values can be clipped, so `.table-scroll td` / `.table-head th`
ellipsize and the renderers put a `title` on every cell that can be truncated. The three pairs are
`clusters-head`/`clusters-table`, `run-status-head`/`run-status-table` and `groups-head`/`groups-table`;
the old `#clusters-table th:last-child { width: 1% }` content-hugging trick is gone with auto layout.

**Vertical rhythm inside a Settings group is `--settings-row-gap`**, applied two ways: as
`.settings-row-gap`'s `margin-top` between sibling rows, and as `.pwgen-col`'s flex `gap` — the
password-generator classes stack two lines inside ONE `.settings-row`, so no margin falls between
them and the column has to supply the same value itself (it used to be `0.5rem`, which left
*Uppercase*/*Symbols* visibly tighter than every other stacked check line).

**The Settings list-row grid is tokenised** (`--le-gap`, `--le-primary-w`, `--le-grip-w`) because
one position is derived from it rather than hand-synced: in the **Comments** row *Preferred comment
view* takes the LEFT slot (narrow and fixed) so the wide **Comment fields** editor beside it starts
at a stable x whichever keys are configured — and
`.settings-field:has(> #comment-view-pref)`'s `calc(grip + primary + 2·gap − 1rem)` puts that x on
the **template** column of the Role Details editor one section below. It is written as a
relationship so changing `--le-primary-w` moves both together; only `--le-grip-w` is nominal (the
grip is sized by its `⠿` glyph, so a different platform font shifts the alignment by a pixel).
`.settings-field:has(> .list-editor)` carries `--list-editor-w` for the same class of reason — the
editor's own `100%` resolves against the field, so an EMPTY list would otherwise collapse the field
to its "Add …" button and drag the control beside it left. An empty editor is also `display:none`d
with its button's clearance cancelled (`.list-editor:empty` / `.list-editor:empty + .list-add`), so
every **Add …** button sits exactly where the editor's FIRST ROW would be instead of clearing a box
with no content — under *Comment fields* that is the line Fields/Raw starts on (it sat 7px lower,
because a gapped `.settings-field` column charged for the empty item twice), and under
*Preconfigured role parents* / *Role Details* one `--settings-row-gap` below the section label.
Deliberately NOT scoped to `.settings-field`: the alignment is wanted in all three.

Three density tokens carry the parts a plain `rem` cannot:
**`--hairline: 1.15px`** for every border (a flat `1px` is 1.75 device px at 175% display scaling,
so the engine snaps it to 1 *or* 2 device px depending on the element's position and borders read
patchy; 1.15px is 2.01 device px there — always 2 — and still rounds to 1px at 100%). Decoration
strokes (checkbox tick, spinner, `.update-badge` ring) stay literal px.
**`--ink-lift`** corrects optical centring: browsers centre the *line box*, which reserves descender
depth and diacritic headroom, so the cap band can land off centre. How far off depends **only on the
font size**, via `(fontBoxAscent - fontBoxDescent - capHeight) / 2` — measured against painted
pixels, 0.455px at `--fs-sm` (= the 0.042em token), 0.30px at `--fs-xs`, and **0.06px at
`--fs-base`, i.e. nothing**. So it is applied as asymmetric padding to the small-font elements only
(`button.small`, `.ph-chip`, `.pick-chip`); an earlier `--ink-lift-control: 0.086em` on
full-height buttons was an overcorrection that pushed labels ~1px above centre — removed, don't
reintroduce it. **Every one of those numbers is a macOS `system-ui` measurement, and that is the
token's limit: the quantity is per-FONT, not per-size** (0.062em on Segoe UI, so the "nothing" at
`--fs-base` is ~2 device px at 175%). Which is why `.chip` and, now, every **full-height control**
are centred *structurally* instead — see **`--control-air`** below; `--ink-lift` survives only on
those three small-font elements. **`--checkbox-lift`** nudges
the Target-selection checkbox, which reads low against its group chip even though both boxes centre
on the same device row. All three are single values — retune, don't sweep.

**`.section-label` is the ONE small-uppercase section label** (Settings groups, Settings meta, the
role form's sections, About), sized by `--fs-section`. It replaced five near-identical rules that
had drifted to three letter-spacings; it sets no `display`/`margin`, so each context opts in.

**`.chip` is the ONE group/cluster pill**, plus a kind modifier: **`.chip-group`** (outlined +
uppercase — a whole group matched, and every group label outside the role form) or
**`.chip-cluster`** (filled tint — one cluster of a group), with `.chip-strike` for a pending revoke
and `.chip-add` needing no rule (its `+` is in the markup). It covers Target selection, the
Clusters / Cluster-groups / Run-status tables and every scope label in the role form (Role Parents,
Attributes, Settings, Present on, search rows, dependency pre-flight), all emitted by
`scopeLabelsHtml`. It replaced `.badge` + `.chip-scope`, which had drifted to **four heights** —
21.8 / 19.6 / 15.4 / 13.4px — and the per-group colour generator (`renderCategoryColors`) lost a
rule with it, since `.badge[data-cat]` and the group-kind scope label were byte-identical. Four
things in that rule are load-bearing, don't undo them:
(1) **`line-height` is explicit** — `normal` is font-dependent and an inherited *number* resizes the
pill, which is the whole reason the Target-selection chip was 2.2px taller than the identical chip
in a table (`.checkbox-group` sets `1.35`);
(2) **the border is always present and only its colour changes**, so an outlined and a filled chip
are the same height — `border: none` on the filled kind is what made it 2px shorter than the
outlined one beside it in one row (it also means `.chip-strike` need only set `color`: the group
kind's `currentColor` border turns red by itself, the filled kind stays outline-less);
(3) **the pill carries real vertical air** because an **underscore is drawn 1.41px below the
baseline** at `--fs-xs` (`UAT_ReplicaDWH`: 2.16px) — with the old 0.05rem padding that ink crowded
the bottom edge and the label read low, which was the reported bug. The text is **not** nudged to
compensate: a per-label optical lift would put neighbouring chips' text on different lines, and
uppercase labels measure centred to 0.02px as they are;
(4) **`--chip-pad-y: 0.1225rem` is derived, not chosen.** Device-pixel rounding acts on `P`, the
padding-edge-to-ink distance: painted air is `round((top+P)·dpr) − round(top·dpr)`, which is
independent of the pill's per-row position (that is what made one `PRODUCTION` chip differ from
another) **exactly when `P·dpr` is an integer**; the border doesn't enter, its device width being
deterministic per DPI. Covering 100/125/150/175/200% at once needs `P·1.25` and `P·1.75` integral,
so **`P` must be a multiple of 4 CSS px** — and for a given `P` the pill height is fixed, leaving
`P=4` (17.5px, this) and `P=8` (25.7px) as the only candidates. `P = pad-y + half-leading +
(ascent − cap height)`, so **changing `line-height` requires re-deriving `--chip-pad-y`**; it is
tuned at the shipped 87.5% density against macOS `system-ui` (Segoe UI lands ~0.1px off), and losing
the exactness costs only the row-to-row stability. The **size exception** is the two lists where a
group is the row's own **subject** rather than an annotation on something else —
`#category-checkboxes .chip` (Target selection's *group* rows) and `#groups-table .chip` (the
Cluster groups editor) — both 21.5px, and deliberately not snap-tuned, each of those rows carrying
exactly one chip so there is no sibling to be compared against. Everywhere a group chip *annotates*
something else takes the shared size: the Clusters table, the secondary cluster list, Run status,
every scope label in the role form. That subject-vs-annotation split is the criterion for a new
list, so extend the selector rather than inventing a size.

(5) **`text-box: trim-both cap alphabetic` behind `@supports` is what actually centres the
label.** Points (1)-(4) size the *pill*; they do not place the *text* in it. A browser centres the
**line box**, which reserves the font's full descent, so the cap band lands low by
`(fontAscent - fontDescent - capHeight)/2` -- a **per-font** quantity, which is why one constant
cannot fix it and why `.chip` is excluded from `--ink-lift`: 0.03em on macOS SF, but **0.062em on
Segoe UI**, leaving 4.58px of air above the caps against 3.50px below -- ~2 device px at 175%
scaling. That was the reported bug, invisible on the Mac the token was tuned on. Trimming the line
box to the text's own edges makes the content box *be* the ink, so the padding edge is the ink edge
and the label is centred for **any** font with nothing to tune. Three consequences: **`P` is no
longer a sum but the padding itself**, so (4)'s snap becomes exact rather than approximate -- and it
now holds on Windows, where the old `P` measured 4.32, not 4; `--chip-pad-y` is restated as the air
itself (`calc(1rem * 2 / 7)` = 4px shared, `calc(1rem * 3 / 7)` = 6px subject -- a decimal literal
must err **high**, since `0.2857rem` x 1.75 = 6.99965 flips a device pixel); and the pill stops
caring about `line-height` at all, inherited or not, so (1) is moot on this path. Measured 7/7
device px of air at every sub-pixel offset. The **subject** chips cannot be snapped (only multiples
of 4px are, and 4px/8px are the wrong sizes), so 6px is exact at 100/150/200% and jitters one device
px at 125/175% -- still better than the ~2 they were off by. An engine without `text-box` skips the
block and renders as (1)-(4) did, so the **WebKit 16 / WebKitGTK 2.38 floor is unchanged** -- it
simply keeps the old centring, which is equally why the fix does not reach an older WebKitGTK. Keep
the id-specificity exception **repeated inside** the block, and the block **after** it.

**Full-height controls are one height and one centring rule**, via the `@supports
(text-box: trim-both cap alphabetic)` block after `.segmented`: `button`, `.tab` and
`.segmented .seg-btn` get `text-box`, `min-height: 0` and `padding-block: var(--control-air)`.
Three symptoms had one cause with two faces. **The text sat low** because nothing sets
`line-height` on a control (`body` declares none), so all of them inherit `normal` and the browser
centres that *line box* — the same per-font cap-band offset as `.chip`, measured here as 19 device
px of air above the caps against 16 below. **The heights disagreed** over where the border sits:
`.tab` had `border: none` (2×hairline short, so it now takes a **transparent** border — the chip's
"always present, only the colour changes" trick) and `.segmented` carries its border on the
**wrapper**, outside its buttons, which is the whole of the "selector is 1px taller". The wrapper's
border plays exactly the role a button's own border does, so `2B + (2P + cap)` is the same sum and
the seg-btn needs no compensating padding once its `min-height` is gone. Measured before —
button/input/select 30.625px, `.tab` 31.143px, `.segmented` 31.679px; after, all three controls are
30.536px reading 17/17 device px at every sub-pixel offset, against 30.625px for a field.
**`--control-air`** (`calc(1rem * 34 / 49)` = 9.714px) is the air, derived not picked:
`P = (H − cap − 2·border)/2` against the measured field height, snapped so `P·1.75` is an integer
(=17). Only 175% is exact — snapping at *every* scaling needs a multiple of 4px and none lands near
the control height. Three things not to undo: **`min-height: 0` is required** (leave `--control-h`
and a smaller-cap font lets `min-height` win, re-centring the ink in the slack — note it is already
not what wins, a Segoe UI line box at `--fs-base` is ~16.8px, which is why controls measured 30.6px
and not the nominal 29.4px); **`padding-block`, never the `padding` shorthand** (the three kinds
keep deliberately different horizontal padding); and **the bare `button` selector is safe** —
`.icon-btn`/`.scope-act`/`.le-del`/`.pw-gen`/`.pw-toggle`/`.info-btn`/`.about-x`/`.q-hint` all carry
class specificity and are `inline-flex` around an SVG with no text, so the trim is a no-op on them.
The reset list (`text-box: normal`) is only the inline-block *text* buttons that opt out of full
height — `button.small`, `.about-check`, `.clusters-toggle`, `.ph-chip`, `.pick-chip` — three of
which carry `--ink-lift` and would be double-corrected. `input`/`select`/`textarea` are deliberately
**not** trimmed (a textarea has no single cap band); they keep `--control-h` and stay aligned
because `P` reproduces their height to 0.09px. Engines without `text-box` skip the block, so the
WebKit 16 / WebKitGTK 2.38 floor is unchanged.

**App shell**: header + tabs bar are fixed (`body` is a flex column, `overflow:hidden`,
no page scroll); `main` fills the rest. Each panel manages its own scroll. Operations is
a two-column grid — left `.ops-sidebar` and right `.ops-main` scroll **independently**;
`.ops-main` is a flex column with a scrolling `.ops-body` (no horizontal padding, so its
content lines up with the footer buttons) and a pinned `.ops-footer` (**Create role** button
for create; Save changes / Remove role for alter, toggled by `updateOpsFooter()`). Clusters
and Settings are single-column with a fixed toolbar / pinned Save-settings footer.
**Action-button convention (keep consistent):** the primary/commit button is the emphasized
(`.primary`) one, placed **rightmost**; Cancel/secondary sits to its left; destructive actions
(e.g. Remove role) sit to the **left of the primary**, still in the right-aligned cluster.
This holds for dialog `<menu>`s (`[Cancel] [Primary]`, all right-aligned — from the ONE shared
`dialog menu` rule, not per-popup copies) and page footers (Create role / Save changes /
Settings & Clusters `[Discard] [Save]` right-aligned; Remove role renders left of Save via
`.ops-footer .alter-actions{justify-content:flex-end}` + `#btn-alter-remove{order:-1}` — `order`
is the whole mechanism, and both rules now sit together). A button opts out to the LEFT of a
right-aligned row with `margin-right:auto` (Test connection, `#fn-dialog-default`,
`#search-status`, `#cluster-test-status`). The **Test connections** button lives in the tabs bar's
Clusters action group (`btn-test-clusters` → `testAllClusters`): it tests every configured cluster
and reports **two ways**, because the Status column is a fixed `9ch` track and a connection error is
a sentence. The **cell carries a one-word label only** — `OK` / `Error` / `testing…` in
`.status-ok`/`.status-error`/`.status-pending`, with the full message as its `title`
(`setClusterStatus`, which takes the message but renders the label) — and the **detail goes to a
footer status chip**, `#cluster-test-status` in `.clusters-footer`, a third independent state
(`clusterTestState`) alongside `runState`/`searchState`, painted by `renderClusterTestStatus` →
the shared `paintStatusChip`, opening the shared `#run-status-dialog` whose **Message column is the
flexible one**. It is seeded from `clustersDraft` (**not** `beginRunStatus`, which resolves
alias/host/group from *saved* clusters and would print an unsaved row's `tmp_<n>` id) via
`buildStatusState(rows, 'queued')` — the phase argument is the whole generalization — then each row
is patched as its test settles, so the chip counts `running… (k/N)`. Durations are timed
frontend-side (`Date.now()`, `TestConnectionInput` returns only an `error`), and `queries` stays
empty, so the popup's magnifier is inert. Following the `searchState` precedent it is **not** in
`clearRunStatus`: the state belongs to the run that produced it and is reset by the next one (the
chip lives inside `#panel-clusters`, so it cannot bleed onto another page). `renderClustersTable`
rebuilds every row, so it ends by calling `restoreClusterStatuses()` to repaint the finished cells
from that state — otherwise any add/edit/delete blanked the column while the chip still said Error.
`#run-status-dialog` labels and sorts a group by name via `categoryLabel`, which falls back to the
**draft** label, so a cluster in a not-yet-saved group is not reported under its slug; the table
itself keeps `draftCategoryLabel` (draft-first), because it must sort by the name it prints — the
two differ only for a group renamed and not yet saved. Cluster rows have
no per-row Test button (testing on-screen values is done from the cluster editor via
`TestConnectionInput`); each row's **Actions** cell holds right-aligned **✎ edit** / **× delete**
icon buttons (`.scope-act`, same as the role form) in a `.row-actions` flex.
`.clusters-footer` therefore mirrors `.ops-footer`: its `.form-error` takes a full-width row
(`flex-basis:100%; order:-1`) so the chip alone holds the left slot — `.settings-footer` keeps the
old `margin-right:auto` error, which is why that one grouped rule is now split.

Top tabs **Operations / Clusters / Settings**, with **one right-aligned action group per page** in
the same bar: `.tab-actions` boxes carrying **Create role** / **Alter role** (`#op-tabs`) and
**Add cluster** / **Test connections** / **Cluster groups** (`#cluster-actions`). Each declares its
page with `data-for`, and the `.tab` click handler shows only the active page's group — so adding a
page's actions is markup, not code (Settings has none). The Clusters page therefore has **no
in-panel toolbar** (`.toolbar` is gone): its table starts at the panel's top padding, like the
Settings body and the Operations grid. The two op-tabs drive **one shared `#role-form`** (there is no
`#form-create_role` / `#form-alter_user` split): Create resets it to an empty form; Alter
opens the search popup and fills it on pick — see the shared-role-form product decision
above. The left sidebar is **Target selection** only (no connection or
confirm-production controls); "Or pick clusters" is a collapse/expand toggle (collapsed
by default; the expanded `.cluster-list` flexes to fill the sidebar). The selection is
**remembered** — held in module-level `selectedCategoryIds` (`null` = the default
all-groups-checked) / `selectedClusterIds`, seeded **once** from persisted `Config.Targets`
on first `loadConfig` (later `loadConfig` calls keep the in-memory selection, so saving
Settings / cluster CRUD no longer resets it), and persisted (debounced) via
`SaveTargetSelection` (`Store.UpdateTargets` → `Config.Targets`, empty = all groups) so it
survives restarts. `render{Category,Cluster}Checkboxes` set `checked` from these; the
checkbox `change` handler is `onTargetChange`. The Clusters
toolbar hosts the right-aligned **Cluster groups** button (`btn-manage-groups` →
`#groups-dialog` list popup → `#group-dialog` add/edit form; edited like clusters, no
Save button, so it lives here rather than Settings). Settings is organised into
divider-separated **`.settings-group`** sections (small uppercase `.settings-group-label`,
same look as the role form): **General** (Appearance theme + Max concurrency), **Preconfigured
role parents**, **Comments** (Comment fields + Preferred comment view), **Role Details** (search
result columns), and **DB command
templates**. Role parents, Comment fields and Find-role columns are drag-orderable add/remove
**list editors** — all three are ONE widget, described by the **`LIST_EDITORS`** table (id, add
button, focus target, draft get/set, `seed` from saved config, `blank` row, `row` markup, `edit`
handler) and driven by `renderListEditor`/`seedListEditor`/`renderListEditors` plus a single
wiring loop over the table; `listRowHtml`/`wireListEditor` supply the grip + remove × + drag
reorder. **Add a fourth list editor by adding a table entry, nothing else.** Drafts stay the
module-level `parentRolesDraft` / `commentFieldsDraft` / `searchColumnsDraft`
(`#parent-roles-editor` / `#comment-fields-editor` / `#search-columns-editor`) because
`readSearchColumnsFromEditor`, `settingsDirty` and the unit tests address them by name. DB templates are a
compact list of command names; clicking one opens
the `#fn-dialog` popup (execution type, call template, clickable placeholder chips — staged in
`dbFnDraft`). The popup's titlebar (`.fn-titlebar`) has a square **help icon button** (`#fn-help`,
`.icon-btn`, top-right, top-aligned with the title) that opens the `#template-help-dialog` syntax
reference — the old Settings-level *Template syntax help* button was removed, so the help now lives
in **every** template editor popup. An **Introspection queries** section (`#db-reads-editor`,
driven by `DB_READS`) sits in a two-column grid (`.settings-two-col`) beside DB command templates;
it lists the four read queries (incl. `role_dependencies`) and opens the **same** `#fn-dialog` in **read mode**
(`openTemplateDialog('read'|'write', key)` — one opener for both, `fnDialogMode` records which):
the execution select is hidden (`setFnDialogExecutionRow`),
the placeholder chips show a single **`${rolename}`** chip
(`renderFnPlaceholders([{token:'${rolename}',kind:'builtin'}])`),
and the contract sentence + query textarea + **Default** button remain; Done stages into
`dbReadsDraft` (saved via `SaveDBReads`/`readDBReadsFromEditor`, dirty-tracked by `savedDBReads`).
The **Preferred comment view** toggle is `#comment-view-pref`
(`ui.comment_default_view`). All staged; the Settings panel uses the same padded-panel + inset
footer as Clusters, with **Discard** (`btn-discard-settings` → `discardSettings`) + **Save**
(`btn-save-settings`, enabled-when-dirty / disabled-when-clean) buttons.

Feature descriptions are not shown inline — they live behind a **`?` help badge**
(`.q-hint`; markup via `hintBadge(text)` in JS, or hand-written next to a static heading).
Mouse **hover** reveals the text in a single shared, `position:fixed` popover
(`.q-hint-pop`) that is positioned in JS (centred, viewport-clamped, flips above when it
would overflow) so `overflow:hidden` panels never clip it. The badges carry **no forced
`tabindex`** (they follow the OS keyboard-navigation setting like every other control); when
keyboard-focusable they open on an explicit **Enter/Space** press (toggle) and close on
blur/Escape — **not** on plain focus (which used to flash the hint while tabbing past).
Delegated `mouseover` + `keydown` handlers drive it, so JS-rendered badges (e.g. the
Alter-role sections) work without per-element wiring. Used on Role Parents/Attributes/Settings
(Alter role), and the Cluster-groups / Find-role / Comments dialogs.
**The badge's optical nudge rides on `vertical-align` (`0.07em`), never on `position/top`.** A badge
sits in one of two container kinds: **inline** (`.section-label`, `.settings-field-label`, a dialog
`h2`), where it is baseline-aligned and needs lifting; or **flex** (`.settings-check-line`,
`#cluster-form .field-label-row`, `.rce-field-label`), where `align-items: center` already centres
it. `vertical-align` is ignored for flex items *by spec*, so the correction self-scopes to the
contexts that need it — whereas the old `top: -1px` applied to both and left every flex label's badge
~1.1px high (measured −1.06/−1.31 vs the label's cap band; now −0.06/−0.31). Don't reintroduce a
`top`, and don't "fix" a new flex label with a per-context reset.

**Shared UI conventions (solve once, apply everywhere — don't re-patch per popup).**
Open every `<dialog>` via the **`openModal(dlgOrId)`** helper in
[frontend/app.js](frontend/app.js), never a bare `.showModal()`: it drops `showModal()`'s
auto-focus (which otherwise leaves a keyboard focus ring on the first Close/OK button, or
pops a `?` hint) **unless** the dialog declares intentional initial focus via an `[autofocus]`
element (e.g. the Find-role search input, and the first field of the add/edit forms — the
group **Label** and cluster **Alias** inputs). Close every `<dialog>` via the mirror-image
**`closeModal(dlgOrId)`**, never a bare `.close()`: closing restores focus (synchronously) to
whatever opened the dialog, and the engine then paints the keyboard focus ring there **even for a
mouse-driven open** — so clicking a control that opens a popup left it ringed once the popup closed
(reported for the status chip inside the Find-role popup). `closeModal` drops that restored focus
when the last interaction was a **pointer** (tracked by `lastInputWasPointer`, capture-phase
`pointerdown`/`keydown` listeners); a keyboard user — including Esc-to-close, which counts as
keyboard — keeps the ring and their place in the tab order. Note the mechanism deliberately does
**not** rely on the `close` event (some engines don't fire it for a programmatic `.close()`) nor on
a focus event (the restore can happen without one). A `<form method="dialog">` submit still closes
natively, bypassing the helper. Settings list editors focus the new row's
input after an Add (role-parent `.pr-value`, comment-field `.cf-key`). Focus indicators are
**keyboard-only** (`:focus-visible`) and **inset** (border-colour + `inset` box-shadow; a
light ring on primary-filled controls where a primary ring would vanish) so scroll containers
/ `overflow:hidden` never clip them — one rule in `styles.css` covers text fields, buttons and
checkboxes, and new controls inherit it rather than adding their own. The base `dialog` is
`padding:0`, so each `*-dialog-body` supplies its own padding (`1.25rem`-ish). Non-text
controls carry no forced `tabindex`, so Tab order follows the OS keyboard-navigation setting.
The header is a `.brand` row (accent dot + smaller title + version chip + round `ⓘ`
`#btn-about`) opening `#about-dialog` (version from `GetAppVersion`; links open via
`runtime.BrowserOpenURL`).

**Role form flow** (all in [frontend/app.js](frontend/app.js), styles in
[frontend/styles.css](frontend/styles.css)) — shared by Create and Alter:
- Clicking the **Alter role** op-tab opens the search dialog (`openSearchDialog`; there
  is no separate "Find user" button); results grouped by login; picking one loads the
  shared form. Search + detail load are **restricted to the selected clusters**
  (`alterTargets`/`alterScopeClusters` captured at search time). Clicking **Create role**
  resets the form to an empty synthetic baseline over the selected clusters.
  **The search popup has its own status chip** (`#search-status`, bottom-left of its `<menu>`,
  Close staying right): `SearchRoles` returns one `ClusterRoleMatches` per cluster, which
  `buildStatusState` turns into `searchState` — a state **independent of `runState`**, because a
  search only runs `SearchRoles` while the role-detail load happens later (`pickUser` →
  `reloadDetails`) and owns the footer chip. Clicking it opens the shared `#run-status-dialog`:
  `openRunStatusDialog(rs)` records `statusDialogState`, and `runStatusSummary(rs)` /
  `renderRunStatusDialog(rs)` / the row magnifier+copy all read the state they were given, so the
  two chips never bleed into each other (the Clusters page's `clusterTestState` is the third).
  `searchState` is cleared by `openSearchDialog` (it belongs
  to the search that produced it); `clearRunStatus` still owns `runState` only.
  **Failures are a one-liner, never a list** — `searchFailureLine(failed, total)` in
  `#alter-search-errors` ("2 of 5 clusters could not be searched — click Status for details."), with
  the per-cluster detail in the status popup. `renderAlterErrors` (the last surviving copy of the
  deleted `renderDetailErrors`) is gone, and with it the alias-printed-twice duplication;
  `stripClusterPrefix` drops the `connect to <alias>: ` that `pg.Connect` adds when the message
  renders in a table that already has a Cluster column.
- **Role Parents** (`#alter-parents`) and **Attributes** (superuser/createrole/createdb/
  inherit/login/replication/bypassrls) render one-per-row: name left, **scope labels**
  right. Completeness is judged **per group**: all selected clusters of a group matched
  → one **outlined** (bordered, transparent) uppercase group label — matching the bordered
  group boxes in Target selection; otherwise one **filled** (no border) per-cluster label,
  coloured by environment. `describeScope`/`scopeLabelsHtml` produce these everywhere
  (present-on, rows, comments, search results).
- Edit model: `alterAdd`/`alterRevoke` and `alterAttrAdd`/`alterAttrRemove` are
  `Map<key, Set<clusterId>>`. **✎ Edit** opens a per-cluster checkbox editor that both
  grants and revokes (diff of desired vs current); **×** removes everywhere; **↺**
  discards pending. All three action buttons always render (stable row layout); the
  inapplicable ones are `disabled` (greyed, `pointer-events:none`) rather than hidden —
  `×` when nothing is granted/pending, `↺` when there are no pending changes.
  `buildAlterClusterOps` groups each cluster's ops into one transactional batch (all of a
  cluster's enable/disable attribute keywords combine into a single `set_attribute`);
  Pending state is rendered by `scopeLabelsHtml`'s two variants only — `chip-add`
  (leading `+`, group colour kept) for a pending grant/enable and `chip-strike` (red
  strikethrough) for a pending revoke/disable — never a green fill, and never for an
  attribute that is simply off (that's `.scope-off`, de-emphasised).
- **Settings** (role GUCs) reuse the same row/scope-editor as attributes but keyed by
  `name=value` (a name with different values per cluster shows multiple rows); pending
  state is `alterConfigSet: Map<"name=value", Set<clusterId>>` and
  `alterConfigReset: Map<name, Set<clusterId>>`; `buildAlterClusterOps` emits
  `set_config`/`reset_config` ops. The scope dialog gains name+value inputs for a new setting.
- **Comment** editor (`#role-comment-editor`, in `#role-identity`) — see the format-agnostic
  comment product decision above. State is the module-level `commentEditor` (rendered FROM /
  written TO it, so `renderAlterDetail` never clobbers pending edits, like the old identity
  block). Loaded on mode entry via `loadCommentEditor()`. When comments **vary** across
  clusters the inline editor is **hidden** (only then does `renderAlterDetail` render a
  "Comments differ — reconcile per cluster" section, flagged *(edited)* when overrides are
  staged); the **Comments** popup (grouped by `canonicalComment`) reconciles per cluster, each
  version editable via its own Fields/Raw editor (`commentVersionEditors`). It has no per-row
  save — **OK** stages edits into `commentOverrides` (`commitCommentsDialog`), **Cancel**
  discards, and the staged comments publish with everything else on **Save changes**.
  **Fields layout — `.rce-fields` is a responsive grid**, `repeat(auto-fill, minmax(14rem, 1fr))`,
  so the keys flow into as many columns as the width allows (2 at an 800px window, 3 at 1024, 4 at
  1280 — the form gets window − 21.25rem) instead of one tall column. One class-level rule serves
  **both** the inline editor and the Comments dialog, which emits the same container. Two things not
  to undo: (1) **`auto-fill`, not `auto-fit`** — auto-fit collapses the empty tracks, so with only
  the two default comment fields each input would stretch to half the form; (2) **`.role-identity`
  carries no `max-width`** — it used to cap the block at 26.25rem, which fixed the column count at
  one, so the login input holds its own `13.125rem` cap instead (the width it had as 50% of that
  cap). `#comments-dialog` is `min(44rem, 94vw)` **with a matching `max-width`**, since the base
  `dialog` rule caps at `min(40rem, 92vw)` and would otherwise clamp it; 44rem holds that grid at
  exactly two columns (three would need ~47.7rem).
- **Password** row: a masked field inside a `.pw-field` with an overlaid **Copy** icon
  (`#btn-copy-password`, left) + **reveal eye** (`.pw-toggle`, right), a **Generate** icon button
  (`#btn-gen-password`, `.pw-gen`) to the right of the field, and the **Set password** checkbox.
  The field + Generate + Copy + eye are **disabled unless "Set password" is checked**
  (`syncPasswordControls()`, driven by `alterDoPassword`; called from `renderAlterDetail`, the
  checkbox handler, and `clearPasswordEditor`). **Generate** (`generatePassword` → written by
  `generatePasswordIntoField`) builds a random password from the saved **`ui.password_gen`** config
  (`model.PasswordGen`: `length` clamped `[6,128]`, class toggles `lowercase/uppercase/digits/symbols`,
  `exclude_similar` drops `il1IoO0`; at least one class stays on — lowercase forced), using
  `crypto.getRandomValues` with a `Math.random` fallback. **Copy** copies the value even while masked
  (COPY→CHECK→COPY icon-swap). The generator config is a **Settings → Password generator** section
  (`#pwgen-*` controls), persisted via the existing `SaveUISettings` (`UISettings.PasswordGen`,
  normalized in `config.store`; no new bound method). A red **Remove role** button. Run results are not an
  in-body table: they surface in the **footer status chip** `#run-status` (left of the action
  buttons; hidden until a run starts, then `running… (D/T)` → `OK`/`Error`), updated live from
  `role-batch-progress` events (`beginRunStatus`/`applyRunProgress`/`finishRunStatus`/
  `renderRunStatus`, state in `runState`). The chip is **button-sized, neutral-colored, and
  glyph-free** (spinner only while running; the *word* OK/Error carries the result — no ✓/✕).
  Clicking it opens `#run-status-dialog` (columns Cluster/Category/Status/Duration/Message +
  actions; **no Host column**), live while running. Rows are **ordered by group name then alias**
  — `statusRowOrder(rs)` sorts at render with the shared `byGroupThenAlias`, so the table is
  stable regardless of the order clusters were queued in or results arrived in, for **every** use of
  it (runs, role loads, search, connection tests), and reads in the same order as the Clusters
  table. **Status is never a sort key** — a failed cluster stays where its group and alias put it
  (the deps popup's `depsTier` grouping is the one deliberate exception). A group that no longer
  exists has no name, so it sorts last (`groupRank`) rather than by its slug. Each done row's actions cell has a
  **magnifier** (`.rst-view`) that opens a separate, larger `#run-queries-dialog` listing that
  cluster's executed SQL (`ClusterResult.Queries`/`ClusterProgress.Queries` — the queries are
  NOT shown inline in the table) and a **copy button** (`.rst-copy`) that copies the cluster's
  message + all queries it sent (including a failed op's, since `runClusterTx` records each op's
  SQL before the error check); `#run-queries-dialog` also has its own Copy button.
  `clearRunStatus()` (op-tab / page-tab switch) keeps it from leaking across pages.

## Layout

```
main.go, app.go           Wails entry + bound methods
system_theme_*.go         Linux-only desktop dark/light probe behind App.IsSystemDark()
native_theme_*.go         Linux-only GTK dark-variant toggle behind App.SetNativeDarkTheme()
internal/model/           Shared JSON-tagged types + RunRequest (stdlib only)
internal/calltemplate/    Template parse/validate/SQL build (stdlib only)
internal/config/          YAML persistence (config.yaml + clusters.yaml), migrate/validate
internal/pg/              DSN, auth, Connect, ExecuteOperation, introspect.go (reads)
internal/batch/           Concurrent executor + all-cluster scan
internal/commands/        Op validation + arg maps + attribute keyword whitelist
internal/update/          GitHub-Releases version check (stdlib http + semver compare)
internal/version/         App version + git-remote-derived RepoURL/DocsURL (ldflags)
frontend/                 Vanilla JS UI (app.js via backend())
build/scripts/            Installer recipes: make-dmg.sh, make-msi.ps1, make-linux-packages.sh
build/windows/installer/  WiX v3 source (product.wxs, License.rtf) — hand-written, committed
build/linux/              pgcowboy.desktop (installed by the deb/rpm)
docs/                     Astro + Starlight site (GitHub Pages); src/assets/ holds the figures
docs/scripts/shots/       Screenshot pipeline — capture.ps1, shots.json, audit.mjs (Windows only)
sql/README.md             Docs for the user's PostgreSQL functions / templates
```

## Package import rules (avoid cycles)

| Package | May import | Must not import |
|---------|-----------|-----------------|
| `internal/model` | stdlib | other `internal/*` |
| `internal/calltemplate` | stdlib | `config`, `pg`, `commands`, `batch` |
| `internal/config` | `model`, `calltemplate` | `pg` |
| `internal/pg` | `model`, `calltemplate`, pgx | `config` |
| `internal/commands` | `model`, `config` | — |
| `internal/batch` | `model`, `config`, `commands`, `pg` | — |
| `internal/update` | `model`, `version`, stdlib | `config`, `pg`, `commands`, `batch` |

`internal/pg` **tests must not import `internal/config`** (config → calltemplate ← pg
test → config cycle). Test SQL via `calltemplate` alone or with `commands`.

## Build / test / run

```bash
export PATH="/opt/homebrew/bin:$HOME/go/bin:$PATH"
go build ./... && go test ./... -count=1   # or: make test-vet
make dev             # dev window (regenerates frontend/wailsjs/)
make package         # build/bin/pgCowboy.app + the host OS installer in dist/
```

- **Go through `make`, never a bare `wails dev`/`wails build`.** Wails' cgo asks pkg-config for
  `webkit2gtk-4.0`; a host that ships only 4.1 (Ubuntu 24.04+, Fedora) fails to compile. The
  Makefile detects the installed version and adds `-tags webkit2_41` (`WAILS_BUILD_FLAGS`), so every
  target that compiles Go must pass it — that is why `dev` exists as a target at all, and a new one
  needs the same flag. It is detected per host rather than pinned in `wails.json`'s `build:tags`,
  which is committed: 4.1 is wrong on a 4.0-only host and meaningless off Linux.

- Run `go test ./... -count=1`, `node --check frontend/app.js`, and `node --test frontend/app.test.mjs`
  before committing. CI: `.github/workflows/test.yml` (go-test + frontend-test jobs).
- Frontend has **no build step / no package.json**; served statically by Wails. Logic tests live in
  [frontend/app.test.mjs](frontend/app.test.mjs) — Node's built-in `node --test`, zero dependencies:
  it loads `app.js` into a `node:vm` context behind a permissive DOM stub (the `DOMContentLoaded`
  init never fires, so loading only defines the globals) and drives the real functions, running
  snippets in the same context so they read/write app.js's top-level `let` state by bare name (same
  trick as the browser console). Covers `canonicalComment`, `editorFromComment`/`assembleCommentFrom`
  (null↔empty), `commentConsensus` (varies / unset-on-one / pending-add), and `buildAlterClusterOps`
  (presence create/remove + comment publishing). For a quick UI smoke test without the Go backend,
  `python3 -m http.server` in `frontend/` and exercise the global functions (`backend()` is
  undefined, so search/save show an inline error, but rendering/logic can be driven with mock
  `window.go.main.App`/`state`/`alterDetails`).
- Introspection/write SQL is best verified against a throwaway Postgres
  (`docker run … postgres:16`), calling `pg.RoleDetail` / `pg.ExecuteOperation`
  directly; remove any scratch `_test.go` afterward.

## Versioning

[VERSION](VERSION) is app semver (git tag `v$(cat VERSION)`) and the **single source** of the
runtime version: `main.go` embeds it (`//go:embed VERSION`) and sets `version.Version` at startup,
so `go run` / `wails dev` / `make` all reflect it without ldflags (the `internal/version.Version`
literal is only an empty-embed fallback). `-ldflags` inject only `Commit`/`BuildDate`/`Repo`.
`GetAppVersion()` surfaces the version. Config YAML `version:` is the **schema** version only.

**[CHANGELOG.md](CHANGELOG.md) is the user-facing history** ([Keep a
Changelog](https://keepachangelog.com/en/1.1.0/) format). Record user-visible changes under
`## [Unreleased]` **as part of the change itself** — **one terse line each** (bold feature name,
then what it does; no narration, no multi-sentence entries), written for someone who uses the app,
not for someone reading the diff (internal refactors, test-only and docs-only work don't belong
there). At release time `[Unreleased]` is renamed to `## [X.Y.Z] - YYYY-MM-DD` and a
fresh empty `[Unreleased]` opened above it; **the heading must match `VERSION`**, because the
release job extracts that section with awk (everything up to the next `## [` heading) into the
GitHub release description — above the install instructions and GitHub's auto-generated,
commit-level "What's Changed" list — followed by a link to the full `CHANGELOG.md` at the released
tag. A missing section only logs a `::warning::` and yields an empty summary. See
[RELEASING.md](RELEASING.md).

**`wails.json` `info.productVersion` is a generated mirror of VERSION — never hand-edit it**, and
don't restate a version number in prose or docs either (use a `{VERSION}` placeholder, as
[docs installation](docs/src/content/docs/installation.md) does). `make sync-wails-version` owns
that field and `build`/`build-ci` depend on it, so `make package` and the release workflow always
package matching bundle metadata (macOS `CFBundleVersion`/`CFBundleShortVersionString`, the Windows
exe version resource — installer names and the MSI `ProductVersion` read VERSION directly). The copy
exists only because Wails v2 hardcodes its config path to `<cwd>/wails.json` and offers **no** CLI
flag or env var for the version; dropping the key makes Wails default to a hardcoded `1.0.0`, and a
`preBuildHook` can't help (the project config is parsed before hooks run). The sync **writes only on
a real change** (printing `… (updated - commit this)`), so builds don't churn the tracked file —
which is how a stale `productVersion` once rode along in an unrelated commit. A build that bypasses
`make` uses whatever is committed; that only affects dev bundle metadata, never a release. (It is
also the lesser of the two reasons not to bypass `make` — see the webkit tag under Build/test/run.)

## Packaging (installers, not archives)

Releases ship **native installers only** — `.dmg` (macOS), `.msi` (Windows), `.deb` + `.rpm`
(Linux). `make package` builds the host OS's installer into `dist/` by running one script per
platform from [build/scripts/](build/scripts/), and
[.github/workflows/release.yml](.github/workflows/release.yml) runs the **same** scripts via
`make package-ci`, so a local package matches a released one — fix packaging bugs in the script,
never in the YAML. Artifact names are `pgCowboy-v<VERSION>-<macos|windows|linux>-<arch>.<ext>`;
`PLATFORM=darwin/universal` (passed to `wails build`, last element = the arch label) builds the
universal macOS bundle CI releases. `internal/update` only reads a release's `tag_name`, so
renaming artifacts never breaks the update check.

- **MSI** ([build/windows/installer/product.wxs](build/windows/installer/product.wxs), WiX v3
  compiled by `make-msi.ps1`): per-machine into `C:\Program Files\pgCowboy`, Start-menu
  shortcut, `MajorUpgrade` in-place upgrades, install path remembered under
  `HKLM\Software\MichalBartak\pgCowboy`. The **`UpgradeCode` GUID must never change** or
  upgrades turn into parallel installs. UI banner/dialog bitmaps are generated from
  `build/appicon.png` at package time; `build/windows/icon.ico` is committed (the rest of
  `build/windows/` is Wails-generated and gitignored — note the negation block in
  [.gitignore](.gitignore) that keeps the WiX sources and the icon tracked).
- **DMG** (`make-dmg.sh`): rebuilds the bundle icon as a full multi-size `.icns`, ad-hoc
  re-signs, then stages the app + an `/Applications` symlink + a background image. Both the
  background (needs Pillow) and the Finder-scripted window layout degrade to a warning rather
  than failing the build.
- **deb/rpm** (`make-linux-packages.sh`, fpm): package `pgcowboy` installs
  `/usr/bin/pgCowboy`, [build/linux/pgcowboy.desktop](build/linux/pgcowboy.desktop) and an
  icon. Runtime deps name the WebKit the binary is linked against
  (`libwebkit2gtk-4.1-0` / `webkit2gtk4.1`) — keep them in step with the Makefile's
  `webkit2_41` build tag.

## Docs screenshots (`docs/scripts/shots/`)

Every figure in the docs is a **light/dark pair** under `docs/src/assets/<section>/`, picked by
Starlight's theme toggle — so replacing one is overwriting the file, never editing markdown.
Capture is **scripted and Windows-only** (it drives the real app); human-facing instructions are in
[docs building.md](docs/src/content/docs/building.md). Four helpers plus a manifest:

| file | role |
|------|------|
| `capture.ps1` | dot-sourced; `Set-ClientSize`, `Save-ClientShot`, `Set-OsTheme`, `Invoke-ClientClick/Scroll`, `Reset-Cursor` |
| `shots.json` | one entry per figure: how to reach it, plus `crop` / `callout` / `redact` / `scrolls` |
| `contentbox.mjs` | derives a callout rect from the pixels |
| `controlbox.mjs` | derives a control's **inner** rect, so a redaction fits inside the field |
| `audit.mjs` | six checks over the whole set; `optimize.mjs` re-encodes losslessly |

**Decisions that cost a re-shoot to rediscover — don't regress them:**

- **Capture the CLIENT rect in physical pixels**, never a hand-crop. The first generation was cropped
  by hand in an image editor: six different sizes across figures, and a 1–2px rim of desktop bleeding
  through the window edge (a teal `0,28,37` last row in the dark shots). `Set-ClientSize` converges on
  an exact client size; PowerShell must be `SetProcessDPIAware()` first or a 175%-scaled display
  silently returns logical pixels.
- **The canonical size comes from the app's own `config.yaml`** (`window_width`/`window_height`),
  not from a constant — resize until the Operations page stops scrolling and the app restores it next
  launch. `audit.mjs` fails any figure showing a scrollbar unless it declares `scrolls: true`
  (Settings always scrolls; `comment-raw-view` does because the Raw textarea is ~95px taller than
  the Fields inputs it replaces).
- **Flip the theme with `Set-OsTheme`, in place.** `ui.theme: system` + `applyTheme`'s
  `prefers-color-scheme` listener means the OS flip repaints the window without losing scroll
  position, staged edits or an open dialog — which is the only way a light/dark pair differs by
  nothing but the theme. Snapshot with `Get-OsTheme` and **restore it at the end**; those two
  `HKCU\…\Themes\Personalize` DWORDs are the only system state the pipeline touches.
- **Blur an `[autofocus]` text field before capturing** (click the dialog's heading). Otherwise its
  caret lands in one theme's frame and not the other's.
- **Callout frames** (`#3DC46C`, 4px, square): left and right clearance **equal**, and every frame on
  a tab starts at the **same x** (Settings 14, Operations 474) whatever its width. A frame **may
  cross the scrollbar lane** — it is empty space, and treating it as a boundary is what once ate the
  right-hand pad and put the stroke on the row action buttons.
- **Redaction is pixelation in the capture, not sanitised data.** Rects must sit **inside** the
  control (derive with `controlbox.mjs`); ones sized by eye overhung the input border by 4–8px. The
  averaging **downscale** is what destroys the information — the **upscale** is bicubic purely for
  looks, so "hardening" it back to nearest-neighbour buys no safety. The site's people-vs-schema
  policy lives in `shots.json`'s `redactPolicy`; `audit.mjs` can prove a rect stayed inside its
  control but **not** that it covers the right thing, so eyeball every redacted figure.
- **`optimize.mjs` after every re-shoot.** `System.Drawing` writes a lazily-deflated PNG ~14% larger
  than the same pixels need; the re-encode asserts pixel-identity before replacing a file, and reads
  the file list from `shots.json` so it never rewrites strays sitting in the assets folder.

Placeholders: `docs/scripts/screenshots.mjs` generates a self-naming placeholder for any newly
referenced figure (`make docs-shots` / `docs-shots-status`), so a missing shot never breaks the build.

## Out of scope (v1)

SSH tunnels, encrypted config vault, audit log, reading remote `pg_hba.conf`.
