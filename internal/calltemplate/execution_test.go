package calltemplate

import (
	"strings"
	"testing"

	"github.com/michal-bartak/pgcowboy/internal/model"
)

func TestBuild_statement_dropRole(t *testing.T) {
	sql, vals, useQuery, err := Build(
		"DROP ROLE ${loginname}",
		map[string]string{"loginname": "jdoe"},
		"remove_role",
		model.ExecutionStatement,
	)
	if err != nil {
		t.Fatal(err)
	}
	if useQuery || len(vals) != 0 {
		t.Fatalf("useQuery=%v vals=%v", useQuery, vals)
	}
	if sql != `DROP ROLE "jdoe"` {
		t.Fatalf("got: %s", sql)
	}
}

func TestBuild_statement_setComment(t *testing.T) {
	sql, vals, useQuery, err := Build(
		"COMMENT ON ROLE ${loginname} IS ${comment}",
		map[string]string{"loginname": "jdoe", "comment": `{"full_name":"O'Hara"}`},
		"set_comment",
		model.ExecutionStatement,
	)
	if err != nil {
		t.Fatal(err)
	}
	if useQuery || len(vals) != 0 {
		t.Fatalf("useQuery=%v vals=%v", useQuery, vals)
	}
	// login name double-quoted as identifier; comment embedded as an escaped string literal.
	want := `COMMENT ON ROLE "jdoe" IS '{"full_name":"O''Hara"}'`
	if sql != want {
		t.Fatalf("got:  %s\nwant: %s", sql, want)
	}
}

