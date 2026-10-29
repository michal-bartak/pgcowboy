// @ts-check

// A role name may be any non-empty string except a comma (the parent-list delimiter) or NUL —
// the backend double-quotes identifiers, so case and special characters are preserved/safe.
const ROLE_NAME_RE = /^[^,\x00]+$/;

/** @type {import('../internal/model/model').Config | null} */
let state = null;
let currentOp = 'create_role';
/** Live run-status state for the footer chip + #run-status-dialog, or null when cleared.
 *  { total:number, order:string[], byId:Map<clusterId,{alias,host,category,phase,status,message,durationMs}> } */
let runState = null;
// Remembered target selection (Operations sidebar). `selectedCategoryIds === null` means the
// default "all groups checked"; a Set means exactly those are checked. Seeded once from the
// persisted Config.Targets on first load, then kept in memory so re-renders don't reset it.
let selectedCategoryIds = null;
let selectedClusterIds = new Set();

// Staged Clusters editor: add/edit/delete mutate these drafts; nothing persists until Save.
// `null` = not yet seeded. The rest of the app keeps reading the SAVED `state.clusters`/
// `state.categories` (so unsaved cluster edits never affect what a run targets).
let clustersDraft = null;
let categoriesDraft = null;
let tmpClusterSeq = 0;

/** Mirror of the backend slugify (store.go): lowercase, [a-z0-9_], collapse other runs to _. */
function jsSlugify(label) {
  return String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** (Re)seed the Clusters drafts from the saved config (deep copies). */
function resetClusterDrafts() {
  clustersDraft = (state?.clusters || []).map((c) => ({ ...c }));
  categoriesDraft = (state?.categories || []).map((c) => ({ ...c }));
}

/** Label for a category id, resolved from the DRAFT categories (Clusters page). */
function draftCategoryLabel(id) {
  return categoriesDraft?.find((c) => c.id === id)?.label || id || '';
}

// Canonical shapes for dirty comparison (ignore cluster id so tmp-id vs UUID isn't noise; a
// new/removed cluster still changes the array length ⇒ dirty).
function normClusterForDiff(c) {
  return {
    alias: c.alias || '', host: c.host || '', port: c.port || 5432, database: c.database || '',
    category: c.category || '', sslmode: c.sslmode || 'prefer', connectUser: c.connectUser || '',
  };
}
function normCatForDiff(c) {
  // A colour-less saved group and one whose colour is the default are equivalent — the colour
  // picker always yields a hex, so editing a colour-less group would otherwise look permanently
  // dirty even after reverting the label.
  return { id: c.id || '', label: c.label || '', color: c.color || DEFAULT_CAT_COLOR, confirm: !!c.confirm };
}

/** True when the Clusters drafts differ from the saved config. */
function clustersDirty() {
  if (!clustersDraft || !categoriesDraft) return false;
  const cl = (a) => JSON.stringify((a || []).map(normClusterForDiff));
  const ct = (a) => JSON.stringify((a || []).map(normCatForDiff));
  return cl(clustersDraft) !== cl(state?.clusters) || ct(categoriesDraft) !== ct(state?.categories);
}

function refreshClustersDirty() {
  const dirty = clustersDirty();
  setDirty(document.getElementById('btn-save-clusters'), dirty);
  setDirty(document.getElementById('btn-discard-clusters'), dirty); // Discard is inert when clean too
}

// --- Alter role tab state ---
/** @type {Array<{loginName:string, clusters:Array<any>}>} */
let alterGroups = [];
/** @type {string|null} */
let alterSelected = null;
/** @type {Array<any>} */
let alterDetails = [];
// Consolidated edit model for the single user form:
/** @type {Map<string, Set<string>>} role -> set of clusterIds to grant it on */
let alterAdd = new Map();
/** @type {Map<string, Set<string>>} role -> set of clusterIds to revoke it on */
let alterRevoke = new Map();
let alterDoPassword = false;
/** @type {{categoryIds:string[], clusterIds:string[]}} target selection captured at search time */
let alterTargets = { categoryIds: [], clusterIds: [] };
/** @type {Array<{clusterId:string, alias:string, category:string}>} selected clusters (compare universe) */
let alterScopeClusters = [];
/** @type {Map<string, Set<string>>} attribute key -> clusterIds to enable */
let alterAttrAdd = new Map();
/** @type {Map<string, Set<string>>} attribute key -> clusterIds to disable */
let alterAttrRemove = new Map();
/** @type {Map<string, Set<string>>} "name=value" -> clusterIds to SET */
let alterConfigSet = new Map();
/** @type {Map<string, Set<string>>} setting name -> clusterIds to RESET */
let alterConfigReset = new Map();
/** @type {Set<string>} clusterIds (currently exists:true) where the role should be DROPPED.
 *  Clusters to ADD the role to are represented as synthetic exists:false rows in alterDetails
 *  (like create mode), so the rest of the form naturally targets them. */
let roleRemoveClusters = new Set();
/** Alter: the new name staged by editing #role-login ('' = no rename). Published on Save changes
 *  as the FIRST op of each existing cluster's transaction (see buildAlterClusterOps). */
let alterRenameTo = '';
/** Inline comment editor state (shared by Create/Alter). Rendered FROM and written TO by
 *  the editor; renderAlterDetail never touches it, so pending edits survive re-renders. */
let commentEditor = {
  mode: 'fields', // 'fields' | 'raw'
  baseObj: {}, // parsed object of the loaded consensus comment (preserves unknown/non-string keys)
  isObject: false, // did the loaded/raw comment parse as a JSON object?
  raw: '', // raw textarea text (authoritative in raw mode)
  shownKeys: [], // ordered keys rendered as value-inputs (configured first, then other keys)
  labels: {}, // key -> label
  values: {}, // key -> edited string value (JSON text for read-only non-string keys)
  readonly: new Set(), // keys whose value isn't a string: shown but only Raw-editable
  varies: false, // comment differs across clusters (inline editor disabled; use Comments dialog)
};
/** @type {Map<string, string>} clusterId -> desired comment, staged from the Comments dialog
 *  (varies case). Published together with the other edits on "Save changes". */
let commentOverrides = new Map();
/** The sidebar selection that matches the currently-loaded Alter scope; used to revert the
 *  checkboxes if a live re-scope is cancelled. Debounce timer + in-flight guard coalesce
 *  rapid toggles so the per-cluster data lookup runs once against the final selection. */
let alterAppliedSelection = { categoryIds: new Set(), clusterIds: new Set() };
let alterScopeTimer = null;
let alterScopeBusy = false;

// The role form is shared by Create and Alter. Create = editing a not-yet-existing role
// across the selected clusters with an empty baseline; Alter = editing an existing role
// over the clusters it lives on. `currentOp` selects the mode.
function isCreateMode() {
  return currentOp === 'create_role';
}

/** Clear the password state AND its on-screen controls (checkbox + field) and refresh the footer.
 *  Touching the DOM directly (not just the state) guarantees "Set password" unchecks even when a
 *  re-render is skipped or deferred — e.g. right after a successful Save. */
function clearPasswordEditor() {
  alterDoPassword = false;
  alterPassword = '';
  const cb = /** @type {HTMLInputElement} */ (document.getElementById('alter-do-pw'));
  if (cb) cb.checked = false;
  const pw = /** @type {HTMLInputElement} */ (document.getElementById('alter-password'));
  if (pw) pw.value = '';
  syncPasswordControls();
  updateOpsFooter();
}

/** Enable the password field + Generate/Copy/reveal controls only while "Set password" is
 *  checked (disabled/greyed otherwise) — a generated or typed value only matters when it will be
 *  saved. Driven by `alterDoPassword`; called from renderAlterDetail and the checkbox handler. */
function syncPasswordControls() {
  const on = alterDoPassword;
  ['alter-password', 'btn-gen-password', 'btn-copy-password'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = !on;
  });
  const eye = document.querySelector('#alter-password')?.closest('.pw-field')?.querySelector('.pw-toggle');
  if (eye) eye.disabled = !on;
}

// Character classes for the random password generator (mirrors model.PasswordGen classes).
const PWGEN_CLASSES = {
  lowercase: 'abcdefghijklmnopqrstuvwxyz',
  uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{}',
};
const PWGEN_SIMILAR = new Set('il1IoO0'.split(''));

/** Build a random password from the saved generator config (state.ui.passwordGen, else defaults).
 *  Uses crypto.getRandomValues when available (falls back to Math.random so it stays testable in the
 *  Node vm harness and safe in any webview). At least one class is always enabled by the backend. */
function generatePassword(cfg) {
  const g = cfg || state?.ui?.passwordGen || DEFAULT_PASSWORD_GEN;
  let pool = '';
  for (const key of Object.keys(PWGEN_CLASSES)) {
    if (g[key]) pool += PWGEN_CLASSES[key];
  }
  if (g.excludeSimilar) pool = pool.split('').filter((c) => !PWGEN_SIMILAR.has(c)).join('');
  if (!pool) pool = PWGEN_CLASSES.lowercase; // defensive: never draw from an empty pool
  const len = Math.max(1, g.length || DEFAULT_PASSWORD_GEN.length);
  const rand = new Uint32Array(len);
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoObj && cryptoObj.getRandomValues) cryptoObj.getRandomValues(rand);
  else for (let i = 0; i < len; i++) rand[i] = Math.floor(Math.random() * 0x100000000);
  let out = '';
  for (let i = 0; i < len; i++) out += pool[rand[i] % pool.length];
  return out;
}

/** Generate button: fill the field with a fresh password and stage it (checkbox is already on,
 *  since the button is only enabled while "Set password" is checked). */
function generatePasswordIntoField() {
  if (!alterDoPassword) return;
  alterPassword = generatePassword();
  const pw = /** @type {HTMLInputElement} */ (document.getElementById('alter-password'));
  if (pw) pw.value = alterPassword;
  updateOpsFooter();
}

/** Copy `text`, confirming on the button itself with a COPY→CHECK→COPY icon swap. There is no
 *  toast to fall back on (and inside a modal one would render under the overlay), so the swap IS
 *  the feedback; a clipboard failure is rare enough to only warrant a console error.
 *  Used by every copy affordance: the password field, the config path, and the status rows. */
async function copyWithFeedback(btn, text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      btn.innerHTML = ICONS.check;
      setTimeout(() => { btn.innerHTML = ICONS.copy; }, 1500);
    }
    return true;
  } catch (e) {
    console.error('clipboard copy failed', e);
    return false;
  }
}

/** Copy button: copy the current password even while the field is masked. */
function copyGeneratedPassword(btn) {
  return copyWithFeedback(btn, alterPassword || document.getElementById('alter-password')?.value || '');
}

/** Clear all pending edit maps + password state (both modes). */
function resetEditMaps() {
  alterAdd = new Map();
  alterRevoke = new Map();
  alterAttrAdd = new Map();
  alterAttrRemove = new Map();
  alterConfigSet = new Map();
  alterConfigReset = new Map();
  commentOverrides = new Map();
  roleRemoveClusters = new Set();
  alterRenameTo = '';
  alterDoPassword = false;
  alterPassword = '';
}

/** Create mode: baseline = the selected clusters as empty (not-yet-existing) rows. */
function synthCreateBaseline() {
  alterScopeClusters = [];
  alterSelected = document.getElementById('role-login')?.value.trim() || null;
  alterDetails = resolveSelectedClusters().map((c) => ({
    clusterId: c.id,
    alias: c.alias,
    category: c.category,
    exists: false,
    comment: '',
    parents: [],
    attributes: {},
    settings: {},
  }));
}

/** Create mode: drop pending grants/enables/sets that point at no-longer-selected clusters. */
function reconcilePendingWithUniverse() {
  const universe = new Set(alterDetails.map((d) => d.clusterId));
  const prune = (map) => {
    for (const [key, ids] of map) {
      for (const id of [...ids]) if (!universe.has(id)) ids.delete(id);
      if (!ids.size) map.delete(key);
    }
  };
  prune(alterAdd);
  prune(alterRevoke);
  prune(alterAttrAdd);
  prune(alterAttrRemove);
  prune(alterConfigSet);
  prune(alterConfigReset);
}

// Editable role attributes (pg_roles flag -> ALTER ROLE enable/disable keywords).
const ROLE_ATTRIBUTES = [
  { key: 'super', label: 'Superuser', on: 'SUPERUSER', off: 'NOSUPERUSER' },
  { key: 'createrole', label: 'Create role', on: 'CREATEROLE', off: 'NOCREATEROLE' },
  { key: 'createdb', label: 'Create DB', on: 'CREATEDB', off: 'NOCREATEDB' },
  { key: 'inherit', label: 'Inherit', on: 'INHERIT', off: 'NOINHERIT' },
  { key: 'login', label: 'Login', on: 'LOGIN', off: 'NOLOGIN' },
  { key: 'replication', label: 'Replication', on: 'REPLICATION', off: 'NOREPLICATION' },
  { key: 'bypassrls', label: 'Bypass RLS', on: 'BYPASSRLS', off: 'NOBYPASSRLS' },
];
/** @type {MediaQueryList | null} */
let systemThemeMedia = null;
/** Cached `Environment().platform === 'linux'`; null until the first probe resolves. */
let isLinuxHost = null;
/** Linux-only gsettings poll while the preference is "system" — see applyTheme. */
let systemThemePoll = null;
/** Bumped by every applyTheme() call. An async resolve (or a late poll tick) captures the
 *  generation it started in and bails if superseded, so a slow probe from a preference the
 *  user has already moved off can't repaint over the newer pick. */
let themeGeneration = 0;

function backend() {
  return window.go?.main?.App;
}

/** The bound-methods object, or null after reporting "backend not available" on `errEl` (and
 *  flashing `btn` red). Every action entry point needs this same guard — it only fails when the
 *  page is opened outside Wails, e.g. the static-server smoke test. */
function requireBackend(errEl, btn) {
  const app = backend();
  if (app) return app;
  showInlineError(errEl, 'Wails backend not available');
  if (btn) flashButton(btn, { cls: 'flash-err' });
  return null;
}

/** Was the last user interaction a pointer (rather than the keyboard)? Capture phase, so it is
 *  already up to date when a click handler opens a dialog. */
let lastInputWasPointer = false;
document.addEventListener('pointerdown', () => { lastInputWasPointer = true; }, true);
document.addEventListener('keydown', () => { lastInputWasPointer = false; }, true);

/**
 * Open a <dialog> modally without leaving a control ringed. showModal() auto-focuses the
 * first focusable descendant, which shows a keyboard focus ring on e.g. a Close/OK button
 * (and can pop a "?" hint open). Unless the dialog declares an intentional initial focus via
 * an [autofocus] element, drop that focus so the popup opens clean; callers that want a
 * specific field focused can still .focus() it afterwards. One place, every dialog.
 *
 * See closeModal for the mirror image on the way out.
 * @param {HTMLDialogElement|string} dlg  the dialog element or its id
 * @returns {HTMLDialogElement|null}
 */
function openModal(dlg) {
  const el = typeof dlg === 'string' ? document.getElementById(dlg) : dlg;
  if (!el) return null;
  el.showModal();
  if (!el.querySelector('[autofocus]')) document.activeElement?.blur();
  return el;
}

/**
 * Close a <dialog> without leaving its opener ringed — the mirror image of openModal. Closing a
 * dialog restores focus (synchronously) to whatever opened it, and the engine then paints the
 * keyboard focus ring there even when the dialog was opened by mouse: clicking a control that
 * opens a popup left that control ringed once the popup closed, most visibly the status chip
 * inside the Find-role popup. After a POINTER-driven interaction we drop that restored focus; a
 * keyboard user keeps their ring and their place in the tab order (Esc counts as keyboard, so
 * Esc-to-close correctly hands the ring back). One place, every dialog.
 * @param {HTMLDialogElement|string} dlg  the dialog element or its id
 */
function closeModal(dlg) {
  const el = typeof dlg === 'string' ? document.getElementById(dlg) : dlg;
  if (!el) return;
  el.close();
  if (lastInputWasPointer) document.activeElement?.blur();
}

/** @returns {Promise<boolean>} */
async function askConfirm(title, message) {
  return (await askConfirmWithCheck(title, message)).ok;
}

/** The confirm popup with an optional checkbox under the message (shown, unticked, only when
 *  `checkLabel` is non-empty). Resolves on either button — or Esc — with the checkbox state too,
 *  since a "Suppress this warning" choice holds whether or not the action goes ahead. With
 *  `canProceed: false` it is a stop, not a question: Continue is hidden and Cancel reads Close, so
 *  the only way out is to back off (it then always resolves `ok:false`).
 *  @returns {Promise<{ok:boolean, checked:boolean}>} */
function askConfirmWithCheck(title, message, { checkLabel = '', canProceed = true } = {}) {
  return new Promise((resolve) => {
    const dlg = document.getElementById('confirm-dialog');
    const okBtn = document.getElementById('confirm-dialog-ok');
    const cancelBtn = document.getElementById('confirm-dialog-cancel');
    const check = /** @type {HTMLInputElement} */ (document.getElementById('confirm-dialog-check'));
    document.getElementById('confirm-dialog-title').textContent = title;
    document.getElementById('confirm-dialog-message').textContent = message;
    // Set both ways on every open: the dialog is shared, so a stop must not leak into the next ask.
    okBtn.classList.toggle('hidden', !canProceed);
    cancelBtn.textContent = canProceed ? 'Cancel' : 'Close';
    document.getElementById('confirm-dialog-check-row')?.classList.toggle('hidden', !checkLabel);
    document.getElementById('confirm-dialog-check-label').textContent = checkLabel || '';
    if (check) check.checked = false;

    const cleanup = () => {
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onCancel);
    };

    const onOk = () => {
      cleanup();
      closeModal(dlg);
      resolve({ ok: true, checked: !!checkLabel && !!check?.checked });
    };
    const onCancel = () => {
      cleanup();
      closeModal(dlg);
      resolve({ ok: false, checked: !!checkLabel && !!check?.checked });
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onCancel);
    openModal(dlg);
  });
}


/** Disable auto-capitalization on technical fields; only fullName uses words. */
function configureInputCapitalization(root = document) {
  root.querySelectorAll('input[type="text"], input[type="email"], input[type="password"]').forEach((el) => {
    if (el.name === 'fullName') {
      el.setAttribute('autocapitalize', 'words');
      return;
    }
    el.setAttribute('autocapitalize', 'none');
    el.setAttribute('autocomplete', 'off');
    if (el.type !== 'password') {
      el.setAttribute('spellcheck', 'false');
    }
  });
  root.querySelectorAll('textarea').forEach((el) => {
    el.setAttribute('autocapitalize', 'none');
    el.setAttribute('spellcheck', 'false');
  });
}

// --- Segmented button groups (Appearance, Preferred comment view) ---
// Both are the same widget: one active button per group, its data-pref carrying the value.

/** The active button's `data-pref` in a segmented group, or `fallback`. */
function segValue(groupId, fallback) {
  return document.querySelector(`#${groupId} .seg-btn.active`)?.dataset.pref || fallback;
}

