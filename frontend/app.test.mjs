// Unit tests for the comment / consensus / presence logic in app.js.
//
// The frontend has no build step and no package.json (see CLAUDE.md), so these tests use only the
// Node built-ins (`node --test`, `node:vm`) — no framework, no dependencies. app.js is a classic
// browser script full of top-level DOM wiring; we load it into a vm context behind a permissive
// DOM stub (the DOMContentLoaded init never fires, so loading only defines the globals), then drive
// the real functions. Snippets run in the SAME context so they can read/write app.js's top-level
// `let` state (alterDetails, commentEditor, …) by bare name, exactly like the browser console.
//
// Run:  node --test frontend/app.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'app.js'), 'utf8');

// --- Minimal permissive DOM/BOM stub (enough for app.js to load without throwing) -------------
function makeEl() {
  return new Proxy(function () {}, {
    get(_t, prop) {
      switch (prop) {
        case 'classList':
          return { add() {}, remove() {}, toggle() {}, contains() { return false; } };
        case 'style': return {};
        case 'dataset': return {};
        case 'value': return '';
        case 'checked': case 'readOnly': case 'disabled': case 'hidden': return false;
        case 'innerHTML': case 'textContent': case 'title': case 'className':
        case 'placeholder': case 'id': case 'type': return '';
        case 'selectionStart': case 'selectionEnd': return 0;
        case 'closest': case 'querySelector': return () => null;
        case 'querySelectorAll': return () => [];
        case 'getBoundingClientRect':
          return () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 });
        case 'children': case 'childNodes': return [];
        case 'parentNode': case 'parentElement': case 'nextSibling': return null;
        case 'getAttribute': return () => null;
        case 'addEventListener': case 'removeEventListener': case 'setAttribute':
        case 'removeAttribute': case 'appendChild': case 'append': case 'prepend':
        case 'insertBefore': case 'remove': case 'focus': case 'blur': case 'click':
        case 'showModal': case 'close': case 'setSelectionRange': case 'dispatchEvent':
        case 'scrollIntoView': case 'cloneNode':
          return () => {};
        default:
          return makeEl();
      }
    },
    set() { return true; },
    apply() { return makeEl(); },
  });
}

const documentStub = {
  getElementById: () => makeEl(),
  querySelector: () => makeEl(),
  querySelectorAll: () => [],
  createElement: () => makeEl(),
  addEventListener: () => {},
  documentElement: makeEl(),
  body: makeEl(),
  head: makeEl(),
};

const sandbox = {};
sandbox.window = sandbox; // window === global, matches the browser
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
sandbox.document = documentStub;
sandbox.navigator = { clipboard: { writeText: async () => {} } };
sandbox.CSS = { escape: (s) => String(s) };
sandbox.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
// Nothing is laid out here, so every resolved value is empty — callers must cope with that.
sandbox.getComputedStyle = () => ({ columnGap: '', gap: '', fontSize: '', width: '' });
sandbox.addEventListener = () => {}; // window.addEventListener('DOMContentLoaded', …) at load
sandbox.removeEventListener = () => {};
sandbox.console = console;
sandbox.setTimeout = () => 0;
sandbox.clearTimeout = () => {};
// Unlike setTimeout above, this one DOES invoke its callback, so a deferred-to-next-frame side
// effect (revealPickedClusters' scroll) is observable synchronously in a test.
sandbox.requestAnimationFrame = (fn) => { fn(); return 0; };
// applyTheme installs a 5s poll when the host is Linux; record the registration instead of
// letting it fire, so a test can assert the poll exists without waiting on a timer.
sandbox.__intervals = [];
sandbox.setInterval = (fn, ms) => sandbox.__intervals.push({ fn, ms });
sandbox.clearInterval = () => {};

const ctx = vm.createContext(sandbox);
vm.runInContext(source, ctx, { filename: 'app.js' });

// Evaluate an expression string in the app.js context and bring the (JSON-serialised) result back
// into this realm — avoids cross-realm prototype mismatches in assert.deepEqual.
function evalJSON(expr) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, ctx));
}

// Same, for an expression that evaluates to a promise.
async function evalJSONAsync(expr) {
  return JSON.parse(await vm.runInContext(`(async () => JSON.stringify(await (${expr})))()`, ctx));
}

// Put the theme module state back to "nothing probed yet" and install recorders for the two
// things applyTheme writes to: <html data-theme> and the Wails runtime's native-theme calls.
// `platform`/`systemDark` drive the two answers a "system" resolve can consult.
const themeSetup = ({ platform, systemDark = false, mediaDark = false }) => `
  isLinuxHost = null; systemThemeMedia = null; systemThemePoll = null; __intervals.length = 0;
  document.documentElement = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; },
                               getAttribute(k) { return this.attrs[k] ?? null; } };
  matchMedia = () => ({ matches: ${mediaDark}, addEventListener() {}, removeEventListener() {} });
  window.__probes = 0;
  window.runtime = { Environment: async () => ({ platform: '${platform}' }),
                     WindowSetSystemDefaultTheme() {}, WindowSetLightTheme() {}, WindowSetDarkTheme() {} };
  window.__gtk = [];
  window.go = { main: { App: {
    IsSystemDark: async () => { window.__probes++; return ${systemDark}; },
    SetNativeDarkTheme: async (d) => { window.__gtk.push(d); },
  } } };
`;

// Shared config: two configured comment fields, Fields as the default empty view.
const SETUP_STATE =
  `state = { ui:{commentDefaultView:'fields'}, commentFields:[{key:'full_name',label:'Full name'},{key:'e_mail',label:'Email'}] };`;

// ---------------------------------------------------------------------------------------------
test('canonicalComment: JSON is key-order / whitespace insensitive; non-JSON is verbatim', () => {
  const r = evalJSON(`(() => ({
    sameObject: canonicalComment('{"a":1,"b":2}') === canonicalComment('{ "b":2, "a":1 }'),
    differ: canonicalComment('{"a":1}') !== canonicalComment('{"a":2}'),
    plain: canonicalComment('hello') === 'hello',
  }))()`);
  assert.equal(r.sameObject, true);
  assert.equal(r.differ, true);
  assert.equal(r.plain, true);
});

// ---------------------------------------------------------------------------------------------
test('editorFromComment: null is an editable empty string (no readonly / no ⚠)', () => {
  const r = evalJSON(`(() => {
    ${SETUP_STATE}
    const e = editorFromComment('{"full_name":null}', false);
    return { isReadonly: e.readonly.has('full_name'), value: e.values['full_name'], mode: e.mode };
  })()`);
  assert.equal(r.isReadonly, false);
  assert.equal(r.value, '');
  assert.equal(r.mode, 'fields');
});

test('editorFromComment: non-string (number) stays read-only and shown as JSON', () => {
  const r = evalJSON(`(() => {
    ${SETUP_STATE}
    const e = editorFromComment('{"count":5}', false);
    return { isReadonly: e.readonly.has('count'), value: e.values['count'] };
  })()`);
  assert.equal(r.isReadonly, true);
  assert.equal(r.value, '5');
});

test('editorFromComment: the configured preference decides the mode, except for plain text', () => {
  const r = evalJSON(`(() => {
    ${SETUP_STATE}
    const plain = editorFromComment('just text', false).mode;
    const empty = editorFromComment('', false).mode;
    const json = editorFromComment('{"full_name":"A"}', false).mode;
    state.ui.commentDefaultView = 'raw';
    const emptyRaw = editorFromComment('', false).mode;
    // The point of the change: a JSON comment no longer overrides a Raw preference.
    const jsonRaw = editorFromComment('{"full_name":"A"}', false).mode;
    const plainRaw = editorFromComment('just text', false).mode;
    return { plain, empty, json, emptyRaw, jsonRaw, plainRaw };
  })()`);
  assert.equal(r.plain, 'raw');
  assert.equal(r.empty, 'fields');
  assert.equal(r.json, 'fields');
  assert.equal(r.emptyRaw, 'raw');
  assert.equal(r.jsonRaw, 'raw');
  assert.equal(r.plainRaw, 'raw');
});

test('commentFieldInputsHtml: says so rather than rendering an empty box', () => {
  const r = evalJSON(`(() => {
    state = { ui:{}, commentFields: [] };
    const e = editorFromComment('', false);
    const empty = commentFieldInputsHtml(e, null, false);
    state.commentFields = [{key:'full_name',label:'Full name'}];
    const withField = commentFieldInputsHtml(editorFromComment('', false), null, false);
    return { empty, hasInput: withField.includes('data-cf-key="full_name"') };
  })()`);
  assert.match(r.empty, /rce-empty/);
  assert.match(r.empty, /No comment fields configured/);
  assert.equal(r.hasInput, true);
});

test('commentFields: no built-in fallback, so an emptied list stays empty', () => {
  const r = evalJSON(`(() => {
    state = { ui:{}, commentFields: [] };
    const emptied = commentFields().length;
    state = { ui:{} };
    const absent = commentFields().length;
    return { emptied, absent };
  })()`);
  assert.equal(r.emptied, 0);
  assert.equal(r.absent, 0);
});

test('preferredCommentView: raw unless fields is explicitly configured', () => {
  const r = evalJSON(`(() => {
    state = { ui:{} };
    const unset = preferredCommentView();
    state.ui.commentDefaultView = 'fields';
    const fields = preferredCommentView();
    state.ui.commentDefaultView = 'raw';
    const raw = preferredCommentView();
    return { unset, fields, raw };
  })()`);
  assert.equal(r.unset, 'raw');
  assert.equal(r.fields, 'fields');
  assert.equal(r.raw, 'raw');
});

// ---------------------------------------------------------------------------------------------
test('assembleCommentFrom: empty & all-blank comment serialises to ""', () => {
  const r = evalJSON(`(() => {
    ${SETUP_STATE}
    const e = editorFromComment('', false); // both configured fields blank, none in baseObj
    return assembleCommentFrom(e);
  })()`);
  assert.equal(r, '');
});

test('assembleCommentFrom: a loaded null round-trips as null', () => {
  const r = evalJSON(`(() => {
    ${SETUP_STATE}
    const e = editorFromComment('{"full_name":null}', false);
    return canonicalComment(assembleCommentFrom(e)) === canonicalComment('{"full_name":null}');
  })()`);
  assert.equal(r, true);
});

test('assembleCommentFrom: clearing an existing string field stores null; a never-present field is dropped', () => {
  const r = evalJSON(`(() => {
    ${SETUP_STATE}
    const e = editorFromComment('{"full_name":"A","e_mail":"x"}', false);
    e.values['full_name'] = '';                 // clear a field that was in the comment
    return canonicalComment(assembleCommentFrom(e)) === canonicalComment('{"full_name":null,"e_mail":"x"}');
  })()`);
  assert.equal(r, true);
});

test('assembleCommentFrom: read-only non-string value is preserved untouched', () => {
  const r = evalJSON(`(() => {
    ${SETUP_STATE}
    const e = editorFromComment('{"count":5,"full_name":"A"}', false);
    return canonicalComment(assembleCommentFrom(e)) === canonicalComment('{"count":5,"full_name":"A"}');
  })()`);
  assert.equal(r, true);
});

// ---------------------------------------------------------------------------------------------
// commentConsensus.varies drives the "Comments differ" banner / inline-vs-dialog mode.
function consensus(rows) {
  return evalJSON(`(() => {
    ${SETUP_STATE}
    alterDetails = ${JSON.stringify(rows)};
    return commentConsensus();
  })()`);
}
const existing = (comment) => ({ clusterId: 'c' + Math.random().toString(36).slice(2), exists: true, comment });

