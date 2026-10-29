# PostgreSQL call templates

pgCowboy runs role operations using a **call template** per operation in **Settings** or `config.yaml` under `db_functions.<operation>`.

Each operation has:

- **`call`** — the template body
- **`execution`** — how to run it: `function` (default), `statement`, or `block`

---

## Execution modes

| `execution` | You write | App runs | Placeholders |
|-------------|-----------|----------|--------------|
| **function** (default) | `schema.fn(${loginname}, …)` | `SELECT …` with `$1`, `$2` binds | Form values → bind parameters |
| **statement** | `DROP ROLE ${loginname}` | Single statement via `Exec` | Role names **embedded** in SQL (see below) |
| **block** | A complete anonymous block, e.g. `DO $do$ BEGIN … END $do$;` | Your block, verbatim via `Exec` | Same embedding as statement |

### Why not `$1` in `DROP ROLE`?

PostgreSQL **cannot** bind object names (roles, tables) as `$1`. Templates like `DROP ROLE $1` leave `$1` unchanged or fail. Use **statement** or **block** mode so `${loginname}` becomes a validated role name in the SQL text (e.g. `DROP ROLE jdoe`).

Do **not** put raw `$1` / `$2` in templates — use `${loginname}` etc.

### Function mode (default)

```sql
SELECT <your template with $1, $2, ...>
```

User input is passed as **bind parameters**. Template literals (`NULL`, `'fixed_role'`, `ARRAY[...]`) come from config only.

Rules:

1. Write the call expression only — **no `SELECT`** (the app adds it).
2. **`${name}`** — whitelisted names only (see table below).
3. No semicolons in the template.

### Statement mode

One SQL statement, no `SELECT`, no semicolon at the end of the template.

```yaml
remove_role:
  execution: statement
  call: "DROP ROLE ${loginname}"
```

`${loginname}` and `${rolename}` (alias) are validated identifiers (`[a-zA-Z_][a-zA-Z0-9_]*`) and embedded into the statement.

Grant example:

```yaml
grant_parents:
  execution: statement
  call: "GRANT ${parent_roles} TO ${loginname}"
```

`${parent_roles}` from the form (`Gr_devs_all_ro` or `gr_a, gr_b`) becomes **unquoted** identifiers in SQL: `GRANT Gr_devs_all_ro TO test` or `GRANT gr_a, gr_b TO testuser`. It is **not** `GRANT 'Gr_devs_all_ro'` (string literals are invalid for role names in `GRANT`).

### Statement/block: how placeholders are embedded

| Field kind | Used for | Example expansion |
|------------|----------|-------------------|
| Identifier | Role/login names | `testuser`, `Gr_devs_all_ro` |
| Identifier list | `${parent_roles}` on `grant_parents` | `gr_a, gr_b` (comma-separated in form) |
| Literal (quoted) | Passwords, `${comment}` on `set_comment` | `'secret'`, `'{"full_name":"O''Hara"}'` |
| Comment field (typed) | `${{<comment field key>}}` on `create_role` / `set_comment` | `'John Doe'` (string), `42` (number), `TRUE` (bool), `NULL` (empty/absent), `'["a","b"]'` (array/object as JSON) |

Function mode always uses `$n` binds instead of embedding.

**Comment-field placeholders.** Each key configured under **Settings → Comments → Comment fields**
(`comment_fields`, e.g. `full_name`, `e_mail`) is available as `${<key>}` in the `create_role` and
`set_comment` templates. Its value is taken from the role's (JSON) comment for that cluster and
embedded **by type**: a string becomes a quoted literal, a number/boolean the bare typed literal,
an array/object its JSON text as a quoted literal, and an **empty string / JSON `null` / missing
key** becomes a bare **`NULL`** (never quoted). The clickable placeholder list under each template
editor is generated from the configured fields.

### Block mode