/** Mark exactly the button carrying `pref` as active (and aria-pressed) in a segmented group. */
function setSegValue(groupId, pref) {
  document.querySelectorAll(`#${groupId} .seg-btn`).forEach((b) => {
    const on = b.dataset.pref === pref;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

const currentThemePref = () => segValue('ui-theme', state?.ui?.theme || 'system');
const setThemeButtons = (pref) => setSegValue('ui-theme', pref);
const currentCommentViewPref = () => segValue('comment-view-pref', state?.ui?.commentDefaultView || 'raw');
const setCommentViewButtons = (pref) => setSegValue('comment-view-pref', pref);

/** Currently-checked "stage create when adding a target that lacks the role" setting. */
function currentStageCreateOnAdd() {
  return !!document.getElementById('ui-stage-create')?.checked;
}

/** Currently-checked "suppress the MD5 password warning on rename" setting. */
function currentSuppressMD5Warning() {
  return !!document.getElementById('ui-suppress-md5')?.checked;
}

/** Currently-checked "automatically check for updates on startup" setting. */
function currentCheckForUpdates() {
  return !!document.getElementById('ui-check-updates')?.checked;
}

/** Whether auto update-check is on per saved config (nil/absent = default ON). */
function autoCheckUpdates() {
  return state?.ui?.checkForUpdates !== false;
}

/** Built-in password-generator defaults, mirroring model.DefaultPasswordGen (used as a fallback
 *  only — the backend normalizes and always returns a populated block in state.ui.passwordGen). */
const DEFAULT_PASSWORD_GEN = { length: 10, lowercase: true, uppercase: false, digits: true, symbols: false, excludeSimilar: false };

/** Read the Settings password-generator controls into a config object. */
function currentPasswordGen() {
  const len = parseInt(document.getElementById('pwgen-length')?.value, 10);
  return {
    length: Number.isFinite(len) && len > 0 ? len : DEFAULT_PASSWORD_GEN.length,
    lowercase: !!document.getElementById('pwgen-lower')?.checked,
    uppercase: !!document.getElementById('pwgen-upper')?.checked,
    digits: !!document.getElementById('pwgen-digits')?.checked,
    symbols: !!document.getElementById('pwgen-symbols')?.checked,
    excludeSimilar: !!document.getElementById('pwgen-exclude-similar')?.checked,
  };
}

/** Reflect a password-generator config in the Settings controls (seed on load / discard). */
function setPasswordGenControls(pg) {
  const g = pg || DEFAULT_PASSWORD_GEN;
  const set = (id, on) => { const el = document.getElementById(id); if (el) el.checked = !!on; };
  const len = document.getElementById('pwgen-length');
  if (len) len.value = String(g.length || DEFAULT_PASSWORD_GEN.length);
  set('pwgen-lower', g.lowercase);
  set('pwgen-upper', g.uppercase);
  set('pwgen-digits', g.digits);
  set('pwgen-symbols', g.symbols);
  set('pwgen-exclude-similar', g.excludeSimilar);
}

/** Tell the native window chrome which theme it is wearing. `resolved` is the concrete
 *  dark/light outcome; for "system" the runtime is asked to follow the OS itself. */
function setNativeTheme(pref, resolved) {
  const rt = window.runtime;
  if (!rt) return;
  try {
    if (pref === 'system' && rt.WindowSetSystemDefaultTheme) {
      rt.WindowSetSystemDefaultTheme();
    } else if (resolved === 'light' && rt.WindowSetLightTheme) {
      rt.WindowSetLightTheme();
    } else if (rt.WindowSetDarkTheme) {
      rt.WindowSetDarkTheme();
    }
  } catch {
    /* native theme optional */
  }
}

async function onLinux() {
  if (isLinuxHost === null) {
    try {
      isLinuxHost = (await window.runtime?.Environment?.())?.platform === 'linux';
    } catch {
      isLinuxHost = false;
    }
  }
  return isLinuxHost;
}

/** Does the desktop prefer dark? WebKitGTK reports `prefers-color-scheme: light` whatever the
 *  desktop is actually set to, so on Linux the backend answers instead (gsettings, then KDE);
 *  the media query is the fallback if that call fails, and the answer everywhere else. */
async function resolveSystemDark() {
  if (await onLinux()) {
    try {
      const dark = await backend()?.IsSystemDark?.();
      if (typeof dark === 'boolean') return dark;
    } catch {
      /* fall through to the media query */
    }
  }
  return !!systemThemeMedia?.matches;
}

async function applyTheme(themePref) {
  const pref = themePref || 'system';
  const gen = ++themeGeneration;
  if (systemThemePoll) { // a poll left over from a previous "system" selection
    clearInterval(systemThemePoll);
    systemThemePoll = null;
  }
  if (!systemThemeMedia) {
    systemThemeMedia = window.matchMedia('(prefers-color-scheme: dark)');
    systemThemeMedia.addEventListener('change', () => {
      if (currentThemePref() === 'system') applyTheme('system');
    });
  }

  // Both halves of "wear this appearance": the page, and — on Linux — GTK. A <select>'s
  // drop-down LIST is drawn natively by WebKitGTK, so `appearance: none` and the rules on the
  // <option>s never reach it; only the GTK theme's variant does. A no-op off Linux, where the
  // native list already follows the page's `color-scheme`.
  const paint = (dark) => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    try {
      backend()?.SetNativeDarkTheme?.(dark)?.catch?.(() => {});
    } catch {
      /* backend absent — the static-server smoke test */
    }
  };

  if (pref !== 'system') {
    paint(pref === 'dark');
    setNativeTheme(pref, pref);
    return;
  }

  const dark = await resolveSystemDark();
  if (gen !== themeGeneration) return; // superseded while the probe was in flight
  paint(dark);
  setNativeTheme('system', dark ? 'dark' : 'light');

  // The media query never fires `change` on Linux (WebKitGTK never sees the desktop switch), so
  // polling the backend probe is the only way "System" keeps tracking the desktop live.
  if (!(await onLinux()) || gen !== themeGeneration) return;
  systemThemePoll = setInterval(async () => {
    const next = await resolveSystemDark();
    if (gen === themeGeneration) paint(next);
  }, 5000);
}

async function loadConfig() {
  const app = backend();
  const opsErr = document.getElementById('ops-error'); // Operations panel is active at startup
  if (!app) {
    showInlineError(opsErr, 'Wails backend not available (open via wails dev or built app)');
    return;
  }
  try {
    state = await app.GetConfig();
    // Built-in templates for the editor's "Default" button. Fetched once; best-effort, since a
    // failure only costs that button, not the config load.
    if (!defaultTemplates) {
      defaultTemplates = await app.GetDefaultTemplates?.().catch(() => null);
    }
    document.getElementById('config-path').textContent = await app.GetConfigPath();
    // Optional call: an un-regenerated binding would throw and take the whole config load with it.
    document.getElementById('clusters-path').textContent = (await app.GetClustersPath?.()) || '';
    setThemeButtons(state?.ui?.theme || 'system');
    applyTheme(state?.ui?.theme || 'system');
    setCommentViewButtons(state?.ui?.commentDefaultView || 'raw');
    { const c = document.getElementById('ui-stage-create'); if (c) c.checked = !!state?.ui?.stageCreateOnTargetAdd; }
    { const c = document.getElementById('ui-suppress-md5'); if (c) c.checked = !!state?.ui?.suppressMd5RenameWarning; }
    { const c = document.getElementById('ui-check-updates'); if (c) c.checked = autoCheckUpdates(); }
    setPasswordGenControls(state?.ui?.passwordGen);
    // Seed the remembered target selection ONCE (later loadConfig calls keep the in-memory
    // selection, so saving Settings / cluster CRUD doesn't reset it). Empty persisted
    // selection falls back to the default "all groups checked" (selectedCategoryIds === null).
    if (selectedCategoryIds === null) {
      const t = state?.targets || {};
      const cats = t.categoryIds || [];
      const cls = t.clusterIds || [];
      if (cats.length || cls.length) {
        selectedCategoryIds = new Set(cats);
        selectedClusterIds = new Set(cls);
      }
    }
    // Seed the Clusters drafts once; later loadConfig calls (e.g. after saving Settings) keep
    // any unsaved cluster edits. Save/Discard reset the drafts to null so they reseed here.
    if (clustersDraft === null || categoriesDraft === null) resetClusterDrafts();
    renderAll();
  } catch (e) {
    showInlineError(opsErr, e);
  }
}

function categoryLabel(id) {
  const c = state?.categories?.find((x) => x.id === id);
  return c?.label || id;
}

/** Sort index of a cluster group: its position in the CONFIGURED category order (unknown last),
 *  the same rule describeScope uses for scope chips — not alphabetical by label. */
function categoryOrderIndex(id) {
  const i = (state?.categories || []).findIndex((c) => c.id === id);
  return i < 0 ? 999 : i;
}

/** The one ordering rule for cluster lists — configured group order, then alias. Shared by the
 *  status table (every usage of it) and the pre-flight dependency popup. Takes anything
 *  cluster-shaped: {category, alias}. */
function byGroupThenAlias(a, b) {
  return (
    categoryOrderIndex(a?.category) - categoryOrderIndex(b?.category) ||
    (a?.alias || '').localeCompare(b?.alias || '')
  );
}

const DEFAULT_CAT_COLOR = '#9aa3b5';
function categoryColor(id) {
  const c = state?.categories?.find((x) => x.id === id);
  return (c && c.color) || DEFAULT_CAT_COLOR;
}

/** Whether a group requires the production-style confirm popup. */
function categoryConfirm(id) {
  return !!state?.categories?.find((x) => x.id === id)?.confirm;
}

/** #rrggbb → rgba(r,g,b,a). Falls back to the default colour on bad input. */
function hexToRgba(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
  const h = m ? m[1] : DEFAULT_CAT_COLOR.slice(1);
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Generate per-group colour rules (badges, scope labels, checkbox highlight). */
function renderCategoryColors() {
  let el = document.getElementById('cat-colors');
  if (!el) {
    el = document.createElement('style');
    el.id = 'cat-colors';
    document.head.appendChild(el);
  }
  // Prefer the staged draft (seeded from state before first render) so a just-added/edited group
  // gets a colour rule immediately — the saved state lacks it until Save round-trips loadConfig.
  el.textContent = (categoriesDraft || state?.categories || [])
    .map((c) => {
      const hex = c.color || DEFAULT_CAT_COLOR;
      const id = (window.CSS && CSS.escape) ? CSS.escape(c.id) : c.id;
      return [
        `.badge[data-cat="${id}"]{color:${hex};background:transparent;border-color:${hex}}`,
        `.chip-scope.scope-kind-group[data-cat="${id}"]{color:${hex};background:transparent;border-color:${hex}}`,
        `.chip-scope.scope-kind-cluster[data-cat="${id}"]{color:${hex};background:${hexToRgba(hex, 0.16)}}`,
        `.checkbox-group label[data-category="${id}"]:has(input:checked){border-color:${hex};background:${hexToRgba(hex, 0.18)}}`,
      ].join('');
    })
    .join('\n');
}

/** How narrow the flexible column may get before the table scrolls sideways instead of letting
 *  `table-layout: fixed` collapse it to nothing (which is what a too-small window does). */
const FLEX_COL_MIN_CH = 12;

/**
 * One column track from a spec, as both CSS and its `ch`/`rem` parts (so the same numbers can be
 * summed into the table's min-width). A spec is one of:
 *   {header, values, min, cap, chip} — `ch` from the widest value, floored by the header label and
 *                                     `min`, capped by `cap`, plus the th/td padding
 *   {width}                         — a fixed rem track (icon buttons have no text to count)
 *   {flex: true}                    — the ONE column that absorbs the remaining width
 * Character counts only — no text measuring, same approach as depsColgroup.
 */
function tableTrack(sp) {
  // + 1.5rem for the th/td horizontal padding (.75rem each side); a chip adds its own.
  const pad = sp.chip ? 3 : 1.5;
  if (sp.width) return { css: sp.width, ch: 0, rem: parseFloat(sp.width) || 0 };
  if (sp.flex) return { css: null, ch: FLEX_COL_MIN_CH, rem: pad };
  const widest = (sp.values || []).reduce(
    (m, v) => Math.max(m, String(v ?? '').length),
    Math.max((sp.header || '').length, sp.min || 0)
  );
  const n = Math.min(sp.cap ?? widest, widest);
  return { css: `calc(${n}ch + ${pad}rem)`, ch: n, rem: pad };
}

/** The colgroup shared by both tables of a split pair. */
function tableColgroup(specs) {
  return specs
    .map((sp) => {
      const t = tableTrack(sp);
      return t.css ? `<col style="width:${t.css}">` : '<col>';
    })
    .join('');
}

/**
 * The floor for both tables of a pair. Without it a window too narrow for the fixed tracks makes
 * `table-layout: fixed` give the flexible column zero width — the values vanish and the header
 * labels print on top of each other. With it the table overflows instead, so the body scrolls
 * sideways and the header follows (the scrollLeft sync in applyTableColumns).
 */
function tableMinWidth(specs) {
  const total = specs.reduce(
    (acc, sp) => {
      const t = tableTrack(sp);
      return { ch: acc.ch + t.ch, rem: acc.rem + t.rem };
    },
    { ch: 0, rem: 0 }
  );
  return `calc(${total.ch}ch + ${total.rem}rem)`;
}

/**
 * Write one colgroup into both tables of a split pair and keep the header in horizontal step with
 * the body: the header sits OUTSIDE the scroll container (that is what keeps it visible and the
 * bar beside the data rows only), so it has no scrollLeft of its own.
 */
function applyTableColumns(headId, bodyId, specs) {
  const head = document.getElementById(headId);
  const body = document.getElementById(bodyId);
  if (!head || !body) return;
  const headCols = head.querySelector('colgroup');
  const bodyCols = body.querySelector('colgroup');
  if (!headCols || !bodyCols) return;
  const html = tableColgroup(specs);
  headCols.innerHTML = html;
  bodyCols.innerHTML = html;
  const min = tableMinWidth(specs);
  head.style.minWidth = min;
  body.style.minWidth = min;
  const clip = head.closest('.table-head-clip');
  const scroll = body.closest('.table-scroll');
  if (clip && scroll && !scroll.dataset.headSync) {
    scroll.dataset.headSync = '1';
    scroll.addEventListener('scroll', () => {
      clip.scrollLeft = scroll.scrollLeft;
    });
  }
}

function renderGroupsTable() {
  const tbody = document.querySelector('#groups-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  applyTableColumns('groups-head', 'groups-table', [
    { header: 'Group', values: (categoriesDraft || []).map((c) => c.label), chip: true, flex: true },
    { header: 'Confirm', min: 8 },
    { width: '5.5rem' },
  ]);
  if (!categoriesDraft?.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="hint">No groups defined.</td></tr>';
    return;
  }
  // Pre-check usage so a group in use can't be deleted (Delete disabled, no failed attempt).
  const usage = {};
  for (const cl of clustersDraft || []) usage[cl.category] = (usage[cl.category] || 0) + 1;

  for (const c of categoriesDraft) {
    const used = usage[c.id] || 0;
    const delTitle = used ? `In use by ${used} cluster${used === 1 ? '' : 's'}` : 'Delete group';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="badge" data-cat="${escapeAttr(c.id)}">${escapeHtml(c.label)}</span></td>
      <td>${c.confirm ? 'Yes' : '—'}</td>
      <td>
        <div class="row-actions">
          <button class="scope-act" data-action="edit" data-id="${escapeAttr(c.id)}" title="Edit group" aria-label="Edit group">${ICONS.edit}</button>
          <button class="scope-act" data-action="delete" data-id="${escapeAttr(c.id)}" ${used ? 'disabled' : ''} title="${escapeAttr(delTitle)}" aria-label="Delete group">${ICONS.remove}</button>
        </div>
      </td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('button').forEach((btn) => btn.addEventListener('click', onGroupAction));
}

function openGroupDialog(cat) {
  const dlg = document.getElementById('group-dialog');
  const form = document.getElementById('group-form');
  document.getElementById('group-dialog-title').textContent = cat ? 'Edit group' : 'Add group';
  form.id.value = cat?.id || '';
  form.label.value = cat?.label || '';
  form.color.value = cat?.color || DEFAULT_CAT_COLOR;
  form.confirm.checked = !!cat?.confirm;
  clearInlineError(document.getElementById('group-error'));
  openModal(dlg);
}

async function onGroupAction(ev) {
  const btn = ev.currentTarget;
  const id = btn.dataset.id;
  const cat = categoriesDraft?.find((c) => c.id === id);
  if (btn.dataset.action === 'edit') {
    openGroupDialog(cat);
    return;
  }
  if (btn.dataset.action === 'delete') {
    const ok = await askConfirm('Delete group', `Delete cluster group "${cat?.label || id}"? (applied on Save)`);
    if (!ok) return;
    categoriesDraft = categoriesDraft.filter((c) => c.id !== id); // staged; persisted on Save
    renderCategoryColors();
    renderGroupsTable();
    refreshClustersDirty();
  }
}

function renderClustersTable() {
  const tbody = document.querySelector('#clusters-table tbody');
  tbody.innerHTML = '';
  // Up here, not after the loop: an EMPTY draft is a legitimate (and the first-run) state whose
  // footer still has to be reported, and the early return below would skip it — which is how a
  // fresh install came up with Save/Discard live before the user had touched anything.
  refreshClustersDirty();
  applyClusterColumns(clustersDraft || []);
  if (!clustersDraft?.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="hint">No clusters configured.</td></tr>';
    return;
  }
  // Display order: Category (asc) then Alias (asc), by the visible Category label. Sort a copy
  // so clustersDraft's own order (dirty-diff + Save) is untouched.
  const rows = [...clustersDraft].sort(
    (a, b) =>
      draftCategoryLabel(a.category).localeCompare(draftCategoryLabel(b.category)) ||
      (a.alias || '').localeCompare(b.alias || ''),
  );
  for (const c of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td title="${escapeAttr(c.alias)}">${escapeHtml(c.alias)}</td>
      <td title="${escapeAttr(c.host)}">${escapeHtml(c.host)}</td>
      <td>${c.port}</td>
      <td title="${escapeAttr(c.database)}">${escapeHtml(c.database)}</td>
      <td><span class="badge" data-cat="${escapeAttr(c.category)}">${escapeHtml(draftCategoryLabel(c.category))}</span></td>
      <td class="cluster-status" data-status-for="${escapeAttr(c.id)}"></td>
      <td>
        <div class="row-actions">
          <button class="scope-act" data-action="edit" data-id="${c.id}" title="Edit cluster" aria-label="Edit cluster">${ICONS.edit}</button>
          <button class="scope-act" data-action="delete" data-id="${c.id}" title="Delete cluster" aria-label="Delete cluster">${ICONS.remove}</button>
        </div>
      </td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', onClusterAction);
  });
}

/**
 * Clusters table columns. Host takes the slack (it is the long one); Status is a fixed track
 * because setClusterStatus fills it after this runs, so deriving its width from content would make
 * the columns jump when a test finishes; Actions is two icon buttons, i.e. no text to count.
 */
function applyClusterColumns(rows) {
  applyTableColumns('clusters-head', 'clusters-table', [
    { header: 'Alias', values: rows.map((c) => c.alias), cap: 24 },
    { flex: true }, // Host
    { header: 'Port', values: rows.map((c) => c.port), cap: 6 },
    { header: 'Database', values: rows.map((c) => c.database), cap: 20 },
    { header: 'Group', values: rows.map((c) => draftCategoryLabel(c.category)), cap: 16, chip: true },
    { header: 'Status', min: 12 },
    { width: '5.5rem' },
  ]);
}

function renderCategoryCheckboxes() {
  const box = document.getElementById('category-checkboxes');
  box.innerHTML = '';
  for (const cat of state?.categories || []) {
    const label = document.createElement('label');
    label.dataset.category = cat.id;
    // null selection = default "all checked"; otherwise honor the remembered set.
    const checked = selectedCategoryIds === null || selectedCategoryIds.has(cat.id);
    label.innerHTML = `<input type="checkbox" name="category" value="${escapeAttr(cat.id)}" ${checked ? 'checked' : ''} />
      <span class="badge" data-cat="${escapeAttr(cat.id)}">${escapeHtml(cat.label)}</span>`;
    box.appendChild(label);
    label.querySelector('input')?.addEventListener('change', onTargetChange);
  }
}

function renderClusterCheckboxes() {
  const box = document.getElementById('cluster-checkboxes');
  box.innerHTML = '';
  for (const c of state?.clusters || []) {
    const label = document.createElement('label');
    if (c.category) label.dataset.category = c.category;
    const checked = selectedClusterIds.has(c.id);
    label.innerHTML = `<input type="checkbox" name="cluster" value="${escapeAttr(c.id)}" ${checked ? 'checked' : ''} />
      <span class="target-cluster-text">${escapeHtml(c.alias)} <span class="target-cluster-host">(${escapeHtml(c.host)})</span></span>
      <span class="badge" data-cat="${escapeAttr(c.category)}">${escapeHtml(categoryLabel(c.category))}</span>`;
    box.appendChild(label);
    label.querySelector('input')?.addEventListener('change', onTargetChange);
  }
}

/** Expand/collapse the "Or pick clusters" list, keeping the caret and aria-expanded in step. */
function setClusterListExpanded(expanded) {
  const btn = document.getElementById('btn-toggle-clusters');
  const list = document.getElementById('cluster-checkboxes');
  if (!btn || !list) return;
  list.classList.toggle('hidden', !expanded);
  btn.setAttribute('aria-expanded', String(expanded));
  const caret = btn.querySelector('.caret');
  if (caret) caret.textContent = expanded ? '▾' : '▸';
}

// On STARTUP ONLY (called from the DOMContentLoaded init, not from loadConfig/renderAll — a later
// config load must not re-open a list the user deliberately collapsed): a cluster pick restored
// from config renders inside the collapsed list, so it is invisible even though it decides what the
// next run targets. Open the list and bring one picked row into view.
//
// Reads `checked` off the DOM rather than iterating selectedClusterIds, which handles a stale
// remembered id for free: if that cluster has since been deleted no checkbox carries its value, so
// we don't expand a list with nothing highlighted. Toggling classes cannot fire `change`, so this
// never triggers onTargetChange's debounced save.
function revealPickedClusters() {
  if (!selectedClusterIds.size) return;
  const first = [...document.querySelectorAll('#cluster-checkboxes input[name="cluster"]')]
    .find((el) => el.checked);
  if (!first) return;
  setClusterListExpanded(true);
  // The rows had no layout box until the line above (.hidden is display:none), and the expanded
  // list flex-sizes against the sidebar — wait a frame so the scroll has real geometry. 'nearest'
  // keeps the movement inside .cluster-list (.ops-sidebar scrolls too) and is a no-op when the row
  // is already visible, which is the common case when every cluster fits.
  requestAnimationFrame(() => {
    first.closest('label')?.scrollIntoView({ block: 'nearest' });
  });
}

// Recompute the remembered selection from the checkboxes, refresh the preview, and persist
// (debounced) so it survives re-renders and restarts.
let saveTargetsTimer = null;
function onTargetChange() {
  selectedCategoryIds = new Set(getSelectedCategories());
  selectedClusterIds = new Set(getSelectedClusterIDs());
  updateTargetPreview();
  clearTimeout(saveTargetsTimer);
  saveTargetsTimer = setTimeout(() => {
    backend()?.SaveTargetSelection({
      categoryIds: [...selectedCategoryIds],
      clusterIds: [...selectedClusterIds],
    });
  }, 300);
}

// DB command (write) templates shown in Settings. `prop` is the state/DBFunctions JSON key,
// `placeholders` the built-in ${…} chips offered in the editor, `contract` the one-sentence
// description above the textarea.
//
// The DEFAULT SQL is deliberately absent: it lives in config.DefaultConfig() on the Go side and
// is fetched once via GetDefaultTemplates() into `defaultTemplates`. Keeping a second copy here
// meant a backend default change silently left the editor's "Default" button reverting to stale
// SQL, with nothing to catch the drift.
const DB_FUNCTIONS = [
  { key: 'create_role', title: 'Create role', prop: 'createRole', placeholders: ['loginname', 'parent_roles'],
    contract: 'Creates the role on each target cluster. Also receives ${parent_roles} (statement: "a", "b"; function: ARRAY[\'a\',\'b\']) and one ${{<comment key>}} placeholder per configured comment field (empty/absent → NULL).' },
  { key: 'remove_role', title: 'Remove role', prop: 'removeRole', placeholders: ['loginname', 'rolename'],
    contract: 'Drops the role from the cluster.' },
  { key: 'rename_role', title: 'Rename role', prop: 'renameRole', placeholders: ['loginname', 'new_loginname'],
    contract: 'Renames the role; ${loginname} is the current name, ${new_loginname} the new one. Runs first in the cluster\'s transaction, so the ops after it use the new name.' },
  { key: 'grant_parents', title: 'Grant parents', prop: 'grantParents', placeholders: ['loginname', 'parent_roles'],
    contract: 'Grants membership of the given parent roles to the role.' },
  { key: 'revoke_parents', title: 'Revoke parents', prop: 'revokeParents', placeholders: ['loginname', 'parent_roles'],
    contract: 'Revokes membership of the given parent roles from the role.' },
  { key: 'change_password', title: 'Change password', prop: 'changePassword', placeholders: ['loginname', 'new_password'],
    contract: "Sets the role's login password." },
  { key: 'set_comment', title: 'Set comment', prop: 'setComment', placeholders: ['loginname', 'comment'],
    contract: "Sets the role's comment; ${comment} is the whole comment as an already-quoted text literal. A single JSON key from the comment is ${{<comment key>}} — configured comment fields only (empty/absent → NULL)." },
  { key: 'set_attribute', title: 'Set attributes', prop: 'setAttribute', placeholders: ['loginname', 'attributes'],
    contract: 'Applies one or more role attribute keywords (e.g. NOLOGIN SUPERUSER); ${attributes} is a space-separated keyword list.' },
  { key: 'set_config', title: 'Set setting', prop: 'setConfig', placeholders: ['loginname', 'config_name', 'config_value'],
    contract: 'Sets one role GUC to a value; ${config_name} is a bare setting name, ${config_value} a literal.' },
  { key: 'reset_config', title: 'Reset setting', prop: 'resetConfig', placeholders: ['loginname', 'config_name'],
    contract: 'Clears one role GUC; ${config_name} is a bare setting name.' },
];
const EXECUTION_LABELS = { function: 'Function call', statement: 'SQL statement', block: 'PL/pgSQL block' };

// Introspection (read) queries used by Alter role. Same shape as DB_FUNCTIONS — and same reason
// for carrying no default SQL. Result columns are scanned by name against the contract.
const DB_READS = [
  { key: 'search_roles', title: 'Search roles', prop: 'searchRoles',
    contract: 'Finds roles by name or comment. ${rolename} is the ILIKE pattern. Must return columns: rolname (text), comment (text, nullable).' },
  { key: 'role_detail', title: 'Role detail', prop: 'roleDetail',
    contract: 'Reads one role. ${rolename} is the role name. Must return one row with columns: rolsuper, rolcreaterole, rolcreatedb, rolinherit, rolcanlogin, rolreplication, rolbypassrls (bool), comment (text, nullable), rolconfig (text[], nullable).' },
  { key: 'role_parents', title: 'Role parents', prop: 'roleParents',
    contract: 'Lists a role’s direct parent roles. ${rolename} is the role name. Must return one row per parent: rolname (text).' },
  { key: 'role_dependencies', title: 'Role dependencies', prop: 'roleDependencies',
    contract: 'Pre-flight check run before a role is dropped: the objects that depend on it. ${rolename} is the role name. Must return one row per dependency: database, dependency, class, object (all text, nullable).' },
];

/** Built-in templates from the backend ({dbFunctions, dbReads}), fetched once at startup and
 *  used only by the editor's "Default" button. Null until loaded — the button no-ops until then
 *  rather than reverting to a guess. */
let defaultTemplates = null;

/** In-memory edits for the command templates, staged until "Save settings". */
let dbFnDraft = {};
/** In-memory edits for the introspection queries, staged until "Save settings". */
let dbReadsDraft = {};
/** @type {string|null} op currently open in the template dialog */
let fnDialogKey = null;
/** 'write' (DB command template) or 'read' (introspection query) — which draft the dialog edits. */
let fnDialogMode = 'write';
/** In-memory edits for comment fields, staged until "Save settings". */
/** @type {Array<{key:string, label:string}>} */
let commentFieldsDraft = [];
/** In-memory edits for preconfigured role parents, staged until "Save settings". */
/** @type {Array<string>} */
let parentRolesDraft = [];
/** In-memory edits for the Find-role result columns, staged until "Save settings". */
/** @type {Array<{label:string, template:string}>} */
let searchColumnsDraft = [];

// --- Shared draggable list editor (comment fields, role parents, search columns) ---

/** One reorderable row: a drag handle, caller-supplied cells, and a remove button. */
function listRowHtml(idx, innerHtml) {
  return `
    <div class="le-row" data-le-idx="${idx}">
      <span class="le-grip" draggable="true" data-le-idx="${idx}" title="Drag to reorder" aria-label="Drag to reorder">⠿</span>
      ${innerHtml}
      <button type="button" class="le-del" data-le-idx="${idx}" title="Remove" aria-label="Remove">${ICONS.remove}</button>
    </div>`;
}

/** Wire drag-to-reorder + remove on a list-editor container. getDraft returns the backing
 *  array; rerender repaints it. Row indices come from data-le-idx. */
function wireListEditor(containerId, getDraft, rerender) {
  const root = document.getElementById(containerId);
  if (!root) return;
  let dragIdx = null;
  root.addEventListener('dragstart', (ev) => {
    const grip = ev.target.closest('.le-grip');
    if (!grip) return;
    dragIdx = Number(grip.dataset.leIdx);
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', String(dragIdx)); // required for DnD to arm in some webviews
  });
  root.addEventListener('dragover', (ev) => {
    if (dragIdx == null) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
  });
  root.addEventListener('drop', (ev) => {
    if (dragIdx == null) return;
    ev.preventDefault();
    const draft = getDraft();
    const row = ev.target.closest('.le-row');
    const [moved] = draft.splice(dragIdx, 1);
    if (!row) {
      draft.push(moved); // dropped past the last row → append
    } else {
      // Insert at the drop target's ORIGINAL index within the post-removal array: dragging
      // down lands the row after the target (so first→last works), dragging up before it.
      draft.splice(Number(row.dataset.leIdx), 0, moved);
    }
    dragIdx = null;
    rerender();
  });
  root.addEventListener('dragend', () => {
    dragIdx = null;
  });
  root.addEventListener('click', (ev) => {
    const del = ev.target.closest('.le-del');
    if (!del) return;
    getDraft().splice(Number(del.dataset.leIdx), 1);
    rerender();
  });
}

// The three Settings list editors (comment fields, role parents, Find-role columns) are the
// same widget over different row shapes: seed a draft from saved config, paint rows, edit in
// place, reorder/remove/add. They used to be three render/paint pairs plus three input
// listeners, three wireListEditor calls and three Add buttons — all near-identical, so a fix
// to one silently skipped the others. One table now describes what differs; the behaviour is
// defined once in renderListEditor / wireListEditors below.
//
// `get`/`set` go through the module-level draft variables by name rather than living in the
// table, because those names are the editors' public surface (readSearchColumnsFromEditor,
// settingsDirty and the unit tests all address them directly).
const LIST_EDITORS = [
  {
    id: 'comment-fields-editor',
    addId: 'btn-add-comment-field',
    focus: '.cf-key', // field to focus in a newly added row
    get: () => commentFieldsDraft,
    set: (v) => { commentFieldsDraft = v; },
    seed: () => (state?.commentFields || []).map((f) => ({ key: f.key || '', label: f.label || '' })),
    blank: () => ({ key: '', label: '' }),
    row: (f, i) =>
      `<input class="cf-key" data-idx="${i}" value="${escapeAttr(f.key)}" placeholder="key (e.g. full_name)" autocapitalize="none" autocomplete="off" spellcheck="false" />
      <input class="cf-label" data-idx="${i}" value="${escapeAttr(f.label)}" placeholder="label (e.g. Full name)" autocomplete="off" />`,
    edit: (draft, i, el) => {
      if (el.classList.contains('cf-key')) draft[i].key = el.value;
      else if (el.classList.contains('cf-label')) draft[i].label = el.value;
    },
  },
  {
    id: 'parent-roles-editor',
    addId: 'btn-add-parent-role',
    focus: '.pr-value',
    get: () => parentRolesDraft,
    set: (v) => { parentRolesDraft = v; },
    seed: () => (state?.parentRoles || []).slice(),
    blank: () => '',
    row: (r, i) =>
      `<input class="pr-value" data-idx="${i}" value="${escapeAttr(r)}" placeholder="e.g. gr_devs_ro" autocapitalize="none" autocomplete="off" spellcheck="false" />`,
    // Rows here are plain strings, so the element is replaced by index, not mutated.
    edit: (draft, i, el) => { if (el.classList.contains('pr-value')) draft[i] = el.value; },
  },
  {
    id: 'search-columns-editor',
    addId: 'btn-add-search-column',
    focus: '.sc-label',
    get: () => searchColumnsDraft,
    set: (v) => { searchColumnsDraft = v; },
    seed: () => (state?.searchColumns || []).map((c) => ({ label: c.label || '', template: c.template || '' })),
    blank: () => ({ label: '', template: '' }),
    row: (c, i) => {
      const err = searchTemplateError(c.template);
      return `<input class="sc-label" data-idx="${i}" value="${escapeAttr(c.label)}" placeholder="label (e.g. Full name)" autocomplete="off" />
      <input class="sc-template${err ? ' invalid' : ''}" data-idx="${i}" value="${escapeAttr(c.template)}" title="${escapeAttr(err)}" placeholder="template (e.g. \${{first_name}} \${{last_name}})" autocapitalize="none" autocomplete="off" spellcheck="false" />`;
    },
    edit: (draft, i, el) => {
      if (el.classList.contains('sc-label')) draft[i].label = el.value;
      else if (el.classList.contains('sc-template')) {
        draft[i].template = el.value;
        // Flag live on the element rather than re-rendering the row, which would drop focus.
        const err = searchTemplateError(el.value);
        el.classList.toggle('invalid', !!err);
        el.title = err;
      }
    },
  },
];

const listEditor = (id) => LIST_EDITORS.find((e) => e.id === id);

/** Paint one list editor from its current draft (after add/delete/reorder/seed). */
function renderListEditor(id) {
  const spec = listEditor(id);
  const root = document.getElementById(id);
  if (!spec || !root) return;
  root.innerHTML = spec.get().map((row, i) => listRowHtml(i, spec.row(row, i))).join('');
  refreshSettingsDirty();
}

/** Reseed one list editor's draft from the saved config, then paint it. */
function seedListEditor(id) {
  const spec = listEditor(id);
  if (!spec) return;
  spec.set(spec.seed());
  renderListEditor(id);
}

/** Reseed + repaint every list editor (initial render and Discard). */
function renderListEditors() {
  for (const spec of LIST_EDITORS) seedListEditor(spec.id);
}

/** Compact list of command names; click a row to edit it in a popup. Rebuilds the draft
 *  from the saved config each render. */
function renderDBFunctionsEditor() {
  const root = document.getElementById('db-functions-editor');
  if (!root) return;
  const fns = state?.dbFunctions;
  dbFnDraft = {};
  root.innerHTML = '';
  for (const { key, title, prop } of DB_FUNCTIONS) {
    const fn = fns?.[prop];
    dbFnDraft[key] = {
      call: fn?.call || '',
      execution: fn?.execution || 'function',
    };
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'scope-row fn-row';
    row.dataset.fnKey = key;
    row.innerHTML = `<span class="scope-row-name">${escapeHtml(title)}</span>
      <span class="scope-row-labels"><span class="fn-row-exec">${escapeHtml(EXECUTION_LABELS[dbFnDraft[key].execution] || dbFnDraft[key].execution)}</span></span>`;
    root.appendChild(row);
  }
  document.getElementById('batch-concurrency').value = String(state?.batch?.maxConcurrency || 5);
}

/** Compact list of introspection query names; click a row to edit it in the shared popup.
 *  Reseeds the draft from saved config each render. */
function renderDBReadsEditor() {
  const root = document.getElementById('db-reads-editor');
  if (!root) return;
  const reads = state?.dbReads;
  dbReadsDraft = {};
  root.innerHTML = '';
  for (const { key, title, prop } of DB_READS) {
    const rd = reads?.[prop];
    dbReadsDraft[key] = { query: rd?.query || '' };
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'scope-row fn-row';
    row.dataset.readKey = key;
    row.innerHTML = `<span class="scope-row-name">${escapeHtml(title)}</span>
      <span class="scope-row-labels"><span class="fn-row-exec">query</span></span>`;
    root.appendChild(row);
  }
}

/** Placeholder chips for a write op: the closed built-in set in the bare `${name}` form, then a
 *  chip per configured comment field in the `${{key}}` form (create_role / set_comment only).
 *  Deliberately NOT de-duplicated against the built-ins: the two namespaces are disjoint, so a
 *  field keyed `comment` or `loginname` now gets its own chip instead of being silently hidden. */
function fnPlaceholderChips(key, staticNames) {
  const chips = staticNames.map((name) => ({ token: '${' + name + '}', kind: 'builtin' }));
  if (key !== 'create_role' && key !== 'set_comment') return chips;
  for (const f of commentFields()) {
    if (f.key) chips.push({ token: '${{' + f.key + '}}', kind: 'field' });
  }
  return chips;
}

/** Render the clickable placeholder chips. Each carries its WHOLE token, so the click handler
 *  never has to re-derive which namespace it belongs to. */
function renderFnPlaceholders(chips) {
  document.getElementById('fn-placeholder-list').innerHTML = chips
    .map((c, i) => {
      const head =
        c.kind === 'field' && (i === 0 || chips[i - 1].kind !== 'field')
          ? '<span class="ph-group-label">Comment fields</span>'
          : '';
      const cls = c.kind === 'field' ? 'ph-chip ph-chip-field' : 'ph-chip';
      return `${head}<button type="button" class="${cls}" data-token="${escapeAttr(c.token)}">${escapeHtml(c.token)}</button>`;
    })
    .join('');
}

/** Show/hide the execution-mode row — reads have no execution mode, only a query. */
function setFnDialogExecutionRow(show) {
  document.getElementById('fn-execution-row')?.classList.toggle('hidden', !show);
}

/** Open the shared template popup for one operation. `mode` is 'write' (a DB command template:
 *  execution mode + per-op placeholder chips) or 'read' (an introspection query: no execution
 *  mode, one ${rolename} bind). Everything else — title, contract, textarea, Default — is the
 *  same dialog, so the two modes differ only in the three lines below. */
function openTemplateDialog(mode, key) {
  const isRead = mode === 'read';
  const meta = (isRead ? DB_READS : DB_FUNCTIONS).find((e) => e.key === key);
  if (!meta) return;
  fnDialogKey = key;
  fnDialogMode = mode;
  setFnDialogExecutionRow(!isRead);
  document.getElementById('fn-dialog-title').textContent = meta.title;
  const contractEl = document.getElementById('fn-contract');
  if (contractEl) contractEl.textContent = meta.contract || '';
  if (isRead) {
    document.getElementById('fn-call').value = dbReadsDraft[key]?.query || '';
    renderFnPlaceholders([{ token: '${rolename}', kind: 'builtin' }]);
  } else {
    const draft = dbFnDraft[key] || { call: '', execution: 'function' };
    document.getElementById('fn-execution').value = draft.execution;
    document.getElementById('fn-call').value = draft.call;
    renderFnPlaceholders(fnPlaceholderChips(key, meta.placeholders));
  }
  openModal('fn-dialog');
  document.getElementById('fn-call').focus();
}

/** Refresh one command row's execution badge from the draft (without rebuilding the list,
 *  which would reset the draft from saved config). */
function renderDBFunctionsRow(key) {
  const row = document.querySelector(`#db-functions-editor .fn-row[data-fn-key="${key}"]`);
  const d = dbFnDraft[key];
  if (!row || !d) return;
  const execEl = row.querySelector('.fn-row-exec');
  if (execEl) execEl.textContent = EXECUTION_LABELS[d.execution] || d.execution;
}

/** Status state for the Find-role popup's own chip. Independent of `runState`: a search only runs
 *  SearchRoles, while the role-detail load happens later (pickUser → reloadDetails) and owns the
 *  footer chip. Lives and dies with the search dialog. */
let searchState = null;
/** Which state #run-status-dialog is currently showing (`runState` or `searchState`). */
let statusDialogState = null;

// ---- Run status (footer chip + #run-status-dialog) ----
// The chip summarises the current/last batch; clicking it opens a popup with per-cluster
// detail. Populated live from "role-batch-progress" Wails events during a run, then finalised
// from the RunRoleBatch result. Cleared on op-tab / page-tab switch so it never leaks.

/** Reset all run-status UI: no chip, closed popup, cleared inline error. */
function clearRunStatus() {
  runState = null;
  statusDialogState = null;
  document.getElementById('run-status')?.classList.add('hidden');
  closeModal('run-status-dialog');
  clearInlineError(document.getElementById('ops-error'));
}

// A run-status row can hold MORE THAN ONE labeled phase ("segment") — e.g. a create then an
// automatic load — so their per-cluster logs concatenate instead of overwriting. A single-phase
// run (alter/remove/user-load) has one unnamed segment and behaves exactly as before.
function newSegment(name) {
  return { name: name || '', status: '', message: '', durationMs: 0, queries: [] };
}
function currentSegment(row) {
  return row.segments[row.segments.length - 1];
}
/** Overall row status: error if any segment errored, else ok (call only when the row is done). */
function rowStatus(row) {
  return row.segments.some((s) => s.status === 'error') ? 'error' : 'ok';
}
function rowDurationMs(row) {
  return row.segments.reduce((a, s) => a + (s.durationMs || 0), 0);
}
/** Non-empty per-segment messages, name-prefixed when the run has named phases. */
function rowMessage(row) {
  return row.segments
    .filter((s) => s.message)
    .map((s) => (s.name ? s.name + ': ' : '') + s.message)
    .join(' · ');
}
/** True when the row carries named phases (create+load), i.e. the log needs "-- X Role" separators. */
function rowHasNamedPhases(row) {
  return row.segments.length > 1 || !!row.segments[0]?.name;
}
/** Flatten a row's segments into a display query list, each named phase prefixed by "-- <Name> Role". */
function rowQueries(row) {
  const named = rowHasNamedPhases(row);
  const out = [];
  for (const s of row.segments) {
    const hasQueries = s.queries && s.queries.length;
    const hasError = s.status === 'error' && s.message;
    if (!hasQueries && !hasError) continue; // nothing to show for this phase
    if (named && s.name) out.push(`-- ${s.name} Role`);
    if (hasQueries) out.push(...s.queries);
    if (hasError) out.push(`-- ERROR: ${s.message}`); // surface the failure inline in the log
  }
  return out;
}

/** Seed run state from the clusters about to run ([{clusterId, operations}]); each starts queued.
 *  phaseName labels this run's segment ('' for single-phase runs; e.g. 'Create' for role creation). */
function beginRunStatus(clusters, phaseName = '') {
  const byId = new Map();
  const order = [];
  for (const c of clusters || []) {
    const meta = state?.clusters?.find((s) => s.id === c.clusterId) || {};
    byId.set(c.clusterId, {
      alias: meta.alias || c.clusterId,
      host: meta.host || '',
      category: meta.category || '',
      phase: 'queued',
      segments: [newSegment(phaseName)],
    });
    order.push(c.clusterId);
  }
  runState = { total: order.length, order, byId };
  renderRunStatus();
}

/** Append a new labeled phase onto the EXISTING run state (preserving prior segments/logs). Adds
 *  rows for any new clusterId. Does not render — the caller fills the segment then renders. */
function appendRunPhase(clusters, phaseName) {
  if (!runState) {
    beginRunStatus(clusters, phaseName);
    return;
  }
  for (const c of clusters || []) {
    let row = runState.byId.get(c.clusterId);
    if (!row) {
      const meta = state?.clusters?.find((s) => s.id === c.clusterId) || {};
      row = { alias: meta.alias || c.clusterId, host: meta.host || '', category: meta.category || '', phase: 'queued', segments: [] };
      runState.byId.set(c.clusterId, row);
      runState.order.push(c.clusterId);
    }
    row.segments.push(newSegment(phaseName));
    row.phase = 'queued';
  }
  runState.total = runState.order.length;
}

/** Merge one progress event (model.ClusterProgress) into run state. */
function applyRunProgress(ev) {
  if (!runState || !ev) return;
  const row = runState.byId.get(ev.clusterId);
  if (!row) return;
  row.phase = ev.phase || row.phase;
  if (ev.alias) row.alias = ev.alias;
  if (ev.host) row.host = ev.host;
  if (ev.category) row.category = ev.category;
  if (ev.phase === 'done') {
    const seg = currentSegment(row);
    seg.status = ev.status || '';
    seg.message = ev.message || '';
    seg.durationMs = ev.durationMs || 0;
    if (ev.queries) seg.queries = ev.queries;
  }
  renderRunStatus();
}

/** Authoritative final merge from the RunRoleBatch results (in case an event was missed). */
function finishRunStatus(results) {
  if (!runState) beginRunStatus((results || []).map((r) => ({ clusterId: r.clusterId })));
  for (const r of results || []) {
    const row = runState.byId.get(r.clusterId);
    if (!row) continue;
    row.phase = 'done';
    const seg = currentSegment(row);
    seg.status = r.status || '';
    seg.message = r.message || '';
    seg.durationMs = r.durationMs || 0;
    if (r.queries) seg.queries = r.queries;
    if (r.alias) row.alias = r.alias;
    if (r.host) row.host = r.host;
    if (r.category) row.category = r.category;
  }
  renderRunStatus();
}

/** Mark every not-yet-done cluster as errored (batch call failed before/at the backend). */
function failRunStatus(msg) {
  if (!runState) return;
  for (const row of runState.byId.values()) {
    if (row.phase !== 'done') {
      row.phase = 'done';
      const seg = currentSegment(row);
      seg.status = 'error';
      seg.message = msg || 'run failed';
    }
  }
  renderRunStatus();
}

/** Compute the footer-chip summary from runState: { stateClass, text }. Pure (no DOM) so it's unit
 *  testable. While any cluster is still running → "running… (done/total)". When all done: all-ok →
 *  "OK (n clusters)"; a single unnamed phase failing → "Error (x/y failed)"; named phases (e.g.
 *  create+load) → a per-phase breakdown "Create (x/y failed), Load OK (n clusters)". */
function runStatusSummary(rs = runState) {
  const rows = [...rs.byId.values()];
  const done = rows.filter((r) => r.phase === 'done');
  const total = rs.total;
  const clusterWord = (n) => `${n} cluster${n === 1 ? '' : 's'}`;

  if (done.length < total) return { stateClass: 'running', text: `Status: running… (${done.length}/${total})` };
  if (!rows.some((r) => rowStatus(r) !== 'ok')) return { stateClass: 'ok', text: `Status: OK (${clusterWord(total)})` };

  // Phase names present, in first-seen order (empty for a single unnamed phase).
  const phaseNames = [];
  for (const r of rows) for (const s of r.segments) if (s.name && !phaseNames.includes(s.name)) phaseNames.push(s.name);
  if (!phaseNames.length) {
    const failed = rows.filter((r) => rowStatus(r) !== 'ok').length;
    return { stateClass: 'error', text: `Status: Error (${failed}/${total} failed)` };
  }
  const parts = phaseNames.map((name) => {
    let count = 0;
    let failed = 0;
    for (const r of rows) for (const s of r.segments) if (s.name === name) { count++; if (s.status === 'error') failed++; }
    return failed ? `${name} (${failed}/${count} failed)` : `${name} OK (${clusterWord(count)})`;
  });
  return { stateClass: 'error', text: `Status: ${parts.join(', ')}` };
}

/** Paint ONE status chip from ONE state (hidden when the state is null). Shared by the Operations
 *  footer chip and the Find-role popup's chip, which hold independent states. */
function paintStatusChip(chip, rs) {
  if (!chip) return;
  if (!rs) {
    chip.classList.add('hidden');
    return;
  }
  const { stateClass, text } = runStatusSummary(rs);
  chip.classList.remove('hidden', 'running', 'ok', 'error');
  chip.classList.add(stateClass);
  const textEl = chip.querySelector('.run-status-text');
  if (textEl) textEl.textContent = text;
}

/** Refresh the popup table when it is currently showing the given state. */
function refreshStatusDialogFor(rs) {
  const dlg = document.getElementById('run-status-dialog');
  if (dlg?.open && statusDialogState === rs) renderRunStatusDialog();
}

/** Update the Operations footer chip and, if open, the popup table. */
function renderRunStatus() {
  paintStatusChip(document.getElementById('run-status'), runState);
  refreshStatusDialogFor(runState);
}

/** Update the Find-role popup's own chip (independent of the footer's run state). */
function renderSearchStatus() {
  paintStatusChip(document.getElementById('search-status'), searchState);
  refreshStatusDialogFor(searchState);
}

/** Build a finished status state from per-cluster read rows — one unnamed, already-done segment
 *  each. Pure, so it is unit-testable; used by the search (a one-shot read, unlike a batch run
 *  which fills its state incrementally from progress events). */
function buildStatusState(rows) {
  const byId = new Map();
  const order = [];
  for (const r of rows || []) {
    byId.set(r.clusterId, {
      alias: r.alias || r.clusterId,
      host: r.host || '',
      category: r.category || '',
      phase: 'done',
      segments: [{
        name: '',
        status: r.status || '',
        message: r.message || '',
        durationMs: r.durationMs || 0,
        queries: r.queries || [],
      }],
    });
    order.push(r.clusterId);
  }
  return { total: order.length, order, byId };
}

/** Normalize one log line for display/copy: SQL statements get a trailing ';'; a "-- …" comment
 *  separator (e.g. the "-- Create Role" / "-- Load Role" phase markers) is left as-is. */
function formatQueryLine(q) {
  return /^\s*--/.test(q) ? q : q.replace(/;?\s*$/, ';');
}

/** Build the clipboard text for one cluster: its message + every SQL statement it sent. */
function runStatusCopyText(r) {
  const parts = [];
  const msg = rowMessage(r);
  if (msg) parts.push(msg);
  const qs = rowQueries(r).map(formatQueryLine);
  if (qs.length) {
    if (parts.length) parts.push('');
    parts.push('-- queries', ...qs);
  }
  return parts.join('\n');
}

/** Drop the leading "connect to <alias>: " that pg.Connect adds — in a table that already has its
 *  own Cluster column, repeating the alias in the message is the duplication we are removing. The
 *  copy text keeps it, since there the message travels without the column. */
function stripClusterPrefix(message, alias) {
  const prefix = `connect to ${alias}: `;
  return alias && message.startsWith(prefix) ? message.slice(prefix.length) : message;
}

/** Per-cluster Status cell: a single status for an unnamed phase, or "Create: ok · Load: ok" when
 *  the row carries named phases (each status coloured, "—" for a phase with no outcome yet). */
function rowStatusHtml(r) {
  const badge = (st) => `<span class="${st === 'ok' ? 'status-ok' : 'status-error'}">${escapeHtml(st)}</span>`;
  if (!rowHasNamedPhases(r)) return badge(r.segments[0]?.status || '');
  return r.segments
    .map((s) => `${escapeHtml(s.name)}: ${s.status ? badge(s.status) : '—'}`)
    .join(' · ');
}

/** Cluster ids of a status state in display order — group then alias, not the order results
 *  happened to arrive in. Pure, so it is unit-testable; applies to every use of the table. */
function statusRowOrder(rs) {
  return [...(rs?.order || [])].sort((x, y) => byGroupThenAlias(rs.byId.get(x), rs.byId.get(y)));
}

/** Render the per-cluster rows into the popup table for whichever state it is showing. */
function renderRunStatusDialog(rs = statusDialogState) {
  const tbody = document.querySelector('#run-status-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const ids = rs ? statusRowOrder(rs) : [];
  // Message takes the slack; Status/Duration are fixed tracks so the columns don't jump as
  // progress events arrive.
  applyTableColumns('run-status-head', 'run-status-table', [
    { header: 'Cluster', values: ids.map((id) => rs.byId.get(id)?.alias), cap: 24 },
    { header: 'Group', values: ids.map((id) => categoryLabel(rs.byId.get(id)?.category)), cap: 16, chip: true },
    { header: 'Status', min: 10 },
    { header: 'Duration', min: 9 },
    { flex: true }, // Message
    { width: '4.5rem' },
  ]);
  if (!rs) return;
  for (const id of ids) {
    const r = rs.byId.get(id);
    const statusCell =
      r.phase !== 'done'
        ? '<span class="rst-running">running…</span>'
        : rowStatusHtml(r);
    const queries = rowQueries(r);
    const message = rowMessage(r);
    // Magnifier opens the queries popup; copy copies message + queries. Both need a done row.
    const viewCell =
      r.phase === 'done' && queries.length
        ? `<button type="button" class="config-path-copy rst-view" data-cluster-id="${escapeAttr(id)}" title="View executed queries" aria-label="View executed queries">${ICONS.search}</button>`
        : '';
    const copyCell =
      r.phase === 'done' && (message || queries.length)
        ? `<button type="button" class="config-path-copy rst-copy" data-cluster-id="${escapeAttr(id)}" title="Copy message + queries" aria-label="Copy message and queries">${ICONS.copy}</button>`
        : '';
    const tr = document.createElement('tr');
    const shownMessage = stripClusterPrefix(message, r.alias);
    tr.innerHTML = `
      <td title="${escapeAttr(r.alias)}">${escapeHtml(r.alias)}</td>
      <td><span class="badge" data-cat="${escapeAttr(r.category)}">${escapeHtml(categoryLabel(r.category))}</span></td>
      <td>${statusCell}</td>
      <td>${r.phase === 'done' ? rowDurationMs(r) + ' ms' : ''}</td>
      <td title="${escapeAttr(shownMessage)}">${escapeHtml(shownMessage)}</td>
      <td><div class="rst-actions">${viewCell}${copyCell}</div></td>`;
    tbody.appendChild(tr);
  }
  // Wire the per-row action buttons (rows are rebuilt on every render).
  tbody.querySelectorAll('.rst-view').forEach((btn) => {
    btn.addEventListener('click', () => openRunQueriesDialog(btn.dataset.clusterId));
  });
  tbody.querySelectorAll('.rst-copy').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = statusDialogState?.byId.get(btn.dataset.clusterId);
      if (row) copyWithFeedback(btn, runStatusCopyText(row));
    });
  });
}