test('commentConsensus: identical comments do not vary', () => {
  assert.equal(consensus([existing('{"full_name":"A"}'), existing('{"full_name":"A"}')]).varies, false);
});

test('commentConsensus: an UNSET comment on one cluster (others equal) counts as a divergence', () => {
  assert.equal(consensus([existing('{"full_name":"A"}'), existing('{"full_name":"A"}'), existing('')]).varies, true);
});

test('commentConsensus: all-unset does not vary', () => {
  assert.equal(consensus([existing(''), existing('')]).varies, false);
});

test('commentConsensus: a pending presence-add (exists:false) never triggers a false divergence', () => {
  const rows = [existing('{"full_name":"A"}'), existing('{"full_name":"A"}'),
    { clusterId: 'cX', exists: false, comment: '' }];
  assert.equal(consensus(rows).varies, false);
});

// ---------------------------------------------------------------------------------------------
// buildAlterClusterOps: presence (create/remove) + comment publishing.
function buildOps(setup) {
  return evalJSON(`(() => {
    ${SETUP_STATE}
    currentOp = 'alter_user';
    alterSelected = 'bob';
    resetEditMaps();
    ${setup}
    return buildAlterClusterOps().map(c => ({ clusterId: c.clusterId, ops: c.operations.map(o => o.operation),
      comment: (c.operations.find(o => o.operation === 'set_comment') || {}).setComment &&
               c.operations.find(o => o.operation === 'set_comment').setComment.comment }));
  })()`);
}

test('buildAlterClusterOps: unchanged consistent-comment role is not dirty (idempotent load)', () => {
  const ops = buildOps(`
    alterDetails = [
      { clusterId:'c1', exists:true, comment:'{"full_name":"A"}', parents:[], attributes:{}, settings:{} },
      { clusterId:'c2', exists:true, comment:'{"full_name":"A"}', parents:[], attributes:{}, settings:{} },
    ];
    commentEditor = editorFromComment('{"full_name":"A"}', false);`);
  assert.deepEqual(ops, []);
});

// Typing into the loaded role's comment editor must enable Save changes — in both modes. The
// handler used to update commentEditor without re-evaluating the footer, so Save stayed disabled.
function saveEnabledAfterCommentInput(mode, target) {
  return evalJSON(`(() => {
    ${SETUP_STATE}
    state.ui.commentDefaultView = '${mode}';
    currentOp = 'alter_user';
    alterSelected = 'bob';
    resetEditMaps();
    alterDetails = [{ clusterId:'c1', exists:true, comment:'{"full_name":"A"}', parents:[], attributes:{}, settings:{} }];
    commentEditor = editorFromComment('{"full_name":"A"}', false);
    const save = { disabled: true };
    const realGet = document.getElementById;
    document.getElementById = (id) => (id === 'btn-alter-save' ? save : realGet(id));
    try {
      updateOpsFooter();
      const before = !save.disabled;
      onCommentEditorInput({ target: ${target} });
      return { before, after: !save.disabled };
    } finally {
      document.getElementById = realGet;
    }
  })()`);
}

test('comment editor: a Fields edit enables Save changes', () => {
  assert.deepEqual(
    saveEnabledAfterCommentInput('fields', `{ dataset: { cfKey: 'full_name' }, value: 'B' }`),
    { before: false, after: true });
});

test('comment editor: a Raw edit enables Save changes', () => {
  assert.deepEqual(
    saveEnabledAfterCommentInput('raw', `{ dataset: {}, id: 'rce-raw', value: '{"full_name":"B"}' }`),
    { before: false, after: true });
});

test('buildAlterClusterOps: presence-add with a consistent comment → create_role + set_comment(consistent)', () => {
  const ops = buildOps(`
    alterScopeClusters = [{clusterId:'c1',alias:'c1',category:'p'},{clusterId:'cX',alias:'cX',category:'p'}];
    alterDetails = [
      { clusterId:'c1', exists:true, comment:'{"full_name":"A"}', parents:[], attributes:{}, settings:{} },
      { clusterId:'cX', exists:false, comment:'', parents:[], attributes:{}, settings:{} },
    ];
    commentEditor = editorFromComment('{"full_name":"A"}', false);`);
  const cX = ops.find((o) => o.clusterId === 'cX');
  assert.deepEqual(cX.ops, ['create_role', 'set_comment']);
  assert.equal(evalJSON(`canonicalComment(${JSON.stringify(cX.comment)})`), evalJSON(`canonicalComment('{"full_name":"A"}')`));
  assert.equal(ops.find((o) => o.clusterId === 'c1'), undefined); // existing cluster unchanged
});

test('buildAlterClusterOps: presence-add while comments vary → create_role only (created bare)', () => {
  const ops = buildOps(`
    alterScopeClusters = [{clusterId:'cX',alias:'cX',category:'p'}];
    alterDetails = [{ clusterId:'cX', exists:false, comment:'', parents:[], attributes:{}, settings:{} }];
    commentEditor = editorFromComment('', true); /* varies */`);
  assert.deepEqual(ops.find((o) => o.clusterId === 'cX').ops, ['create_role']);
});

test('buildAlterClusterOps: a cluster flagged for removal → remove_role only', () => {
  const ops = buildOps(`
    alterDetails = [
      { clusterId:'c1', exists:true, comment:'{"full_name":"A"}', parents:['gr_x'], attributes:{}, settings:{} },
    ];
    commentEditor = editorFromComment('{"full_name":"A"}', false);
    roleRemoveClusters = new Set(['c1']);`);
  assert.deepEqual(ops, [{ clusterId: 'c1', ops: ['remove_role'] }]);
});

test('buildAlterClusterOps: a pending grant emits grant_parents', () => {
  const ops = buildOps(`
    alterDetails = [{ clusterId:'c1', exists:true, comment:'{"full_name":"A"}', parents:[], attributes:{}, settings:{} }];
    commentEditor = editorFromComment('{"full_name":"A"}', false);
    alterAdd.set('gr_new', new Set(['c1']));`);
  assert.deepEqual(ops, [{ clusterId: 'c1', ops: ['grant_parents'] }]);
});

// ---------------------------------------------------------------------------------------------
// Rename: a staged alterRenameTo is the FIRST op of each existing cluster's transaction, and every op
// after it addresses the new name. Returns [{clusterId, ops:[{op, login, …}]}].
function renameOps(setup) {
  return evalJSON(`(() => {
    ${SETUP_STATE}
    currentOp = 'alter_user';
    alterSelected = 'bob';
    resetEditMaps();
    alterRenameTo = 'robert';
    alterDetails = [{ clusterId:'c1', exists:true, comment:'', parents:[], attributes:{}, settings:{} }];
    commentEditor = editorFromComment('', false);
    ${setup}
    return buildAlterClusterOps().map((c) => ({ clusterId: c.clusterId, ops: c.operations.map((o) => {
      const p = Object.values(o).find((v) => v && typeof v === 'object');
      return o.operation === 'rename_role'
        ? { op: o.operation, from: p.loginName, to: p.newLoginName }
        : { op: o.operation, login: p.loginName };
    }) }));
  })()`);
}

test('rename: a rename alone is one rename_role per existing cluster (so Save is dirty)', () => {
  assert.deepEqual(renameOps(''), [{ clusterId: 'c1', ops: [{ op: 'rename_role', from: 'bob', to: 'robert' }] }]);
});

test('rename: runs first, and the later ops (incl. the password) use the new name', () => {
  const r = renameOps(`
    alterAdd.set('gr_new', new Set(['c1']));
    alterDoPassword = true; alterPassword = 'pw';`);
  assert.deepEqual(r[0].ops, [
    { op: 'rename_role', from: 'bob', to: 'robert' },
    { op: 'grant_parents', login: 'robert' },
    { op: 'change_password', login: 'robert' },
  ]);
});

test('rename: a presence-add creates the NEW name and is not renamed', () => {
  const r = renameOps(`
    alterDetails.push({ clusterId:'cX', exists:false, comment:'', parents:[], attributes:{}, settings:{} });`);
  assert.deepEqual(r.find((c) => c.clusterId === 'cX').ops, [{ op: 'create_role', login: 'robert' }]);
});

test('rename: a presence-remove drops the OLD name and is not renamed', () => {
  const r = renameOps(`roleRemoveClusters = new Set(['c1']);`);
  assert.deepEqual(r, [{ clusterId: 'c1', ops: [{ op: 'remove_role', login: 'bob' }] }]);
});

test('rename: typing a new login stages it; the loaded name or a blank field stages nothing', () => {
  const r = evalJSON(`(() => {
    ${SETUP_STATE}
    currentOp = 'alter_user';
    alterSelected = 'bob';
    resetEditMaps();
    alterDetails = [{ clusterId:'c1', exists:true, comment:'', parents:[], attributes:{}, settings:{} }];
    commentEditor = editorFromComment('', false);
    const input = { value: '' };
    const save = { disabled: true };
    const realGet = document.getElementById;
    document.getElementById = (id) => (id === 'role-login' ? input : id === 'btn-alter-save' ? save : realGet(id));
    try {
      const step = (v) => { input.value = v; onRoleLoginInput(); return { to: alterRenameTo, save: !save.disabled }; };
      return [step(' robert '), step('bob'), step('  ')];
    } finally {
      document.getElementById = realGet;
    }
  })()`);
  assert.deepEqual(r, [{ to: 'robert', save: true }, { to: '', save: false }, { to: '', save: false }]);
});

test('rename: the ↺ is always shown for a loaded role, disabled until a rename is staged', () => {
  const r = evalJSON(`(() => {
    ${SETUP_STATE}
    currentOp = 'alter_user';
    alterSelected = 'bob';
    resetEditMaps();
    const box = { innerHTML: '', hidden: false, classList: { toggle(_c, on) { box.hidden = on; } } };
    const realGet = document.getElementById;
    document.getElementById = (id) => (id === 'role-rename' ? box : realGet(id));
    try {
      const snap = () => ({ hidden: box.hidden, disabled: / disabled>/.test(box.innerHTML),
        title: (box.innerHTML.match(/title="([^"]*)"/) || [])[1] || '', text: box.innerHTML.replace(/<[^>]*>/g, '') });
      renderRenameState();
      const clean = snap();
      alterRenameTo = 'robert';
      renderRenameState();
      const staged = snap();
      currentOp = 'create_role';
      renderRenameState();
      return { clean, staged, create: snap() };
    } finally {
      document.getElementById = realGet;
    }
  })()`);
  assert.deepEqual(r.clean, { hidden: false, disabled: true, title: 'Undo rename', text: '' });
  assert.deepEqual(r.staged, { hidden: false, disabled: false, title: 'Renamed from: bob', text: '' }); // no visible label
  assert.equal(r.create.hidden, true);
});

// confirmRename with the backend + popup stubbed. `found` = clusters where the NEW name already
// exists; the popup stub records each ask and ticks the checkbox whenever one is offered.
function renameConfirm(steps, found = []) {
  return evalJSONAsync(`(async () => {
    ${SETUP_STATE}
    currentOp = 'alter_user';
    alterSelected = 'bob';
    resetEditMaps();
    alterRenameTo = 'robert';
    alterDetails = [
      { clusterId:'c1', alias:'c1', category:'p', exists:true, comment:'', parents:[], attributes:{}, settings:{} },
      { clusterId:'c2', alias:'c2', category:'p', exists:true, comment:'', parents:[], attributes:{}, settings:{} },
    ];
    const saved = [];
    window.go = { main: { App: {
      LoadRoleDetails: async () => ${JSON.stringify(found)}.map((id) => ({ clusterId:id, alias:id, category:'p', exists:true })),
      SaveUISettings: async (ui) => { saved.push({ ...ui }); },
    } } };
    const asked = [];
    const realAsk = askConfirmWithCheck;
    askConfirmWithCheck = async (title, message, { checkLabel = '', canProceed = true } = {}) => {
      asked.push({ title, md5: /MD5/.test(message), checkLabel, canProceed });
      return { ok: canProceed, checked: !!checkLabel };
    };
    try {
      const results = [];
      ${steps}
      return { results, asked, saved: saved.map((u) => u.suppressMd5RenameWarning) };
    } finally {
      askConfirmWithCheck = realAsk;
    }
  })()`);
}