Write the **complete** anonymous code block, including the `DO`, your own dollar-quote
delimiter, and `BEGIN … END`. The app runs it **verbatim** (after embedding placeholders) — it
adds no wrapper of its own. Semicolons are allowed. Pick a delimiter (e.g. `$do$`) that cannot
appear in your embedded values.

```yaml
remove_role:
  execution: block
  call: |
    DO $do$ BEGIN
      DROP ROLE ${loginname};
    END $do$;
```

Because embedded literal values (e.g. `${comment}`, `${new_password}`) are inserted into your
block as SQL string literals, a value that contains your chosen delimiter would end the block
early. Choose an unusual delimiter, or use **function** mode (bind parameters) for untrusted
values.

---

## Placeholder syntax (function mode)

| Syntax | Behavior |
|--------|----------|
| `${loginname}`, `${new_password}`, … | Value from the Operations form, bound as `$n`. |
| `${parent_roles}` | Expands **inline** to `ARRAY['gr_a', 'gr_b']` (a text[] literal, values verbatim), **not** a bind; empty → `NULL`. |
| `${{<comment field>}}` | Bound as its typed value (text/number/bool, or `NULL`). |
| `NULL`, `'literal'` | Copied into SQL unchanged (from trusted config). |
| `ARRAY['gr_a', 'gr_b'] \|\| ${parent_roles}` | Fixed roles in template; empty → `\|\| NULL`; set → `\|\| $n::text[]` (this concat form binds as `$n::text[]`, unlike a standalone `${parent_roles}`). |
| `ARRAY[${parent_roles}, 'gr_a', 'gr_b']` | Normalized to `ARRAY['gr_a', 'gr_b'] \|\| ${parent_roles}`. |

`create_role` with `ARRAY ||` syntax requires **`execution: function`**.

---

## Create role

```text
admin_access.create_role(${loginname}, NULL, ${{full_name}}, ${{e_mail}}, ARRAY['gr_personal_users', 'gr_personal_users_ldap'] || ${parent_roles})
```

```yaml
db_functions:
  create_role:
    execution: function
    call: "admin_access.create_role(${loginname}, NULL, ${{full_name}}, ${{e_mail}}, ARRAY['gr_personal_users', 'gr_personal_users_ldap'] || ${parent_roles})"
```

---

## Remove role examples

**Function (wrapper on server):**

```yaml
remove_role:
  execution: function
  call: "admin_access.drop_user(${loginname})"
```

**Direct DDL:**

```yaml
remove_role:
  execution: statement
  call: "DROP ROLE ${loginname}"
```

**PL/pgSQL block:**

```yaml
remove_role:
  execution: block
  call: "DROP ROLE ${loginname};"
```

---

## Grant parent roles

**Function (wrapper on server):**

```yaml
grant_parents:
  execution: function
  call: "your_schema.grant_role_parents(${loginname}, ${parent_roles})"
```

In function mode `${parent_roles}` expands **inline** to an `ARRAY['gr_a', 'gr_b']` text[] literal
(values placed verbatim between single quotes; a value containing a `'` is rejected), so your
function receives a real array — not a comma-joined string. An empty selection → bare `NULL`.

**Direct GRANT (statement mode):**

```yaml
grant_parents:
  execution: statement
  call: "GRANT ${parent_roles} TO ${loginname}"
```

In statement/block mode, `${parent_roles}` expands to **unquoted role identifiers**, not `'literal'` strings. Comma-separated values in the form become `GRANT gr_a, gr_b TO user`. `${loginname}` is also an identifier (the member role).

Example runtime SQL: `GRANT Gr_devs_all_ro TO test` (not `GRANT 'Gr_devs_all_ro' TO test`).

---

## Revoke parent roles

Same form fields and placeholders as grant (`loginname`, `parent_roles`). Default in the app:

```yaml
revoke_parents:
  execution: statement
  call: "REVOKE ${parent_roles} FROM ${loginname}"
```

**Function (wrapper on server):**