/** @type {string|null} run-status row backing #run-queries-dialog (null when opened elsewhere) */
let runQueriesClusterId = null;

/** Show a list of executed queries in the larger read-only popup. Shared by the run-status rows
 *  and the pre-flight dependency popup (a <dialog> opens fine on top of another one). */
function showQueriesDialog(title, queries) {
  runQueriesClusterId = null; // no run-status row backs this popup unless the caller sets one
  document.getElementById('run-queries-title').textContent = title;
  const qs = (queries || []).map(formatQueryLine);
  document.getElementById('run-queries-pre').textContent = qs.length ? qs.join('\n\n') : '(no queries)';
  openModal('run-queries-dialog');
}

/** Show all executed queries for one cluster in a larger read-only popup. */
function openRunQueriesDialog(clusterId) {
  const r = statusDialogState?.byId.get(clusterId);
  if (!r) return;
  showQueriesDialog(`Executed queries — ${r.alias}`, rowQueries(r));
  runQueriesClusterId = clusterId; // set AFTER: showQueriesDialog clears it
}

/** Open the shared per-cluster popup for one status state (footer run, or a search). */
function openRunStatusDialog(rs = runState) {
  if (!rs) return;
  statusDialogState = rs;
  renderRunStatusDialog(rs);
  openModal('run-status-dialog');
}

// --- Pre-flight dependency check (runs before any remove_role) ---
// Both removal paths (the red Remove role button and the Present-on editor's pending removals on
// Save changes) first read role_dependencies on every targeted cluster and show the result in
// #deps-dialog. A cluster with dependencies — or one whose check failed — is SKIPPED by default
// and only dropped if the user picks "Try anyway"; a clean cluster is dropped without asking.

/** @type {Array<object>} ClusterRoleDependencies rows, ordered like alterDetails. */
let depsRows = [];
/** @type {Map<string,'skip'|'try'>} per-cluster choice; only clusters that need a decision. */
let depsChoices = new Map();
/** @type {{confirmLabel:string, requireAny:boolean}} how the open dialog behaves. */
let depsOpts = { confirmLabel: 'Remove role', requireAny: false };
/** @type {((v:Set<string>|null)=>void)|null} resolver of the open dialog's promise. */
let depsResolve = null;
/** @type {Array<string>} the clusters the open popup is checking — what Reload re-checks. */
let depsClusterIds = [];
/** True while a (re)load is in flight: spins the reload icon and holds the commit button. */
let depsBusy = false;

/** A cluster needs a per-cluster decision when it reported dependencies, or the check failed. */
function depsNeedsChoice(row) {
  return !!(row.error || (row.dependencies && row.dependencies.length));
}

/** Seed the per-cluster choices: everything that needs a decision defaults to Skip. */
function initialDepsChoices(rows) {
  const m = new Map();
  for (const r of rows || []) if (depsNeedsChoice(r)) m.set(r.clusterId, 'skip');
  return m;
}

/** Synthesize one "could not be checked" row per cluster. Used when the whole read throws, so a
 *  total failure is reported exactly like a per-cluster one instead of vanishing behind the modal. */
function depsErrorRowsFor(clusterIds, msg, known) {
  return (clusterIds || []).map((id) => {
    const d = (known || []).find((x) => x.clusterId === id) || {};
    return {
      clusterId: id,
      alias: d.alias || id,
      host: d.host || '',
      category: d.category || '',
      dependencies: [],
      error: msg,
      // Keep any SQL a previous load reported, so the titlebar magnifier survives a failed reload.
      queries: d.queries || [],
    };
  });
}

/** Carry Skip/Try picks across a reload: a cluster that still needs a decision keeps what was
 *  chosen, a newly flagged one defaults to Skip, and one that came back clean drops out. */
function mergeDepsChoices(rows, prev) {
  const next = initialDepsChoices(rows);
  for (const [id, choice] of prev || []) if (next.has(id)) next.set(id, choice);
  return next;
}

/** Cluster ids to actually drop on: the clean ones, plus those set to "Try anyway". */
function depsAllowedSet(rows = depsRows, choices = depsChoices) {
  const out = new Set();
  for (const r of rows || []) {
    if (!depsNeedsChoice(r) || choices.get(r.clusterId) === 'try') out.add(r.clusterId);
  }
  return out;
}

/** Drop the remove_role-only cluster entries the user chose to skip; every other cluster entry
 *  (and any cluster whose ops are more than a lone removal) is passed through untouched. */
function filterSkippedRemovals(clusters, allowed) {
  return (clusters || []).filter((c) => {
    const removalOnly = c.operations.length === 1 && c.operations[0].operation === 'remove_role';
    return !removalOnly || allowed.has(c.clusterId);
  });
}

/** Which of the three popup sections a cluster belongs to: 0 = clean, 1 = check failed,
 *  2 = has dependencies. Doubles as the section order. */
function depsTier(r) {
  if (r.error) return 1;
  return (r.dependencies || []).length ? 2 : 0;
}

/** Clean clusters first, then the ones that could not be checked, then the ones with
 *  dependencies; inside each section the shared group-then-alias rule. */
function depsSortRows(rows) {
  return (rows || [])
    .slice()
    .sort((a, b) => depsTier(a) - depsTier(b) || byGroupThenAlias(a, b));
}

/** A cluster's label: the filled, group-coloured per-cluster chip used in Present on and the
 *  parent rows (there is no separate alias text or group badge in this popup). */
function depsClusterChip(r) {
  return scopeLabelsHtml([{ kind: 'cluster', cat: r.category, label: r.alias }]);
}

/** The Skip / Try anyway toggle for one cluster (only tiers 1 and 2 get one). */
function depsChoiceHtml(r) {
  const choice = depsChoices.get(r.clusterId) || 'skip';
  return `<div class="segmented deps-choice" role="group" aria-label="Removal on ${escapeAttr(r.alias)}">
      <button type="button" class="seg-btn${choice === 'skip' ? ' active' : ''}" data-choice="skip">Skip</button>
      <button type="button" class="seg-btn${choice === 'try' ? ' active' : ''}" data-choice="try">Try anyway</button>
    </div>`;
}

/** Shared <colgroup> for EVERY dependency table, so the columns line up across clusters: the
 *  three short columns are sized to the widest value across all clusters (capped), and the
 *  trailing bare <col> lets Object absorb the rest. Paired with table-layout: fixed. */
function depsColgroup(rows) {
  const all = (rows || []).flatMap((r) => r.dependencies || []);
  const col = (key, header, cap) => {
    const widest = all.reduce((m, d) => Math.max(m, (d[key] || '').length), header.length);
    // + 1.5rem for the th/td horizontal padding (.75rem each side).
    return `<col style="width:calc(${Math.min(cap, widest)}ch + 1.5rem)">`;
  };
  return `<colgroup>${col('database', 'Database', 28)}${col('dependency', 'Dependency', 20)}${col('class', 'Class', 18)}<col></colgroup>`;
}

/** A section heading, reusing the role form's small-uppercase section label. */
function depsSubhead(text) {
  return `<div class="section-label deps-subhead">${escapeHtml(text)}</div>`;
}

/** Section 1 — clusters with nothing depending on the role: chips only, no per-cluster decision. */
function depsCleanHtml(rows) {
  return `<section class="deps-group">${depsSubhead('No dependencies')}
    <div class="deps-chips">${rows.map(depsClusterChip).join('')}</div></section>`;
}

/** Section 2 — clusters whose check failed: cluster, error, and the Skip/Try decision. */
function depsErrorHtml(rows) {
  const body = rows
    .map(
      (r) => `<tr data-cluster-id="${escapeAttr(r.clusterId)}">
        <td>${depsClusterChip(r)}</td>
        <td class="status-error">${escapeHtml(r.error)}</td>
        <td>${depsChoiceHtml(r)}</td></tr>`
    )
    .join('');
  return `<section class="deps-group">${depsSubhead('Could not be checked')}
    <div class="table-wrap"><table class="deps-error-table">
      <thead><tr><th>Cluster</th><th>Error</th><th></th></tr></thead>
      <tbody>${body}</tbody>
    </table></div></section>`;
}

/** Section 3 — one header line + one table per cluster, all tables sharing depsColgroup. */
function depsFoundHtml(rows) {
  const colgroup = depsColgroup(rows);
  const blocks = rows
    .map((r) => {
      const deps = r.dependencies || [];
      const body = deps
        .map(
          (d) =>
            `<tr><td>${escapeHtml(d.database || '')}</td><td>${escapeHtml(d.dependency || '')}</td><td>${escapeHtml(d.class || '')}</td><td>${escapeHtml(d.object || '')}</td></tr>`
        )
        .join('');
      return `<div class="deps-cluster" data-cluster-id="${escapeAttr(r.clusterId)}">
        <div class="deps-cluster-head">${depsClusterChip(r)}
          <span class="deps-summary">${deps.length} dependenc${deps.length === 1 ? 'y' : 'ies'}</span>
          ${depsChoiceHtml(r)}</div>
        <div class="table-wrap"><table class="deps-table">${colgroup}
          <thead><tr><th>Database</th><th>Dependency</th><th>Class</th><th>Object</th></tr></thead>
          <tbody>${body}</tbody>
        </table></div></div>`;
    })
    .join('');
  return `<section class="deps-group">${depsSubhead('Dependencies found')}${blocks}</section>`;
}

/** Render the popup from depsRows/depsChoices as three ordered sections (empty ones omitted).
 *  The dialog goes wide as soon as any cluster has rows — the Object column carries full
 *  function/table identifiers. */
function renderDepsDialog() {
  const list = document.getElementById('deps-list');
  if (!list) return;
  const tiers = [0, 1, 2].map((t) => depsRows.filter((r) => depsTier(r) === t));
  document.getElementById('deps-dialog')?.classList.toggle('wide', tiers[2].length > 0);
  list.innerHTML = [
    tiers[0].length ? depsCleanHtml(tiers[0]) : '',
    tiers[1].length ? depsErrorHtml(tiers[1]) : '',
    tiers[2].length ? depsFoundHtml(tiers[2]) : '',
  ].join('');
  // Re-check the same clusters in place — the icon spins while the read is in flight.
  const reload = document.getElementById('deps-reload');
  if (reload) {
    reload.innerHTML = ICONS.refresh;
    reload.disabled = depsBusy;
    reload.classList.toggle('busy', depsBusy);
  }
  // Every cluster runs the SAME query (one configured read, one role name), so one magnifier in
  // the titlebar covers them all.
  const view = document.getElementById('deps-view-sql');
  if (view) {
    const queries = depsRows.find((r) => (r.queries || []).length)?.queries || [];
    view.innerHTML = ICONS.search;
    view.classList.toggle('hidden', !queries.length);
  }
  const ok = document.getElementById('deps-ok');
  if (!ok) return;
  ok.textContent = depsOpts.confirmLabel;
  // Nothing left to remove (every cluster skipped) ⇒ the commit button goes inert, like every
  // other "disabled when there is nothing to do" button in the app.
  ok.disabled = depsBusy || (depsOpts.requireAny && depsAllowedSet().size === 0);
}

/** Close the popup and resolve its promise (null = cancelled). */
function closeDepsDialog(result) {
  closeModal('deps-dialog');
  const resolve = depsResolve;
  depsResolve = null;
  resolve?.(result);
}

/** Read role_dependencies for clusterIds into depsRows/depsChoices. Results come back in
 *  completion order, so they are re-grouped into the three popup sections. A thrown call becomes
 *  one "could not be checked" row per cluster: the popup is the only visible surface once it is
 *  open (an #ops-error would render behind the modal), and it keeps the safe default — every
 *  cluster on Skip, so a role that could not be checked still is not dropped. */
async function loadDepsRows(clusterIds, { keepChoices = false } = {}) {
  let rows;
  try {
    rows = await backend().LoadRoleDependencies({
      loginName: alterSelected,
      categoryIds: [],
      clusterIds,
      auth: getAuth(),
    });
  } catch (e) {
    console.error('dependency check failed', e);
    rows = depsErrorRowsFor(clusterIds, String(e), depsRows.length ? depsRows : alterDetails);
  }
  depsRows = depsSortRows(rows);
  depsChoices = keepChoices ? mergeDepsChoices(depsRows, depsChoices) : initialDepsChoices(depsRows);
}

/** Re-run the check on the same clusters, in place, keeping the picks that still apply — for when
 *  the user has just gone and fixed the dependencies elsewhere. */
async function reloadDeps() {
  if (depsBusy || !depsClusterIds.length) return;
  depsBusy = true;
  renderDepsDialog(); // paint the busy state (spinning icon, commit held)
  try {
    await loadDepsRows(depsClusterIds, { keepChoices: true });
  } finally {
    depsBusy = false;
    renderDepsDialog();
  }
}