test('rename confirm: the MD5 note offers "Suppress this warning"; once suppressed there is no popup at all', async () => {
  const r = await renameConfirm(`
    results.push(await confirmRename(null, null));   // asks, user ticks Suppress
    results.push(await confirmRename(null, null));   // suppressed → straight through
    state.ui.suppressMd5RenameWarning = false;
    alterDoPassword = true;                           // Set password ticked → nothing to warn about
    results.push(await confirmRename(null, null));`);
  assert.deepEqual(r.results, [true, true, true]);
  assert.deepEqual(r.asked, [{ title: 'Rename role', md5: true, checkLabel: 'Suppress this warning', canProceed: true }]);
  assert.deepEqual(r.saved, [true]); // persisted once, from the only popup
});

test('rename confirm: a name collision is a Close-only stop, even with the MD5 note suppressed', async () => {
  const r = await renameConfirm(`
    state.ui.suppressMd5RenameWarning = true;
    results.push(await confirmRename(null, null));`, ['c2']);
  assert.deepEqual(r.results, [false]);
  assert.deepEqual(r.asked, [{ title: 'Name already exists', md5: false, checkLabel: '', canProceed: false }]);
  assert.deepEqual(r.saved, []);
});

// Regression: the parents selected for a newly-created role must reach BOTH the create_role
// template's ${parent_roles} AND the follow-up grant_parents (per cluster).
test('buildCreateClusterOps: create_role and grant_parents both carry the selected parents', () => {
  const r = evalJSON(`(() => {
    ${SETUP_STATE}
    const _origResolve = resolveSelectedClusters; // shared vm context — restore to avoid leaking
    try {
      state.clusters = [{id:'c1',alias:'c1',category:'p'},{id:'c2',alias:'c2',category:'p'}];
      currentOp = 'create_role';
      resetEditMaps();
      resolveSelectedClusters = () => state.clusters;   // stub the DOM-checkbox read
      alterDetails = state.clusters.map((c) => ({ clusterId:c.id, exists:false, comment:'', parents:[], attributes:{}, settings:{} }));
      alterSelected = 'bob';
      alterAdd.set('gr_admin', new Set(['c1','c2']));
      alterAdd.set('gr_ro', new Set(['c1']));           // c1 gets two parents, c2 gets one
      return buildCreateClusterOps({ loginName:'bob' }).map((c) => ({
        id: c.clusterId,
        create: c.operations.find((o) => o.operation === 'create_role').createRole.parentRoles,
        grant: (c.operations.find((o) => o.operation === 'grant_parents') || {}).grantParents.parentRoles,
      }));
    } finally { resolveSelectedClusters = _origResolve; }
  })()`);
  assert.deepEqual(r, [
    { id: 'c1', create: 'gr_admin,gr_ro', grant: 'gr_admin,gr_ro' },
    { id: 'c2', create: 'gr_admin', grant: 'gr_admin' },
  ]);
});

// Alter presence-add: create_role for a newly-added cluster also carries that cluster's parents.
test('buildAlterClusterOps: presence-add create_role carries the granted parents', () => {
  const r = evalJSON(`(() => {
    ${SETUP_STATE}
    currentOp = 'alter_user';
    alterSelected = 'bob';
    resetEditMaps();
    alterDetails = [{ clusterId:'cX', exists:false, comment:'', parents:[], attributes:{}, settings:{} }];
    commentEditor = editorFromComment('', true); /* varies → created bare, no comment */
    alterAdd.set('gr_new', new Set(['cX']));
    const ops = buildAlterClusterOps().find((c) => c.clusterId === 'cX').operations;
    return {
      order: ops.map((o) => o.operation),
      create: ops.find((o) => o.operation === 'create_role').createRole.parentRoles,
      grant: ops.find((o) => o.operation === 'grant_parents').grantParents.parentRoles,
    };
  })()`);
  assert.deepEqual(r.order, ['create_role', 'grant_parents']);
  assert.equal(r.create, 'gr_new');
  assert.equal(r.grant, 'gr_new');
});

// The Assign-parents field takes a comma-separated LIST (the label is plural and its ? hint says
// so). Comma is the parent-list delimiter app-wide, so splitting on it cannot narrow what a single
// name may contain — ROLE_NAME_RE already excludes commas.
test('parseRoleNameList: comma-separated, trimmed, blanks dropped, duplicates collapsed', () => {
  const r = evalJSON(`({
    list: parseRoleNameList('gr_devs_ro, app_ro'),
    messy: parseRoleNameList('  a , b ,, a ,'),
    single: parseRoleNameList('app_ro'),
    blank: parseRoleNameList('   '),
    empty: parseRoleNameList(''),
    spacey: parseRoleNameList('Mixed Case Role'),
    nul: parseRoleNameList('ok,ba\\u0000d'),
  })`);
  assert.deepEqual(r.list, { roles: ['gr_devs_ro', 'app_ro'], invalid: null });
  // Trimmed, the blank between the two commas skipped, the trailing comma ignored, 'a' not repeated.
  assert.deepEqual(r.messy, { roles: ['a', 'b'], invalid: null });
  assert.deepEqual(r.single, { roles: ['app_ro'], invalid: null });
  // No name at all is not an error here — confirmScopeDialog reports it, since picking a chip alone
  // is a valid way to assign a parent.
  assert.deepEqual(r.blank, { roles: [], invalid: null });
  assert.deepEqual(r.empty, { roles: [], invalid: null });
  // A role name may contain spaces and case (the backend double-quotes identifiers), so this is one
  // name, not three — only a comma splits.
  assert.deepEqual(r.spacey, { roles: ['Mixed Case Role'], invalid: null });
  // NUL is the only thing left that a split part can fail on; the valid names before it are kept so
  // the message can name the offender.
  assert.equal(r.nul.invalid, 'ba d');
  assert.deepEqual(r.nul.roles, ['ok']);
});

// addParentScope: "Assign parents" is additive — it must never revoke where the parent already
// lives. Regression for the bug where adding P1 to cluster D revoked it from A/B/C.
test('addParentScope: assigning an existing parent to a new cluster grants D and revokes nothing', () => {
  const r = evalJSON(`(() => {
    alterDetails = [
      { clusterId:'A', exists:true, parents:['P1'], attributes:{}, settings:{}, comment:'' },
      { clusterId:'B', exists:true, parents:['P1'], attributes:{}, settings:{}, comment:'' },
      { clusterId:'C', exists:true, parents:['P1'], attributes:{}, settings:{}, comment:'' },
      { clusterId:'D', exists:true, parents:[],     attributes:{}, settings:{}, comment:'' },
    ];
    alterAdd = new Map(); alterRevoke = new Map();
    addParentScope(['P1'], new Set(['D']));
    return { add:[...(alterAdd.get('P1')||[])].sort(), rev:[...(alterRevoke.get('P1')||[])].sort() };
  })()`);
  assert.deepEqual(r.add, ['D']); // only D newly granted
  assert.deepEqual(r.rev, []);    // A/B/C stay granted — nothing revoked
});

// Adding a cluster that had a pending revoke cancels that revoke (grant wins), still no over-revoke.
test('addParentScope: granting a cluster clears its pending revoke and merges with prior adds', () => {
  const r = evalJSON(`(() => {
    alterDetails = [
      { clusterId:'A', exists:true, parents:['P1'], attributes:{}, settings:{}, comment:'' },
      { clusterId:'B', exists:true, parents:[],     attributes:{}, settings:{}, comment:'' },
      { clusterId:'C', exists:true, parents:[],     attributes:{}, settings:{}, comment:'' },
    ];
    alterAdd = new Map([['P1', new Set(['B'])]]);
    alterRevoke = new Map([['P1', new Set(['A'])]]);
    addParentScope(['P1'], new Set(['A','C']));
    return { add:[...(alterAdd.get('P1')||[])].sort(), rev:[...(alterRevoke.get('P1')||[])].sort() };
  })()`);
  assert.deepEqual(r.add, ['B', 'C']); // prior add B kept; C newly granted; A already present so not re-added
  assert.deepEqual(r.rev, []);         // pending revoke of A cancelled by granting A
});

// Shared primitives used by all three sections (role parents, attributes, settings).
test('scopeMergeAdd: additive — extends add over desired, cancels revoke there, never touches others', () => {
  const r = evalJSON(`(() => {
    const add = new Set(['x']), rev = new Set(['a','z']);
    scopeMergeAdd(add, rev, new Set(['a','b']) /*cur*/, new Set(['a','c']) /*desired*/);
    return { add:[...add].sort(), rev:[...rev].sort() };
  })()`);
  assert.deepEqual(r.add, ['c', 'x']); // c newly added; a already in cur so not added; prior x kept
  assert.deepEqual(r.rev, ['z']);      // a removed from rev (granted); z (outside desired) untouched
});

test('scopeDiff: full desired-vs-current diff → grant (desired−cur), revoke (cur−desired)', () => {
  const r = evalJSON(`(() => {
    const d = scopeDiff(new Set(['a','b','c']) /*cur*/, new Set(['b','d']) /*desired*/);
    return { add:[...d.add].sort(), rev:[...d.rev].sort() };
  })()`);
  assert.deepEqual(r.add, ['d']);
  assert.deepEqual(r.rev, ['a', 'c']);
});

// Same additive bug/fix as privileges, now shared: "Add setting" must not RESET clusters that
// already carry the value elsewhere.
test('applyConfigScope: adding an existing setting to a new cluster SETs D and RESETs nothing', () => {
  const r = evalJSON(`(() => {
    alterDetails = [
      { clusterId:'A', exists:true, parents:[], attributes:{}, settings:{work_mem:'64MB'}, comment:'' },
      { clusterId:'B', exists:true, parents:[], attributes:{}, settings:{work_mem:'64MB'}, comment:'' },
      { clusterId:'C', exists:true, parents:[], attributes:{}, settings:{work_mem:'64MB'}, comment:'' },
      { clusterId:'D', exists:true, parents:[], attributes:{}, settings:{}, comment:'' },
    ];
    alterConfigSet = new Map(); alterConfigReset = new Map();
    applyConfigScope('work_mem', '64MB', null, true /*isNew*/, new Set(['D']));
    return { set:[...(alterConfigSet.get('work_mem=64MB')||[])].sort(),
             reset:[...(alterConfigReset.get('work_mem')||[])].sort() };
  })()`);
  assert.deepEqual(r.set, ['D']); // only D newly set
  assert.deepEqual(r.reset, []);  // A/B/C keep the setting — nothing reset
});

// Editing a setting's value still RESETs the clusters that leave the old value.
test('applyConfigScope: editing a value SETs desired and RESETs clusters leaving the old value', () => {
  const r = evalJSON(`(() => {
    alterDetails = [
      { clusterId:'A', exists:true, parents:[], attributes:{}, settings:{work_mem:'64MB'}, comment:'' },
      { clusterId:'B', exists:true, parents:[], attributes:{}, settings:{work_mem:'64MB'}, comment:'' },
    ];
    alterConfigSet = new Map(); alterConfigReset = new Map();
    applyConfigScope('work_mem', '128MB', '64MB', false /*edit*/, new Set(['A']));
    return { set:[...(alterConfigSet.get('work_mem=128MB')||[])].sort(),
             reset:[...(alterConfigReset.get('work_mem')||[])].sort() };
  })()`);
  assert.deepEqual(r.set, ['A']);   // A moved to the new value
  assert.deepEqual(r.reset, ['B']); // B left 64MB and wasn't re-selected → reset
});