// A backslash in a comment must be emitted as an E'…' escape string so the literal is safe
// even when the server has standard_conforming_strings off (otherwise a trailing backslash
// could escape the closing quote and swallow following SQL).
func TestBuild_statement_setComment_backslashUsesEString(t *testing.T) {
	cases := []struct {
		comment string
		want    string
	}{
		{`domain\user`, `COMMENT ON ROLE "jdoe" IS E'domain\\user'`},
		{`ends with backslash \`, `COMMENT ON ROLE "jdoe" IS E'ends with backslash \\'`},
		{`quote'and\slash`, `COMMENT ON ROLE "jdoe" IS E'quote''and\\slash'`},
	}
	for _, tc := range cases {
		sql, _, _, err := Build(
			"COMMENT ON ROLE ${loginname} IS ${comment}",
			map[string]string{"loginname": "jdoe", "comment": tc.comment},
			"set_comment",
			model.ExecutionStatement,
		)
		if err != nil {
			t.Fatalf("comment %q: %v", tc.comment, err)
		}
		if sql != tc.want {
			t.Fatalf("comment %q:\ngot:  %s\nwant: %s", tc.comment, sql, tc.want)
		}
	}
}

func TestBuild_statement_setComment_empty(t *testing.T) {
	sql, _, _, err := Build(
		"COMMENT ON ROLE ${loginname} IS ${comment}",
		map[string]string{"loginname": "jdoe", "comment": ""},
		"set_comment",
		model.ExecutionStatement,
	)
	if err != nil {
		t.Fatal(err)
	}
	if sql != `COMMENT ON ROLE "jdoe" IS ''` {
		t.Fatalf("got: %s", sql)
	}
}

func TestBuild_statement_setAttribute(t *testing.T) {
	// ${attribute} (singular) is kept as a backward-compat alias for ${attributes}.
	sql, _, _, err := Build(
		"ALTER ROLE ${loginname} WITH ${attribute}",
		map[string]string{"loginname": "jdoe", "attribute": "NOSUPERUSER", "attributes": "NOSUPERUSER"},
		"set_attribute",
		model.ExecutionStatement,
	)
	if err != nil {
		t.Fatal(err)
	}
	// Login is double-quoted; the attribute keyword is embedded unquoted.
	if sql != `ALTER ROLE "jdoe" WITH NOSUPERUSER` {
		t.Fatalf("got: %s", sql)
	}
}

func TestBuild_statement_setAttributes_plural(t *testing.T) {
	sql, _, _, err := Build(
		"ALTER ROLE ${loginname} WITH ${attributes}",
		map[string]string{"loginname": "jdoe", "attributes": "NOSUPERUSER NOLOGIN", "attribute": "NOSUPERUSER NOLOGIN"},
		"set_attribute",
		model.ExecutionStatement,
	)
	if err != nil {
		t.Fatal(err)
	}
	if sql != `ALTER ROLE "jdoe" WITH NOSUPERUSER NOLOGIN` {
		t.Fatalf("got: %s", sql)
	}
}

func TestBuild_statement_setAttribute_multipleKeywords(t *testing.T) {
	sql, _, _, err := Build(
		"ALTER ROLE ${loginname} WITH ${attribute}",
		map[string]string{"loginname": "jdoe", "attribute": "NOSUPERUSER NOLOGIN CREATEDB"},
		"set_attribute",
		model.ExecutionStatement,
	)
	if err != nil {
		t.Fatal(err)
	}
	if sql != `ALTER ROLE "jdoe" WITH NOSUPERUSER NOLOGIN CREATEDB` {
		t.Fatalf("got: %s", sql)
	}
}

func TestBuild_statement_setConfig(t *testing.T) {
	sql, _, _, err := Build(
		"ALTER ROLE ${loginname} SET ${config_name} = ${config_value}",
		map[string]string{"loginname": "jdoe", "config_name": "search_path", "config_value": "public"},
		"set_config",
		model.ExecutionStatement,
	)
	if err != nil {
		t.Fatal(err)
	}
	// Login double-quoted, GUC name embedded unquoted, value a quoted literal.
	if sql != `ALTER ROLE "jdoe" SET search_path = 'public'` {
		t.Fatalf("got: %s", sql)
	}
}

func TestBuild_statement_setConfig_namespacedName(t *testing.T) {
	sql, _, _, err := Build(
		"ALTER ROLE ${loginname} SET ${config_name} = ${config_value}",
		map[string]string{"loginname": "jdoe", "config_name": "auto_explain.log_min_duration", "config_value": "0"},
		"set_config",
		model.ExecutionStatement,
	)
	if err != nil {
		t.Fatal(err)
	}
	if sql != `ALTER ROLE "jdoe" SET auto_explain.log_min_duration = '0'` {
		t.Fatalf("got: %s", sql)
	}
}

func TestBuild_statement_setConfig_rejectsBadName(t *testing.T) {
	_, _, _, err := Build(
		"ALTER ROLE ${loginname} SET ${config_name} = ${config_value}",
		map[string]string{"loginname": "jdoe", "config_name": "bad name; DROP", "config_value": "x"},
		"set_config",
		model.ExecutionStatement,
	)
	if err == nil {
		t.Fatal("expected error for a non-identifier setting name")
	}
}

func TestBuild_statement_setConfig_valueEscaped(t *testing.T) {
	sql, _, _, err := Build(
		"ALTER ROLE ${loginname} SET ${config_name} = ${config_value}",
		map[string]string{"loginname": "jdoe", "config_name": "search_path", "config_value": `a\b`},
		"set_config",
		model.ExecutionStatement,
	)
	if err != nil {
		t.Fatal(err)
	}
	// A backslash-bearing value uses an E'…' escape string.
	if sql != `ALTER ROLE "jdoe" SET search_path = E'a\\b'` {
		t.Fatalf("got: %s", sql)
	}
}

func TestBuild_statement_resetConfig(t *testing.T) {
	sql, _, _, err := Build(
		"ALTER ROLE ${loginname} RESET ${config_name}",
		map[string]string{"loginname": "jdoe", "config_name": "search_path"},
		"reset_config",
		model.ExecutionStatement,
	)
	if err != nil {
		t.Fatal(err)
	}
	if sql != `ALTER ROLE "jdoe" RESET search_path` {
		t.Fatalf("got: %s", sql)
	}
}

func TestBuild_statement_renameRole(t *testing.T) {
	sql, _, _, err := Build(
		"ALTER ROLE ${loginname} RENAME TO ${new_loginname}",
		map[string]string{"loginname": "jdoe", "new_loginname": `Mixed"Case`},
		"rename_role",
		model.ExecutionStatement,
	)
	if err != nil {
		t.Fatal(err)
	}
	// Both names are double-quoted identifiers: case is kept and an embedded quote is doubled.
	if sql != `ALTER ROLE "jdoe" RENAME TO "Mixed""Case"` {
		t.Fatalf("got: %s", sql)
	}
}

func TestBuild_statement_renameRole_rejectsCommaInNewName(t *testing.T) {
	_, _, _, err := Build(
		"ALTER ROLE ${loginname} RENAME TO ${new_loginname}",
		map[string]string{"loginname": "jdoe", "new_loginname": "a,b"},
		"rename_role",
		model.ExecutionStatement,
	)
	if err == nil {
		t.Fatal("expected a comma in the new name to be rejected")
	}
}

func TestBuild_statement_setAttribute_rejectsBadToken(t *testing.T) {
	_, _, _, err := Build(
		"ALTER ROLE ${loginname} WITH ${attribute}",
		map[string]string{"loginname": "jdoe", "attribute": "SUPERUSER; DROP"},
		"set_attribute",
		model.ExecutionStatement,
	)
	if err == nil {
		t.Fatal("expected error for a non-identifier attribute token")
	}
}

func TestBuild_statement_rolenameAlias(t *testing.T) {
	sql, _, _, err := Build(
		"DROP ROLE ${rolename}",
		map[string]string{"loginname": "testuser", "rolename": "testuser"},
		"remove_role",
		model.ExecutionStatement,
	)
	if err != nil {
		t.Fatal(err)
	}
	if sql != `DROP ROLE "testuser"` {
		t.Fatalf("got: %s", sql)
	}
}

// Block mode runs the user's complete anonymous code block verbatim, only embedding
// placeholder values — the app adds no DO/delimiter wrapper of its own.
func TestBuild_block_runsVerbatim(t *testing.T) {
	call := "DO $do$ BEGIN\n  DROP ROLE ${loginname};\nEND $do$;"
	sql, _, useQuery, err := Build(
		call,
		map[string]string{"loginname": "jdoe"},
		"remove_role",
		model.ExecutionBlock,
	)
	if err != nil {
		t.Fatal(err)
	}
	if useQuery {
		t.Fatal("expected Exec mode")
	}
	// The user's DO wrapper is preserved; only ${loginname} is substituted (as an identifier).
	want := "DO $do$ BEGIN\n  DROP ROLE \"jdoe\";\nEND $do$;"
	if sql != want {
		t.Fatalf("got:  %s\nwant: %s", sql, want)
	}
}

func TestBuild_function_unchanged(t *testing.T) {
	call := "your_schema.remove_app_role(${loginname})"
	sql, vals, useQuery, err := Build(
		call,
		map[string]string{"loginname": "u1"},
		"remove_role",
		model.ExecutionFunction,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !useQuery || len(vals) != 1 {
		t.Fatalf("useQuery=%v vals=%v", useQuery, vals)
	}
	if sql != "SELECT your_schema.remove_app_role($1)" {
		t.Fatalf("got: %s", sql)
	}
}

func TestValidate_rejectsRawDollarParams(t *testing.T) {
	err := ValidateCallTemplateWithExecution("drop_user($1)", "remove_role", model.ExecutionFunction)
	if err == nil || !strings.Contains(err.Error(), "$1") {
		t.Fatalf("got: %v", err)
	}
}

// Block mode now runs a complete user-authored anonymous block, so an outer DO with its own
// delimiter is accepted (the app no longer owns the wrapper).
func TestValidate_block_acceptsOuterDO(t *testing.T) {
	if err := ValidateCallTemplateWithExecution("DO $$ BEGIN NULL; END $$", "remove_role", model.ExecutionBlock); err != nil {
		t.Fatalf("outer DO should be allowed in block mode: %v", err)
	}
}

func TestValidate_statement_allowsDrop(t *testing.T) {
	if err := ValidateCallTemplateWithExecution("DROP ROLE ${loginname}", "remove_role", model.ExecutionStatement); err != nil {
		t.Fatal(err)
	}
}

func TestBuild_statement_grantParents_singleRole(t *testing.T) {
	sql, _, _, err := Build(
		"GRANT ${parent_roles} TO ${loginname}",
		map[string]string{"parent_roles": "Gr_devs_all_ro", "loginname": "test"},
		"grant_parents",
		model.ExecutionStatement,
	)
	if err != nil {
		t.Fatal(err)
	}
	if sql != `GRANT "Gr_devs_all_ro" TO "test"` {
		t.Fatalf("got: %s", sql)
	}
	if strings.Contains(sql, "'") {
		t.Fatalf("role names must not be quoted as literals: %s", sql)
	}
}

func TestBuild_statement_grantParents_multipleRoles(t *testing.T) {
	sql, _, _, err := Build(
		"GRANT ${parent_roles} TO ${loginname}",
		map[string]string{"parent_roles": "gr_a, gr_b", "loginname": "testuser"},
		"grant_parents",
		model.ExecutionStatement,
	)
	if err != nil {
		t.Fatal(err)
	}
	if sql != `GRANT "gr_a", "gr_b" TO "testuser"` {
		t.Fatalf("got: %s", sql)
	}
}

func TestBuild_statement_grantParents_hyphenNowQuoted(t *testing.T) {
	// A hyphenated name is valid once identifiers are double-quoted.
	sql, _, _, err := Build(
		"GRANT ${parent_roles} TO ${loginname}",
		map[string]string{"parent_roles": "bad-role", "loginname": "test"},
		"grant_parents",
		model.ExecutionStatement,
	)
	if err != nil {
		t.Fatal(err)
	}
	if sql != `GRANT "bad-role" TO "test"` {
		t.Fatalf("got: %s", sql)
	}
}

func TestBuild_statement_grantParents_emptyElementRejected(t *testing.T) {
	// An empty list element (trailing comma) is still rejected.
	_, _, _, err := Build(
		"GRANT ${parent_roles} TO ${loginname}",
		map[string]string{"parent_roles": "gr_a,", "loginname": "test"},
		"grant_parents",
		model.ExecutionStatement,
	)
	if err == nil {
		t.Fatal("expected error for empty list element")
	}
}

func TestBuild_statement_revokeParents(t *testing.T) {
	sql, _, _, err := Build(
		"REVOKE ${parent_roles} FROM ${loginname}",
		map[string]string{"parent_roles": "Gr_devs_all_ro", "loginname": "test"},
		"revoke_parents",
		model.ExecutionStatement,
	)
	if err != nil {
		t.Fatal(err)
	}
	if sql != `REVOKE "Gr_devs_all_ro" FROM "test"` {
		t.Fatalf("got: %s", sql)
	}
	if strings.Contains(sql, "'") {
		t.Fatalf("role names must not be single-quoted: %s", sql)
	}
}

// Identifiers are double-quoted, so mixed case is preserved, hyphens/dots are allowed, and an
// embedded double-quote is doubled.
func TestBuild_statement_identifiersQuoted_preserveCaseAndSpecial(t *testing.T) {
	sql, _, _, err := Build(
		"REVOKE ${parent_roles} FROM ${loginname}",
		map[string]string{"parent_roles": `My-Role,db.reader,od"d`, "loginname": "AdminUser"},
		"revoke_parents",
		model.ExecutionStatement,
	)
	if err != nil {
		t.Fatal(err)
	}
	want := `REVOKE "My-Role", "db.reader", "od""d" FROM "AdminUser"`
	if sql != want {
		t.Fatalf("got:  %s\nwant: %s", sql, want)
	}
}

// ${parent_roles} in function mode expands to an inline ARRAY['a','b'] literal (verbatim), NOT a
// single-string bind — so a wrapper function receives a real text[] rather than "gr_a,gr_b".
func TestBuild_function_parentRoles_inlineArray(t *testing.T) {
	sql, vals, useQuery, err := Build(
		"your_schema.grant_role_parents(${loginname}, ${parent_roles})",
		map[string]string{"loginname": "u1", "parent_roles": "gr_a, gr_b"},
		"grant_parents",
		model.ExecutionFunction,
	)
	if err != nil {
		t.Fatal(err)
	}
	// Only loginname is a bind ($1); parent_roles is embedded inline as an array literal.
	if !useQuery || len(vals) != 1 || vals[0] != "u1" {
		t.Fatalf("useQuery=%v vals=%v", useQuery, vals)
	}
	if sql != "SELECT your_schema.grant_role_parents($1, ARRAY['gr_a', 'gr_b'])" {
		t.Fatalf("got: %s", sql)
	}
}

// create_role's ${parent_roles} is the same field: statement → quoted identifier list; function →
// inline ARRAY literal. A value with a single quote is rejected (injection guard for verbatim mode).
func TestBuild_parentRoles_createRole_bothModes(t *testing.T) {
	stmt, _, _, err := Build("CREATE ROLE ${loginname} IN ROLE ${parent_roles}", // (statement)
		map[string]string{"loginname": "jdoe", "parent_roles": "gr_a, gr_b"}, "create_role", model.ExecutionStatement)
	if err != nil {
		t.Fatal(err)
	}
	if stmt != `CREATE ROLE "jdoe" IN ROLE "gr_a", "gr_b"` {
		t.Fatalf("statement got: %s", stmt)
	}
	fn, vals, _, err := Build("admin.create(${loginname}, ${parent_roles})",
		map[string]string{"loginname": "jdoe", "parent_roles": "gr_a, gr_b"}, "create_role", model.ExecutionFunction)
	if err != nil {
		t.Fatal(err)
	}
	if fn != "SELECT admin.create($1, ARRAY['gr_a', 'gr_b'])" || len(vals) != 1 {
		t.Fatalf("function got: %s vals=%v", fn, vals)
	}
	if _, _, _, err := Build("admin.create(${loginname}, ${parent_roles})",
		map[string]string{"loginname": "jdoe", "parent_roles": "gr_a', DROP"}, "create_role", model.ExecutionFunction); err == nil {
		t.Fatal("expected a single-quote-bearing role name to be rejected")
	}
}

// --- Comment-field placeholders (create_role / set_comment) ---

// TestBuild_commentFields_statementTyping covers the JSON-typed embedding: string → quoted
// literal, empty/null/absent → bare NULL, number/bool → typed literal, array/object → JSON text.
func TestBuild_commentFields_statementTyping(t *testing.T) {
	call := "CREATE ROLE ${loginname} /* ${{full_name}} ${{e_mail}} ${{age}} ${{active}} ${{tags}} */"
	args := map[string]string{
		"loginname":    "jdoe",
		"cf:full_name": `"John O'Hara"`,
		"cf:e_mail":    `""`, // empty string → NULL
		"cf:age":       `42`,
		"cf:active":    `true`,
		"cf:tags":      `["a","b"]`,
		// "missing" intentionally absent → NULL
	}
	sql, _, useQuery, err := Build(call, args, "create_role", model.ExecutionStatement,
		"full_name", "e_mail", "age", "active", "tags", "missing")
	if err != nil {
		t.Fatal(err)
	}
	if useQuery {
		t.Fatal("statement mode should not use a query")
	}
	want := `CREATE ROLE "jdoe" /* 'John O''Hara' NULL 42 TRUE '["a","b"]' */`
	if sql != want {
		t.Fatalf("got:  %s\nwant: %s", sql, want)
	}
}

// TestBuild_commentFields_absentIsNull ensures an unconfigured-in-args field resolves to NULL
// rather than erroring "missing value".
func TestBuild_commentFields_absentIsNull(t *testing.T) {
	sql, _, _, err := Build("COMMENT ON ROLE ${loginname} IS ${comment} -- ${{dept}}",
		map[string]string{"loginname": "jdoe", "comment": "'{}'"}, "set_comment", model.ExecutionStatement, "dept")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(sql, "-- NULL") {
		t.Fatalf("expected trailing NULL, got: %s", sql)
	}
}

// TestBuild_commentFields_functionBinds ensures function mode binds typed values (nil / string /
// number / bool) rather than raw JSON text.
func TestBuild_commentFields_functionBinds(t *testing.T) {
	_, vals, useQuery, err := Build("admin.create(${loginname}, ${{full_name}}, ${{age}}, ${{missing}})",
		map[string]string{"loginname": "jdoe", "cf:full_name": `"Jane"`, "cf:age": `7`},
		"create_role", model.ExecutionFunction, "full_name", "age", "missing")
	if err != nil {
		t.Fatal(err)
	}
	if !useQuery {
		t.Fatal("function mode should use a query")
	}
	// $1 loginname (string), $2 full_name ("Jane"), $3 age (7), $4 missing (nil).
	if len(vals) != 4 {
		t.Fatalf("want 4 binds, got %v", vals)
	}
	if vals[1] != "Jane" {
		t.Fatalf("full_name bind: %#v", vals[1])
	}
	if f, ok := vals[2].(float64); !ok || f != 7 {
		t.Fatalf("age bind: %#v", vals[2])
	}
	if vals[3] != nil {
		t.Fatalf("missing bind should be nil, got %#v", vals[3])
	}
}

// TestBuild_commentFields_emptyStringIsNull pins the requirement that an empty-string comment
// field (JSON-encoded as `""` — present in the args, not absent) is stored as SQL NULL in BOTH
// execution modes, exactly like a JSON null or a missing key — never as an empty literal ”.
func TestBuild_commentFields_emptyStringIsNull(t *testing.T) {
	// Statement mode: embedded as a bare, unquoted NULL (not '').
	sql, _, _, err := Build("CREATE ROLE ${loginname} -- ${{full_name}}",
		map[string]string{"loginname": "jdoe", "cf:full_name": `""`}, "create_role", model.ExecutionStatement, "full_name")
	if err != nil {
		t.Fatal(err)
	}
	if sql != `CREATE ROLE "jdoe" -- NULL` {
		t.Fatalf("statement got: %q, want trailing NULL", sql)
	}

	// Function mode: bound as a real nil (→ SQL NULL), not the empty string "".
	_, vals, useQuery, err := Build("admin.create(${loginname}, ${{full_name}})",
		map[string]string{"loginname": "jdoe", "cf:full_name": `""`}, "create_role", model.ExecutionFunction, "full_name")
	if err != nil {
		t.Fatal(err)
	}
	if !useQuery || len(vals) != 2 {
		t.Fatalf("useQuery=%v vals=%v", useQuery, vals)
	}
	if vals[1] != nil {
		t.Fatalf("empty-string full_name should bind as nil (NULL), got %#v", vals[1])
	}
}

// TestValidate_createRole_rejectsRemovedFullnameEmail confirms the legacy fullname/email
// placeholders are gone (hard removal), while a configured comment field is accepted.
func TestValidate_createRole_rejectsRemovedFullnameEmail(t *testing.T) {
	if err := ValidateCallTemplateWithExecution("CREATE ROLE ${loginname} -- ${fullname}", "create_role", model.ExecutionStatement); err == nil {
		t.Fatal("expected ${fullname} to be rejected for create_role")
	}
	if err := ValidateCallTemplateWithExecution("CREATE ROLE ${loginname} -- ${email}", "create_role", model.ExecutionStatement); err == nil {
		t.Fatal("expected ${email} to be rejected for create_role")
	}
	// A comment field lives in the ${{...}} namespace only, and only when configured.
	if err := ValidateCallTemplateWithExecution("CREATE ROLE ${loginname} -- ${{full_name}}", "create_role", model.ExecutionStatement); err == nil {
		t.Fatal("expected ${{full_name}} rejected when not configured")
	}
	if err := ValidateCallTemplateWithExecution("CREATE ROLE ${loginname} -- ${{full_name}}", "create_role", model.ExecutionStatement, "full_name"); err != nil {
		t.Fatalf("configured ${{full_name}} should be allowed: %v", err)
	}
	// The bare form is a built-in name only — even for a configured field. This is the inversion
	// that separates the namespaces — there is no migration, a stale template is simply rejected.
	if err := ValidateCallTemplateWithExecution("CREATE ROLE ${loginname} -- ${full_name}", "create_role", model.ExecutionStatement, "full_name"); err == nil {
		t.Fatal("expected bare ${full_name} rejected even when configured")
	}
}