/** Run the dependency check on clusterIds and let the user decide per cluster.
 *  @returns {Promise<Set<string>|null>} cluster ids to drop on, or null when cancelled. */
async function preflightRemoval(clusterIds, { confirmLabel = 'Remove role', requireAny = false } = {}) {
  if (!requireBackend(document.getElementById('ops-error'))) return null;
  if (!clusterIds.length) return new Set();
  depsClusterIds = clusterIds.slice();
  depsOpts = { confirmLabel, requireAny };
  await loadDepsRows(clusterIds);
  renderDepsDialog();
  return new Promise((resolve) => {
    depsResolve = resolve;
    openModal('deps-dialog');
  });
}

function renderAll() {
  renderCategoryColors();
  renderClustersTable();
  renderCategoryCheckboxes();
  renderClusterCheckboxes();
  renderGroupsTable();
  renderDBFunctionsEditor();
  renderDBReadsEditor();
  renderListEditors();
  updateTargetPreview();
  refreshSettingsDirty();
}

function getSelectedCategories() {
  return [...document.querySelectorAll('#category-checkboxes input:checked')].map((el) => el.value);
}

function getSelectedClusterIDs() {
  return [...document.querySelectorAll('#cluster-checkboxes input:checked')].map((el) => el.value);
}

function getAuth() {
  // Connection controls were removed from the UI; run-time auth resolves from cluster
  // connect_user / PGUSER / PGPASSWORD / ~/.pgpass on the backend.
  return { user: '', password: '' };
}

async function updateTargetPreview() {
  const app = backend();
  const preview = document.getElementById('target-preview');
  // Create mode: the universe is the selected clusters, so rebuild the synthetic baseline
  // (and drop pending edits on deselected clusters) whenever the selection changes.
  if (isCreateMode()) {
    synthCreateBaseline();
    reconcilePendingWithUniverse();
    renderAlterDetail();
  } else if (alterSelected && (alterScopeClusters.length || alterDetails.length)) {
    // Alter mode with a role loaded: the sidebar is live — re-scope the form (debounced).
    scheduleAlterScopeChange();
  }
  if (!app || !state) {
    preview.textContent = '';
    return;
  }
  try {
    const targets = await app.PreviewTargets({
      operation: currentOp,
      categoryIds: getSelectedCategories(),
      clusterIds: getSelectedClusterIDs(),
      auth: getAuth(),
      confirmProduction: true,
    });
    preview.textContent = `${targets.length} cluster(s) will be targeted.`;
  } catch (e) {
    preview.textContent = String(e);
  }
}

/** Debounce the Alter-mode live re-scope so rapid checkbox toggles coalesce into one run. */
function scheduleAlterScopeChange() {
  clearTimeout(alterScopeTimer);
  alterScopeTimer = setTimeout(() => { applyAlterScopeChange(); }, 300);
}

/** Alias for a clusterId, best-effort across scope / details / saved clusters. */
function aliasOf(id) {
  const c = alterScopeClusters.find((x) => x.clusterId === id)
    || alterDetails.find((d) => d.clusterId === id)
    || (state?.clusters || []).find((x) => x.id === id);
  return c?.alias || id;
}

/** Does the given cluster carry any unsaved staged edit (so removing it would lose work)? */
function clusterHasStagedEdits(id) {
  const inMap = (m) => { for (const ids of m.values()) if (ids.has(id)) return true; return false; };
  return inMap(alterAdd) || inMap(alterRevoke) || inMap(alterAttrAdd) || inMap(alterAttrRemove)
    || inMap(alterConfigSet) || inMap(alterConfigReset)
    || roleRemoveClusters.has(id) || commentOverrides.has(id)
    || alterDetails.some((d) => d.clusterId === id && !d.exists); // pending create row
}

/** Restore the sidebar checkboxes to the selection that matches the current Alter scope. */
function revertAlterSelection() {
  selectedCategoryIds = new Set(alterAppliedSelection.categoryIds);
  selectedClusterIds = new Set(alterAppliedSelection.clusterIds);
  renderCategoryCheckboxes();
  renderClusterCheckboxes();
}

/** Alter mode: bring the loaded form in line with the live Target selection. Adds trigger a
 *  data lookup on just the new clusters; removals drop rows (confirming first if they carry
 *  staged edits). Edits on surviving clusters are kept (all maps are keyed by clusterId).
 *  Sidebar-remove means "stop targeting" — it does NOT enqueue a remove_role (that's Present on). */
async function applyAlterScopeChange() {
  if (alterScopeBusy) { scheduleAlterScopeChange(); return; }
  const opsErr = document.getElementById('ops-error');
  const newClusters = resolveSelectedClusters();
  const newIds = new Set(newClusters.map((c) => c.id));
  if (!newIds.size) {
    showInlineError(opsErr, 'Select at least one target cluster.');
    revertAlterSelection();
    return;
  }
  const scopeIds = new Set(alterScopeClusters.map((c) => c.clusterId));
  const removed = [...scopeIds].filter((id) => !newIds.has(id));
  const added = [...newIds].filter((id) => !scopeIds.has(id));
  if (!removed.length && !added.length) return;

  const removedWithEdits = removed.filter(clusterHasStagedEdits);
  if (removedWithEdits.length) {
    const aliases = removedWithEdits.map(aliasOf).join(', ');
    const one = removedWithEdits.length === 1;
    const ok = await askConfirm(
      'Discard staged changes?',
      `Removing ${aliases} from the targets discards the change${one ? '' : 's'} you staged on ${one ? 'it' : 'them'}. Changes on the other clusters are kept. Continue?`
    );
    if (!ok) { revertAlterSelection(); return; }
  }
  clearInlineError(opsErr);

  alterScopeBusy = true;
  try {
    if (removed.length) {
      const rm = new Set(removed);
      alterScopeClusters = alterScopeClusters.filter((c) => !rm.has(c.clusterId));
      alterDetails = alterDetails.filter((d) => !rm.has(d.clusterId));
      for (const id of removed) { roleRemoveClusters.delete(id); commentOverrides.delete(id); }
    }
    if (added.length) {
      const app = backend();
      let details = [];
      try {
        details = (await app.LoadRoleDetails({
          loginName: alterSelected, categoryIds: [], clusterIds: added, auth: getAuth(),
        })) || [];
      } catch (e) {
        showInlineError(opsErr, e);
      }
      const meta = new Map(newClusters.map((c) => [c.id, c]));
      for (const d of details) {
        const m = meta.get(d.clusterId) || {};
        if (!alterScopeClusters.some((c) => c.clusterId === d.clusterId)) {
          alterScopeClusters.push({ clusterId: d.clusterId, alias: d.alias || m.alias, category: d.category || m.category });
        }
        if (d.error) continue; // unreachable → in scope, no row (reported in the chip)
        if (d.exists) {
          alterDetails.push(d); // real baseline row
        } else if (stageCreateOnAdd()) {
          // Role absent + setting on → stage a create (synthetic exists:false row, like Present on).
          alterDetails.push({ clusterId: d.clusterId, alias: d.alias || m.alias, category: d.category || m.category, exists: false, comment: '', parents: [], attributes: {}, settings: {} });
        }
        // Role absent + setting off → scope only (offered in Present on ✎), no row.
      }
      // Show the added clusters' load status in the run-status chip.
      reportRoleLoad({ valid: details.filter((d) => !d.error), errors: details.filter((d) => d.error) });
    }
    alterTargets = { categoryIds: getSelectedCategories(), clusterIds: getSelectedClusterIDs() };
    alterAppliedSelection = { categoryIds: new Set(selectedCategoryIds), clusterIds: new Set(selectedClusterIds) };
    reconcilePendingWithUniverse();
    loadCommentEditor();
    renderAlterDetail();
    updateOpsFooter();
  } finally {
    alterScopeBusy = false;
  }
}

function fillCategorySelect(select) {
  select.innerHTML = '';
  for (const cat of categoriesDraft || []) {
    const opt = document.createElement('option');
    opt.value = cat.id;
    opt.textContent = cat.label;
    select.appendChild(opt);
  }
}

function openClusterDialog(cluster) {
  const dlg = document.getElementById('cluster-dialog');
  const form = document.getElementById('cluster-form');
  document.getElementById('cluster-dialog-title').textContent = cluster ? 'Edit cluster' : 'Add cluster';
  fillCategorySelect(form.category);
  form.id.value = cluster?.id || '';
  form.alias.value = cluster?.alias || '';
  form.host.value = cluster?.host || '';
  form.port.value = cluster?.port || 5432;
  form.database.value = cluster?.database || '';
  form.category.value = cluster?.category || 'uat';
  form.sslMode.value = cluster?.sslmode || 'prefer';
  form.connectUser.value = cluster?.connectUser || '';
  form.password.value = cluster?.password || '';
  // Reset the password field to masked each time the dialog opens.
  form.password.type = 'password';
  const pwToggle = form.querySelector('.pw-toggle');
  if (pwToggle) setPwToggle(pwToggle, false);
  // Reset any leftover test result.
  const errEl = document.getElementById('cluster-test-error');
  errEl.classList.add('hidden');
  errEl.textContent = '';
  resetFlash(document.getElementById('btn-test-cluster'));
  openModal(dlg);
}

function clusterInputFromForm(form) {
  return {
    alias: form.alias.value.trim(),
    host: form.host.value.trim(),
    port: parseInt(form.port.value, 10) || 5432,
    database: form.database.value.trim(),
    category: form.category.value,
    sslMode: form.sslMode.value,
    connectUser: form.connectUser.value.trim(),
    // Not trimmed — a password may legitimately contain leading/trailing spaces.
    password: form.password.value,
  };
}

async function onClusterAction(ev) {
  const btn = ev.currentTarget;
  const id = btn.dataset.id;
  const action = btn.dataset.action;
  const cluster = clustersDraft?.find((c) => c.id === id);

  if (action === 'edit') {
    openClusterDialog(cluster);
    return;
  }
  if (action === 'delete') {
    const ok = await askConfirm('Delete cluster', `Delete cluster "${cluster?.alias}"? (applied on Save)`);
    if (!ok) return;
    clustersDraft = clustersDraft.filter((c) => c.id !== id); // staged; persisted on Save
    renderClustersTable();
    return;
  }
}

/** Preconfigured role parents defined in Settings. */
function preconfiguredParentRoles() {
  return state?.parentRoles || [];
}


/** Create-role parent universe = the clusters covered by the sidebar target selection. */
/** Read the shared login input. Full name / email now live in the comment editor. */
function roleIdentityInputs() {
  return {
    loginName: document.getElementById('role-login')?.value.trim() || '',
  };
}

/** Build per-cluster ops for Create: create_role first, then that cluster's alter diff
 *  (parents/attributes/settings/password/comment) from buildAlterClusterOps. create_role's
 *  ${parent_roles} carries the SAME per-cluster parents as that cluster's grant_parents op, so a
 *  create_role template that grants at creation gets them (the follow-up grant_parents still runs —
 *  re-granting an existing membership is a harmless NOTICE in PostgreSQL). The comment-field
 *  placeholders come from the same comment the follow-up set_comment writes. */
function buildCreateClusterOps(base) {
  const alterByCluster = new Map(buildAlterClusterOps().map((c) => [c.clusterId, c.operations]));
  const fields = commentFieldArgs(assembleComment());
  return resolveSelectedClusters().map((c) => {
    const alterOps = alterByCluster.get(c.id) || [];
    const grant = alterOps.find((o) => o.operation === 'grant_parents');
    return {
      clusterId: c.id,
      operations: [
        {
          operation: 'create_role',
          createRole: {
            loginName: base.loginName,
            parentRoles: grant ? grant.grantParents.parentRoles : '',
            commentFields: fields,
          },
        },
        ...alterOps,
      ],
    };
  });
}

async function runOperation() {
  const errEl = document.getElementById('ops-error');
  const btn = document.getElementById('btn-run');
  clearInlineError(errEl);
  const app = requireBackend(errEl, btn);
  if (!app) return;
  if (!isCreateMode()) return;

  const base = roleIdentityInputs();
  if (!base.loginName || !ROLE_NAME_RE.test(base.loginName)) {
    showInlineError(errEl, 'Enter a login name (no commas)');
    flashButton(btn, { cls: 'flash-err' });
    return;
  }
  const clusters = resolveSelectedClusters();
  if (!clusters.length) {
    showInlineError(errEl, 'Select at least one group or cluster');
    flashButton(btn, { cls: 'flash-err' });
    return;
  }
  alterSelected = base.loginName; // buildAlterClusterOps keys its ops on this login

  // Pre-flight: warn if the role already exists on any selected cluster (create would error).
  try {
    const found = await app.LoadRoleDetails({
      loginName: base.loginName,
      categoryIds: getSelectedCategories(),
      clusterIds: getSelectedClusterIDs(),
      auth: getAuth(),
    });
    const present = (found || []).filter((d) => d.exists).map((d) => d.alias);
    if (present.length) {
      const ok = await askConfirm(
        'Role exists',
        `"${base.loginName}" already exists on ${present.join(', ')}. create_role will error there. Continue anyway?`
      );
      if (!ok) return;
    }
  } catch {
    /* pre-flight is best-effort; per-cluster errors will still surface on run */
  }

  // Per cluster: create_role first, then the grant/attr/setting/password/comment diff — all
  // run as one transaction on the backend.
  const clusterBatch = buildCreateClusterOps(base);
  warnIfPlainTextComment(clusterBatch);
  const results = await executeRoleBatch(clusterBatch, 'Role created', 'Create');
  if (!results) return; // blocked/cancelled/threw — leave the form untouched
  // All clusters failed → stay in Create so the user can fix and retry; the chip shows the errors.
  if (!results.some((r) => r.status === 'ok')) return;
  // At least one cluster succeeded → hand off to the Alter form with the new role loaded over all
  // originally-selected clusters (failed ones show as "not present" and are retryable via Save). The
  // load appends a "Load" phase to the run-status log rather than overwriting the "Create" log.
  flashButton(btn, { text: 'Created', cls: 'flash-ok' });
  await enterAlterAfterCreate(base.loginName);
}

/** Post-create hand-off: switch the shared role form into Alter mode with `login` loaded over the
 *  current sidebar selection, WITHOUT clearing the run-status chip (so the create log survives and
 *  the load appends to it). Mirrors what runRoleSearch + pickUser set up, minus the search dialog. */
async function enterAlterAfterCreate(login) {
  currentOp = 'alter_user';
  document.querySelectorAll('.op-tab').forEach((t) => t.classList.toggle('active', t.dataset.op === 'alter_user'));
  document.getElementById('alter-current-hint')?.classList.add('hidden');
  document.getElementById('alter-detail')?.classList.remove('hidden');

  alterSelected = login;
  const categoryIds = getSelectedCategories();
  const clusterIds = getSelectedClusterIDs();
  alterTargets = { categoryIds, clusterIds };
  alterScopeClusters = resolveSelectedClusters().map((c) => ({ clusterId: c.id, alias: c.alias, category: c.category }));
  alterAppliedSelection = { categoryIds: new Set(categoryIds), clusterIds: new Set(clusterIds) };
  resetEditMaps();

  await reloadDetails({ appendLog: true });
  updateOpsFooter();
}

/** Update the inline Status cell for a cluster row on the Clusters page. */
function setClusterStatus(id, status, message) {
  const cell = [...document.querySelectorAll('#clusters-table td.cluster-status')]
    .find((td) => td.dataset.statusFor === id);
  if (!cell) return;
  const cls = status === 'ok' ? 'status-ok' : status === 'error' ? 'status-error' : 'status-pending';
  cell.className = `cluster-status ${cls}`;
  cell.textContent = message;
  cell.title = message;
}

/** Test every configured cluster and show the result inline in the table. */
async function testAllClusters() {
  const errEl = document.getElementById('clusters-error');
  const btn = document.getElementById('btn-test-clusters');
  clearInlineError(errEl);
  const app = requireBackend(errEl, btn);
  if (!app) return;
  const clusters = clustersDraft || []; // test the on-screen (possibly unsaved) values
  if (!clusters.length) {
    showInlineError(errEl, 'No clusters configured');
    flashButton(btn, { cls: 'flash-err' });
    return;
  }
  if (btn) btn.disabled = true;
  clusters.forEach((c) => setClusterStatus(c.id, 'pending', 'testing…'));
  let ok = 0;
  let failed = 0;
  for (const c of clusters) {
    const input = {
      alias: c.alias, host: c.host, port: c.port, database: c.database,
      category: c.category, sslMode: c.sslmode, connectUser: c.connectUser,
      password: c.password || '',
    };
    try {
      await app.TestConnectionInput(input, { user: c.connectUser || '', password: '' });
      setClusterStatus(c.id, 'ok', 'connected');
      ok += 1;
    } catch (e) {
      setClusterStatus(c.id, 'error', String(e));
      failed += 1;
    }
  }
  if (btn) btn.disabled = false;
  // Per-row Status column carries the detail; the button flash summarises pass/fail.
  flashButton(btn, failed ? { cls: 'flash-err' } : { cls: 'flash-ok' });
}

// The draft and the saved baseline must normalize IDENTICALLY or the dirty check never settles,
// so each pair is one function over a `source(entry) -> raw` lookup rather than two that have to
// be kept in step by hand.
function collectDBFunctions(source) {
  const out = {};
  for (const { key, prop } of DB_FUNCTIONS) {
    const fn = source(key, prop) || {};
    out[prop] = { call: (fn.call || '').trim(), execution: fn.execution || 'function' };
  }
  return out;
}
function collectDBReads(source) {
  const out = {};
  for (const { key, prop } of DB_READS) {
    out[prop] = { query: ((source(key, prop) || {}).query || '').trim() };
  }
  return out;
}

const readDBFunctionsFromEditor = () => collectDBFunctions((key) => dbFnDraft[key]);
const savedDBFunctions = () => collectDBFunctions((key, prop) => state?.dbFunctions?.[prop]);
const readDBReadsFromEditor = () => collectDBReads((key) => dbReadsDraft[key]);
const savedDBReads = () => collectDBReads((key, prop) => state?.dbReads?.[prop]);

/** Search columns as the backend will store them: trimmed, blank-template rows dropped. Must
 *  match config.validateSearchColumns, or Save leaves the button dirty. */
function readSearchColumnsFromEditor() {
  return searchColumnsDraft
    .map((c) => ({ label: (c.label || '').trim(), template: (c.template || '').trim() }))
    .filter((c) => c.template);
}

/** Saved search-columns baseline, normalized the same way readSearchColumnsFromEditor produces. */
function savedSearchColumns() {
  return (state?.searchColumns || []).map((c) => ({ label: c.label || '', template: c.template || '' }));
}

/** True when any Settings control/draft differs from the saved config (`state`). */
function settingsDirty() {
  if (!state) return false;
  if (currentThemePref() !== (state.ui?.theme || 'system')) return true;
  if (currentCommentViewPref() !== (state.ui?.commentDefaultView || 'raw')) return true;
  if (currentStageCreateOnAdd() !== !!state.ui?.stageCreateOnTargetAdd) return true;
  if (currentSuppressMD5Warning() !== !!state.ui?.suppressMd5RenameWarning) return true;
  if (currentCheckForUpdates() !== autoCheckUpdates()) return true;
  if (JSON.stringify(currentPasswordGen()) !== JSON.stringify(state.ui?.passwordGen || DEFAULT_PASSWORD_GEN)) return true;
  const conc = parseInt(document.getElementById('batch-concurrency')?.value, 10) || 5;
  if (conc !== (state.batch?.maxConcurrency || 5)) return true;
  const pr = parentRolesDraft.map((r) => r.trim()).filter(Boolean);
  if (JSON.stringify(pr) !== JSON.stringify(state.parentRoles || [])) return true;
  const cf = commentFieldsDraft.map((f) => ({ key: f.key.trim(), label: f.label.trim() })).filter((f) => f.key);
  // No default baseline: removing every field is a real change, like clearing search columns.
  const savedCf = (state.commentFields || []).map((f) => ({ key: f.key, label: f.label }));
  if (JSON.stringify(cf) !== JSON.stringify(savedCf)) return true;
  if (JSON.stringify(readSearchColumnsFromEditor()) !== JSON.stringify(savedSearchColumns())) return true;
  if (JSON.stringify(readDBFunctionsFromEditor()) !== JSON.stringify(savedDBFunctions())) return true;
  if (JSON.stringify(readDBReadsFromEditor()) !== JSON.stringify(savedDBReads())) return true;
  return false;
}

function refreshSettingsDirty() {
  const dirty = settingsDirty();
  setDirty(document.getElementById('btn-save-settings'), dirty);
  setDirty(document.getElementById('btn-discard-settings'), dirty); // Discard is inert when clean too
}

/** Revert all Settings controls/drafts back to the saved config. */
function discardSettings() {
  setThemeButtons(state?.ui?.theme || 'system');
  applyTheme(state?.ui?.theme || 'system');
  setCommentViewButtons(state?.ui?.commentDefaultView || 'raw');
  { const c = document.getElementById('ui-stage-create'); if (c) c.checked = !!state?.ui?.stageCreateOnTargetAdd; }
  { const c = document.getElementById('ui-suppress-md5'); if (c) c.checked = !!state?.ui?.suppressMd5RenameWarning; }
  { const c = document.getElementById('ui-check-updates'); if (c) c.checked = autoCheckUpdates(); }
  setPasswordGenControls(state?.ui?.passwordGen);
  document.getElementById('batch-concurrency').value = String(state?.batch?.maxConcurrency || 5);
  renderDBFunctionsEditor(); // these reseed their drafts from saved `state`
  renderDBReadsEditor();
  renderListEditors();
  clearInlineError(document.getElementById('settings-error'));
  refreshSettingsDirty();
}

/** Persist the whole staged clusters+categories set at once. */
async function saveClusters() {
  const errEl = document.getElementById('clusters-error');
  const btn = document.getElementById('btn-save-clusters');
  clearInlineError(errEl);
  const app = requireBackend(errEl, btn);
  if (!app) return;
  const payload = {
    clusters: (clustersDraft || []).map((c) => ({ ...c, id: String(c.id).startsWith('tmp_') ? '' : c.id })),
    categories: (categoriesDraft || []).map((c) => ({ ...c })),
  };
  try {
    await app.SaveClusters(payload);
    clustersDraft = null; // force reseed from fresh saved state
    categoriesDraft = null;
    await loadConfig();
    flashButton(btn, { text: 'Saved', cls: 'flash-ok' });
  } catch (e) {
    showInlineError(errEl, e);
    flashButton(btn, { cls: 'flash-err' });
  }
}

/** Revert staged cluster/group edits back to the saved config. */
function discardClusters() {
  resetClusterDrafts();
  clearInlineError(document.getElementById('clusters-error'));
  renderClustersTable();
  renderGroupsTable();
  refreshClustersDirty();
}