// ---------------------------------------------------------------------------------------------
test('clusterHasStagedEdits: true for any staged map / pending-create row, false when clean', () => {
  const r = evalJSON(`(() => {
    resetEditMaps();
    alterDetails = [
      { clusterId:'grant', exists:true }, { clusterId:'attr', exists:true },
      { clusterId:'cfg', exists:true }, { clusterId:'drop', exists:true },
      { clusterId:'cmt', exists:true }, { clusterId:'create', exists:false },
      { clusterId:'clean', exists:true },
    ];
    alterAdd.set('parent', new Set(['grant']));
    alterAttrRemove.set('LOGIN', new Set(['attr']));
    alterConfigSet.set('work_mem=128MB', new Set(['cfg']));
    roleRemoveClusters.add('drop');
    commentOverrides.set('cmt', 'hello');
    return {
      grant: clusterHasStagedEdits('grant'),
      attr: clusterHasStagedEdits('attr'),
      cfg: clusterHasStagedEdits('cfg'),
      drop: clusterHasStagedEdits('drop'),
      cmt: clusterHasStagedEdits('cmt'),
      create: clusterHasStagedEdits('create'),
      clean: clusterHasStagedEdits('clean'),
    };
  })()`);
  assert.deepEqual(r, { grant:true, attr:true, cfg:true, drop:true, cmt:true, create:true, clean:false });
});

// ---------------------------------------------------------------------------------------------
test('openSearchDialog clears cached results (no stale matches from a prior scope)', () => {
  const r = evalJSON(`(() => {
    alterGroups = [{ login:'stale', details:[] }];
    openSearchDialog();          // must not throw; must drop cached results
    return { cleared: alterGroups.length };
  })()`);
  assert.equal(r.cleared, 0);
});

// --- commentFieldArgs: per-cluster create_role / set_comment placeholder values ---------------
test('commentFieldArgs: JSON-encodes each configured field present in the comment (typed)', () => {
  const r = evalJSON(`(() => {
    ${SETUP_STATE}
    state.commentFields = [{key:'full_name'},{key:'e_mail'},{key:'age'},{key:'active'}];
    return commentFieldArgs('{"full_name":"John","age":42,"active":true,"e_mail":null}');
  })()`);
  // Values are JSON encodings so the backend can recover their type; null encodes as "null".
  assert.deepEqual(r, { full_name: '"John"', e_mail: 'null', age: '42', active: 'true' });
});

test('commentFieldArgs: an empty-string field is kept, encoded as "" (backend maps it to NULL)', () => {
  const r = evalJSON(`(() => {
    ${SETUP_STATE}
    state.commentFields = [{key:'full_name'}];
    return commentFieldArgs('{"full_name":""}');
  })()`);
  // Present (not omitted) and JSON-encoded as the two-char string "" — renderCommentFieldSQL /
  // commentFieldBindValue then turn "" into SQL NULL. Distinct from an absent key (also NULL).
  assert.deepEqual(r, { full_name: '""' });
});

test('commentFieldArgs: keys absent from the comment are omitted (→ backend NULL)', () => {
  const r = evalJSON(`(() => {
    ${SETUP_STATE}
    return commentFieldArgs('{"full_name":"Jane"}');
  })()`);
  assert.deepEqual(r, { full_name: '"Jane"' }); // e_mail omitted
});

test('commentFieldArgs: a plain-text (non-object) comment yields no field args', () => {
  const r = evalJSON(`(() => {
    ${SETUP_STATE}
    return commentFieldArgs('just some text');
  })()`);
  assert.deepEqual(r, {});
});

test('fnPlaceholderChips: built-ins bare, comment fields doubled, no shadow de-dup', () => {
  const r = evalJSON(`(() => {
    // A field keyed like a built-in is the case that used to be silently de-duplicated away.
    state = { commentFields: [{key:'full_name',label:'Full name'},{key:'comment',label:'Note'}] };
    return {
      create: fnPlaceholderChips('create_role', ['loginname','parent_roles']),
      comment: fnPlaceholderChips('set_comment', ['loginname','comment']),
      other: fnPlaceholderChips('change_password', ['loginname','new_password']),
    };
  })()`);
  assert.deepEqual(r.create.map((c) => c.token), ['\${loginname}', '\${parent_roles}', '\${{full_name}}', '\${{comment}}']);
  assert.deepEqual(r.create.map((c) => c.kind), ['builtin', 'builtin', 'field', 'field']);
  // ${comment} (built-in) and ${{comment}} (the field) both get a chip — the namespaces are disjoint.
  assert.deepEqual(r.comment.map((c) => c.token), ['\${loginname}', '\${comment}', '\${{full_name}}', '\${{comment}}']);
  // An op without comment fields gets built-ins only.
  assert.deepEqual(r.other.map((c) => c.token), ['\${loginname}', '\${new_password}']);
});

// --- Run-status phases: create+load log concatenation and phase-aware chip summary -------------
test('run-status: post-create load logs a -- Load Role query on EVERY cluster + inline error', () => {
  const r = evalJSON(`(() => {
    ${SETUP_STATE}
    state.clusters = [{id:'c1',alias:'c1',category:'p'},{id:'c2',alias:'c2',category:'p'}];
    runState = null;
    beginRunStatus([{clusterId:'c1'},{clusterId:'c2'}], 'Create');
    finishRunStatus([
      {clusterId:'c1', status:'ok', message:'', durationMs:5, queries:['CREATE ROLE "bob"','GRANT "gr_a" TO "bob"']},
      {clusterId:'c2', status:'error', message:'permission denied', durationMs:3, queries:['CREATE ROLE "bob"']},
    ]);
    const createSummary = runStatusSummary();
    // Load runs on ALL selected clusters: c1 found, c2 reachable-but-role-absent (carries the SQL).
    reportRoleLoad({
      valid:  [{clusterId:'c1', alias:'c1', category:'p', durationMs:2, exists:true,  queries:['SELECT rolname']}],
      errors: [],
      all:    [
        {clusterId:'c1', alias:'c1', category:'p', durationMs:2, exists:true,  error:'', queries:['SELECT rolname']},
        {clusterId:'c2', alias:'c2', category:'p', durationMs:1, exists:false, error:'', queries:['SELECT rolname']},
      ],
    }, { appendLog:true });
    return {
      createSummary,
      afterSummary: runStatusSummary(),
      c1: rowQueries(runState.byId.get('c1')),
      c2: rowQueries(runState.byId.get('c2')),
    };
  })()`);
  assert.deepEqual(r.createSummary, { stateClass:'error', text:'Status: Create (1/2 failed)' });
  // Load ran (ok) on both clusters, so the Load phase reports 2 clusters.
  assert.equal(r.afterSummary.text, 'Status: Create (1/2 failed), Load OK (2 clusters)');
  assert.deepEqual(r.c1, ['-- Create Role','CREATE ROLE "bob"','GRANT "gr_a" TO "bob"','-- Load Role','SELECT rolname']);
  // The failed cluster now shows its create error inline AND the load query that ran there.
  assert.deepEqual(r.c2, ['-- Create Role','CREATE ROLE "bob"','-- ERROR: permission denied','-- Load Role','SELECT rolname']);
});

test('run-status: an unreachable cluster on load shows -- Load Role + -- ERROR (no SQL ran)', () => {
  const r = evalJSON(`(() => {
    ${SETUP_STATE}
    state.clusters = [{id:'c1',alias:'c1',category:'p'}];
    runState = null;
    beginRunStatus([{clusterId:'c1'}], 'Create');
    finishRunStatus([{clusterId:'c1', status:'ok', durationMs:1, queries:['CREATE ROLE "bob"']}]);
    reportRoleLoad({ valid:[], errors:[], all:[{clusterId:'c1', alias:'c1', category:'p', error:'connection refused', queries:[]}] }, { appendLog:true });
    return { summary: runStatusSummary(), c1: rowQueries(runState.byId.get('c1')) };
  })()`);
  assert.equal(r.summary.text, 'Status: Create OK (1 cluster), Load (1/1 failed)');
  assert.deepEqual(r.c1, ['-- Create Role','CREATE ROLE "bob"','-- Load Role','-- ERROR: connection refused']);
});

test('run-status: create+load all-ok chip shows OK (n clusters)', () => {
  const r = evalJSON(`(() => {
    ${SETUP_STATE}
    state.clusters = [{id:'c1',alias:'c1',category:'p'}];
    runState = null;
    beginRunStatus([{clusterId:'c1'}], 'Create');
    finishRunStatus([{clusterId:'c1', status:'ok', durationMs:1, queries:['CREATE ROLE "bob"']}]);
    reportRoleLoad({ valid:[{clusterId:'c1', alias:'c1', category:'p', durationMs:1, exists:true, queries:['SELECT 1']}], errors:[], all:[{clusterId:'c1', alias:'c1', category:'p', durationMs:1, exists:true, error:'', queries:['SELECT 1']}] }, { appendLog:true });
    return runStatusSummary();
  })()`);
  assert.deepEqual(r, { stateClass:'ok', text:'Status: OK (1 cluster)' });
});

test('run-status: a single unnamed phase keeps the legacy chip text and a verbatim log', () => {
  const r = evalJSON(`(() => {
    ${SETUP_STATE}
    state.clusters = [{id:'c1',alias:'c1',category:'p'},{id:'c2',alias:'c2',category:'p'}];
    runState = null;
    beginRunStatus([{clusterId:'c1'},{clusterId:'c2'}]); // no phase name
    finishRunStatus([
      {clusterId:'c1', status:'ok', queries:['REVOKE "x" FROM "bob"']},
      {clusterId:'c2', status:'error', message:'no', queries:[]},
    ]);
    return { summary: runStatusSummary(), c1: rowQueries(runState.byId.get('c1')) };
  })()`);
  assert.deepEqual(r.summary, { stateClass:'error', text:'Status: Error (1/2 failed)' });
  assert.deepEqual(r.c1, ['REVOKE "x" FROM "bob"']); // unnamed phase → no -- separators
});

test('run-status: a default (user-initiated) load resets the chip (create log dropped)', () => {
  const r = evalJSON(`(() => {
    ${SETUP_STATE}
    state.clusters = [{id:'c1',alias:'c1',category:'p'}];
    runState = null;
    beginRunStatus([{clusterId:'c1'}], 'Create');
    finishRunStatus([{clusterId:'c1', status:'ok', queries:['CREATE ROLE "bob"']}]);
    reportRoleLoad({ valid:[{clusterId:'c1', alias:'c1', category:'p', queries:['SELECT 1']}], errors:[] }); // default: reset
    return rowQueries(runState.byId.get('c1'));
  })()`);
  assert.deepEqual(r, ['SELECT 1']); // reset to a single unnamed load phase, verbatim
});

test('formatQueryLine: SQL gets a trailing ; but -- comment separators are left alone', () => {
  const r = evalJSON(`[formatQueryLine('SELECT 1'), formatQueryLine('CREATE ROLE "x";'), formatQueryLine('-- Create Role'), formatQueryLine('-- ERROR: permission denied')]`);
  assert.deepEqual(r, ['SELECT 1;', 'CREATE ROLE "x";', '-- Create Role', '-- ERROR: permission denied']);
});