```yaml
revoke_parents:
  execution: function
  call: "your_schema.revoke_role_parents(${loginname}, ${parent_roles})"
```

Statement/block: `${parent_roles}` → unquoted identifiers (`REVOKE Gr_devs_all_ro FROM test` or `REVOKE gr_a, gr_b FROM testuser`).

---

## Set comment

Used by the **Alter user** comments popup to write a role's `COMMENT ON ROLE`. Default in the app:

```yaml
set_comment:
  execution: statement
  call: "COMMENT ON ROLE ${loginname} IS ${comment}"
```

`${loginname}` is a validated identifier; `${comment}` is embedded as an **escaped string literal** (single quotes doubled), so JSON comments like `{"full_name":"O'Hara"}` are safe. Each configured comment field is also available as `${{<key>}}` (typed; empty/absent → `NULL`) — useful for splitting the comment into columns of a wrapper function, e.g. `admin.set_role_meta(${loginname}, ${{full_name}}, ${{e_mail}})`. Note the double braces: `${comment}` is the whole comment, `${{comment}}` a JSON key named `comment`.

---

## Set attribute

Used by the **Alter user** attributes section to toggle role flags. Default in the app:

```yaml
set_attribute:
  execution: statement
  call: "ALTER ROLE ${loginname} WITH ${attributes}"
```

`${attributes}` is a **space-separated list of whitelisted keywords** embedded unquoted — each one of `SUPERUSER`/`NOSUPERUSER`, `CREATEROLE`/`NOCREATEROLE`, `CREATEDB`/`NOCREATEDB`, `INHERIT`/`NOINHERIT`, `LOGIN`/`NOLOGIN`, `REPLICATION`/`NOREPLICATION`, `BYPASSRLS`/`NOBYPASSRLS`. The app combines all of a cluster's attribute changes into one call (e.g. `ALTER ROLE jdoe WITH NOSUPERUSER NOLOGIN`). (`${attribute}`, singular, is still accepted as an alias.)

---

## Role settings

The Alter-role **Settings** section reads `pg_roles.rolconfig` and writes role GUCs through the
configurable `set_config` / `reset_config` templates (like every other operation). Defaults:
`ALTER ROLE ${loginname} SET ${config_name} = ${config_value}` and
`ALTER ROLE ${loginname} RESET ${config_name}`. `config_name` is embedded as a **bare, unquoted**
GUC name (validated as a GUC identifier — case-insensitive, optionally namespaced); `config_value`
is a single-quote-escaped literal (`E'…'` when it contains a backslash).

---

## Introspection queries (reads)

The Alter-role flow (search, per-cluster detail, and the pre-flight check before a drop) uses four
**read** queries, configurable under
Settings → **Introspection queries** or in config `db_reads.<name>.query`. Unlike command
templates they have **no execution mode**: each is plain SQL with a single named bind
**`${rolename}`** (rewritten to `$1` before execution — it stays a bind, so it is injection-safe;
a legacy raw `$1` also works), and its result columns are scanned **by name** against a fixed
contract.

| Read | `${rolename}` | Must return columns (by name) |
|------|---------------|-------------------------------|
| `search_roles` | ILIKE pattern | `rolname` (text), `comment` (text, nullable) |
| `role_detail` | role name | one row: `rolsuper`, `rolcreaterole`, `rolcreatedb`, `rolinherit`, `rolcanlogin`, `rolreplication`, `rolbypassrls` (bool), `comment` (text, nullable), `rolconfig` (text[], nullable) |
| `role_parents` | role name | one row per parent: `rolname` (text) |
| `role_dependencies` | role name | one row per dependency: `database`, `dependency`, `class`, `object` (text, nullable) |