async function saveSettings() {
  const app = backend();
  const btn = document.getElementById('btn-save-settings');
  const errEl = document.getElementById('settings-error');
  clearInlineError(errEl);
  // Which ROW is wrong is information the backend error cannot carry, so check here first.
  const cols = readSearchColumnsFromEditor();
  for (let i = 0; i < cols.length; i++) {
    const err = searchTemplateError(cols[i].template);
    if (err) {
      showInlineError(errEl, `Role Details column ${i + 1} (${cols[i].label || 'no label'}): ${err}`);
      flashButton(btn, { cls: 'flash-err' });
      return;
    }
  }
  try {
    // ONE atomic call: the backend validates everything before writing anything, so a rejected
    // template can't leave the role parents / comment fields already persisted. It also removes
    // the old ordering constraint — templates are validated against the comment fields in this
    // same payload, so adding a field and using it as ${{key}} in one save just works.
    await app.SaveSettings({
      parentRoles: parentRolesDraft.map((r) => r.trim()).filter(Boolean),
      commentFields: commentFieldsDraft
        .map((f) => ({ key: f.key.trim(), label: f.label.trim() }))
        .filter((f) => f.key),
      searchColumns: cols,
      dbFunctions: readDBFunctionsFromEditor(),
      dbReads: readDBReadsFromEditor(),
      batch: { maxConcurrency: parseInt(document.getElementById('batch-concurrency').value, 10) || 5 },
      ui: {
        theme: currentThemePref(),
        commentDefaultView: currentCommentViewPref(),
        stageCreateOnTargetAdd: currentStageCreateOnAdd(),
        suppressMd5RenameWarning: currentSuppressMD5Warning(),
        checkForUpdates: currentCheckForUpdates(),
        passwordGen: currentPasswordGen(),
      },
    });
    await loadConfig(); // reseeds drafts + controls → clean
    refreshSettingsDirty(); // now clean ⇒ disabled
    flashButton(btn, { text: 'Saved', cls: 'flash-ok' });
  } catch (e) {
    showInlineError(errEl, e);
    flashButton(btn, { cls: 'flash-err' });
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

// --------------------------------------------------------------------------
// Inline SVG icons — one home for every glyph in the UI, so buttons render
// identically across platforms (the old Unicode glyphs varied on macOS/Windows).
// Each icon uses `currentColor` (inherits the button's colour + opacity); size
// comes from CSS (`.ic`, or a container rule like `.pw-toggle svg`). `aria-hidden`
// keeps them out of the accessibility tree — the enclosing button's aria-label
// names the action. Stroke geometry from Feather/Lucide (MIT).
//
// `svgIcon(body, {cls, viewBox, w})`: `w` = stroke width. Icons carry NO width/height —
// every container sizes its glyph in rem from styles.css, so icons scale with the root
// font-size instead of pinning themselves to a pixel count that drifts out of step.
const svgIcon = (body, { cls = '', viewBox = '0 0 24 24', w = 2 } = {}) => {
  return (
    `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="${viewBox}" fill="none" ` +
    `stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true" focusable="false">${body}</svg>`
  );
};
const ICONS = {
  // Row / list action icons (sized in rem via `.scope-act .ic` / `.le-del .ic`).
  edit: svgIcon(
    '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    { cls: 'ic-edit' },
  ),
  remove: svgIcon('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', { cls: 'ic-remove' }),
  discard: svgIcon('<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>', { cls: 'ic-discard' }),
  // Password field: reveal eye / eye-off, copy, generate (sized via container CSS).
  eye: svgIcon('<path d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12Z"/><circle cx="12" cy="12" r="3.2"/>', { cls: 'ic-eye', w: 1.8 }),
  eyeOff: svgIcon(
    '<path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c7 0 10.5 8 10.5 8a18.6 18.6 0 0 1-2.16 3.19M6.06 6.06A18.5 18.5 0 0 0 1.5 12S5 20 12 20a10 10 0 0 0 5.94-1.94"/><path d="M9.88 9.88a3 3 0 0 0 4.24 4.24"/><line x1="2" y1="2" x2="22" y2="22"/>',
    { cls: 'ic-eye', w: 1.8 },
  ),
  gen: svgIcon('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>', { cls: 'ic-gen' }),
  // Small 16-grid icons with an explicit px size (used in run-status / copy buttons).
  copy: svgIcon('<rect x="5" y="1" width="10" height="11" rx="2"/><rect x="1" y="4" width="10" height="11" rx="2"/>', { cls: 'ic-copy', viewBox: '0 0 16 16', w: 1.5 }),
  check: svgIcon('<polyline points="2,8 6,13 14,3"/>', { cls: 'ic-check', viewBox: '0 0 16 16', w: 2.5 }),
  search: svgIcon('<circle cx="7" cy="7" r="5"/><line x1="10.5" y1="10.5" x2="15" y2="15"/>', { cls: 'ic-search', viewBox: '0 0 16 16', w: 1.5 }),
  // refresh-cw on the 16 grid, so it matches `search` where the two sit side by side (the 24-grid
  // `gen` is the same shape but belongs to the password generator).
  refresh: svgIcon('<polyline points="14 2.5 14 6 10.5 6"/><polyline points="2 13.5 2 10 5.5 10"/><path d="M3.13 6a5.5 5.5 0 0 1 9.08-2.05L14 6M2 10l1.79 1.95A5.5 5.5 0 0 0 12.87 10"/>', { cls: 'ic-refresh', viewBox: '0 0 16 16', w: 1.5 }),
  // Standalone amber warning (the .q-warn hint badge has no circle chrome, so a triangle fits).
  warn: svgIcon('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13.5"/><line x1="12" y1="16.5" x2="12.01" y2="16.5"/>', { cls: 'ic-warn' }),
};

// ------------------------------------------------------------------
// "?" help badges — hide a feature description behind a hover/focus popover.
// ------------------------------------------------------------------

/** Markup for a "?" badge whose hover popover shows `text`. */
function hintBadge(text) {
  return `<button type="button" class="q-hint" aria-label="${escapeAttr(text)}" data-hint="${escapeAttr(text)}">?</button>`;
}

/** @type {HTMLDivElement | null} */
let qHintPop = null;

function positionQHint(btn) {
  const text = btn.dataset.hint || '';
  if (!text) return;
  // Single source of truth: static badges (index.html) carry only data-hint. The badge's
  // visible content is just a "?" glyph or an SVG icon, so mirror the hint into aria-label
  // as its accessible name.
  if (!btn.getAttribute('aria-label')) btn.setAttribute('aria-label', text);
  if (!qHintPop) {
    qHintPop = document.createElement('div');
    qHintPop.className = 'q-hint-pop';
    qHintPop.setAttribute('role', 'tooltip');
  }
  // A modal <dialog> renders in the browser top layer, above any z-index; when the
  // badge lives in one, host the popover inside it so it isn't drawn under the dialog.
  const host = btn.closest('dialog[open]') || document.body;
  if (qHintPop.parentElement !== host) host.appendChild(qHintPop);
  qHintPop.textContent = text;
  qHintPop.hidden = false;
  const m = 8; // viewport margin
  const r = btn.getBoundingClientRect();
  const pw = qHintPop.offsetWidth;
  const ph = qHintPop.offsetHeight;
  // Centre on the badge, clamped inside the viewport.
  const left = Math.max(m, Math.min(r.left + r.width / 2 - pw / 2, window.innerWidth - pw - m));
  // Prefer below the badge; flip above if it would overflow the bottom edge.
  let top = r.bottom + 6;
  if (top + ph > window.innerHeight - m) top = r.top - ph - 6;
  if (top < m) top = m;
  qHintPop.style.left = `${left}px`;
  qHintPop.style.top = `${top}px`;
}

function hideQHint() {
  if (qHintPop) qHintPop.hidden = true;
}

// Delegated so badges rendered later (e.g. the Alter-role detail) work too.
// Mouse: reveal on hover. Keyboard: badges stay Tab-reachable but do NOT open just from
// focus landing on them (that flashed the tooltip while tabbing past) — they open only on
// an explicit Enter/Space press (toggle), and close on blur or Escape.
document.addEventListener('mouseover', (e) => {
  const btn = e.target.closest?.('.q-hint');
  if (btn) positionQHint(btn);
});
document.addEventListener('mouseout', (e) => {
  if (e.target.closest?.('.q-hint')) hideQHint();
});
document.addEventListener('keydown', (e) => {
  const btn = e.target.closest?.('.q-hint');
  if (!btn) return;
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault(); // don't scroll on Space; the badge has no click action of its own
    if (qHintPop && !qHintPop.hidden) hideQHint();
    else positionQHint(btn);
  } else if (e.key === 'Escape') {
    hideQHint();
  }
});
document.addEventListener('focusout', (e) => {
  if (e.target.closest?.('.q-hint')) hideQHint();
});

// Mirror data-hint → aria-label for static badges up front, so assistive tech has an
// accessible name before the first hover (positionQHint also does this lazily on interaction).
function syncQHintLabels(root = document) {
  root.querySelectorAll('.q-hint[data-hint]:not([aria-label])').forEach((btn) => {
    btn.setAttribute('aria-label', btn.dataset.hint || '');
  });
}

// ------------------------------------------------------------------
// Alter role tab
// ------------------------------------------------------------------

let alterPassword = '';
/** @type {{kind:string, key:string}|null} scope-dialog context; null = assigning new parents */
let scopeDialogCtx = null;
/** @type {Array<{text:string, ids:string[]}>} distinct comment values for the popup */
let commentVersions = [];
/** @type {Array<object>} one comment-editor model per version (parallel to commentVersions) */
let commentVersionEditors = [];

function clusterCategory(clusterId) {
  return state?.clusters?.find((c) => c.id === clusterId)?.category || '';
}

/** Group flat RoleMatch rows by login name. Each match keeps its own `comment`, so the
 *  configured search columns are resolved at render time (a Settings change takes effect
 *  without re-running the search). */
function groupMatches(matches) {
  const map = new Map();
  for (const m of matches) {
    if (!m.loginName) continue;
    let g = map.get(m.loginName);
    if (!g) {
      g = { loginName: m.loginName, clusters: [] };
      map.set(m.loginName, g);
    }
    g.clusters.push(m);
  }
  return [...map.values()].sort((a, b) => a.loginName.localeCompare(b.loginName));
}

/** Clusters covered by the current sidebar target selection (categories ∪ clusters). */
function resolveSelectedClusters() {
  const cats = new Set(getSelectedCategories());
  const ids = new Set(getSelectedClusterIDs());
  const out = [];
  const seen = new Set();
  for (const c of state?.clusters || []) {
    if ((ids.has(c.id) || cats.has(c.category)) && !seen.has(c.id)) {
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

async function runRoleSearch() {
  const app = backend();
  const searchErr = document.getElementById('alter-search-errors');
  searchErr.textContent = '';
  if (!app) {
    searchErr.textContent = 'Wails backend not available';
    return;
  }
  const term = document.getElementById('alter-search-term').value.trim();
  if (term.length < 2) {
    searchErr.textContent = 'Enter at least 2 characters to search';
    return;
  }
  // Only the selected clusters/groups are compared.
  const targets = { categoryIds: getSelectedCategories(), clusterIds: getSelectedClusterIDs() };
  const scopeClusters = resolveSelectedClusters();
  if (!scopeClusters.length) {
    searchErr.textContent = 'Select at least one group or cluster in Target selection';
    return;
  }
  alterTargets = targets;
  alterScopeClusters = scopeClusters.map((c) => ({ clusterId: c.id, alias: c.alias, category: c.category }));
  // Baseline for the live sidebar (Alter mode): the selection that produced this scope.
  alterAppliedSelection = { categoryIds: new Set(targets.categoryIds), clusterIds: new Set(targets.clusterIds) };

  // Reset any open detail view for a fresh search.
  alterSelected = null;
  alterDetails = [];
  document.getElementById('alter-detail').classList.add('hidden');
  document.getElementById('alter-results').innerHTML = '<p class="hint">Searching selected clusters…</p>';

  let scanned;
  try {
    scanned = await app.SearchRoles({ term, categoryIds: targets.categoryIds, clusterIds: targets.clusterIds, auth: getAuth() });
  } catch (e) {
    // The whole call failed, so no cluster was scanned: report every one of them, the same way a
    // per-cluster failure is reported, instead of dumping the raw error into the popup.
    console.error('role search failed', e);
    scanned = scopeClusters.map((c) => ({
      clusterId: c.id, alias: c.alias, host: c.host, category: c.category,
      matches: [], error: String(e),
    }));
  }
  scanned = scanned || [];

  // One row per cluster → the popup's own status chip (the footer chip stays with the role load).
  searchState = buildStatusState(
    scanned.map((c) => ({
      clusterId: c.clusterId, alias: c.alias, host: c.host, category: c.category,
      status: c.error ? 'error' : 'ok', message: c.error || '',
      durationMs: c.durationMs || 0, queries: c.queries || [],
    }))
  );
  renderSearchStatus();

  // ONE line about the fact, never a per-cluster list — the detail is in the status popup. (The
  // old list also re-printed each alias, which the Go error already carries.)
  const failed = scanned.filter((c) => c.error).length;
  searchErr.textContent = failed ? searchFailureLine(failed, scanned.length) : '';

  alterGroups = groupMatches(scanned.flatMap((c) => c.matches || []));
  renderAlterResults();
}

/** One line about failed clusters: counting, not concatenating (same idiom as runStatusSummary),
 *  so N clusters behind one broken network read as one fact instead of N identical messages. */
function searchFailureLine(failed, total) {
  return `${failed} of ${total} cluster${total === 1 ? '' : 's'} could not be searched — click Status for details.`;
}

/** Ordered configured search columns (Config.SearchColumns). No default fallback on purpose:
 *  the backend resolves the built-in column when the key is absent, so an empty list here means
 *  the user deliberately chose "role name only". */
function searchColumns() {
  const sc = state?.searchColumns;
  return Array.isArray(sc) ? sc.filter((c) => c && c.template) : [];
}

/** One group's configured column values. A role's comment can differ per cluster, so each
 *  column reports the value from the first cluster in configured group-then-alias order (a
 *  stable pick — search results arrive in completion order).
 *
 *  Disagreement between clusters is deliberately NOT flagged here: the popup is for finding a role,
 *  and the reconciliation UI reports it once the role is loaded (the "Comments differ" banner and the
 *  Comments dialog). A bare marker in a search row read as an unexplained artifact. */
function searchCellValues(group, cols) {
  const rows = (group.clusters || []).slice().sort(byGroupThenAlias);
  return cols.map((col) => {
    for (const m of rows) {
      const v = renderSearchTemplate(col.template, m.comment);
      if (v) return v;
    }
    return '';
  });
}

// Column widths are pure CSS: the results container owns the tracks and every row/header subgrids
// into them (see .alter-results in styles.css), so the browser sizes each column to its widest cell
// across all rows and shares the free space among them. This replaced ~165 lines that measured text
// with canvas measureText against fonts read from throwaway DOM probes, plus a two-pass render to
// reserve the chip column.
const SEARCH_COL_MIN_CH = 4; // a squeezed column keeps a readable stub instead of collapsing away
const SEARCH_LOGIN_MAX_CH = 40; // rolenames go to 63 chars; longer ones ellipsize with a title
const SEARCH_BADGE_MIN_CH = 8; // reserved for the cluster chips, so a wide column can't starve them

/** The `grid-template-columns` for the results container: the rolename, one track per configured
 *  column, then the cluster chips.
 *
 *  Configured columns are `minmax(<floor>, max-content)`. Two failure modes were measured, and that
 *  exact pair of keywords is what avoids both:
 *  - `fit-content(<cap>)` made a long value (a raw `${comment}` above all) ellipsize at the cap
 *    while hundreds of px sat unused further right. Hence no cap — a column may grow to its content.
 *  - an `auto` maximum ALSO stretches a column past its content, because grid's last sizing step
 *    hands the remaining free space to every auto-max track. With short values that padded each
 *    column by ~240px, so "Michal Bartak" and the email beside it sat a quarter of a row apart.
 *    `max-content` stops a column exactly at its text, and the columns read as a table again.
 *  `.alter-cell` still ellipsizes, but only once the space genuinely isn't there; the floor keeps a
 *  squeezed column from collapsing to nothing.
 *
 *  That leaves the CHIPS track as the flexible one (`auto`), always. It is last and
 *  `justify-self: end`, so handing it the leftover both keeps the chips flush against the right edge
 *  and parks the slack in the one place it reads as deliberate — between the last value and the
 *  chips. Its `8ch` floor lets it shrink (and wrap) under real pressure rather than forcing a
 *  horizontal scrollbar and crushing the rolename. */
function searchGridTemplate(colCount) {
  return [
    `fit-content(${SEARCH_LOGIN_MAX_CH}ch)`,
    ...Array.from({ length: colCount }, () => `minmax(${SEARCH_COL_MIN_CH}ch, max-content)`),
    `minmax(${SEARCH_BADGE_MIN_CH}ch, auto)`,
  ].join(' ');
}

function renderAlterResults() {
  const box = document.getElementById('alter-results');
  if (!alterGroups.length) {
    box.innerHTML = '<p class="hint">No matching roles found.</p>';
    return;
  }
  const cols = searchColumns();
  const cells = alterGroups.map((g) => searchCellValues(g, cols));
  // One template on the container; the header and every row subgrid into it.
  box.style.setProperty('--search-cols', searchGridTemplate(cols.length));
  const head = cols.length
    ? `<div class="alter-result-head">
        <span class="alter-cell">Role</span>
        ${cols.map((c) => `<span class="alter-cell">${escapeHtml(c.label || '')}</span>`).join('')}
        <span></span>
      </div>`
    : '';
  box.innerHTML =
    head +
    alterGroups
      .map((g, gi) => {
        const labels = scopeLabelsHtml(describeScope(new Set(g.clusters.map((m) => m.clusterId))));
        const extra = cells[gi]
          .map((text) => {
            // Unconditional: a flexible column ellipsizes by design, and any column gets squeezed
            // below its content once the window is narrow enough, so there is no reliable way to
            // predict which values stay fully visible.
            const title = text ? ` title="${escapeAttr(text)}"` : '';
            return `<span class="alter-cell"${title}>${escapeHtml(text)}</span>`;
          })
          .join('');
        const loginTitle = ` title="${escapeAttr(g.loginName)}"`;
        return `<button type="button" class="alter-result-row" data-login="${escapeAttr(g.loginName)}">
        <span class="alter-login"${loginTitle}>${escapeHtml(g.loginName)}</span>
        ${extra}
        <span class="alter-cluster-badges">${labels}</span>
      </button>`;
      })
      .join('');
}

async function pickUser(login) {
  alterSelected = login;
  resetEditMaps();

  closeModal('search-dialog');
  // The detail header shows which role is being edited; hide the empty-state prompt.
  document.getElementById('alter-current-hint')?.classList.add('hidden');
  const detail = document.getElementById('alter-detail');
  detail.classList.remove('hidden');
  detail.innerHTML = '<p class="hint">Loading role details…</p>';

  await reloadDetails();
}

/** Reload alterDetails for the selected login, preserving pending edits. */
/** Fetch the selected role's per-cluster details WITHOUT rendering. Returns
 *  { valid, errors, all }: valid = exists && no error; errors = unreachable/failed clusters;
 *  all = every queried cluster (incl. reachable-but-role-not-found rows, which carry the
 *  introspection SQL and are used by the post-create load log). `null` on a hard throw (shown
 *  inline). Pure — callers decide whether to render. */
async function fetchRoleDetails() {
  const app = backend();
  let details;
  try {
    details = await app.LoadRoleDetails({
      loginName: alterSelected,
      categoryIds: alterTargets.categoryIds,
      clusterIds: alterTargets.clusterIds,
      auth: getAuth(),
    });
  } catch (e) {
    showInlineError(document.getElementById('ops-error'), e);
    return null;
  }
  const all = details || [];
  return {
    valid: all.filter((d) => d.exists && !d.error),
    errors: all.filter((d) => d.error),
    all,
  };
}

/** Reload + re-render the form from the DB (the "reset" path used by remove/search).
 *  This DOES re-render, so it can show the empty-state/"not found" — callers that must
 *  not clobber the form on error should use `fetchRoleDetails` and guard the render. */
async function reloadDetails(opts = {}) {
  const res = await fetchRoleDetails();
  if (!res) return;
  alterDetails = res.valid;
  loadCommentEditor();
  // per-cluster reachability → run-status chip (OK/Error + details on click). Skipped when the
  // caller owns the chip (e.g. remove: an empty post-removal load would otherwise clear it).
  if (!opts.keepRunStatus) reportRoleLoad(res, opts);
  renderAlterDetail();
}

/** Distinct sorted parent roles across every cluster the user exists on. */
function allPrivileges() {
  const s = new Set();
  for (const d of alterDetails) for (const p of d.parents || []) s.add(p);
  return [...s].sort();
}

/** Set of clusterIds on which the given role is currently granted. */
function clusterIdsWith(role) {
  return new Set(alterDetails.filter((d) => (d.parents || []).includes(role)).map((d) => d.clusterId));
}

/** Set of clusterIds on which the given attribute is currently enabled. */
function clusterIdsWithAttr(key) {
  return new Set(alterDetails.filter((d) => d.attributes && d.attributes[key]).map((d) => d.clusterId));
}

/** Set of clusterIds where setting `name` currently equals `value`. */
function clusterIdsWithConfig(name, value) {
  return new Set(alterDetails.filter((d) => d.settings && d.settings[name] === value).map((d) => d.clusterId));
}

/** Distinct {name,value} pairs across present clusters, sorted by name then value. */
function allSettings() {
  const seen = new Set();
  const out = [];
  for (const d of alterDetails) {
    for (const [name, value] of Object.entries(d.settings || {})) {
      const k = name + '=' + value;
      if (!seen.has(k)) {
        seen.add(k);
        out.push({ name, value });
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.value.localeCompare(b.value));
}

// Row key is "name=value"; GUC names never contain '=', so split on the first one.
const cfgKey = (name, value) => name + '=' + value;
const cfgParse = (key) => {
  const i = key.indexOf('=');
  return { name: key.slice(0, i), value: key.slice(i + 1) };
};

/**
 * Describe a set of clusterIds against a universe (the selected comparison scope).
 * Completeness is judged per group only: if every universe cluster of a category is in
 * the set → one group label (named after the group); otherwise one label per matched
 * cluster of that group. There is no cross-group "all". Parts are ordered by the
 * configured category order and carry their category for colouring.
 */
function scopeUniverse() {
  return alterScopeClusters.length ? alterScopeClusters : alterDetails;
}

function describeScope(idSet, universe = scopeUniverse()) {
  const byCat = new Map();
  for (const d of universe) {
    if (!byCat.has(d.category)) byCat.set(d.category, []);
    byCat.get(d.category).push(d);
  }
  // Same rule as byGroupThenAlias: configured group order, unknown groups last, id as tiebreak.
  const cats = [...byCat.keys()].sort(
    (a, b) => categoryOrderIndex(a) - categoryOrderIndex(b) || a.localeCompare(b)
  );
  const parts = [];
  for (const cat of cats) {
    const clusters = byCat.get(cat);
    const inSet = clusters.filter((d) => idSet.has(d.clusterId));
    if (!inSet.length) continue;
    if (inSet.length === clusters.length) {
      parts.push({ kind: 'group', cat, label: categoryLabel(cat) || cat });
    } else {
      for (const d of inSet) parts.push({ kind: 'cluster', cat, label: d.alias });
    }
  }
  return parts;
}

function scopeLabelsHtml(parts, extraCls = '') {
  // Added labels keep data-cat (so the per-group colour applies) and are flagged with a leading
  // "+"; removed labels drop data-cat so the red strikethrough overlay wins; normal labels carry
  // data-cat for their group colour.
  const isStrike = extraCls === 'chip-scope-strike';
  const isAdd = extraCls === 'chip-scope-add';
  return parts
    .map((p) => {
      const cat = isStrike ? '' : ` data-cat="${escapeAttr(p.cat)}"`;
      const name = (isAdd ? '+' : '') + p.label;
      return `<span class="chip-scope scope-kind-${p.kind} ${extraCls}"${cat}>${escapeHtml(name)}</span>`;
    })
    .join('');
}

/** Ordered configured comment fields (Config.CommentFields). No default fallback — like
 *  searchColumns(): which JSON keys a comment carries is a site convention, and an empty list
 *  is both the built-in state and a choice the user can save. */
function commentFields() {
  const cf = state?.commentFields;
  return Array.isArray(cf) ? cf : [];
}

/** Canonical form of a comment for comparison: sorted-key JSON when valid, else raw. */
function canonicalComment(text) {
  const t = (text || '').trim();
  if (!t || t[0] !== '{') return text || '';
  try {
    return JSON.stringify(sortKeysDeep(JSON.parse(t)));
  } catch {
    return text || '';
  }
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeysDeep(value[k]);
    return out;
  }
  return value;
}

/** Parse a role comment. isObject=true only for a JSON object (not array/scalar/plain text).
 *  Single source of truth for reading structured comments. */
function parseCommentObject(comment) {
  const t = (comment || '').trim();
  if (!t || t[0] !== '{') return { isObject: false, obj: {} };
  try {
    const o = JSON.parse(t);
    if (o && typeof o === 'object' && !Array.isArray(o)) return { isObject: true, obj: o };
  } catch {
    /* not JSON */
  }
  return { isObject: false, obj: {} };
}

/** One comment key as display text: strings trimmed, number/bool bare, array/object as JSON.
 *  A missing key and JSON null are both '' (same rule as the comment editor's empty field). */
function commentValueString(obj, key) {
  const v = obj?.[key];
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** The bare `${name}` namespace of a search-column template is a CLOSED built-in set; a comment
 *  key is always `${{name}}`. Mirrors config.searchBuiltins / calltemplate's split, so a comment
 *  key named `comment` stays reachable alongside the whole-comment built-in. */
const SEARCH_BUILTINS = new Set(['comment']);
/** Both name classes exclude braces, so the bare branch cannot swallow a `${{…}}` token — the
 *  precedence is structural, not just the order of the alternatives. Module-level /g literal: use
 *  it only with String.replace / String.matchAll (both leave lastIndex at 0), never .test/.exec. */
const SEARCH_TOKEN_RE = /\$\{\{([^{}]*)\}\}|\$\{([^{}]*)\}/g;

/** Render one search-column template against a role comment. `${{<key>}}` resolves to that key of
 *  the (JSON) comment, `${comment}` to the raw comment. Whitespace is collapsed afterwards so
 *  "${{first}} ${{last}}" with no last name yields "John", not "John "; literal separators are kept
 *  verbatim. An unknown bare name renders as ITSELF rather than empty, so the mistake is visible in
 *  the row — saving such a template is refused with a message naming the `${{…}}` form. */
function renderSearchTemplate(tmpl, comment) {
  const { isObject, obj } = parseCommentObject(comment);
  const out = String(tmpl || '').replace(SEARCH_TOKEN_RE, (token, key, builtin) => {
    if (key !== undefined) return isObject ? commentValueString(obj, key.trim()) : '';
    const name = builtin.trim();
    if (name === 'comment') return comment || '';
    return token;
  });
  return out.replace(/\s+/g, ' ').trim();
}

/** Why a search-column template is invalid, or '' when it is fine. Deliberate mirror of
 *  config.checkSearchTemplate — keep the wording in step with internal/config/store.go. */
function searchTemplateError(tmpl) {
  const t = String(tmpl || '');
  if (t.replace(SEARCH_TOKEN_RE, '').includes('${')) {
    return 'Unfinished placeholder: write ${comment} or ${{comment_key}} with both braces closed.';
  }
  for (const [, key, builtin] of t.matchAll(SEARCH_TOKEN_RE)) {
    const name = (key ?? builtin).trim();
    if (!name) return 'Empty placeholder: put a name between the braces.';
    if (key === undefined && !SEARCH_BUILTINS.has(name)) {
      return `\${${name}} is not supported — use \${{${name}}} for a comment key, or \${comment} for the whole comment.`;
    }
  }
  return '';
}

/** Build the create_role / set_comment comment-field args for the comment actually written to a
 *  cluster: for each configured field key present in the (JSON) comment, its JSON-encoded value
 *  (e.g. `"John"`, `42`, `true`, `null`). A key absent from the comment (or a plain-text /
 *  non-object comment) is omitted, so the backend resolves its ${key} placeholder to SQL NULL. */
function commentFieldArgs(commentText) {
  const out = {};
  const { isObject, obj } = parseCommentObject(commentText);
  if (!isObject) return out;
  for (const f of commentFields()) {
    if (f.key && Object.prototype.hasOwnProperty.call(obj, f.key)) {
      out[f.key] = JSON.stringify(obj[f.key]);
    }
  }
  return out;
}

/** The mode the comment editor opens in (ui.comment_default_view): 'fields' | 'raw'. */
function preferredCommentView() {
  return state?.ui?.commentDefaultView === 'fields' ? 'fields' : 'raw';
}

/** Alter-role: whether adding a target where the role is missing auto-stages its creation. */
function stageCreateOnAdd() {
  return state?.ui?.stageCreateOnTargetAdd === true;
}

/** Consensus comment across the loaded clusters + whether they disagree. Existing clusters only —
 *  pending presence-adds (exists:false, empty baseline) receive the consistent comment and must not
 *  count as a divergence. An UNSET comment on a real cluster IS a divergence, so empties are kept
 *  (not filtered), i.e. "A, A, (unset)" reports varies. */
function commentConsensus() {
  const raws = alterDetails.filter((d) => d.exists).map((d) => d.comment || '');
  const canon = new Set(raws.map(canonicalComment));
  return { comment: raws.length ? raws[0] : '', varies: canon.size > 1, hasComment: raws.some(Boolean) };
}

/** Build the editor model from a comment string. Configured fields always render (blank if
 *  absent); extra string keys render too (labeled by raw key); non-string keys stay in
 *  baseObj only (Raw-editable). Mode follows the configured preference, except that plain
 *  text always lands in Raw. */
function editorFromComment(comment, varies) {
  const { isObject, obj } = parseCommentObject(comment);
  const labels = {};
  const values = {};
  const shownKeys = [];
  const seen = new Set();
  const readonly = new Set(); // keys whose value isn't a string: shown but only Raw-editable
  const addKey = (key, label) => {
    if (seen.has(key)) return;
    seen.add(key);
    shownKeys.push(key);
    labels[key] = label;
    if (isObject && key in obj && obj[key] !== null && typeof obj[key] !== 'string') {
      // Non-string value (number/bool/array/object): display it (JSON) but read-only, so it's
      // visible per the design and its type is preserved via baseObj on save. null is treated as
      // an empty editable string (below) instead — see assembleCommentFrom (empty -> null).
      values[key] = JSON.stringify(obj[key]);
      readonly.add(key);
    } else {
      values[key] = isObject && typeof obj[key] === 'string' ? obj[key] : '';
    }
  };
  // Configured fields always render (in order); then every other key present in the comment.
  for (const f of commentFields()) addKey(f.key, f.label || f.key);
  if (isObject) for (const k of Object.keys(obj)) addKey(k, k);
  // Mode: the configured preference wins, in the role form and in the Comments dialog alike.
  // Fields is only possible for a JSON object or an empty comment — plain text has no fields to
  // show, so it always opens in Raw (see commentFieldsBlocked).
  const hasPlainText = !isObject && !!(comment || '').trim();
  const mode = preferredCommentView() === 'fields' && !hasPlainText ? 'fields' : 'raw';
  return {
    mode,
    baseObj: isObject ? obj : {},
    isObject,
    raw: comment || '',
    shownKeys,
    labels,
    values,
    readonly,
    varies,
  };
}

function freshEditor() {
  return editorFromComment('', false);
}

/** Load #role-login + build the comment editor model. Called on mode entry / role load only
 *  — NOT on every re-render, so pending user edits aren't clobbered. */
function loadCommentEditor() {
  const login = document.getElementById('role-login');
  if (!login) return;
  if (isCreateMode()) {
    login.value = '';
    commentEditor = freshEditor();
  } else {
    login.value = alterSelected || '';
    const c = commentConsensus();
    commentEditor = editorFromComment(c.varies ? '' : c.comment, c.varies);
  }
  renderCommentEditor();
}

/** Paint the comment editor (toggle state + per-key value inputs + notice) from commentEditor. */
function renderCommentEditor() {
  const fieldsBox = document.getElementById('rce-fields');
  const raw = document.getElementById('rce-raw');
  const notice = document.getElementById('rce-notice');
  if (!fieldsBox || !raw || !notice) return;
  const e = commentEditor;
  const blockFields = commentFieldsBlocked(e); // non-JSON text → Fields would drop it
  document.querySelectorAll('#rce-mode .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === e.mode);
    if (b.dataset.mode === 'fields') {
      b.disabled = blockFields;
      b.title = blockFields ? 'Comment is plain text (not JSON) — edit it in Raw' : '';
    }
  });

  const fieldsDisabled = e.varies;
  fieldsBox.classList.toggle('hidden', e.mode !== 'fields');
  raw.classList.toggle('hidden', e.mode !== 'raw');
  raw.value = e.raw;

  fieldsBox.innerHTML = commentFieldInputsHtml(e, null, fieldsDisabled);

  notice.textContent = e.varies
    ? 'Comments differ across clusters — reconcile via "View / edit comments" below.'
    : '';
}

/** The comment an editor model currently represents (may be plain text in raw mode). */
function assembleCommentFrom(e) {
  if (e.mode === 'raw') return e.raw.trim();
  const out = { ...e.baseObj };
  for (const k of e.shownKeys) {
    if (e.readonly && e.readonly.has(k)) continue; // non-string value: keep baseObj's typed value
    const v = (e.values[k] || '').trim();
    if (v) out[k] = v;
    // Empty value: a key that already existed in the loaded comment (string or null) is kept as
    // null — so a loaded null round-trips unchanged and clearing a field stores null rather than
    // silently dropping it. A key that was never in the comment stays absent (no null spam on new
    // roles / empty comments — preserving load idempotence).
    else if (k in e.baseObj) out[k] = null;
    else delete out[k];
  }
  return Object.keys(out).length ? JSON.stringify(sortKeysDeep(out)) : '';
}
function assembleComment() {
  return assembleCommentFrom(commentEditor);
}

/** Fields mode can't represent non-JSON text, so switching to it would drop the content.
 *  Blocked when the raw text is non-empty and not a JSON object (empty/JSON are fine). Only
 *  meaningful in raw mode — in fields mode the content is already a JSON object / empty. */
function commentFieldsBlocked(e) {
  if (e.mode !== 'raw') return false;
  const t = (e.raw || '').trim();
  return !!t && !parseCommentObject(e.raw).isObject;
}

/** Switch an editor model between Fields<->Raw without losing data (mutates e). */
function switchEditorMode(e, mode) {
  if (mode === e.mode) return;
  if (mode === 'fields' && commentFieldsBlocked(e)) return; // guard: never drop non-JSON text
  if (mode === 'raw') {
    e.raw = assembleCommentFrom(e); // serialize field state so nothing is lost
  } else {
    const rebuilt = editorFromComment(e.raw, e.varies);
    e.baseObj = rebuilt.baseObj;
    e.isObject = rebuilt.isObject;
    e.shownKeys = rebuilt.shownKeys;
    e.labels = rebuilt.labels;
    e.values = rebuilt.values;
    e.readonly = rebuilt.readonly;
  }
  e.mode = mode;
}
function switchCommentMode(mode) {
  switchEditorMode(commentEditor, mode);
  renderCommentEditor();
}

/** Field value inputs for an editor model, namespaced with data-cv-idx for reuse in dialogs.
 *  Non-string keys (e.readonly) render disabled with a note — visible but edited via Raw. */
function commentFieldInputsHtml(e, idx, disabled) {
  const idxAttr = idx == null ? '' : ` data-cv-idx="${idx}"`;
  // With no configured comment fields and none in the comment there is nothing to lay out, and an
  // empty box reads as a broken editor. Comment fields default to none, so this is the first thing
  // a new user sees in Fields mode.
  if (!e.shownKeys.length) {
    return '<p class="rce-empty">No comment fields configured — add them in Settings, or edit the comment in Raw.</p>';
  }
  return e.shownKeys
    .map((k) => {
      const ro = e.readonly && e.readonly.has(k);
      const note = ro
        ? ` <button type="button" class="q-hint q-warn" aria-label="Non-text value — edit in Raw" data-hint="Non-text value — edit in Raw">${ICONS.warn}</button>`
        : '';
      return `
    <label class="rce-field"><span class="rce-field-label">${escapeHtml(e.labels[k] || k)}${note}</span>
      <input type="text"${idxAttr} data-cf-key="${escapeAttr(k)}" value="${escapeAttr(e.values[k] || '')}"
        autocapitalize="none" autocomplete="off" spellcheck="false" ${disabled || ro ? 'disabled' : ''} />
    </label>`;
    })
    .join('');
}

function renderAlterDetail() {
  const root = document.getElementById('alter-detail');
  const identity = document.getElementById('role-identity');
  const present = document.getElementById('role-present');
  const hint = document.getElementById('alter-current-hint');
  const login = document.getElementById('role-login');
  const create = isCreateMode();

  // Identity block + "Present on" (edit only, above the form) + empty-state hint.
  if (create) {
    // Login + comment only make sense once there's a target cluster; hide the whole identity
    // block until then (the root shows a "select a cluster" hint below).
    identity.classList.toggle('hidden', alterDetails.length === 0);
    hint.classList.add('hidden');
    if (login) login.readOnly = false;
    present.classList.add('hidden');
    present.innerHTML = '';
  } else if (alterSelected && alterDetails.length) {
    identity.classList.remove('hidden');
    hint.classList.add('hidden');
    if (login) login.readOnly = false; // editable: a changed name stages a rename
    // Present-on shows three states against the searched scope: existing (plain), pending-add
    // ("+" prefix, group colour kept; synthetic exists:false rows) and pending-remove (red
    // strikethrough). The ✎ button
    // opens the presence editor to add the role to missing clusters or drop it from some.
    const presentIds = new Set(alterDetails.filter((d) => d.exists && !roleRemoveClusters.has(d.clusterId)).map((d) => d.clusterId));
    const addIds = new Set(alterDetails.filter((d) => !d.exists).map((d) => d.clusterId));
    const presentLabels =
      scopeLabelsHtml(describeScope(presentIds)) +
      scopeLabelsHtml(describeScope(addIds), 'chip-scope-add') +
      scopeLabelsHtml(describeScope(new Set(roleRemoveClusters)), 'chip-scope-strike');
    present.innerHTML =
      `<span class="section-label">Present on</span>` +
      `<button type="button" class="scope-act" id="btn-present-edit" title="Add / remove role on clusters" aria-label="Add / remove role on clusters">${ICONS.edit}</button>` +
      `<span class="alter-cluster-badges">${presentLabels || '<span class="hint">no clusters</span>'}</span>`;
    present.classList.remove('hidden');
  } else {
    identity.classList.add('hidden');
    hint.classList.remove('hidden');
    present.classList.add('hidden');
    present.innerHTML = '';
  }

  if (!create && !alterSelected) {
    root.classList.add('hidden');
    root.innerHTML = '';
    return;
  }
  root.classList.remove('hidden');

  if (!alterDetails.length) {
    // Unreachable-cluster errors go to the bottom status line (showAlterErrors), not the form.
    root.innerHTML = create
      ? '<p class="hint">Select at least one target cluster to create a role.</p>'
      : `<p class="hint">Role <strong>${escapeHtml(alterSelected)}</strong> was not found on any selected cluster.</p>`;
    return;
  }

  // Comment UI mode follows the STAGED state (`commentEditor.varies`), not the DB baseline — so
  // once the Comments dialog reconciles every cluster to one value, the inline editor takes over
  // and the "differ" banner clears immediately on OK (before Save).
  const commentEditorEl = document.getElementById('role-comment-editor');
  if (commentEditorEl) commentEditorEl.classList.toggle('hidden', !create && commentEditor.varies);

  // Edit-only: when comments still vary, surface a "reconcile per cluster" entry (Comments dialog).
  // When consistent, the inline editor above is the only comment UI (no redundant section).
  let editHead = '';
  if (!create) {
    if (commentEditor.varies) {
      const staged = alterDetails.some(
        (d) => commentOverrides.has(d.clusterId) && canonicalComment(commentOverrides.get(d.clusterId)) !== canonicalComment(d.comment || '')
      );
      editHead += `
    <div class="alter-section">
      <div class="section-label">Comment</div>
      <div class="alter-add-row">
        <button type="button" class="small btn-two-line${staged ? ' is-added' : ''}" id="btn-alter-comments">Comments differ across clusters<br>view / edit per cluster</button>
      </div>
    </div>`;
    }
  }

  const existing = allPrivileges();
  const existingSet = new Set(existing);
  const newRoles = [...alterAdd.keys()].filter((r) => !existingSet.has(r));
  const parentRows = existing
    .concat(newRoles)
    .map((r) => scopeRowHtml('priv', r, r, clusterIdsWith(r), alterAdd.get(r) || new Set(), alterRevoke.get(r) || new Set()));
  const parentHtml = parentRows.length ? parentRows.join('') : '<p class="hint">No role parents.</p>';

  const attrRows = ROLE_ATTRIBUTES.map((a) =>
    scopeRowHtml('attr', a.key, a.label, clusterIdsWithAttr(a.key), alterAttrAdd.get(a.key) || new Set(), alterAttrRemove.get(a.key) || new Set())
  ).join('');

  // SETTINGS: existing (name,value) pairs plus any brand-new pending sets.
  const settingPairs = allSettings();
  const seenCfg = new Set(settingPairs.map((p) => cfgKey(p.name, p.value)));
  for (const key of alterConfigSet.keys()) {
    if (!seenCfg.has(key)) {
      seenCfg.add(key);
      settingPairs.push(cfgParse(key));
    }
  }
  const cfgRows = settingPairs.map((p) => configRowHtml(p.name, p.value)).join('');
  const cfgHtml = cfgRows || '<p class="hint">No settings.</p>';

  root.innerHTML = `
    ${editHead}
    <div class="alter-section">
      <div class="section-label">Role Parents ${hintBadge('Each parent shows the clusters/groups it is granted on. Use ✎ to add or remove clusters, × to revoke everywhere.')}</div>
      <div class="scope-rows" id="alter-parents">${parentHtml}</div>
      <div class="alter-add-row">
        <button type="button" class="list-add" id="btn-alter-add">Assign parents…</button>
      </div>
    </div>

    <div class="alter-section">
      <div class="section-label">Attributes ${hintBadge('Each attribute shows where it is enabled. Use ✎ to enable/disable per cluster, × to disable everywhere.')}</div>
      <div class="scope-rows" id="alter-attrs">${attrRows}</div>
    </div>

    <div class="alter-section">
      <div class="section-label">Settings ${hintBadge('Role GUCs (ALTER ROLE … SET/RESET). Use ✎ to set on chosen clusters, × to reset everywhere it has that value.')}</div>
      <div class="scope-rows" id="alter-configs">${cfgHtml}</div>
      <div class="alter-add-row">
        <button type="button" class="list-add" id="btn-alter-add-config">Add setting…</button>
      </div>
    </div>

    <div class="alter-section">
      <div class="section-label">Password</div>
      <div class="alter-password">
        <span class="pw-field">
          <input type="password" id="alter-password" autocapitalize="none" autocomplete="off" placeholder="new password" />
          <button type="button" class="pw-copy" id="btn-copy-password" aria-label="Copy password">${ICONS.copy}</button>
          <button type="button" class="pw-toggle" aria-label="Show password">${ICONS.eye}</button>
        </span>
        <button type="button" class="pw-gen" id="btn-gen-password" aria-label="Generate password" title="Generate a random password">${ICONS.gen}</button>
        <label class="inline"><input type="checkbox" id="alter-do-pw"${alterDoPassword ? ' checked' : ''} /> Set password</label>
      </div>
    </div>`;

  const pwInput = /** @type {HTMLInputElement} */ (document.getElementById('alter-password'));
  if (pwInput) pwInput.value = alterPassword;
  syncPasswordControls();
  renderRenameState();
  updateOpsFooter();
}

/** The ↺ beside the login input (Alter, role loaded): always shown so the row never shifts, disabled
 *  until a rename is staged; its hint names the loaded name it reverts to. Never writes the input
 *  itself, so typing is not disturbed. */
function renderRenameState() {
  const box = document.getElementById('role-rename');
  if (!box) return;
  const show = !isCreateMode() && !!alterSelected;
  box.classList.toggle('hidden', !show);
  if (!show) {
    box.innerHTML = '';
    return;
  }
  const label = alterRenameTo ? `Renamed from: ${alterSelected}` : 'Undo rename';
  box.innerHTML =
    `<button type="button" class="scope-act" id="btn-rename-revert" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}"` +
    `${alterRenameTo ? '' : ' disabled'}>${ICONS.discard}</button>`;
}

/** Show the right pinned footer for the active op: Create → Run; Alter → Save/Remove
 *  (only once a role is loaded). Hide the footer entirely when neither applies. */
function updateOpsFooter() {
  const isCreate = isCreateMode();
  const showAlter = !isCreate && !!alterSelected && alterDetails.length > 0;
  // Keep the footer visible when the run-status chip is showing (e.g. a role-load that hit
  // unreachable clusters) even with no action buttons, so the chip isn't hidden with the footer.
  const hasStatus = !!runState;
  // No target selected in create mode → nothing to create; hide the action + footer.
  const createReady = isCreate && alterDetails.length > 0;
  document.getElementById('create-run-bar')?.classList.toggle('hidden', !createReady);
  document.getElementById('alter-actions')?.classList.toggle('hidden', !showAlter);
  document.getElementById('ops-footer')?.classList.toggle('hidden', !createReady && !showAlter && !hasStatus);
  // "Save changes" is enabled only when there is something to save.
  if (showAlter) setDirty(document.getElementById('btn-alter-save'), buildAlterClusterOps().length > 0);
}

/** Report a role-load's per-cluster reachability through the shared run-status chip — OK / Error
 *  in the bottom bar, per-cluster error messages on click — the same surface used for create/alter
 *  runs. `res` is the { valid, errors, all } from `fetchRoleDetails`.
 *  Default (user-initiated load): RESET the chip to just this load (valid + unreachable). With
 *  `appendLog` (the automatic post-create load): append a "Load" phase to the EXISTING run state for
 *  EVERY queried cluster — including reachable clusters where the role wasn't found (create failed
 *  there) — so each shows the introspection SQL that ran, preserving the create log. */
function reportRoleLoad(res, { appendLog = false } = {}) {
  const rowResult = (d) => ({
    clusterId: d.clusterId, alias: d.alias, host: d.host, category: d.category,
    status: d.error ? 'error' : 'ok', message: d.error || '', durationMs: d.durationMs || 0, queries: d.queries || [],
  });
  if (appendLog && runState) {
    // Log a Load segment for EVERY queried cluster (found / not-found / unreachable), preserving the
    // prior (create) log. An empty result set just leaves the create log untouched (no reset).
    const results = (res.all || []).map(rowResult);
    appendRunPhase(results.map((r) => ({ clusterId: r.clusterId })), 'Load');
    for (const r of results) {
      const row = runState.byId.get(r.clusterId);
      if (!row) continue;
      row.phase = 'done';
      const seg = currentSegment(row);
      seg.status = r.status;
      seg.message = r.message;
      seg.durationMs = r.durationMs;
      seg.queries = r.queries || [];
    }
    renderRunStatus();
    return;
  }
  // Default (user-initiated) load: reset the chip to just this load — role found + unreachable.
  const results = [...(res.valid || []), ...(res.errors || [])].map(rowResult);
  if (!results.length) {
    clearRunStatus();
    return;
  }
  beginRunStatus(results.map((r) => ({ clusterId: r.clusterId })));
  finishRunStatus(results);
}

/** Subtract set b from set a (returns a new Set). */
function setMinus(a, b) {
  const out = new Set();
  for (const x of a) if (!b.has(x)) out.add(x);
  return out;
}

// --- Shared scope-set primitives ---------------------------------------------------------
// Every "grant / enable / set on clusters" section (role parents, attributes, role settings)
// stages its edits as a pending add-set and a pending remove-set of clusterIds against the
// current DB state (`cur`). These two primitives are the single source of truth for how a
// dialog selection turns into those sets, so the three sections behave identically.

/**
 * Additive apply (the "Add …" popups). Extend `add` to cover every `desired` cluster and
 * cancel any pending removal there, WITHOUT touching clusters outside `desired`. A cluster
 * that already has the item in the DB (`cur`) needs no pending grant, so it is dropped from
 * `add`. This is what "Assign parents" / "Add setting" must do — they only ever EXTEND
 * coverage; selecting cluster D for an item that already lives on A/B/C must leave A/B/C
 * untouched (a full desired-vs-current diff would instead revoke every unpicked cluster).
 * Mutates `add` and `rev` in place.
 */
function scopeMergeAdd(add, rev, cur, desired) {
  for (const cid of desired) {
    rev.delete(cid); // granting a cluster cancels any pending removal on it
    if (cur.has(cid)) add.delete(cid); // already present in the DB → no pending grant needed
    else add.add(cid);
  }
}

/**
 * Full diff (the per-row ✎ Edit). Make `desired` the exact target set: grant where missing
 * (`desired − cur`) and revoke where present-but-unwanted (`cur − desired`). Returns fresh
 * add/rev sets (the row editor replaces any prior pending state for that key).
 */
function scopeDiff(cur, desired) {
  return { add: setMinus(desired, cur), rev: setMinus(cur, desired) };
}

/**
 * One row for a role parent or attribute: name on the left, scope labels on the right,
 * then actions. kind is 'priv' or 'attr'. curSet = current clusters; addSet = pending
 * grants/enables; revSet = pending revokes/disables.
 */
function scopeRowHtml(kind, key, name, curSet, addSet, revSet) {
  const isNew = curSet.size === 0;
  const k = escapeAttr(key);
  const pending = addSet.size > 0 || revSet.size > 0;
  const kept = setMinus(curSet, revSet);
  const emptyNote = kind === 'attr' ? '<span class="hint scope-off">off</span>' : '<span class="hint">none</span>';

  const keptLabels = scopeLabelsHtml(describeScope(kept));
  const addLabels = addSet.size ? scopeLabelsHtml(describeScope(addSet), 'chip-scope-add') : '';
  const revLabels = revSet.size ? scopeLabelsHtml(describeScope(revSet), 'chip-scope-strike') : '';
  const labels = keptLabels + addLabels + revLabels || emptyNote;

  // All three actions always render as square buttons beside the row; the ones that don't
  // apply are disabled (greyed, inert to the mouse) rather than hidden, so layout is stable.
  const editBtn = `<button type="button" class="scope-act" data-kind="${kind}" data-act="scope" data-key="${k}" title="Edit clusters" aria-label="Edit clusters">${ICONS.edit}</button>`;

  const verbRemove = kind === 'attr' ? 'Disable everywhere' : kind === 'config' ? 'Reset everywhere' : 'Revoke everywhere';
  let xAct = 'revoke';
  let xTitle = verbRemove;
  if (isNew && addSet.size) {
    xAct = 'deladd';
    xTitle = 'Cancel';
  }
  // × only acts while a grant remains (kept) or a pending add exists; once everything
  // is revoked/cancelled it has nothing left to do, so it goes inactive.
  const xOn = kept.size > 0 || addSet.size > 0;
  const xBtn = `<button type="button" class="scope-act" data-kind="${kind}" data-act="${xAct}" data-key="${k}" title="${escapeAttr(xTitle)}" aria-label="${escapeAttr(xTitle)}"${xOn ? '' : ' disabled'}>${ICONS.remove}</button>`;

  const resetBtn = `<button type="button" class="scope-act" data-kind="${kind}" data-act="reset" data-key="${k}" title="Discard pending changes" aria-label="Discard pending changes"${pending ? '' : ' disabled'}>${ICONS.discard}</button>`;

  const fullyRemoved = kept.size === 0 && addSet.size === 0 && revSet.size > 0;
  const stateCls = fullyRemoved ? 'is-removed' : '';
  return `<div class="scope-line">
    <div class="scope-row ${stateCls}">
      <span class="scope-row-name">${escapeHtml(name)}</span>
      <span class="scope-row-labels">${labels}</span>
    </div>
    <div class="scope-row-actions">${editBtn}${xBtn}${resetBtn}</div>
  </div>`;
}

/** A SETTINGS row (name=value): current scope = clusters where the setting has that value;
 *  a cluster is "removed" if pending-reset for the name or pending-set to a different value. */
function configRowHtml(name, value) {
  const key = cfgKey(name, value);
  const cur = clusterIdsWithConfig(name, value);
  const add = alterConfigSet.get(key) || new Set();
  const resetIds = alterConfigReset.get(name) || new Set();
  const rev = new Set();
  for (const cid of cur) {
    if (resetIds.has(cid)) {
      rev.add(cid);
      continue;
    }
    for (const [k, ids] of alterConfigSet) {
      if (k !== key && cfgParse(k).name === name && ids.has(cid)) {
        rev.add(cid);
        break;
      }
    }
  }
  return scopeRowHtml('config', key, `${name} = ${value}`, cur, add, rev);
}

// --- Scope dialog (assign new role parents, or extend a parent/attribute) ---

/** ctx: null → assign new parents; {kind:'priv',key} → edit one parent; {kind:'attr',key} → edit attribute. */
function openScopeDialog(ctx) {
  scopeDialogCtx = ctx || null;
  clearInlineError(document.getElementById('scope-error'));
  const dlg = document.getElementById('scope-dialog');
  const title = document.getElementById('scope-dialog-title');
  const roleLabel = document.getElementById('scope-role-label');
  const roleInput = /** @type {HTMLInputElement} */ (document.getElementById('scope-role'));
  const cnameLabel = document.getElementById('scope-cname-label');
  const cvalueLabel = document.getElementById('scope-cvalue-label');
  const ok = document.getElementById('scope-dialog-ok');

  roleLabel.classList.add('hidden');
  cnameLabel.classList.add('hidden');
  cvalueLabel.classList.add('hidden');
  document.getElementById('scope-cname').readOnly = false;
  document.getElementById('scope-preconfigured')?.classList.add('hidden');

  if (!ctx) {
    title.textContent = 'Assign parents';
    roleLabel.classList.remove('hidden');
    roleInput.value = '';
    renderScopePreconfigured();
    ok.textContent = 'Add';
  } else if (ctx.kind === 'config' && ctx.isNew) {
    title.textContent = 'Add setting';
    cnameLabel.classList.remove('hidden');
    cvalueLabel.classList.remove('hidden');
    document.getElementById('scope-cname').value = '';
    document.getElementById('scope-cvalue').value = '';
    ok.textContent = 'Add';
  } else if (ctx.kind === 'config') {
    // Edit an existing setting: value editable, name fixed (read-only).
    const { name, value } = cfgParse(ctx.key);
    title.textContent = name;
    cnameLabel.classList.remove('hidden');
    cvalueLabel.classList.remove('hidden');
    const cname = document.getElementById('scope-cname');
    cname.value = name;
    cname.readOnly = true;
    document.getElementById('scope-cvalue').value = value;
    ok.textContent = 'Apply';
  } else if (ctx.kind === 'presence') {
    title.textContent = 'Add / remove role on clusters';
    ok.textContent = 'Apply';
  } else if (ctx.kind === 'attr') {
    const a = ROLE_ATTRIBUTES.find((x) => x.key === ctx.key);
    title.textContent = a ? a.label : ctx.key;
    ok.textContent = 'Apply';
  } else {
    title.textContent = ctx.key;
    ok.textContent = 'Apply';
  }
  buildScopeTargets(ctx);
  openModal(dlg);
  if (!ctx) roleInput.focus();
  else if (ctx.kind === 'config' && ctx.isNew) document.getElementById('scope-cname').focus();
  else if (ctx.kind === 'config') document.getElementById('scope-cvalue').focus();
}

/** Preconfigured role-parent chips shown when assigning new parents. The picker carries no caption
 *  of its own — the "Role names" label above it, and its ? hint, cover both ways of choosing. */
function renderScopePreconfigured() {
  const box = document.getElementById('scope-preconfigured');
  if (!box) return;
  const roles = preconfiguredParentRoles();
  if (!roles.length) {
    box.innerHTML = '';
    box.classList.add('hidden');
    return;
  }
  box.innerHTML =
    roles
      .map(
        (r) =>
          `<button type="button" class="pick-chip" data-role="${escapeAttr(r)}">${escapeHtml(r)}</button>`
      )
      .join('');
  box.classList.remove('hidden');
}

/** Create mode: a fresh add/attribute editor defaults to every target cluster (every edit in
 *  Create is a pure grant over the selected clusters, so pre-tick them all). Only kicks in when
 *  nothing is set yet, so re-opening a partially-configured item keeps the user's choice. */
function createDefaultScope(desired) {
  if (isCreateMode() && desired.size === 0) return new Set(alterDetails.map((d) => d.clusterId));
  return desired;
}

/** Desired-state set currently reflected for a ctx: (current − pendingRevoke) ∪ pendingAdd. */
function scopeDesired(ctx) {
  if (!ctx) return createDefaultScope(new Set());
  if (ctx.kind === 'presence') {
    // Desired = clusters where the role will exist: real rows not marked for removal, plus the
    // synthetic pending-add rows (exists:false).
    return new Set(
      alterDetails.filter((d) => (d.exists ? !roleRemoveClusters.has(d.clusterId) : true)).map((d) => d.clusterId)
    );
  }
  if (ctx.kind === 'config') {
    if (ctx.isNew) return createDefaultScope(new Set());
    const { name, value } = cfgParse(ctx.key);
    const cur = clusterIdsWithConfig(name, value);
    const rev = alterConfigReset.get(name) || new Set();
    const add = alterConfigSet.get(ctx.key) || new Set();
    const desired = setMinus(cur, rev);
    for (const cid of add) desired.add(cid);
    return desired;
  }
  const cur = ctx.kind === 'attr' ? clusterIdsWithAttr(ctx.key) : clusterIdsWith(ctx.key);
  const add = (ctx.kind === 'attr' ? alterAttrAdd : alterAdd).get(ctx.key) || new Set();
  const rev = (ctx.kind === 'attr' ? alterAttrRemove : alterRevoke).get(ctx.key) || new Set();
  const desired = setMinus(cur, rev);
  for (const cid of add) desired.add(cid);
  return ctx.kind === 'attr' ? createDefaultScope(desired) : desired;
}

function buildScopeTargets(ctx) {
  const box = document.getElementById('scope-targets');
  const desired = scopeDesired(ctx);

  // Presence editing offers the whole searched scope (so absent clusters are checkable); every
  // other editor targets only the clusters the role currently lives on.
  const source = ctx && ctx.kind === 'presence' ? alterScopeClusters : alterDetails;
  const byCat = new Map();
  for (const d of source) {
    if (!byCat.has(d.category)) byCat.set(d.category, []);
    byCat.get(d.category).push(d);
  }
  let html = '';
  for (const [cat, clusters] of byCat) {
    html += `<div class="scope-group">
      <label class="scope-group-head"><input type="checkbox" class="scope-group-check" data-cat="${escapeAttr(cat)}" /> All ${escapeHtml(categoryLabel(cat) || cat)}</label>
      <div class="scope-clusters">`;
    for (const d of clusters) {
      html += `<label class="scope-cluster">
        <input type="checkbox" class="scope-cluster-check" data-cluster="${escapeAttr(d.clusterId)}" data-cat="${escapeAttr(cat)}" ${desired.has(d.clusterId) ? 'checked' : ''} />
        ${escapeHtml(d.alias)}
      </label>`;
    }
    html += `</div></div>`;
  }
  box.innerHTML = html;
  refreshScopeGroupChecks();
}

/** Sync each group-head checkbox to its clusters: checked when all (enabled) clusters are ticked,
 *  indeterminate when only some are — lets the head act as a whole-group (de)select. */
function refreshScopeGroupChecks() {
  document.querySelectorAll('#scope-targets .scope-group-check').forEach((head) => {
    const boxes = [...document.querySelectorAll(
      `#scope-targets .scope-cluster-check[data-cat="${CSS.escape(head.dataset.cat)}"]`
    )].filter((cb) => !cb.disabled);
    const ticked = boxes.filter((cb) => cb.checked).length;
    head.checked = boxes.length > 0 && ticked === boxes.length;
    head.indeterminate = ticked > 0 && ticked < boxes.length;
  });
}

/**
 * Split the Assign-parents input into role names: comma-separated, each trimmed, blanks dropped
 * (so "a,,b," and "a, b" both give two names), duplicates collapsed. Comma is the parent-list
 * delimiter everywhere in the app (ROLE_NAME_RE excludes it, ops send `parentRoles: 'a,b'`), so a
 * single name can never contain one — which is why splitting here does not narrow what is accepted.
 * @param {string} value raw field value
 * @returns {{roles: string[], invalid: string|null}} `invalid` is the first name that isn't legal
 */
function parseRoleNameList(value) {
  const roles = [];
  for (const part of String(value ?? '').split(',')) {
    const name = part.trim();
    if (!name) continue;
    if (!ROLE_NAME_RE.test(name)) return { roles, invalid: name };
    if (!roles.includes(name)) roles.push(name);
  }
  return { roles, invalid: null };
}

/**
 * "Assign parents": additively grant one or more parent roles on the `desired` clusters, merging
 * with current grants and any pending edits. See scopeMergeAdd for the semantics.
 * @param {string[]} roles parent-role names to grant
 * @param {Set<string>} desired clusterIds picked in the dialog
 */
function addParentScope(roles, desired) {
  for (const key of roles) {
    const add = new Set(alterAdd.get(key) || []);
    const rev = new Set(alterRevoke.get(key) || []);
    scopeMergeAdd(add, rev, clusterIdsWith(key), desired);
    if (add.size) alterAdd.set(key, add);
    else alterAdd.delete(key);
    if (rev.size) alterRevoke.set(key, rev);
    else alterRevoke.delete(key);
  }
}

function confirmScopeDialog() {
  const ctx = scopeDialogCtx;
  clearInlineError(document.getElementById('scope-error'));
  const desired = new Set(
    [...document.querySelectorAll('#scope-targets .scope-cluster-check')]
      .filter((cb) => cb.checked)
      .map((cb) => cb.dataset.cluster)
  );

  if (ctx && ctx.kind === 'presence') {
    confirmPresenceScope(desired);
    return;
  }

  if (ctx && ctx.kind === 'config') {
    confirmConfigScope(ctx, desired);
    return;
  }

  // Assign parents: any number at once — a comma-separated list typed in the field, and/or chips.
  if (!ctx) {
    const scopeErr = document.getElementById('scope-error');
    const { roles, invalid } = parseRoleNameList(document.getElementById('scope-role').value);
    if (invalid) {
      showInlineError(scopeErr, `Invalid role name: ${invalid}`);
      return;
    }
    for (const chip of document.querySelectorAll('#scope-preconfigured .pick-chip.active')) {
      if (!roles.includes(chip.dataset.role)) roles.push(chip.dataset.role);
    }
    if (!roles.length) {
      showInlineError(scopeErr, 'Enter at least one role name or pick a preconfigured one');
      return;
    }
    addParentScope(roles, desired);
    closeModal('scope-dialog');
    renderAlterDetail();
    return;
  }

  // Edit an existing parent/attribute (single key): desired becomes the exact target set.
  const key = ctx.key;
  const isAttr = ctx.kind === 'attr';
  const addMap = isAttr ? alterAttrAdd : alterAdd;
  const revMap = isAttr ? alterAttrRemove : alterRevoke;
  const cur = isAttr ? clusterIdsWithAttr(key) : clusterIdsWith(key);

  const { add: grant, rev: revoke } = scopeDiff(cur, desired);
  if (grant.size) addMap.set(key, grant);
  else addMap.delete(key);
  if (revoke.size) revMap.set(key, revoke);
  else revMap.delete(key);

  closeModal('scope-dialog');
  renderAlterDetail();
}

/** Apply the scope dialog for a role SETTING (name=value): SET on desired clusters,
 *  RESET on clusters that had this value but are no longer desired. */
function confirmConfigScope(ctx, desired) {
  let name;
  let origValue = null; // the value of the row being edited (its baseline clusters)
  if (ctx.isNew) {
    name = document.getElementById('scope-cname').value.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(name)) {
      showInlineError(document.getElementById('scope-error'), 'Invalid setting name (letters, digits, underscore, optional dot)');
      return;
    }
  } else {
    ({ name, value: origValue } = cfgParse(ctx.key));
  }
  // The value comes from the (editable) input in both add and edit modes; the name is
  // fixed when editing.
  const value = document.getElementById('scope-cvalue').value;
  applyConfigScope(name, value, origValue, ctx.isNew, desired);

  closeModal('scope-dialog');
  renderAlterDetail();
}

/**
 * Pure core of the settings scope editor (mutates alterConfigSet/alterConfigReset). Adding a
 * setting (isNew) is additive — it SETs the `desired` clusters via the shared scopeMergeAdd and
 * never RESETs a cluster just because it already carries the value elsewhere (the same additive
 * rule as "Assign parents"). Editing a row (isNew=false) also RESETs the clusters that leave the
 * row's original value (origValue). A cluster set to this value has any other pending value for
 * the same setting name cleared, since a role GUC holds one value per name.
 */
function applyConfigScope(name, value, origValue, isNew, desired) {
  const key = cfgKey(name, value);
  const curNew = clusterIdsWithConfig(name, value); // clusters already at this value
  const set = new Set(alterConfigSet.get(key) || []);
  const reset = new Set(alterConfigReset.get(name) || []);

  scopeMergeAdd(set, reset, curNew, desired);
  for (const cid of desired) {
    for (const [k, ids] of alterConfigSet) {
      if (k !== key && cfgParse(k).name === name && ids.has(cid)) {
        ids.delete(cid);
        if (!ids.size) alterConfigSet.delete(k);
      }
    }
  }
  // Only editing an existing row reduces coverage: RESET the clusters leaving origValue.
  if (!isNew) {
    for (const cid of clusterIdsWithConfig(name, origValue)) {
      if (!desired.has(cid)) {
        reset.add(cid);
        set.delete(cid);
      }
    }
  }
  if (set.size) alterConfigSet.set(key, set);
  else alterConfigSet.delete(key);
  if (reset.size) alterConfigReset.set(name, reset);
  else alterConfigReset.delete(name);
}

/** Apply the presence editor: create the role on newly-checked clusters (synthetic exists:false
 *  rows, so the rest of the form can target them) and drop it from unchecked real clusters. Real
 *  DB presence = the exists:true rows; the diff never mutates them, only flags removals. */
function confirmPresenceScope(desired) {
  const realPresent = new Set(alterDetails.filter((d) => d.exists).map((d) => d.clusterId));
  roleRemoveClusters = setMinus(realPresent, desired);
  const addIds = setMinus(desired, realPresent);
  const byId = new Map(alterScopeClusters.map((c) => [c.clusterId, c]));
  const syntheticRows = [...addIds]
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((c) => ({
      clusterId: c.clusterId,
      alias: c.alias,
      category: c.category,
      exists: false,
      comment: '',
      parents: [],
      attributes: {},
      settings: {},
    }));
  alterDetails = alterDetails.filter((d) => d.exists).concat(syntheticRows);
  reconcilePendingWithUniverse(); // drop pending grants pointing at no-longer-added clusters
  closeModal('scope-dialog');
  renderAlterDetail();
}

// --- Comments dialog (group clusters by comment, edit per group) ---

function buildCommentVersions() {
  // Group by canonical value so JSON comments differing only in formatting collapse into one
  // version. Seed each group from any staged override (so reopening shows pending edits),
  // else from the current DB comment.
  const map = new Map();
  for (const d of alterDetails) {
    const key = canonicalComment(d.comment);
    if (!map.has(key)) {
      const text = commentOverrides.has(d.clusterId) ? commentOverrides.get(d.clusterId) : d.comment || '';
      map.set(key, { text, ids: [] });
    }
    map.get(key).ids.push(d.clusterId);
  }
  commentVersions = [...map.values()];
  // One 2-mode editor model per version (same Fields/Raw editor as the inline one).
  commentVersionEditors = commentVersions.map((v) => editorFromComment(v.text, false));
}

function openCommentsDialog() {
  buildCommentVersions();
  renderCommentsDialog();
  const dlg = openModal('comments-dialog');
  // openModal already dropped the auto-focus from the header "?" badge (which would pop its
  // hint). Prefer focus on the first editable control if there is one.
  dlg?.querySelector('#comments-list textarea:not(.hidden), #comments-list input:not([disabled])')?.focus();
  hideQHint();
}

function renderCommentsDialog() {
  const box = document.getElementById('comments-list');
  box.innerHTML = commentVersions
    .map((v, i) => {
      const e = commentVersionEditors[i];
      const labels = scopeLabelsHtml(describeScope(new Set(v.ids)));
      const blockFields = commentFieldsBlocked(e); // non-JSON text → Fields would drop it
      const fieldsTitle = blockFields ? ' title="Comment is plain text (not JSON) — edit it in Raw"' : '';
      const useAll =
        commentVersions.length > 1
          ? `<button type="button" class="small" data-cv-useall="${i}">Use in all clusters</button>`
          : '<span></span>';
      return `<div class="comment-version">
        <div class="comment-scope">${labels || '<span class="hint">no clusters</span>'}</div>
        <div class="rce-toolbar">
          ${useAll}
          <div class="segmented rce-mode" data-cv-mode="${i}" role="group" aria-label="Comment editing mode">
            <button type="button" class="seg-btn ${e.mode === 'fields' ? 'active' : ''}" data-mode="fields"${blockFields ? ' disabled' : ''}${fieldsTitle}>Fields</button>
            <button type="button" class="seg-btn ${e.mode === 'raw' ? 'active' : ''}" data-mode="raw">Raw</button>
          </div>
        </div>
        <div class="rce-fields${e.mode !== 'fields' ? ' hidden' : ''}" data-cv-fields="${i}">${commentFieldInputsHtml(e, i, false)}</div>
        <textarea class="rce-raw comment-edit${e.mode !== 'raw' ? ' hidden' : ''}" data-cv-raw="${i}" rows="4" autocapitalize="none" spellcheck="false">${escapeHtml(e.raw)}</textarea>
        <p class="hint rce-notice"></p>
      </div>`;
    })
    .join('');
}

/** OK: stage each version's assembled comment into commentOverrides (per cluster) and close.
 *  Nothing is sent here — the edits publish with the other changes on "Save changes". */
function commitCommentsDialog() {
  commentVersions.forEach((v, i) => {
    const desired = assembleCommentFrom(commentVersionEditors[i]);
    for (const cid of v.ids) commentOverrides.set(cid, desired);
  });
  closeModal('comments-dialog');
  // If the reconciled comments are now all identical (whether via "Use in all clusters" or by
  // editing each group to the same value), the role has one consistent comment again: fold it into
  // the inline editor and drop the per-cluster overrides, so the "differ" banner clears on OK.
  const eff = alterDetails
    .filter((d) => d.exists)
    .map((d) => (commentOverrides.has(d.clusterId) ? commentOverrides.get(d.clusterId) : d.comment || ''));
  const folded = new Set(eff.map(canonicalComment)).size <= 1;
  if (folded) {
    commentEditor = editorFromComment(eff.length ? eff[0] : '', false);
    commentOverrides = new Map();
  }
  renderAlterDetail(); // reflect the staged/"edited" state (or the folded-consistent state)
  if (folded) renderCommentEditor(); // repaint the now-visible inline editor's field inputs
}

/** Build per-cluster ordered operation lists for the alter diff. Returns
 *  [{clusterId, operations:[{operation, <paramKey>:{…}}]}] for clusters with >=1 change.
 *  The backend runs each cluster's operations as one transaction. */
function buildAlterClusterOps() {
  /** @type {Array<{clusterId:string, operations:Array<object>}>} */
  const out = [];
  // The comment editor owns the consistent case: assemble the desired comment once and emit
  // set_comment per cluster where it actually changes. When comments vary across clusters the
  // inline editor is disabled and per-cluster desired comments come from the Comments dialog
  // (commentOverrides).
  const desiredInline = commentEditor.varies ? null : assembleComment();
  // A staged rename runs first on every existing cluster, so every later op addresses the new name.
  const login = alterRenameTo || alterSelected;

  for (const d of alterDetails) {
    // Presence: a cluster flagged for removal gets a single remove_role (nothing else, so it is not
    // renamed and drops the OLD name); a synthetic exists:false row (Alter presence-add) gets a
    // create_role prepended to its grant/comment diff.
    if (roleRemoveClusters.has(d.clusterId)) {
      out.push({ clusterId: d.clusterId, operations: [{ operation: 'remove_role', removeRole: { loginName: alterSelected } }] });
      continue;
    }

    const ops = [];
    const parents = d.parents || [];
    const toGrant = [...alterAdd.entries()]
      .filter(([role, ids]) => ids.has(d.clusterId) && !parents.includes(role))
      .map(([role]) => role);
    const toRevoke = [...alterRevoke.entries()]
      .filter(([role, ids]) => ids.has(d.clusterId) && parents.includes(role))
      .map(([role]) => role);
    if (toGrant.length) {
      ops.push({ operation: 'grant_parents', grantParents: { loginName: login, parentRoles: toGrant.join(',') } });
    }
    if (toRevoke.length) {
      ops.push({ operation: 'revoke_parents', revokeParents: { loginName: login, parentRoles: toRevoke.join(',') } });
    }
    if (alterDoPassword) {
      // Checkbox alone stages the op; an empty value is a legitimate reset (PASSWORD '').
      ops.push({ operation: 'change_password', changePassword: { loginName: login, newPassword: alterPassword } });
    }

    // Attributes: combine all enable/disable keywords into ONE ALTER ROLE … WITH … statement.
    const kws = [];
    for (const a of ROLE_ATTRIBUTES) {
      const on = !!(d.attributes && d.attributes[a.key]);
      const enableIds = alterAttrAdd.get(a.key);
      const disableIds = alterAttrRemove.get(a.key);
      if (enableIds && enableIds.has(d.clusterId) && !on) kws.push(a.on);
      else if (disableIds && disableIds.has(d.clusterId) && on) kws.push(a.off);
    }
    if (kws.length) {
      ops.push({ operation: 'set_attribute', setAttribute: { loginName: login, attribute: kws.join(' ') } });
    }

    // Settings: SET name=value where pending & not already that value; RESET where pending.
    const settings = d.settings || {};
    for (const [key, ids] of alterConfigSet) {
      if (!ids.has(d.clusterId)) continue;
      const { name, value } = cfgParse(key);
      if (settings[name] !== value) {
        ops.push({ operation: 'set_config', setConfig: { loginName: login, configName: name, configValue: value } });
      }
    }
    for (const [name, ids] of alterConfigReset) {
      if (ids.has(d.clusterId) && Object.prototype.hasOwnProperty.call(settings, name)) {
        ops.push({ operation: 'reset_config', resetConfig: { loginName: login, configName: name } });
      }
    }

    // Comment via set_comment: a staged per-cluster override (varies case) wins; otherwise the
    // inline editor's assembled comment. Emit only on a real change.
    const desiredComment = commentOverrides.has(d.clusterId) ? commentOverrides.get(d.clusterId) : desiredInline;
    if (desiredComment !== null && canonicalComment(desiredComment) !== canonicalComment(d.comment || '')) {
      ops.push({
        operation: 'set_comment',
        setComment: { loginName: login, comment: desiredComment, commentFields: commentFieldArgs(desiredComment) },
      });
    }

    // Rename: prepended to an existing cluster's diff, so the password (hashed under the new name —
    // what an MD5 site needs) and everything else apply to the renamed role in the same transaction.
    if (d.exists && alterRenameTo) {
      ops.unshift({ operation: 'rename_role', renameRole: { loginName: alterSelected, newLoginName: alterRenameTo } });
    }

    // Alter presence-add: create the role first (Create mode has its own buildCreateClusterOps, so
    // guard against double-prepending there). ${parent_roles} carries this cluster's granted
    // parents (same as the follow-up grant_parents below); comment-field placeholders come from the
    // comment this cluster gets (varies-with-no-override ⇒ null ⇒ bare create, all fields NULL).
    if (!d.exists && !isCreateMode()) {
      ops.unshift({
        operation: 'create_role',
        createRole: {
          loginName: login,
          parentRoles: toGrant.join(','),
          commentFields: commentFieldArgs(desiredComment || ''),
        },
      });
    }

    if (ops.length) out.push({ clusterId: d.clusterId, operations: ops });
  }
  return out;
}

/** Warn if any staged set_comment stores a non-empty, non-JSON comment (plain text). */
function warnIfPlainTextComment(clusters) {
  const plain = clusters.some((c) =>
    c.operations.some(
      (op) => op.operation === 'set_comment' && op.setComment.comment && !parseCommentObject(op.setComment.comment).isObject
    )
  );
  if (plain) showInlineError(document.getElementById('ops-error'), 'Note: comment saved as plain text (not JSON)');
}

async function saveAlterations() {
  const errEl = document.getElementById('ops-error');
  const btn = document.getElementById('btn-alter-save');
  clearInlineError(errEl);
  if (!requireBackend(errEl, btn)) return;
  const clusters = buildAlterClusterOps();
  if (!clusters.length) return; // Save is disabled when clean; nothing to do
  const renamedTo = alterRenameTo;
  if (renamedTo && !(await confirmRename(errEl, btn))) return;

  // Pending presence removals are a lone remove_role — pre-flight them like the Remove role
  // button does. Cancelling aborts the whole save (as cancelling the production confirm does);
  // skipping a cluster drops only that cluster's removal, the other edits still publish.
  const removalIds = clusters
    .filter((c) => c.operations.length === 1 && c.operations[0].operation === 'remove_role')
    .map((c) => c.clusterId);
  let send = clusters;
  if (removalIds.length) {
    let allowed;
    try {
      if (btn) btn.disabled = true;
      allowed = await preflightRemoval(removalIds, { confirmLabel: 'Save changes', requireAny: false });
    } finally {
      if (btn) btn.disabled = false; // still dirty at this point, so re-enabling is correct
    }
    if (!allowed) return;
    send = filterSkippedRemovals(clusters, allowed);
    if (!send.length) return;
  }
  warnIfPlainTextComment(send);

  const results = await executeRoleBatch(send, 'Changes saved');
  if (!results) return; // blocked/cancelled/threw — leave the form untouched
  if (results.some((r) => r.status !== 'ok')) return; // any error → keep form + pending edits (chip/popup report it)
  flashButton(btn, { text: 'Saved', cls: 'flash-ok' });
  // Fully successful: the password change (if any) is now live on every cluster, so always clear the
  // staged password NOW — both the state and the on-screen controls — so "Set password" can never
  // stay checked (and re-apply on the next Save) regardless of what the reload/re-render below does.
  clearPasswordEditor();
  if (!alterSelected) return;
  // Fully successful: the role now goes by its new name everywhere we touched — load it under that.
  if (renamedTo) {
    alterSelected = renamedTo;
    alterRenameTo = '';
  }
  // Fully successful: the comment we sent is now live on every cluster. Reconcile the local comment
  // baseline optimistically and drop the staged overrides, so the "Comments differ" banner reflects
  // what we just wrote even if a cluster is momentarily unreachable on the reload below (otherwise
  // the reload guard would skip the refresh and leave a stale "differ" view).
  const desiredInline = commentEditor.varies ? null : assembleComment();
  for (const d of alterDetails) {
    const dc = commentOverrides.has(d.clusterId) ? commentOverrides.get(d.clusterId) : desiredInline;
    if (dc !== null) d.comment = dc;
  }
  commentOverrides = new Map();
  // Prefer the authoritative DB reload, but ONLY when it is clean so a transient unreachable cluster
  // can never wipe the form; otherwise keep the optimistic baseline above. Either way re-render so
  // the comment editor + differ banner update.
  const fresh = await fetchRoleDetails();
  if (fresh && fresh.valid.length && !fresh.errors.length) {
    alterDetails = fresh.valid;
    resetEditMaps();
  }
  loadCommentEditor();
  renderAlterDetail(); // recomputes dirty ⇒ Save disabled when nothing remains
}

/** Save pre-flight for a staged rename: validate the new name, then look it up across the searched
 *  scope. Where it already exists the rename (or a presence-add's create) would fail on that cluster
 *  alone and leave the role named differently across clusters, so a collision is a STOP — a
 *  Close-only popup, nothing sent. Otherwise the only thing left to say is the MD5 note: asked about
 *  when it applies, and no popup at all when it doesn't (Set password ticked, or suppressed).
 *  Resolves false to abort the whole Save. */
async function confirmRename(errEl, btn) {
  const from = alterSelected;
  const to = alterRenameTo;
  if (!ROLE_NAME_RE.test(to)) {
    showInlineError(errEl, 'Enter a login name (no commas)');
    flashButton(btn, { cls: 'flash-err' });
    return false;
  }
  const kept = alterDetails.filter((d) => !roleRemoveClusters.has(d.clusterId));
  const renamed = kept.filter((d) => d.exists).sort(byGroupThenAlias).map((d) => d.alias);
  let taken = [];
  try {
    if (btn) btn.disabled = true;
    const found = await backend().LoadRoleDetails({
      loginName: to,
      categoryIds: alterTargets.categoryIds,
      clusterIds: alterTargets.clusterIds,
      auth: getAuth(),
    });
    const keptIds = new Set(kept.map((d) => d.clusterId));
    taken = (found || []).filter((d) => d.exists && keptIds.has(d.clusterId)).sort(byGroupThenAlias).map((d) => d.alias);
  } catch {
    /* pre-flight is best-effort (as in Create); a collision still surfaces per cluster on run */
  } finally {
    if (btn) btn.disabled = false; // still dirty at this point, so re-enabling is correct
  }
  if (taken.length) {
    await askConfirmWithCheck(
      'Name already exists',
      `"${to}" already exists on ${taken.join(', ')}. The rename would fail there while going ahead on the other clusters, leaving the role named differently across clusters — so nothing was saved. Choose another name.`,
      { canProceed: false }
    );
    return false;
  }
  if (alterDoPassword || state?.ui?.suppressMd5RenameWarning) return true;
  const { ok, checked } = await askConfirmWithCheck(
    'Rename role',
    `Rename "${from}" to "${to}" on ${renamed.join(', ') || 'no existing cluster'}.\n\n` +
      'A password stored as an MD5 hash is cleared by a rename (SCRAM passwords are kept). Tick Set password to set a new one in the same save.',
    { checkLabel: 'Suppress this warning' }
  );
  if (checked) await suppressMD5RenameWarning();
  return ok;
}

/** Persist ui.suppress_md5_rename_warning from the Rename confirm. Writes the SAVED ui block (not the
 *  Settings page's drafts), then mirrors the new value into the Settings checkbox so that page
 *  neither turns dirty nor keeps showing the old value. A failure only costs the user seeing the
 *  note again, so it is logged rather than surfaced. */
async function suppressMD5RenameWarning() {
  const ui = { ...(state?.ui || {}), suppressMd5RenameWarning: true };
  try {
    await backend().SaveUISettings(ui);
  } catch (e) {
    console.error('saving the MD5 warning suppression failed', e);
    return;
  }
  if (state) state.ui = ui;
  const c = /** @type {HTMLInputElement} */ (document.getElementById('ui-suppress-md5'));
  if (c) c.checked = true;
  refreshSettingsDirty();
}

/** Remove the role on every cluster where it exists (immediate, red button). */
async function removeRole() {
  const errEl = document.getElementById('ops-error');
  const btn = document.getElementById('btn-alter-remove');
  clearInlineError(errEl);
  if (!requireBackend(errEl, btn)) return;
  // Only real (exists:true) clusters — never a pending synthetic add-row from the presence editor.
  const realRows = alterDetails.filter((d) => d.exists);
  if (!realRows.length) return;
  // The dependency popup IS the confirmation: it lists what depends on the role per cluster and
  // lets the user skip the clusters that would break (the default) or drop them anyway.
  let allowed;
  try {
    if (btn) btn.disabled = true;
    allowed = await preflightRemoval(realRows.map((d) => d.clusterId), {
      confirmLabel: 'Remove role',
      requireAny: true,
    });
  } finally {
    if (btn) btn.disabled = false;
  }
  if (!allowed || !allowed.size) return; // cancelled, failed, or every cluster skipped
  const clusters = realRows
    .filter((d) => allowed.has(d.clusterId))
    .map((d) => ({
      clusterId: d.clusterId,
      operations: [{ operation: 'remove_role', removeRole: { loginName: alterSelected } }],
    }));
  const results = await executeRoleBatch(clusters, 'Role removed');
  if (!results) return; // blocked/cancelled/threw — leave the form untouched
  if (results.some((r) => r.status !== 'ok')) return; // any error → keep form (role may still exist somewhere)
  // Removed everywhere: reset the form to the empty state, but keep the "Role removed" run-status
  // chip (an empty post-removal load would otherwise clear it).
  await reloadDetails({ keepRunStatus: true });
}

/** Run a per-cluster batch: each cluster's operations execute as ONE transaction on the backend
 *  (all-or-nothing per cluster), clusters concurrent, one result row per cluster. Gates on the
 *  production confirm first and reports through the run-status chip.
 *
 *  Returns the per-cluster results array (which may still contain per-cluster errors), or `null`
 *  when blocked/cancelled before execution or on a hard throw. Callers must NOT let a null or a
 *  partially-failed result mutate the form — the chip/popup are the outcome surface. */
async function executeRoleBatch(clusters, successMsg, phaseName = '') {
  const app = requireBackend(document.getElementById('ops-error'));
  if (!app) return null;
  const prodInvolved = clusters.some((c) => categoryConfirm(clusterCategory(c.clusterId)));
  if (prodInvolved) {
    const ok = await askConfirm('Production', 'This action includes PRODUCTION clusters. Continue?');
    if (!ok) return null;
  }

  // Seed the footer status chip and listen for live per-cluster progress during the run.
  beginRunStatus(clusters, phaseName);
  const off = window.runtime?.EventsOn?.('role-batch-progress', applyRunProgress);

  let results;
  try {
    results = await app.RunRoleBatch({ clusters, auth: getAuth(), confirmProduction: true });
  } catch (e) {
    off?.();
    failRunStatus(String(e)); // chip → Error; the message shows per-cluster in the status popup
    return null;
  }
  off?.();
  results = results || [];
  finishRunStatus(results); // chip → OK / Error (n/total) — the sole run-outcome surface
  return results;
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
    // The per-page action groups (Create/Alter role, the Clusters actions) live in the tabs bar;
    // each declares the page it belongs to, so a new group needs no code here.
    document
      .querySelectorAll('.tab-actions')
      .forEach((group) => group.classList.toggle('hidden', group.dataset.for !== tab.dataset.tab));
    // Leaving/entering a page discards stale run status so it never bleeds across pages.
    clearRunStatus();
  });
});

document.querySelectorAll('.op-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    currentOp = tab.dataset.op;
    clearRunStatus();
    document.querySelectorAll('.op-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    if (isCreateMode()) {
      // Fresh, empty create form over the current target selection.
      resetEditMaps();
      loadCommentEditor(); // clears the identity inputs
      synthCreateBaseline();
      renderAlterDetail();
      updateOpsFooter();
    } else {
      // Alter doubles as "find role": clear state, show the prompt, open the search popup.
      alterSelected = null;
      alterDetails = [];
      resetEditMaps();
      renderAlterDetail();
      updateOpsFooter();
      openSearchDialog();
    }
  });
});