test('enterAlterAfterCreate: switches to Alter, scopes to the sidebar selection, appends the load log', async () => {
  const p = vm.runInContext(`(async () => {
    ${SETUP_STATE}
    state.clusters = [{id:'c1',alias:'c1',category:'p'},{id:'c2',alias:'c2',category:'p'}];
    const _resolve = resolveSelectedClusters, _cats = getSelectedCategories, _ids = getSelectedClusterIDs, _reload = reloadDetails, _footer = updateOpsFooter;
    let reloadOpts = null;
    try {
      getSelectedCategories = () => ['p'];
      getSelectedClusterIDs = () => [];
      resolveSelectedClusters = () => state.clusters;
      updateOpsFooter = () => {};
      reloadDetails = async (opts) => { reloadOpts = opts; };
      currentOp = 'create_role';
      await enterAlterAfterCreate('bob');
      return JSON.stringify({
        currentOp, alterSelected,
        targets: alterTargets,
        scope: alterScopeClusters.map((c) => c.clusterId),
        appliedClusterIds: [...alterAppliedSelection.clusterIds],
        reloadOpts,
      });
    } finally {
      resolveSelectedClusters = _resolve; getSelectedCategories = _cats; getSelectedClusterIDs = _ids;
      reloadDetails = _reload; updateOpsFooter = _footer;
    }
  })()`, ctx);
  const r = JSON.parse(await p);
  assert.equal(r.currentOp, 'alter_user');
  assert.equal(r.alterSelected, 'bob');
  assert.deepEqual(r.targets, { categoryIds: ['p'], clusterIds: [] });
  assert.deepEqual(r.scope, ['c1', 'c2']);          // all originally-selected clusters
  assert.deepEqual(r.reloadOpts, { appendLog: true }); // load appends to the create log, not reset
});

// ---------------------------------------------------------------------------------------------
// Password generator (no crypto in the vm sandbox → generatePassword uses its Math.random fallback).
test('generatePassword: honors length and only draws from enabled classes', () => {
  const r = evalJSON(`(() => {
    const pw = generatePassword({ length: 40, lowercase: true, uppercase: false, digits: false, symbols: false, excludeSimilar: false });
    return { len: pw.length, allLower: /^[a-z]+$/.test(pw) };
  })()`);
  assert.equal(r.len, 40);
  assert.equal(r.allLower, true);
});

test('generatePassword: digits + uppercase pool excludes lowercase/symbols', () => {
  const r = evalJSON(`(() => {
    const pw = generatePassword({ length: 60, lowercase: false, uppercase: true, digits: true, symbols: false, excludeSimilar: false });
    return { onlyUpperDigits: /^[A-Z0-9]+$/.test(pw), len: pw.length };
  })()`);
  assert.equal(r.onlyUpperDigits, true);
  assert.equal(r.len, 60);
});

test('generatePassword: excludeSimilar removes look-alike characters', () => {
  const r = evalJSON(`(() => {
    const pw = generatePassword({ length: 200, lowercase: true, uppercase: true, digits: true, symbols: false, excludeSimilar: true });
    return { hasSimilar: /[il1IoO0]/.test(pw) };
  })()`);
  assert.equal(r.hasSimilar, false);
});

test('generatePassword: empty pool (no classes) defensively falls back to lowercase', () => {
  const r = evalJSON(`(() => {
    const pw = generatePassword({ length: 12, lowercase: false, uppercase: false, digits: false, symbols: false, excludeSimilar: false });
    return { len: pw.length, allLower: /^[a-z]+$/.test(pw) };
  })()`);
  assert.equal(r.len, 12);
  assert.equal(r.allLower, true);
});

// ---------------------------------------------------------------------------------------------
// Pre-flight dependency check before a role is dropped.
test('initialDepsChoices: clusters with dependencies or an error default to Skip', () => {
  const r = evalJSON(`(() => {
    const rows = [
      { clusterId: 'c-clean', dependencies: [] },
      { clusterId: 'c-deps', dependencies: [{ database: 'app', dependency: 'owner', class: 'pg_class', object: 'table t' }] },
      { clusterId: 'c-err', dependencies: [], error: 'connect failed' },
      { clusterId: 'c-nodeps-undefined' },
    ];
    const m = initialDepsChoices(rows);
    return { entries: [...m.entries()], size: m.size };
  })()`);
  assert.equal(r.size, 2);
  assert.deepEqual(r.entries, [['c-deps', 'skip'], ['c-err', 'skip']]);
});

test('depsAllowedSet: clean clusters always allowed; flagged ones only when set to Try anyway', () => {
  const r = evalJSON(`(() => {
    const rows = [
      { clusterId: 'c-clean', dependencies: [] },
      { clusterId: 'c-deps', dependencies: [{ object: 'table t' }] },
      { clusterId: 'c-err', dependencies: [], error: 'connect failed' },
    ];
    const skipAll = [...depsAllowedSet(rows, initialDepsChoices(rows))];
    const choices = initialDepsChoices(rows);
    choices.set('c-deps', 'try');
    const oneTried = [...depsAllowedSet(rows, choices)];
    return { skipAll, oneTried };
  })()`);
  assert.deepEqual(r.skipAll, ['c-clean']);
  assert.deepEqual(r.oneTried, ['c-clean', 'c-deps']);
});

test('filterSkippedRemovals: drops skipped remove_role-only entries, keeps every other cluster', () => {
  const r = evalJSON(`(() => {
    const clusters = [
      { clusterId: 'c-skip', operations: [{ operation: 'remove_role', removeRole: { loginName: 'u' } }] },
      { clusterId: 'c-try', operations: [{ operation: 'remove_role', removeRole: { loginName: 'u' } }] },
      { clusterId: 'c-edit', operations: [{ operation: 'grant_parents', grantParents: { loginName: 'u', parentRoles: 'app_ro' } }] },
      { clusterId: 'c-multi', operations: [
        { operation: 'create_role', createRole: { loginName: 'u' } },
        { operation: 'remove_role', removeRole: { loginName: 'u' } },
      ] },
    ];
    const kept = filterSkippedRemovals(clusters, new Set(['c-try'])).map((c) => c.clusterId);
    return { kept };
  })()`);
  // c-skip is dropped; the unrelated edit and the multi-op cluster are untouched.
  assert.deepEqual(r.kept, ['c-try', 'c-edit', 'c-multi']);
});

test('depsSortRows: clean → unchecked → with-dependencies, then category order, then alias', () => {
  const r = evalJSON(`(() => {
    // Configured category order is prod, then uat (NOT alphabetical).
    state = { categories: [{ id: 'prod', label: 'Production' }, { id: 'uat', label: 'UAT' }] };
    const rows = [
      { clusterId: 'uat-deps',   alias: 'uat-9',  category: 'uat',  dependencies: [{ object: 'table t' }] },
      { clusterId: 'uat-clean-b',alias: 'uat-b',  category: 'uat',  dependencies: [] },
      { clusterId: 'prod-err',   alias: 'prod-2', category: 'prod', dependencies: [], error: 'refused' },
      { clusterId: 'prod-deps',  alias: 'prod-1', category: 'prod', dependencies: [{ object: 'table t' }] },
      { clusterId: 'uat-clean-a',alias: 'uat-a',  category: 'uat',  dependencies: [] },
      { clusterId: 'prod-clean', alias: 'prod-0', category: 'prod', dependencies: [] },
      { clusterId: 'uat-err',    alias: 'uat-1',  category: 'uat',  dependencies: [], error: 'timeout' },
    ];
    return { order: depsSortRows(rows).map((x) => x.clusterId), tiers: depsSortRows(rows).map(depsTier) };
  })()`);
  assert.deepEqual(r.order, [
    // tier 0 (clean): prod before uat (configured order), then alias within uat
    'prod-clean', 'uat-clean-a', 'uat-clean-b',
    // tier 1 (could not be checked)
    'prod-err', 'uat-err',
    // tier 2 (dependencies found)
    'prod-deps', 'uat-deps',
  ]);
  assert.deepEqual(r.tiers, [0, 0, 0, 1, 1, 2, 2]);
});

test('depsColgroup: short columns sized to the widest value across ALL clusters, Object bare', () => {
  const r = evalJSON(`(() => {
    const rows = [
      { dependencies: [{ database: 'postgres', dependency: 'owner', class: 'pg_class', object: 'table t' }] },
      { dependencies: [{ database: 'analytics_warehouse', dependency: 'privileges (ACL)', class: 'pg_proc', object: 'x' }] },
    ];
    return { html: depsColgroup(rows) };
  })()`);
  // 'analytics_warehouse' = 19 chars wins over the 'Database' header; the last <col> has no width.
  assert.match(r.html, /width:calc\(19ch \+ 1\.5rem\)/);
  // 'privileges (ACL)' = 16 chars wins over the 'Dependency' header (10).
  assert.match(r.html, /width:calc\(16ch \+ 1\.5rem\)/);
  // 'pg_class'/'pg_proc' are shorter than the 'Class' header? No — 8 > 5, so 8 wins.
  assert.match(r.html, /width:calc\(8ch \+ 1\.5rem\)/);
  assert.match(r.html, /<col><\/colgroup>$/);
});

test('depsColgroup: caps a pathologically long value and falls back to the header width', () => {
  const r = evalJSON(`(() => {
    const rows = [
      { dependencies: [{ database: 'd'.repeat(200), dependency: 'o', class: 'c', object: 'x' }] },
      { dependencies: [] },
    ];
    return { html: depsColgroup(rows), empty: depsColgroup([]) };
  })()`);
  assert.match(r.html, /width:calc\(28ch \+ 1\.5rem\)/); // capped at 28
  assert.match(r.html, /width:calc\(10ch \+ 1\.5rem\)/); // 'Dependency' header wins over 'o'
  // No rows at all → every column falls back to its header length.
  assert.match(r.empty, /width:calc\(8ch \+ 1\.5rem\)/);  // 'Database'
  assert.match(r.empty, /width:calc\(5ch \+ 1\.5rem\)/);  // 'Class'
});

test('depsErrorRowsFor: one unchecked row per cluster, alias/category resolved from known rows', () => {
  const r = evalJSON(`(() => {
    const known = [
      { clusterId: 'c1', alias: 'prod-1', host: 'h1', category: 'prod', queries: ['SELECT 1'] },
      { clusterId: 'c2', alias: 'uat-1', host: 'h2', category: 'uat' },
    ];
    return { rows: depsErrorRowsFor(['c1', 'c2', 'c-unknown'], 'backend exploded', known) };
  })()`);
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.rows.map((x) => x.alias), ['prod-1', 'uat-1', 'c-unknown']); // falls back to the id
  assert.deepEqual(r.rows.map((x) => x.category), ['prod', 'uat', '']);
  assert.ok(r.rows.every((x) => x.error === 'backend exploded' && x.dependencies.length === 0));
  // A previously reported query is kept so the titlebar magnifier survives a failed reload.
  assert.deepEqual(r.rows[0].queries, ['SELECT 1']);
  assert.deepEqual(r.rows[1].queries, []);
});

test('mergeDepsChoices: keeps still-relevant picks, defaults new ones, drops now-clean clusters', () => {
  const r = evalJSON(`(() => {
    const prev = new Map([['still-deps', 'try'], ['now-clean', 'try'], ['gone', 'skip']]);
    const rows = [
      { clusterId: 'still-deps', dependencies: [{ object: 'table t' }] },
      { clusterId: 'now-clean',  dependencies: [] },
      { clusterId: 'newly-bad',  dependencies: [{ object: 'table u' }] },
    ];
    return { entries: [...mergeDepsChoices(rows, prev).entries()] };
  })()`);
  assert.deepEqual(r.entries, [
    ['still-deps', 'try'], // survived the reload
    ['newly-bad', 'skip'], // newly flagged → safe default
  ]); // 'now-clean' needs no decision any more, 'gone' is not in the new rows at all
});

