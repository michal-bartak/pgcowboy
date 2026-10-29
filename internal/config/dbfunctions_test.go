package config

import (
	"strings"
	"testing"

	"github.com/michal-bartak/pgcowboy/internal/model"
)

func TestMigrateOne_brokenCreateRoleName(t *testing.T) {
	def := DefaultConfig()
	broken := model.DBFunction{
		Name: "admin_access.create_role(${loginname}, NULL)",
	}
	got := migrateOne(broken, def.DBFunctions.CreateRole, "create_role")
	// A broken create_role (full SQL stored in the deprecated Name field) falls back to the
	// current default template.
	if got.Call != def.DBFunctions.CreateRole.Call {
		t.Fatalf("got: %s, want default %s", got.Call, def.DBFunctions.CreateRole.Call)
	}
}

func TestMigrateOne_legacyNameAndParams(t *testing.T) {
	fn := model.DBFunction{
		Name:   "app.remove",
		Params: []string{"loginname"},
	}
	got := migrateOne(fn, model.DBFunction{}, "remove_role")
	if got.Call != "app.remove(${loginname})" {
		t.Fatalf("got: %s", got.Call)
	}
}

// A config written before rename_role existed has no key for it; loading it must supply the
// default rather than leave an empty template that fails validation.
func TestMigrateDBFunctions_fillsMissingRenameRole(t *testing.T) {
	fns := DefaultConfig().DBFunctions
	fns.RenameRole = model.DBFunction{}
	migrateDBFunctions(&fns)
	if want := "ALTER ROLE ${loginname} RENAME TO ${new_loginname}"; fns.RenameRole.Call != want {
		t.Fatalf("got: %q, want %q", fns.RenameRole.Call, want)
	}
	if err := validateDBFunctions(fns); err != nil {
		t.Fatalf("migrated defaults should validate: %v", err)
	}
}

func TestValidateDBFunctions_rejectsInvalidPlaceholder(t *testing.T) {
	fns := DefaultConfig().DBFunctions
	fns.RemoveRole = model.DBFunction{Call: "fn(${not_allowed})"}
	err := validateDBFunctions(fns)
	if err == nil || !strings.Contains(err.Error(), "remove_role") {
		t.Fatalf("got: %v", err)
	}
}

func TestValidateDBFunctions_acceptsDefaults(t *testing.T) {
	if err := validateDBFunctions(DefaultConfig().DBFunctions); err != nil {
		t.Fatal(err)
	}
}

func TestValidateDBFunctions_acceptsRevokeParentsDefault(t *testing.T) {
	fns := DefaultConfig().DBFunctions
	if err := validateDBFunctions(fns); err != nil {
		t.Fatal(err)
	}
	if fns.RevokeParents.Execution != model.ExecutionStatement {
		t.Fatalf("execution: %q", fns.RevokeParents.Execution)
	}
	if !strings.Contains(fns.RevokeParents.Call, "REVOKE") {
		t.Fatalf("call: %s", fns.RevokeParents.Call)
	}
}

func TestValidateDBFunctions_acceptsRemoveRoleStatement(t *testing.T) {
	fns := DefaultConfig().DBFunctions
	fns.RemoveRole = model.DBFunction{
		Call:      "DROP ROLE ${loginname}",
		Execution: model.ExecutionStatement,
	}
	if err := validateDBFunctions(fns); err != nil {
		t.Fatal(err)
	}
}

func TestNormalizeDBFunction_invalidExecution(t *testing.T) {
	fn := normalizeDBFunction(model.DBFunction{Execution: "invalid"})
	if fn.Execution != model.ExecutionFunction {
		t.Fatalf("got %q", fn.Execution)
	}
}

func TestNeedsCreateRoleTemplateFix(t *testing.T) {
	cases := []struct {
		call string
		want bool
	}{
		{"admin_access.create_role(${loginname}, ${Array['x']})", true},
		{"admin_access.create_role(${loginname}, ARRAY['a'] || ${parent_roles})", false},
		{"fn(${array_concat:parent_role,a,b})", true},
	}
	for _, c := range cases {
		if got := needsCreateRoleTemplateFix("create_role", c.call); got != c.want {
			t.Fatalf("%q: got %v want %v", c.call, got, c.want)
		}
	}
}

func TestValidateDBFunctions_namespaces(t *testing.T) {
	fns := DefaultConfig().DBFunctions
	fns.CreateRole = model.DBFunction{Execution: model.ExecutionFunction, Call: "admin.create(${loginname}, ${{full_name}})"}
	if err := validateDBFunctions(fns, "full_name"); err != nil {
		t.Fatalf("${{full_name}} should be accepted when configured: %v", err)
	}
	// The bare form is built-ins only, even for a configured field.
	fns.CreateRole = model.DBFunction{Execution: model.ExecutionFunction, Call: "admin.create(${loginname}, ${full_name})"}
	err := validateDBFunctions(fns, "full_name")
	if err == nil {
		t.Fatal("bare ${full_name} should be rejected")
	}
	if !strings.Contains(err.Error(), "${{full_name}}") {
		t.Fatalf("the error should point at the ${{...}} form, got: %v", err)
	}
}