// Dependency popup: the segmented Skip/Try anyway per cluster (carried by a .deps-cluster block
// in the Dependencies section or a <tr> in the Could-not-be-checked table), the titlebar SQL
// magnifier, and the two footer buttons. Rows are rebuilt on every render, so the list is delegated.
document.getElementById('deps-list')?.addEventListener('click', (ev) => {
  const seg = ev.target.closest('.deps-choice .seg-btn');
  if (!seg) return;
  const owner = seg.closest('[data-cluster-id]');
  if (!owner) return;
  depsChoices.set(owner.dataset.clusterId, seg.dataset.choice);
  renderDepsDialog();
});
document.getElementById('deps-reload')?.addEventListener('click', reloadDeps);
document.getElementById('deps-view-sql')?.addEventListener('click', () => {
  // All clusters run the identical query, so show the first one we have.
  const queries = depsRows.find((r) => (r.queries || []).length)?.queries || [];
  if (queries.length) showQueriesDialog('Dependency query', queries);
});
document.getElementById('deps-ok')?.addEventListener('click', () => closeDepsDialog(depsAllowedSet()));
document.getElementById('deps-cancel')?.addEventListener('click', () => closeDepsDialog(null));
document.getElementById('deps-dialog')?.addEventListener('cancel', (ev) => {
  ev.preventDefault(); // resolve the promise ourselves, then close
  closeDepsDialog(null);
});