test('reloadDeps: re-reads the same clusters, re-sorts, and preserves a Try anyway pick', async () => {
  const p = vm.runInContext(`(async () => {
    const _backend = backend, _getAuth = getAuth, _render = renderDepsDialog;
    let req = null, busyDuringLoad = null;
    try {
      state = { categories: [{ id: 'prod', label: 'Production' }, { id: 'uat', label: 'UAT' }] };
      alterSelected = 'bob';
      getAuth = () => ({ user: '', password: '' });
      renderDepsDialog = () => {};
      // Opening state: one cluster with deps (set to Try anyway), one clean.
      depsRows = [
        { clusterId: 'c1', alias: 'prod-1', category: 'prod', dependencies: [{ object: 'table t' }] },
        { clusterId: 'c2', alias: 'uat-1', category: 'uat', dependencies: [] },
      ];
      depsChoices = new Map([['c1', 'try']]);
      depsClusterIds = ['c1', 'c2'];
      backend = () => ({ LoadRoleDependencies: async (r) => {
        req = r;
        busyDuringLoad = depsBusy;
        // c1 still has deps; c2 came back dirty this time — deliberately out of order.
        return [
          { clusterId: 'c2', alias: 'uat-1', category: 'uat', dependencies: [{ object: 'table u' }] },
          { clusterId: 'c1', alias: 'prod-1', category: 'prod', dependencies: [{ object: 'table t' }] },
        ];
      } });
      await reloadDeps();
      return JSON.stringify({
        req, busyDuringLoad, busyAfter: depsBusy,
        order: depsRows.map((x) => x.clusterId),
        choices: [...depsChoices.entries()],
      });
    } finally {
      backend = _backend; getAuth = _getAuth; renderDepsDialog = _render;
    }
  })()`, ctx);
  const r = JSON.parse(await p);
  assert.deepEqual(r.req.clusterIds, ['c1', 'c2']); // same clusters re-checked
  assert.equal(r.req.loginName, 'bob');
  assert.equal(r.busyDuringLoad, true);  // spinner state held during the read
  assert.equal(r.busyAfter, false);      // and released afterwards
  assert.deepEqual(r.order, ['c1', 'c2']); // re-sorted by category order, not response order
  assert.deepEqual(r.choices, [['c1', 'try'], ['c2', 'skip']]); // pick survived, new one defaults
});

test('reloadDeps: a thrown read lands every cluster under "could not be checked", not an empty list', async () => {
  const p = vm.runInContext(`(async () => {
    const _backend = backend, _getAuth = getAuth, _render = renderDepsDialog, _err = console.error;
    try {
      state = { categories: [{ id: 'prod', label: 'Production' }] };
      alterSelected = 'bob';
      getAuth = () => ({ user: '', password: '' });
      renderDepsDialog = () => {};
      console.error = () => {};
      depsRows = [{ clusterId: 'c1', alias: 'prod-1', category: 'prod', dependencies: [{ object: 't' }] }];
      depsChoices = new Map([['c1', 'try']]);
      depsClusterIds = ['c1'];
      backend = () => ({ LoadRoleDependencies: async () => { throw new Error('no route to host'); } });
      await reloadDeps();
      return JSON.stringify({
        rows: depsRows.map((x) => ({ id: x.clusterId, alias: x.alias, tier: depsTier(x), error: x.error })),
        allowed: [...depsAllowedSet()],
        busy: depsBusy,
      });
    } finally {
      backend = _backend; getAuth = _getAuth; renderDepsDialog = _render; console.error = _err;
    }
  })()`, ctx);
  const r = JSON.parse(await p);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].tier, 1);            // "could not be checked"
  assert.equal(r.rows[0].alias, 'prod-1');    // identity kept from the previous rows
  assert.match(r.rows[0].error, /no route to host/);
  assert.deepEqual(r.allowed, ['c1']);        // the earlier "Try anyway" still applies...
  assert.equal(r.busy, false);
});

// --- Find-role popup: one-liner failures + its own independent status chip --------------------
test('searchFailureLine: one counted line, singular/plural aware', () => {
  const r = evalJSON(`[searchFailureLine(1, 5), searchFailureLine(3, 3), searchFailureLine(1, 1)]`);
  assert.equal(r[0], '1 of 5 clusters could not be searched — click Status for details.');
  assert.equal(r[1], '3 of 3 clusters could not be searched — click Status for details.');
  assert.equal(r[2], '1 of 1 cluster could not be searched — click Status for details.');
});

test('buildStatusState: per-cluster rows become a finished single-segment state, order preserved', () => {
  const r = evalJSON(`(() => {
    const st = buildStatusState([
      { clusterId: 'c2', alias: 'uat-1', host: 'h2', category: 'uat', status: 'ok', durationMs: 12, queries: ['SELECT 1'] },
      { clusterId: 'c1', alias: 'prod-1', host: 'h1', category: 'prod', status: 'error', message: 'refused' },
    ]);
    return {
      total: st.total,
      order: st.order,
      rows: st.order.map((id) => {
        const row = st.byId.get(id);
        return { alias: row.alias, phase: row.phase, segs: row.segments.length,
                 status: row.segments[0].status, msg: row.segments[0].message,
                 ms: rowDurationMs(row), queries: rowQueries(row) };
      }),
      summary: runStatusSummary(st),
    };
  })()`);
  assert.equal(r.total, 2);
  assert.deepEqual(r.order, ['c2', 'c1']); // insertion order, not re-sorted
  assert.deepEqual(r.rows[0], { alias: 'uat-1', phase: 'done', segs: 1, status: 'ok', msg: '', ms: 12, queries: ['SELECT 1'] });
  assert.equal(r.rows[1].status, 'error');
  assert.equal(r.rows[1].msg, 'refused');
  assert.deepEqual(r.rows[1].queries, ['-- ERROR: refused']); // no SQL ran, the error shows instead
  // Unnamed single phase → the legacy chip wording, counted not concatenated.
  assert.deepEqual(r.summary, { stateClass: 'error', text: 'Status: Error (1/2 failed)' });
});

test('runStatusSummary: takes an explicit state, so the two chips stay independent', () => {
  const r = evalJSON(`(() => {
    ${SETUP_STATE}
    state.clusters = [{id:'c1',alias:'c1',category:'p'}];
    // Footer state: a failed run.
    runState = null;
    beginRunStatus([{clusterId:'c1'}]);
    finishRunStatus([{clusterId:'c1', status:'error', message:'nope'}]);
    // Search state: all good. Neither must affect the other.
    const search = buildStatusState([{ clusterId:'c1', alias:'c1', category:'p', status:'ok', durationMs:3 }]);
    return { footer: runStatusSummary(runState), search: runStatusSummary(search), bare: runStatusSummary() };
  })()`);
  assert.equal(r.footer.text, 'Status: Error (1/1 failed)');
  assert.equal(r.search.text, 'Status: OK (1 cluster)');
  assert.equal(r.bare.text, r.footer.text); // the default argument still means runState
});

test('groupMatches: works on the flattened per-cluster matches (no error rows to skip any more)', () => {
  const r = evalJSON(`(() => {
    const scanned = [
      { clusterId:'c1', alias:'prod-1', category:'prod', matches:[
        { clusterId:'c1', loginName:'bob', comment:'' },
        { clusterId:'c1', loginName:'alice', comment:'{"full_name":"Alice A"}' }] },
      { clusterId:'c2', alias:'uat-1', category:'uat', matches:[] },           // scanned, no match
      { clusterId:'c3', alias:'uat-2', category:'uat', matches:[], error:'refused' }, // never scanned
      { clusterId:'c4', alias:'uat-3', category:'uat', matches:[
        { clusterId:'c4', loginName:'bob', comment:'{"full_name":"Bob B"}' }] },
    ];
    const groups = groupMatches(scanned.flatMap((c) => c.matches || []));
    return groups.map((g) => ({ login: g.loginName, clusters: g.clusters.map((m) => m.clusterId) }));
  })()`);
  assert.deepEqual(r, [
    { login: 'alice', clusters: ['c1'] },
    { login: 'bob', clusters: ['c1', 'c4'] },
  ]);
});

// ---------------------------------------------------------------------------------------------
test('renderSearchTemplate: combines comment keys, collapses gaps, types non-strings', () => {
  const r = evalJSON(`(() => {
    const c = '{"first_name":"John","last_name":"O\\'Hara","age":42,"active":true,"tags":["a"],"note":null}';
    return {
      combined: renderSearchTemplate('\${{first_name}} \${{last_name}}', c),
      missingTail: renderSearchTemplate('\${{first_name}} \${{nope}}', c),   // no trailing space
      missingHead: renderSearchTemplate('\${{nope}} \${{first_name}}', c),   // no leading space
      separator: renderSearchTemplate('\${{last_name}}, \${{nope}}', c),     // literals kept verbatim
      number: renderSearchTemplate('\${{age}}', c),
      bool: renderSearchTemplate('\${{active}}', c),
      array: renderSearchTemplate('\${{tags}}', c),
      nullValue: renderSearchTemplate('\${{note}}', c),
      literal: renderSearchTemplate('id \${{first_name}}!', c),
      spacedName: renderSearchTemplate('\${{ first_name }}', c),
      missingKey: renderSearchTemplate('\${{nope}}', c),
      unknownBare: renderSearchTemplate('\${nope}', c),
    };
  })()`);
  assert.equal(r.combined, "John O'Hara");
  assert.equal(r.missingTail, 'John');
  assert.equal(r.missingHead, 'John');
  assert.equal(r.separator, "O'Hara,"); // a literal comma survives an empty placeholder
  assert.equal(r.number, '42');
  assert.equal(r.bool, 'true');
  assert.equal(r.array, '["a"]');
  assert.equal(r.nullValue, ''); // JSON null reads as empty, like the comment editor
  assert.equal(r.literal, 'id John!');
  assert.equal(r.spacedName, 'John');
  assert.equal(r.missingKey, ''); // an absent comment key is empty
  // A bare name is a BUILT-IN reference, and there is no built-in called `nope`, so it renders as
  // itself — the mistake is visible in the row, and saving it is refused with a guiding message.
  assert.equal(r.unknownBare, '\${nope}');
});

test('renderSearchTemplate: ${comment} is the raw comment, JSON keys need a JSON comment', () => {
  const r = evalJSON(`(() => ({
    rawFromJson: renderSearchTemplate('\${comment}', '{"full_name":"Ann"}'),
    rawFromText: renderSearchTemplate('\${comment}', 'just a person'),
    keyFromText: renderSearchTemplate('\${{full_name}}', 'just a person'),
    keyFromBadJson: renderSearchTemplate('\${{full_name}}', '{"full_name":'),
    emptyComment: renderSearchTemplate('\${comment}', ''),
  }))()`);
  assert.equal(r.rawFromJson, '{"full_name":"Ann"}');
  assert.equal(r.rawFromText, 'just a person'); // the only way to show a plain-text comment
  assert.equal(r.keyFromText, '');
  assert.equal(r.keyFromBadJson, '');
  assert.equal(r.emptyComment, '');
});

// This is the case the namespace split exists for: a JSON comment carrying its own `comment` key.
test('renderSearchTemplate: ${comment} and ${{comment}} are different things', () => {
  const c = '{"comment":"inner note","loginname":"shadow","full_name":"Ann"}';
  const r = evalJSON(`(() => {
    const c = '${c}';
    return {
      whole: renderSearchTemplate('\${comment}', c),
      key: renderSearchTemplate('\${{comment}}', c),
      shadowedKey: renderSearchTemplate('\${{loginname}}', c),
      bareLoginname: renderSearchTemplate('\${loginname}', c),
      mixed: renderSearchTemplate('\${{comment}} / \${{full_name}}', c),
    };
  })()`);
  assert.equal(r.whole, c); // the built-in: the comment verbatim
  assert.equal(r.key, 'inner note'); // the JSON key of the same name — previously unreachable
  assert.equal(r.shadowedKey, 'shadow');
  assert.equal(r.bareLoginname, '${loginname}'); // not a search built-in
  assert.equal(r.mixed, 'inner note / Ann');
});