`role_dependencies` is the **pre-flight check** run before a role is dropped — by the **Remove
role** button and by a pending removal staged in the *Present on* editor. It runs on every cluster
the drop targets and its result is shown per cluster in a confirmation popup: a cluster that
reports rows (or that could not be checked) is **skipped** unless the user picks *Try anyway*; a
cluster with no rows is dropped without further asking. The default query reads `pg_shdepend`,
which only describes objects of the database the app connects to plus cluster-wide ones — rows
belonging to other databases are listed but reported as `Located in other database`.

Scan-by-name rules: **column order does not matter**; a NULL `comment`/`rolconfig` is fine (no
`COALESCE` needed); a contract column your query **omits** is treated as its zero value; a column
your query returns that is **not** in the contract is an **error**. Defaults are vanilla catalog
queries. Point a read at a **privileged wrapper function or view** (e.g.
`SELECT rolname, comment FROM admin.search_roles(${rolename})`) when the connect user cannot read the
catalogs directly, or to add audit logging — as long as it returns the contract columns. The
editor's **Default** button reverts a read to its vanilla built-in.

---

## Allowed placeholders

Two namespaces, and they never overlap:

- **`${name}`** — a built-in, from the closed set the operation offers (below). Any other name is
  rejected when you save.
- **`${{key}}`** — a configured comment field (Settings → Comment fields), on `create_role` and
  `set_comment` only.

That separation is what keeps a comment key named like a built-in usable: `${comment}` is the whole
comment, `${{comment}}` is a JSON key called `comment`. A comment field cannot be used inside the
`ARRAY[...] || ${...}` concat form.

| Operation | `${...}` names | Statement/block embedding |
|-----------|----------------|---------------------------|
| `create_role` | `loginname`, `parent_roles`, `${{<comment field>}}` | `loginname` identifier; `parent_roles` = statement → quoted identifier list, function → inline `ARRAY['a','b']`; comment fields typed (empty/absent → `NULL`) |
| `remove_role` | `loginname`, `rolename` | Identifiers |
| `rename_role` | `loginname`, `new_loginname` | Identifiers (current name, new name) |
| `grant_parents` | `loginname`, `parent_roles` | Identifiers; `parent_roles` = comma-separated identifier list |
| `revoke_parents` | `loginname`, `parent_roles` | Same as grant_parents |
| `change_password` | `loginname`, `new_password` | Identifier + literal (password) |
| `set_comment` | `loginname`, `comment`, `${{<comment field>}}` | Identifier + literal (comment); comment fields typed (empty/absent → `NULL`) |
| `set_attribute` | `loginname`, `attributes` (alias `attribute`) | Identifier + space-separated whitelisted keywords (e.g. `NOLOGIN`) |
| `set_config` | `loginname`, `config_name`, `config_value` | Identifier + bare GUC name (unquoted) + literal |
| `reset_config` | `loginname`, `config_name` | Identifier + bare GUC name (unquoted) |

---

## Common mistakes

| Mistake | Result |
|---------|--------|
| `DROP ROLE $1` or `drop_user($1)` in template | Use `${loginname}`; use `execution: statement` for DDL |
| `GRANT 'role_name' TO user` from `${parent_roles}` | Use `execution: statement`; parent roles are identifiers, not quoted literals |
| `REVOKE 'role_name' FROM user` | Same as GRANT — use `revoke_parents` statement mode |
| `${rolename}` without statement/block | Works as alias of login name when whitelisted |
| `SELECT` in function template | Rejected on save |
| Omitting `DO … BEGIN … END` in a block template | Block mode runs your text verbatim — write the complete anonymous block yourself |
| Full call pasted into legacy `name` field | Migrated or reset on load |
| `${full_name}` for a comment field | Rejected on save: comment keys use `${{full_name}}` — single braces are built-ins only |

---

## Security (statement / block)

Role names are embedded after strict identifier validation. Only whitelisted `${...}` placeholders are allowed. Prefer DB functions for complex logic when possible.

---

## Return values

**Function** mode: if the call returns `text`, that value appears in results; otherwise `ok`.

**Statement / block** mode: `ok` on success.