document.getElementById('run-status')?.addEventListener('click', () => openRunStatusDialog(runState));
document.getElementById('search-status')?.addEventListener('click', () => openRunStatusDialog(searchState));
document.getElementById('run-status-dialog-close')?.addEventListener('click', () => {
  closeModal('run-status-dialog');
});
document.getElementById('run-queries-close')?.addEventListener('click', () => {
  closeModal('run-queries-dialog');
});
document.getElementById('run-queries-copy')?.addEventListener('click', async (ev) => {
  // Opened from a status row → copy its message + queries; opened from the dependency
  // popup → copy exactly what is on screen.
  const row = runQueriesClusterId ? statusDialogState?.byId.get(runQueriesClusterId) : null;
  const text = row ? runStatusCopyText(row) : document.getElementById('run-queries-pre')?.textContent || '';
  if (!text) return;
  const btn = ev.currentTarget;
  try {
    await navigator.clipboard.writeText(text);
    // No toast: it renders beneath the modal overlay. The button label is the feedback.
    const prev = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = prev; }, 1500);
  } catch (e) {
    console.error('clipboard copy failed', e);
  }
});

document.getElementById('btn-add-cluster').addEventListener('click', () => openClusterDialog(null));
document.getElementById('btn-save-clusters')?.addEventListener('click', saveClusters);
document.getElementById('btn-discard-clusters')?.addEventListener('click', discardClusters);

document.getElementById('cluster-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const form = ev.target;
  const input = clusterInputFromForm(form);
  const errEl = document.getElementById('cluster-test-error');
  if (!input.alias || !input.host || !input.database || !input.category) {
    showInlineError(errEl, 'Alias, host, database and group are required');
    return;
  }
  // Draft cluster uses the model's field names (sslmode/connectUser). Persisted on Clusters Save.
  const draft = {
    alias: input.alias, host: input.host, port: input.port, database: input.database,
    category: input.category, sslmode: input.sslMode, connectUser: input.connectUser,
    password: input.password,
  };
  const id = form.id.value;
  if (id) {
    const i = clustersDraft.findIndex((c) => c.id === id);
    if (i >= 0) clustersDraft[i] = { ...clustersDraft[i], ...draft };
  } else {
    clustersDraft.push({ id: `tmp_${++tmpClusterSeq}`, ...draft });
  }
  closeModal('cluster-dialog');
  renderClustersTable();
});

document.getElementById('cluster-form').addEventListener('click', (ev) => {
  if (ev.target.value === 'cancel') {
    closeModal('cluster-dialog');
    return;
  }
  togglePwReveal(ev.target);
});

/** Set a password reveal toggle to the revealed (eye-off) or masked (eye) state. */
function setPwToggle(toggle, revealed) {
  toggle.innerHTML = revealed ? ICONS.eyeOff : ICONS.eye;
  toggle.setAttribute('aria-label', revealed ? 'Hide password' : 'Show password');
}