test('renderSearchTemplate: only the two exact forms are placeholders', () => {
  const r = evalJSON(`(() => {
    const c = '{"x":"v"}';
    return {
      halfClosed: renderSearchTemplate('\${{x}', c),
      innerBrace: renderSearchTemplate('\${a{b}', c),
      emptyDouble: renderSearchTemplate('\${{}}', c),
      emptyBare: renderSearchTemplate('\${}', c),
    };
  })()`);
  // Each is left verbatim because the name classes exclude braces — nothing is half-substituted.
  assert.equal(r.halfClosed, '${{x}');
  assert.equal(r.innerBrace, '${a{b}');
  assert.equal(r.emptyDouble, ''); // a well-formed token with an empty key → empty value
  assert.equal(r.emptyBare, '${}');
});

test('searchTemplateError: guides ${full_name} to ${{full_name}}', () => {
  const r = evalJSON(`[
    searchTemplateError('\${{first_name}} \${{e-mail}}'),
    searchTemplateError('pre \${comment} post'),
    searchTemplateError('no placeholders at all'),
    searchTemplateError('\${full_name}'),
    searchTemplateError('\${oops'),
    searchTemplateError('\${{oops}'),
    searchTemplateError('\${}'),
    searchTemplateError('\${{}}'),
  ]`);
  assert.equal(r[0], ''); // any comment key is fine in the double form
  assert.equal(r[1], ''); // ${comment} is the one built-in
  assert.equal(r[2], '');
  assert.match(r[3], /\$\{\{full_name\}\}/); // names the fix
  assert.match(r[4], /Unfinished/);
  assert.match(r[5], /Unfinished/);
  assert.match(r[6], /Empty/);
  assert.match(r[7], /Empty/);
});

test('searchCellValues: stable pick in configured order, disagreement not flagged', () => {
  const r = evalJSON(`(() => {
    state = { categories: [{ id:'prod', label:'Production' }, { id:'uat', label:'UAT' }] };
    const cols = [{ label:'Name', template:'\${{full_name}}' }, { label:'Mail', template:'\${{e_mail}}' }];
    // Deliberately out of configured order, as results arrive in completion order.
    const group = { loginName:'bob', clusters: [
      { clusterId:'u1', alias:'uat-1',  category:'uat',  comment:'{"full_name":"Bobby"}' },
      { clusterId:'p1', alias:'prod-1', category:'prod', comment:'{"full_name":"Bob B"}' },
    ]};
    const consistent = { loginName:'ann', clusters: [
      { clusterId:'p1', alias:'prod-1', category:'prod', comment:'{"full_name":"Ann"}' },
      { clusterId:'u1', alias:'uat-1',  category:'uat',  comment:'{"full_name":"Ann"}' },
    ]};
    // Each column is searched on its own, so a row can mix clusters: the name only exists on
    // prod-1, the mail only on uat-1. Documented in docs/…/configuration/role-details.md.
    const split = { loginName:'cid', clusters: [
      { clusterId:'u1', alias:'uat-1',  category:'uat',  comment:'{"e_mail":"cid@example.com"}' },
      { clusterId:'p1', alias:'prod-1', category:'prod', comment:'{"full_name":"Cid C"}' },
    ]};
    return {
      varying: searchCellValues(group, cols),
      same: searchCellValues(consistent, cols),
      split: searchCellValues(split, cols),
    };
  })()`);
  // prod-1 sorts first (configured group order), so its value is the one shown — and a differing
  // value on uat-1 changes nothing about the cell: the search row carries no "differs" marker, since
  // reconciliation belongs to the loaded role (Comments banner / dialog), not to finding one.
  assert.deepEqual(r.varying, ['Bob B', '']); // second column: no e_mail anywhere
  assert.deepEqual(r.same, ['Ann', '']);
  // A cluster with nothing for a column is SKIPPED, not rendered empty — so the Mail column falls
  // through prod-1 to uat-1, and the two columns of one row report different clusters.
  assert.deepEqual(r.split, ['Cid C', 'cid@example.com']);
});

test('searchColumns: an empty list means role name only (no default fallback)', () => {
  const r = evalJSON(`(() => {
    const out = {};
    state = { searchColumns: [] };
    out.explicitEmpty = searchColumns().length;
    state = { searchColumns: [{ label:'A', template:'\${a}' }, { label:'B', template:'' }] };
    out.dropsBlankTemplate = searchColumns().map((c) => c.label);
    state = {};
    out.missing = searchColumns().length;
    return out;
  })()`);
  assert.equal(r.explicitEmpty, 0); // the backend already resolved the default at load
  assert.deepEqual(r.dropsBlankTemplate, ['A']);
  assert.equal(r.missing, 0);
});

// Column widths are CSS's job now (the container's tracks + subgrid on rows/header), so what is
// left to test is the track LIST: one flexible track per configured column, between a rolename track
// and the chips track. The sizing itself is the browser's and is verified in a real engine instead.
test('searchGridTemplate: rolename + one flexible track per column + the chips track', () => {
  const r = evalJSON(`({
    none: searchGridTemplate(0),
    one: searchGridTemplate(1),
    three: searchGridTemplate(3),
  })`);
  // No configured columns: rolename + chips only.
  assert.equal(r.none, 'fit-content(40ch) minmax(8ch, auto)');
  // Each column is minmax(4ch, max-content): no cap, so a long value grows to its content instead of
  // ellipsizing early — but no `auto` max either, or grid's stretch step would pad every column with
  // a share of the leftover and push the next column far from the previous one's text.
  assert.equal(r.one, 'fit-content(40ch) minmax(4ch, max-content) minmax(8ch, auto)');
  assert.equal(
    r.three,
    'fit-content(40ch) minmax(4ch, max-content) minmax(4ch, max-content) minmax(4ch, max-content) minmax(8ch, auto)',
  );
  // The chips track is the flexible one in every case: it is last and end-aligned, so it holds the
  // leftover width, keeping the chips flush right and the slack in one deliberate-looking place.
  for (const t of [r.none, r.one, r.three]) assert.match(t, /minmax\(8ch, auto\)$/);
});

test('search-columns dirty check matches what the backend stores', () => {
  const r = evalJSON(`(() => {
    state = { searchColumns: [{ label:'Full name', template:'\${full_name}' }] };
    const dirty = () => JSON.stringify(readSearchColumnsFromEditor()) !== JSON.stringify(savedSearchColumns());
    const out = {};
    searchColumnsDraft = [{ label:'Full name', template:'\${full_name}' }];
    out.clean = dirty();
    searchColumnsDraft = [{ label:' Full name ', template:' \${full_name} ' }];
    out.whitespaceOnly = dirty(); // trimmed the same way validateSearchColumns does
    searchColumnsDraft = [{ label:'Full name', template:'\${first_name} \${last_name}' }];
    out.edited = dirty();
    searchColumnsDraft = [];
    out.cleared = dirty();
    searchColumnsDraft = [{ label:'Full name', template:'\${full_name}' }, { label:'x', template:'  ' }];
    out.blankRow = dirty(); // a row with no template is dropped, so it is not a change
    return out;
  })()`);
  assert.equal(r.clean, false);
  assert.equal(r.whitespaceOnly, false);
  assert.equal(r.edited, true);
  assert.equal(r.cleared, true); // removing every column is a real change
  assert.equal(r.blankRow, false);
});

test('clusters dirty check: an empty saved list arrives as null and is not a change', () => {
  // Go marshals an empty []Cluster as JSON null, so the saved half and the freshly seeded draft
  // must still compare equal — otherwise a fresh install starts out "dirty".
  const r = evalJSON(`(() => {
    state = { clusters: null, categories: [{id:'uat', label:'UAT', color:'#6eb5ff'}] };
    resetClusterDrafts();
    const clean = clustersDirty();
    clustersDraft.push({ id:'tmp_1', alias:'a', host:'h', port:5432, database:'postgres', category:'uat', sslmode:'prefer' });
    return { clean, afterAdd: clustersDirty() };
  })()`);
  assert.equal(r.clean, false);
  assert.equal(r.afterAdd, true);
});

test('renderClustersTable reports the footer state even with no clusters', () => {
  // The empty-draft early return used to skip refreshClustersDirty(), leaving Save/Discard in
  // their initial enabled state on a fresh install.
  const r = evalJSON(`(() => {
    state = { clusters: [], categories: [{id:'uat', label:'UAT', color:'#6eb5ff'}] };
    resetClusterDrafts();
    const buttons = {};
    const stub = (id) => (buttons[id] = buttons[id] || { id, disabled: null, classList:{ add(){}, remove(){}, toggle(){} } });
    const realGet = document.getElementById, realQuery = document.querySelector;
    document.getElementById = (id) => (id.endsWith('-clusters') ? stub(id) : realGet(id));
    document.querySelector = () => ({ innerHTML: '', querySelectorAll: () => [], appendChild(){} });
    try { renderClustersTable(); } finally { document.getElementById = realGet; document.querySelector = realQuery; }
    return { save: buttons['btn-save-clusters'].disabled, discard: buttons['btn-discard-clusters'].disabled };
  })()`);
  assert.equal(r.save, true, 'Save must be inert when nothing has been edited');
  assert.equal(r.discard, true, 'Discard must be inert when nothing has been edited');
});

test('stripClusterPrefix: the alias is not repeated in a table that has a Cluster column', () => {
  const r = evalJSON(`[
    stripClusterPrefix('connect to uat-2: failed to connect to \`db=x\`: refused', 'uat-2'),
    stripClusterPrefix('connect to other: failed', 'uat-2'),
    stripClusterPrefix('operation 1/2 (remove_role): dependent objects', 'uat-2'),
    stripClusterPrefix('connect to uat-2: x', ''),
  ]`);
  assert.equal(r[0], 'failed to connect to `db=x`: refused'); // own alias stripped
  assert.equal(r[1], 'connect to other: failed');             // a different alias is left alone
  assert.equal(r[2], 'operation 1/2 (remove_role): dependent objects'); // non-connect messages untouched
  assert.equal(r[3], 'connect to uat-2: x');                  // no alias → nothing to strip
});

test('statusRowOrder: the status table is ordered by configured group, then alias', () => {
  const r = evalJSON(`(() => {
    // Configured order is prod, then uat (deliberately NOT alphabetical by label).
    state = { categories: [{ id: 'prod', label: 'Production' }, { id: 'uat', label: 'Alpha UAT' }] };
    // Insertion order = the order results arrived in, which is what we are replacing.
    const st = buildStatusState([
      { clusterId: 'u2', alias: 'uat-9',  category: 'uat',     status: 'ok' },
      { clusterId: 'p2', alias: 'prod-9', category: 'prod',    status: 'ok' },
      { clusterId: 'x1', alias: 'orphan', category: 'deleted', status: 'error' },
      { clusterId: 'u1', alias: 'uat-1',  category: 'uat',     status: 'ok' },
      { clusterId: 'p1', alias: 'prod-1', category: 'prod',    status: 'ok' },
    ]);
    return { arrived: st.order, displayed: statusRowOrder(st) };
  })()`);
  assert.deepEqual(r.arrived, ['u2', 'p2', 'x1', 'u1', 'p1']); // as reported by the backend
  // prod before uat (configured order), alias within each group, unknown group last.
  assert.deepEqual(r.displayed, ['p1', 'p2', 'u1', 'u2', 'x1']);
});