/** Flip the `.pw-field` input this toggle sits in between masked and revealed. Shared by the
 *  cluster editor and the role form so both password fields behave identically. Returns true when
 *  the click actually hit a toggle (so callers can early-return). */
function togglePwReveal(target) {
  const toggle = target.closest?.('.pw-toggle');
  if (!toggle) return false;
  const input = toggle.closest('.pw-field')?.querySelector('input');
  if (input) {
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    setPwToggle(toggle, reveal);
  }
  return true;
}

// Generic transient button feedback (replaces the corner toast for confirmations/errors).
// text: optional temporary label (e.g. "Saved"); cls: 'flash-ok' | 'flash-err'.
const flashTimers = new WeakMap();
function flashButton(btn, { text, cls } = {}) {
  if (!btn) return;
  (flashTimers.get(btn) || []).forEach(clearTimeout);
  const label = btn.dataset.flashLabel || (btn.dataset.flashLabel = btn.textContent);
  btn.style.minWidth = `${btn.getBoundingClientRect().width}px`;
  btn.classList.remove('flash-fade');
  if (cls) btn.classList.add(cls);
  if (text) btn.textContent = text;
  const timers = [];
  timers.push(
    setTimeout(() => {
      if (text) btn.textContent = label;
      btn.classList.add('flash-fade');
      void btn.offsetWidth; // commit the flash colour + transition before removing it
      if (cls) btn.classList.remove(cls);
      timers.push(
        setTimeout(() => {
          btn.classList.remove('flash-fade');
          btn.style.minWidth = '';
        }, 900)
      );
    }, 1200)
  );
  flashTimers.set(btn, timers);
}

/** Cancel any in-flight flash and restore the button's resting label/width — for reopening a
 *  dialog whose button may still be mid-animation from the previous time it was used. */
function resetFlash(btn) {
  if (!btn) return;
  (flashTimers.get(btn) || []).forEach(clearTimeout);
  flashTimers.delete(btn);
  btn.classList.remove('flash-ok', 'flash-err', 'flash-fade');
  btn.style.minWidth = '';
  if (btn.dataset.flashLabel) btn.textContent = btn.dataset.flashLabel;
}

// Toggle a Save button's unsaved-changes state: enabled when there are changes, disabled (inert)
// when clean — no extra marker (the enabled/disabled state is the signal, like Alter's Save).
function setDirty(btn, dirty) {
  if (!btn) return;
  btn.disabled = !dirty;
}

// Inline error text near a control (a `.form-error` element).
function showInlineError(el, msg) {
  if (!el) return;
  el.textContent = String(msg);
  el.classList.remove('hidden');
}
function clearInlineError(el) {
  if (!el) return;
  el.textContent = '';
  el.classList.add('hidden');
}

document.getElementById('btn-test-cluster').addEventListener('click', async () => {
  const app = backend();
  const form = document.getElementById('cluster-form');
  const errEl = document.getElementById('cluster-test-error');
  errEl.classList.add('hidden');
  errEl.textContent = '';

  const input = clusterInputFromForm(form);
  const auth = { user: input.connectUser, password: '' };
  try {
    // Test the on-screen values (works for unsaved/new clusters too).
    await app.TestConnectionInput(input, auth);
    flashButton(document.getElementById('btn-test-cluster'), { text: 'OK', cls: 'flash-ok' });
  } catch (e) {
    errEl.textContent = String(e);
    errEl.classList.remove('hidden');
  }
});

document.getElementById('btn-run').addEventListener('click', runOperation);
document.getElementById('btn-test-clusters').addEventListener('click', testAllClusters);
document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
document.getElementById('btn-discard-settings')?.addEventListener('click', discardSettings);

// Keyed by id rather than a `.config-path-copy` selector: that class is reused as a generic
// icon-button elsewhere.
for (const [btnId, pathId] of [['btn-copy-config-path', 'config-path'], ['btn-copy-clusters-path', 'clusters-path']]) {
  document.getElementById(btnId)?.addEventListener('click', (ev) => {
    copyWithFeedback(ev.currentTarget, document.getElementById(pathId).textContent || '');
  });
}

document.getElementById('btn-toggle-clusters')?.addEventListener('click', () => {
  setClusterListExpanded(document.getElementById('cluster-checkboxes').classList.contains('hidden'));
});

// Cluster groups editor: a popup (list) reached from the Clusters toolbar, with a
// second popup for add/edit — mirrors how clusters are managed.
document.getElementById('btn-manage-groups')?.addEventListener('click', () => {
  renderGroupsTable();
  openModal('groups-dialog');
});
document.getElementById('groups-dialog-close')?.addEventListener('click', () => {
  closeModal('groups-dialog');
});
document.getElementById('btn-add-group')?.addEventListener('click', () => openGroupDialog(null));

document.getElementById('group-form')?.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const form = ev.target;
  const label = form.label.value.trim();
  const errEl = document.getElementById('group-error');
  clearInlineError(errEl);
  if (!label) {
    showInlineError(errEl, 'Label is required');
    return;
  }
  const color = form.color.value;
  const confirm = form.confirm.checked;
  const id = form.id.value;
  if (id) {
    const i = categoriesDraft.findIndex((c) => c.id === id); // edit keeps the id (stable slug)
    if (i >= 0) categoriesDraft[i] = { ...categoriesDraft[i], label, color, confirm };
  } else {
    const newId = jsSlugify(label);
    if (!newId) {
      showInlineError(errEl, 'Label must contain a letter or digit');
      return;
    }
    if (categoriesDraft.some((c) => c.id === newId)) {
      showInlineError(errEl, `A group with id "${newId}" already exists`);
      return;
    }
    categoriesDraft.push({ id: newId, label, color, confirm });
  }
  closeModal('group-dialog');
  renderCategoryColors();
  renderGroupsTable();
  refreshClustersDirty();
});

document.getElementById('group-form')?.addEventListener('click', (ev) => {
  if (ev.target.value === 'cancel') closeModal('group-dialog');
});

// Alter role tab wiring
function openSearchDialog() {
  const dlg = document.getElementById('search-dialog');
  const scope = document.getElementById('alter-search-scope');
  if (scope) {
    const clusters = resolveSelectedClusters();
    scope.textContent = clusters.length
      ? `Comparing ${clusters.length} selected cluster(s): ${clusters.map((c) => c.alias).join(', ')}`
      : 'No clusters selected — pick groups/clusters in Target selection first.';
  }
  // Never reopen with stale results: a prior search's scope may not match the current Target
  // selection, so picking one of those cached matches could load the form against the wrong
  // clusters. Clear the results/errors. Keep the last term in the field but select it, so the
  // next keystroke replaces it with a fresh search (and it can still be re-run as-is).
  alterGroups = [];
  document.getElementById('alter-results').innerHTML = '';
  document.getElementById('alter-search-errors').textContent = '';
  searchState = null; // the popup's status belongs to the search it ran, not to the next one
  renderSearchStatus();
  openModal(dlg);
  const term = document.getElementById('alter-search-term');
  term?.focus();
  term?.select();
}
document.getElementById('search-dialog-close')?.addEventListener('click', () => {
  closeModal('search-dialog');
});
document.getElementById('btn-alter-search')?.addEventListener('click', runRoleSearch);
document.getElementById('alter-search-term')?.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    runRoleSearch();
  } else if (ev.key === 'Escape') {
    // type=search would otherwise just clear the field (swallowing Esc) instead of the
    // native <dialog> Esc-to-close. Force the close regardless of the field's content.
    ev.preventDefault();
    closeModal('search-dialog');
  }
});

document.getElementById('alter-results')?.addEventListener('click', (ev) => {
  const row = ev.target.closest('.alter-result-row');
  if (row) pickUser(row.dataset.login);
});

document.getElementById('alter-detail')?.addEventListener('click', (ev) => {
  const target = ev.target;
  if (togglePwReveal(target)) return; // password reveal eye — nothing else to do
  if (target.closest?.('#btn-gen-password')) { generatePasswordIntoField(); return; }
  if (target.closest?.('#btn-copy-password')) { copyGeneratedPassword(target.closest('#btn-copy-password')); return; }
  const chipBtn = target.closest('[data-act]');
  if (chipBtn) {
    const { act, kind, key } = chipBtn.dataset;
    if (act === 'scope') {
      openScopeDialog({ kind, key });
      return;
    }
    if (kind === 'config') {
      const { name, value } = cfgParse(key);
      const cur = clusterIdsWithConfig(name, value);
      if (act === 'revoke') {
        alterConfigSet.delete(key);
        if (cur.size) {
          const reset = new Set(alterConfigReset.get(name) || []);
          for (const cid of cur) reset.add(cid);
          alterConfigReset.set(name, reset);
        }
      } else if (act === 'deladd') {
        alterConfigSet.delete(key);
      } else if (act === 'reset') {
        alterConfigSet.delete(key);
        const reset = alterConfigReset.get(name);
        if (reset) {
          for (const cid of cur) reset.delete(cid);
          if (!reset.size) alterConfigReset.delete(name);
        }
      }
      renderAlterDetail();
      return;
    }
    const isAttr = kind === 'attr';
    const addMap = isAttr ? alterAttrAdd : alterAdd;
    const revMap = isAttr ? alterAttrRemove : alterRevoke;
    const cur = isAttr ? clusterIdsWithAttr(key) : clusterIdsWith(key);
    if (act === 'revoke') {
      // Quick remove everywhere it currently applies.
      addMap.delete(key);
      if (cur.size) revMap.set(key, new Set(cur));
    } else if (act === 'deladd') {
      addMap.delete(key);
    } else if (act === 'reset') {
      addMap.delete(key);
      revMap.delete(key);
    }
    renderAlterDetail();
    return;
  }
  if (target.closest('#btn-alter-add')) {
    if (isCreateMode() && !alterDetails.length) {
      showInlineError(document.getElementById('ops-error'), 'Select at least one group or cluster first');
      return;
    }
    openScopeDialog(null);
    return;
  }
  if (target.closest('#btn-alter-add-config')) {
    if (isCreateMode() && !alterDetails.length) {
      showInlineError(document.getElementById('ops-error'), 'Select at least one group or cluster first');
      return;
    }
    openScopeDialog({ kind: 'config', isNew: true });
    return;
  }
  if (target.closest('#btn-alter-comments')) {
    openCommentsDialog();
  }
});

// The "Present on" block sits ABOVE #alter-detail (a sibling), so its ✎ needs its own listener.
document.getElementById('role-present')?.addEventListener('click', (ev) => {
  if (ev.target.closest('#btn-present-edit')) openScopeDialog({ kind: 'presence' });
});

// Save / Remove live in the pinned footer (outside #alter-detail).
document.getElementById('btn-alter-save')?.addEventListener('click', saveAlterations);
document.getElementById('btn-alter-remove')?.addEventListener('click', removeRole);

document.getElementById('alter-detail')?.addEventListener('change', (ev) => {
  if (ev.target.id === 'alter-do-pw') {
    alterDoPassword = ev.target.checked;
    syncPasswordControls();
    updateOpsFooter();
  }
});

document.getElementById('alter-detail')?.addEventListener('input', (ev) => {
  if (ev.target.id === 'alter-password') {
    alterPassword = ev.target.value;
    updateOpsFooter();
  }
});

// Login name: in Alter mode a name different from the loaded one stages a rename (blank = none).
function onRoleLoginInput() {
  if (isCreateMode() || !alterSelected) return;
  const v = document.getElementById('role-login')?.value.trim() || '';
  alterRenameTo = v && v !== alterSelected ? v : '';
  renderRenameState();
  updateOpsFooter();
}
/** Put the loaded name back in the field and drop the staged rename. */
function revertRename() {
  const login = document.getElementById('role-login');
  if (login) login.value = alterSelected || '';
  onRoleLoginInput();
}
document.getElementById('role-login')?.addEventListener('input', onRoleLoginInput);
document.getElementById('role-login')?.addEventListener('change', () => {
  // Leaving the field blank stages nothing — show the name that will actually be kept.
  if (!isCreateMode() && alterSelected && !document.getElementById('role-login')?.value.trim()) revertRename();
});
document.getElementById('role-rename')?.addEventListener('click', (ev) => {
  if (ev.target.closest('#btn-rename-revert')) revertRename();
});

// Comment editor: value/raw edits write straight into commentEditor (never clobbered by
// renderAlterDetail, which does not touch #role-comment-editor), then re-evaluate Save's dirty
// state — a comment edit is a pending change like any other.
function onCommentEditorInput(ev) {
  const t = ev.target;
  if (t.dataset && t.dataset.cfKey) commentEditor.values[t.dataset.cfKey] = t.value;
  else if (t.id === 'rce-raw') {
    commentEditor.raw = t.value;
    // Live-disable Fields when the raw text stops being a JSON object (would drop content).
    const fieldsBtn = document.querySelector('#rce-mode .seg-btn[data-mode="fields"]');
    if (fieldsBtn) {
      const block = commentFieldsBlocked(commentEditor);
      fieldsBtn.disabled = block;
      fieldsBtn.title = block ? 'Comment is plain text (not JSON) — edit it in Raw' : '';
    }
  }
  updateOpsFooter();
}
document.getElementById('role-comment-editor')?.addEventListener('input', onCommentEditorInput);
document.getElementById('rce-mode')?.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.seg-btn');
  if (btn) {
    switchCommentMode(btn.dataset.mode);
    updateOpsFooter();
  }
});

// Scope dialog
document.getElementById('scope-dialog-ok')?.addEventListener('click', confirmScopeDialog);
document.getElementById('scope-dialog-cancel')?.addEventListener('click', () => {
  closeModal('scope-dialog');
});
document.getElementById('scope-preconfigured')?.addEventListener('click', (ev) => {
  const chip = ev.target.closest('.pick-chip');
  if (chip) chip.classList.toggle('active');
});
document.getElementById('scope-targets')?.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.classList.contains('scope-group-check')) {
    // Ticking a group toggles all its (enabled) clusters.
    document
      .querySelectorAll(`#scope-targets .scope-cluster-check[data-cat="${CSS.escape(t.dataset.cat)}"]`)
      .forEach((cb) => {
        if (!cb.disabled) cb.checked = t.checked;
      });
  }
  // Re-derive every group head from its clusters (checked / indeterminate) after any toggle.
  refreshScopeGroupChecks();
});

// Comments dialog — edits stage locally; Cancel discards, OK keeps them (published on
// "Save changes" together with the other edits).
document.getElementById('comments-dialog-cancel')?.addEventListener('click', () => {
  closeModal('comments-dialog');
});
document.getElementById('comments-dialog-ok')?.addEventListener('click', commitCommentsDialog);
document.getElementById('comments-list')?.addEventListener('click', (ev) => {
  // "Use in all clusters": broadcast this version's comment to every version editor (staged; the
  // groups collapse into one only after OK re-groups them by canonical value).
  const useAllBtn = ev.target.closest('[data-cv-useall]');
  if (useAllBtn) {
    const idx = Number(useAllBtn.dataset.cvUseall);
    const src = commentVersionEditors[idx];
    if (src) {
      const text = assembleCommentFrom(src);
      commentVersionEditors = commentVersions.map(() => editorFromComment(text, false));
      renderCommentsDialog();
    }
    return;
  }
  // Fields/Raw toggle for a version.
  const modeBtn = ev.target.closest('[data-cv-mode] .seg-btn');
  if (modeBtn) {
    const idx = Number(modeBtn.closest('[data-cv-mode]').dataset.cvMode);
    const e = commentVersionEditors[idx];
    if (e) {
      switchEditorMode(e, modeBtn.dataset.mode);
      renderCommentsDialog();
    }
  }
});
// Value/raw edits write straight into the per-version editor model.
document.getElementById('comments-list')?.addEventListener('input', (ev) => {
  const t = ev.target;
  const idx = t.dataset.cvIdx != null ? Number(t.dataset.cvIdx) : (t.dataset.cvRaw != null ? Number(t.dataset.cvRaw) : null);
  if (idx == null || !commentVersionEditors[idx]) return;
  if (t.dataset.cfKey) commentVersionEditors[idx].values[t.dataset.cfKey] = t.value;
  else if (t.dataset.cvRaw != null) {
    commentVersionEditors[idx].raw = t.value;
    const fieldsBtn = document.querySelector(`[data-cv-mode="${idx}"] .seg-btn[data-mode="fields"]`);
    if (fieldsBtn) {
      const block = commentFieldsBlocked(commentVersionEditors[idx]);
      fieldsBtn.disabled = block;
      fieldsBtn.title = block ? 'Comment is plain text (not JSON) — edit it in Raw' : '';
    }
  }
});

document.getElementById('ui-theme')?.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.seg-btn');
  if (!btn) return;
  setThemeButtons(btn.dataset.pref);
  applyTheme(btn.dataset.pref);
  refreshSettingsDirty();
});

document.getElementById('comment-view-pref')?.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.seg-btn');
  if (btn) setCommentViewButtons(btn.dataset.pref);
  refreshSettingsDirty();
});

document.getElementById('batch-concurrency')?.addEventListener('input', refreshSettingsDirty);
document.getElementById('ui-stage-create')?.addEventListener('change', refreshSettingsDirty);
document.getElementById('ui-suppress-md5')?.addEventListener('change', refreshSettingsDirty);
document.getElementById('ui-check-updates')?.addEventListener('change', refreshSettingsDirty);
document.getElementById('pwgen-length')?.addEventListener('input', refreshSettingsDirty);
['pwgen-lower', 'pwgen-upper', 'pwgen-digits', 'pwgen-symbols', 'pwgen-exclude-similar'].forEach((id) =>
  document.getElementById(id)?.addEventListener('change', refreshSettingsDirty)
);

document.getElementById('fn-help')?.addEventListener('click', () => {
  openModal('template-help-dialog');
});

document.getElementById('template-help-close')?.addEventListener('click', () => {
  closeModal('template-help-dialog');
});

// About dialog: the header ⓘ opens it; the version chips are filled from the backend;
// link buttons open in the user's default browser via the Wails runtime.
async function initAbout() {
  try {
    const v = await backend()?.GetAppVersion?.();
    const ver = v?.version ? `v${v.version}` : '';
    if (ver) {
      for (const id of ['app-version', 'about-version']) {
        const el = document.getElementById(id);
        if (el) { el.textContent = ver; el.hidden = false; }
      }
    }
    // Point the About links at the repo/docs URLs derived from the git remote (falls back to
    // the hardcoded data-url in index.html when unavailable, e.g. no backend).
    const docs = document.getElementById('about-docs');
    if (docs && v?.docsURL) docs.dataset.url = v.docsURL;
    const repo = document.getElementById('about-repo');
    if (repo && v?.repoURL) repo.dataset.url = v.repoURL;
  } catch { /* best-effort — keep the static fallbacks */ }
}
document.getElementById('btn-about')?.addEventListener('click', () => {
  openModal('about-dialog');
});
document.getElementById('about-close')?.addEventListener('click', () => {
  closeModal('about-dialog');
});
document.getElementById('about-dialog')?.addEventListener('click', (ev) => {
  const link = ev.target.closest?.('[data-url]');
  if (!link) return;
  ev.preventDefault();
  window.runtime?.BrowserOpenURL?.(link.dataset.url);
});

// ------------------------------------------------------------------
// Update check (GitHub Releases)
// ------------------------------------------------------------------

/** @type {object|null} last CheckForUpdate result, so the About dialog can reflect it. */
let updateState = null;

/**
 * Reflect the latest update-check result on the header About button as a small accent dot.
 * Driven by `updateState`, so both the manual "Check for updates" press and the startup
 * auto-check light it (each sets `updateState` then calls this).
 */
function renderUpdateBadge() {
  const btn = document.getElementById('btn-about');
  const badge = document.getElementById('update-badge');
  if (!btn || !badge) return;
  const available = !!updateState?.updateAvailable;
  badge.hidden = !available;
  btn.title = available ? `Update available — v${updateState.latestVersion}` : 'About pgCowboy';
}

/** Render the About "Version" status line from the latest check result. */
function renderAboutUpdate(res, error) {
  const el = document.getElementById('about-update');
  if (!el) return;
  if (error) { el.textContent = 'Couldn’t check for updates.'; return; }
  if (!res) { el.textContent = ''; return; }
  if (res.updateAvailable) {
    // The delegated [data-url] handler on #about-dialog turns this into a BrowserOpenURL link.
    el.innerHTML = `Update available: <strong>v${escapeHtml(res.latestVersion)}</strong> — ` +
      `<a href="#" class="about-link-inline" data-url="${escapeAttr(res.releaseURL)}">View release</a>`;
  } else {
    el.textContent = `You’re up to date (v${res.currentVersion}).`;
  }
}

/** Populate + open the update popup for an available update. */
function showUpdateDialog(res) {
  const msg = document.getElementById('update-message');
  if (msg) {
    msg.textContent = `pgCowboy v${res.latestVersion} is available — you have v${res.currentVersion}.`;
  }
  const link = document.getElementById('update-release-link');
  if (link) link.dataset.url = res.releaseURL || '';
  openModal('update-dialog');
}

/**
 * Check GitHub Releases for a newer version. Best-effort — never throws to the user.
 * `manual` = the user pressed "Check for updates" (always pops the dialog when an update
 * exists); the auto/startup path only pops for a version not already dismissed.
 */
async function checkForUpdate(manual) {
  const app = backend();
  if (!app?.CheckForUpdate) return;
  // Manual press: give tactile feedback — disable the button, show "Pending…" in
  // the status line above it, and keep the whole thing on screen for at least 1s
  // (the actual check is near-instant, which otherwise reads as "nothing happened").
  const btn = manual ? document.getElementById('btn-check-update') : null;
  const status = manual ? document.getElementById('about-update') : null;
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Pending…';
  let res;
  try {
    const [result] = await Promise.all([
      app.CheckForUpdate(),
      manual ? new Promise((r) => setTimeout(r, 1000)) : Promise.resolve(),
    ]);
    res = result;
  } catch {
    if (btn) btn.disabled = false;
    if (manual) renderAboutUpdate(null, true);
    return;
  }
  if (btn) btn.disabled = false;
  updateState = res;
  renderUpdateBadge();
  renderAboutUpdate(res);
  if (!res.updateAvailable) return;
  if (manual) {
    showUpdateDialog(res);
    // A manual check counts as "seen" too: persist it (like the auto path) so it survives
    // restart and the startup popup won't re-nag for a version the user already saw here.
    persistSeenVersion(res.latestVersion);
  } else if (res.latestVersion && res.latestVersion !== state?.updateSeenVersion) {
    showUpdateDialog(res);
    persistSeenVersion(res.latestVersion);
  }
}

/** Record the release version as "seen" both in memory and in the private config. */
function persistSeenVersion(v) {
  if (!v) return;
  if (state) state.updateSeenVersion = v;
  backend()?.SetUpdateSeenVersion?.(v);
}

/**
 * Light the update badge + About line from the persisted "seen" version (no network call), so a
 * previously-found update survives restart. Best-effort; only adopts a still-pending update so it
 * never clobbers a fresh result. `GetPendingUpdate` reports "not available" once we've upgraded.
 */
async function restorePendingUpdate() {
  const app = backend();
  if (!app?.GetPendingUpdate) return;
  try {
    const res = await app.GetPendingUpdate();
    if (res?.updateAvailable) {
      updateState = res;
      renderUpdateBadge();
      renderAboutUpdate(res);
    }
  } catch { /* best-effort: the network check (if enabled) is the authoritative path */ }
}

document.getElementById('btn-check-update')?.addEventListener('click', () => checkForUpdate(true));
document.getElementById('update-close')?.addEventListener('click', () => {
  closeModal('update-dialog');
});
document.getElementById('update-dismiss')?.addEventListener('click', () => {
  closeModal('update-dialog');
});
document.getElementById('update-dialog')?.addEventListener('click', (ev) => {
  const link = ev.target.closest?.('[data-url]');
  if (!link) return;
  ev.preventDefault();
  window.runtime?.BrowserOpenURL?.(link.dataset.url);
});

// DB command templates: click a name to edit its type + template in a popup.
document.getElementById('db-functions-editor')?.addEventListener('click', (ev) => {
  const row = ev.target.closest('.fn-row');
  if (row) openTemplateDialog('write', row.dataset.fnKey);
});
document.getElementById('db-reads-editor')?.addEventListener('click', (ev) => {
  const row = ev.target.closest('.fn-row');
  if (row) openTemplateDialog('read', row.dataset.readKey);
});

// Settings list editors (comment fields, role parents, Find-role columns): in-place edit,
// drag-to-reorder, remove, add. One wiring loop over LIST_EDITORS — see that table for what
// differs between the three.
for (const spec of LIST_EDITORS) {
  const repaint = () => renderListEditor(spec.id);

  document.getElementById(spec.id)?.addEventListener('input', (ev) => {
    const el = ev.target;
    const idx = Number(el.dataset.idx);
    const draft = spec.get();
    if (!Number.isInteger(idx) || draft[idx] == null) return;
    spec.edit(draft, idx, el);
    refreshSettingsDirty();
  });

  wireListEditor(spec.id, spec.get, repaint);

  document.getElementById(spec.addId)?.addEventListener('click', () => {
    spec.get().push(spec.blank());
    repaint();
    document.querySelector(`#${spec.id} .le-row:last-child ${spec.focus}`)?.focus();
  });
}
document.getElementById('fn-dialog-done')?.addEventListener('click', () => {
  if (fnDialogMode === 'read') {
    if (fnDialogKey && dbReadsDraft[fnDialogKey]) {
      dbReadsDraft[fnDialogKey] = { query: document.getElementById('fn-call').value };
    }
  } else if (fnDialogKey && dbFnDraft[fnDialogKey]) {
    dbFnDraft[fnDialogKey] = {
      call: document.getElementById('fn-call').value,
      execution: document.getElementById('fn-execution').value,
    };
    renderDBFunctionsRow(fnDialogKey);
  }
  closeModal('fn-dialog');
  fnDialogKey = null;
  refreshSettingsDirty();
});
// Revert the open template to its built-in vanilla default (staged, not saved until "Done").
// The defaults come from the backend (GetDefaultTemplates), so there is exactly one definition
// of "vanilla" in the project.
document.getElementById('fn-dialog-default')?.addEventListener('click', () => {
  if (!defaultTemplates) return; // not fetched (no backend) — leave the template alone
  const isRead = fnDialogMode === 'read';
  const meta = (isRead ? DB_READS : DB_FUNCTIONS).find((e) => e.key === fnDialogKey);
  if (!meta) return;
  if (isRead) {
    document.getElementById('fn-call').value = defaultTemplates.dbReads?.[meta.prop]?.query || '';
    return;
  }
  const def = defaultTemplates.dbFunctions?.[meta.prop] || {};
  document.getElementById('fn-call').value = def.call || '';
  document.getElementById('fn-execution').value = def.execution || 'function';
});
document.getElementById('fn-dialog-cancel')?.addEventListener('click', () => {
  closeModal('fn-dialog');
  fnDialogKey = null;
});
// Insert a ${placeholder} at the cursor in the call template.
document.getElementById('fn-placeholder-list')?.addEventListener('click', (ev) => {
  const chip = ev.target.closest('.ph-chip');
  if (!chip) return;
  const ta = document.getElementById('fn-call');
  const token = chip.dataset.token || '';
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + token + ta.value.slice(end);
  ta.focus();
  const caret = start + token.length;
  ta.setSelectionRange(caret, caret);
});

window.addEventListener('DOMContentLoaded', async () => {
  document.documentElement.setAttribute('data-theme', 'dark');
  configureInputCapitalization();
  syncQHintLabels();
  initAbout();
  await loadConfig();
  // Startup only: surface a restored cluster pick, which loadConfig has just rendered inside the
  // collapsed "Or pick clusters" list.
  revealPickedClusters();
  // The app opens on Create role; build the comment editor now so it honours the configured
  // preferred view (loadCommentEditor otherwise runs only on op-tab entry / role load).
  loadCommentEditor();
  // Restore the "update available" badge from the persisted result (no network), so an update
  // found by an earlier check — manual or auto — survives restart and lights the badge even when
  // the startup auto-check is off. Awaited so the authoritative network check (below) wins.
  await restorePendingUpdate();
  // Opt-in (default on): check GitHub Releases for a newer version, non-blocking.
  if (autoCheckUpdates()) checkForUpdate(false);
});

// Persist the OS window size (debounced) so it's restored on next launch. Save Wails'
// WindowGetSize — NOT window.innerWidth: the viewport excludes the OS chrome, so saving it
// would shrink the window by that much on every restart.
let winSizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(winSizeTimer);
  winSizeTimer = setTimeout(() => {
    window.runtime?.WindowGetSize?.()
      .then((s) => { if (s && s.w > 0 && s.h > 0) backend()?.SaveWindowSize(s.w, s.h); })
      .catch(() => {});
  }, 500);
});