test('byGroupThenAlias: configured group order wins over the label, alias breaks ties', () => {
  const r = evalJSON(`(() => {
    state = { categories: [{ id: 'zeta', label: 'Zeta' }, { id: 'alpha', label: 'Alpha' }] };
    const sort = (rows) => rows.slice().sort(byGroupThenAlias).map((c) => c.alias);
    return {
      groups: sort([{ category: 'alpha', alias: 'a' }, { category: 'zeta', alias: 'b' }]),
      aliases: sort([{ category: 'zeta', alias: 'b' }, { category: 'zeta', alias: 'a' }]),
      unknownLast: sort([{ category: 'nope', alias: 'a' }, { category: 'zeta', alias: 'z' }]),
    };
  })()`);
  assert.deepEqual(r.groups, ['b', 'a']);      // zeta is configured first, despite 'Alpha' < 'Zeta'
  assert.deepEqual(r.aliases, ['a', 'b']);     // same group → alias
  assert.deepEqual(r.unknownLast, ['z', 'a']); // a group no longer configured sorts last
});

test('closeModal: drops the focus the UA restores after a pointer-driven open, keeps it for keyboard', () => {
  const r = evalJSON(`(() => {
    const blurs = [];
    // Closing a <dialog> restores focus to its opener synchronously; stand in for that opener.
    const opener = { id: 'search-status', blur() { blurs.push('blurred'); } };
    const dlg = { closed: 0, close() { this.closed++; document.activeElement = opener; } };
    const run = (pointer) => {
      blurs.length = 0;
      document.activeElement = null;
      lastInputWasPointer = pointer;
      closeModal(dlg);
      return { closed: dlg.closed, blurs: blurs.length, active: document.activeElement === opener };
    };
    const byPointer = run(true);
    const byKeyboard = run(false);
    document.activeElement = null; // leave the stub as we found it
    return { byPointer, byKeyboard };
  })()`);
  // Mouse: the dialog closed and the ring the engine put back on the chip is dropped.
  assert.equal(r.byPointer.closed, 1);
  assert.equal(r.byPointer.blurs, 1);
  // Keyboard (including Esc): focus stays on the opener, so the ring and tab position survive.
  assert.equal(r.byKeyboard.closed, 2);
  assert.equal(r.byKeyboard.blurs, 0);
  assert.equal(r.byKeyboard.active, true);
});

// ---------------------------------------------------------------------------------------------
test('revealPickedClusters: opens the collapsed cluster list only when a restored pick is really there', () => {
  const r = evalJSON(`(() => {
    const realGet = document.getElementById;
    const realQSA = document.querySelectorAll;
    // Drive the real function against a recording stand-in for the sidebar.
    const run = (picks, checkedValues) => {
      const rec = { toggled: [], aria: null, caret: null, scrolled: null };
      const caret = { textContent: '▸' };
      const btn = {
        setAttribute(k, v) { if (k === 'aria-expanded') rec.aria = v; },
        querySelector: (sel) => (sel === '.caret' ? caret : null),
      };
      let hidden = true;
      const list = { classList: {
        toggle(cls, on) { if (cls === 'hidden') { hidden = on; rec.toggled.push(on); } },
        contains: () => hidden,
      } };
      const inputs = ['c1', 'c2', 'c3'].map((v) => {
        const label = { scrollIntoView(o) { rec.scrolled = { value: v, block: o && o.block }; } };
        return { value: v, checked: checkedValues.includes(v), closest: () => label };
      });
      document.getElementById = (id) =>
        id === 'btn-toggle-clusters' ? btn : id === 'cluster-checkboxes' ? list : null;
      document.querySelectorAll = () => inputs;
      selectedClusterIds = new Set(picks);
      revealPickedClusters();
      rec.hidden = hidden;
      rec.caret = caret.textContent;
      return rec;
    };
    const noPicks = run([], []);
    const stalePick = run(['gone'], []);   // remembered id whose cluster has since been deleted
    const livePick = run(['c2'], ['c2']);
    document.getElementById = realGet;     // leave the stub as we found it
    document.querySelectorAll = realQSA;
    selectedClusterIds = new Set();
    return { noPicks, stalePick, livePick };
  })()`);

  // Nothing picked (the default "all groups") → the list is left exactly as it was.
  assert.deepEqual(r.noPicks.toggled, []);
  assert.equal(r.noPicks.hidden, true);
  assert.equal(r.noPicks.scrolled, null);

  // A pick whose cluster no longer exists → still collapsed, rather than opening an empty-looking
  // list. This is the branch that reads `checked` off the DOM instead of trusting the Set.
  assert.deepEqual(r.stalePick.toggled, []);
  assert.equal(r.stalePick.hidden, true);
  assert.equal(r.stalePick.scrolled, null);

  // A live pick → expanded, with aria-expanded and the caret kept in step, and that row brought
  // into view by the minimum amount ('nearest' keeps .ops-sidebar from scrolling too).
  assert.deepEqual(r.livePick.toggled, [false]); // toggle('hidden', false) = un-hide
  assert.equal(r.livePick.hidden, false);
  assert.equal(r.livePick.aria, 'true');
  assert.equal(r.livePick.caret, '▾');
  assert.deepEqual(r.livePick.scrolled, { value: 'c2', block: 'nearest' });
});

// ---------------------------------------------------------------------------------------------
// The split header/body tables (Clusters, run status, groups) align only because both halves get
// the SAME colgroup, so this is the one thing worth pinning: how a spec becomes a track.
test('tableColgroup: header/min floor the width, cap ceilings it, flex and fixed tracks pass through', () => {
  const r = evalJSON(`(() => ({
    fromValue: tableColgroup([{ header: 'Alias', values: ['a-very-long-alias'], cap: 24 }]),
    headerFloor: tableColgroup([{ header: 'Database', values: ['db'] }]),
    capped: tableColgroup([{ header: 'Host', values: ['x'.repeat(80)], cap: 20 }]),
    minFloor: tableColgroup([{ header: 'Status', min: 12 }]),
    chip: tableColgroup([{ header: 'Group', values: ['Production'], chip: true }]),
    flex: tableColgroup([{ flex: true }]),
    fixed: tableColgroup([{ width: '5.5rem' }]),
    pair: tableColgroup([{ flex: true }, { width: '4.5rem' }]),
    nullValue: tableColgroup([{ header: 'Port', values: [null, 5432] }]),
    // The floor keeps a too-narrow window from collapsing the flexible column to nothing: the
    // fixed tracks plus FLEX_COL_MIN_CH for the flexible one.
    minWidth: tableMinWidth([
      { header: 'Alias', values: ['prod-01'] },
      { flex: true },
      { width: '5.5rem' },
    ]),
  }))()`);
  assert.equal(r.fromValue, '<col style="width:calc(17ch + 1.5rem)">');
  assert.equal(r.headerFloor, '<col style="width:calc(8ch + 1.5rem)">');
  assert.equal(r.capped, '<col style="width:calc(20ch + 1.5rem)">');
  assert.equal(r.minFloor, '<col style="width:calc(12ch + 1.5rem)">');
  // A chip carries its own padding, so its column gets more than the plain cell padding.
  assert.equal(r.chip, '<col style="width:calc(10ch + 3rem)">');
  // The flexible column is emitted bare: it absorbs whatever the fixed tracks leave over.
  assert.equal(r.flex, '<col>');
  assert.equal(r.fixed, '<col style="width:5.5rem">');
  assert.equal(r.pair, '<col><col style="width:4.5rem">');
  // A null/undefined value must not widen the column past its header ('Port' = 4, '5432' = 4).
  assert.equal(r.nullValue, '<col style="width:calc(4ch + 1.5rem)">');
  // 7ch (prod-01) + 12ch (the flexible floor) and 1.5 + 1.5 + 5.5 rem of padding/fixed track.
  assert.equal(r.minWidth, 'calc(19ch + 8.5rem)');
});

// ---------------------------------------------------------------------------------------------
// Appearance = "System". WebKitGTK answers prefers-color-scheme with "light" whatever the desktop
// is set to, so on Linux the answer has to come from the backend probe instead.
test('applyTheme(system): Linux takes the backend probe over the media query', async () => {
  const r = await evalJSONAsync(`(async () => {
    ${themeSetup({ platform: 'linux', systemDark: true, mediaDark: false })}
    await applyTheme('system');
    return { theme: document.documentElement.attrs['data-theme'], probes: window.__probes,
             gtk: window.__gtk, pollMs: __intervals.map((i) => i.ms) };
  })()`);
  // The media query said light; the desktop is dark, and that is what wins.
  assert.equal(r.theme, 'dark');
  assert.equal(r.probes, 1);
  // GTK is told too — the <select> drop-down list is native and no CSS reaches it.
  assert.deepEqual(r.gtk, [true]);
  // Linux gets a live poll — the media query never fires `change` for a desktop theme switch.
  assert.deepEqual(r.pollMs, [5000]);
});

test('applyTheme: a live desktop switch retells GTK, not just the page', async () => {
  const r = await evalJSONAsync(`(async () => {
    ${themeSetup({ platform: 'linux', systemDark: false, mediaDark: false })}
    await applyTheme('system');                       // desktop starts light
    window.go.main.App.IsSystemDark = async () => true; // user flips it to dark
    await __intervals[0].fn();                         // one poll tick
    return { theme: document.documentElement.attrs['data-theme'], gtk: window.__gtk };
  })()`);
  assert.equal(r.theme, 'dark');
  // The poll must drive BOTH surfaces, or the page goes dark and the drop-downs stay white.
  assert.deepEqual(r.gtk, [false, true]);
});

test('applyTheme(system): off Linux the media query answers and the backend is never probed', async () => {
  const r = await evalJSONAsync(`(async () => {
    ${themeSetup({ platform: 'darwin', systemDark: false, mediaDark: true })}
    await applyTheme('system');
    return { theme: document.documentElement.attrs['data-theme'], probes: window.__probes,
             polls: __intervals.length };
  })()`);
  assert.equal(r.theme, 'dark');
  assert.equal(r.probes, 0);
  assert.equal(r.polls, 0); // no poll: matchMedia('change') is reliable here
});

test('applyTheme: an explicit pick ignores both the probe and the media query', async () => {
  const r = await evalJSONAsync(`(async () => {
    ${themeSetup({ platform: 'linux', systemDark: true, mediaDark: true })}
    await applyTheme('light');
    return { theme: document.documentElement.attrs['data-theme'], probes: window.__probes,
             gtk: window.__gtk, polls: __intervals.length };
  })()`);
  assert.equal(r.theme, 'light');
  assert.equal(r.probes, 0);
  assert.deepEqual(r.gtk, [false]);
  assert.equal(r.polls, 0); // and it tears down any poll a previous "system" left running
});

test('applyTheme: a slow system probe cannot repaint over a newer explicit pick', async () => {
  const r = await evalJSONAsync(`(async () => {
    ${themeSetup({ platform: 'linux', systemDark: true, mediaDark: false })}
    let release;
    const gate = new Promise((res) => { release = res; });
    window.go.main.App.IsSystemDark = async () => { await gate; return true; };
    const slow = applyTheme('system');   // blocks in the probe
    await applyTheme('light');           // user picks Light while it is still in flight
    release();
    await slow;
    return { theme: document.documentElement.attrs['data-theme'], polls: __intervals.length };
  })()`);
  assert.equal(r.theme, 'light');
  assert.equal(r.polls, 0); // the superseded call must not leave a poll behind either
});
