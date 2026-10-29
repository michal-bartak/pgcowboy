package commands

import (
	"strings"
	"testing"

	"github.com/michal-bartak/pgcowboy/internal/calltemplate"
	"github.com/michal-bartak/pgcowboy/internal/config"
	"github.com/michal-bartak/pgcowboy/internal/model"
)

func testConfig() model.Config {
	return config.DefaultConfig()
}

// ValidateOperation is what the live batch path runs (via ValidateRoleBatch); these cases were
// previously written against the removed single-op ValidateRequest wrapper.
func TestValidateOperation_acceptsWellFormedParams(t *testing.T) {
	cfg := testConfig()
	for _, tc := range []struct {
		name string
		op   model.OperationSpec
	}{
		{"createRole", model.OperationSpec{Operation: OpCreateRole, CreateRole: &model.CreateRoleParams{LoginName: "jdoe"}}},
		{"removeRole", model.OperationSpec{Operation: OpRemoveRole, RemoveRole: &model.RemoveRoleParams{LoginName: "jdoe"}}},
		{"renameRole", model.OperationSpec{Operation: OpRenameRole, RenameRole: &model.RenameRoleParams{LoginName: "jdoe", NewLoginName: "john.doe"}}},
		{"grantParents", model.OperationSpec{Operation: OpGrantParents, GrantParents: &model.GrantParentsParams{LoginName: "jdoe", ParentRoles: "gr_a,gr_b"}}},
		{"revokeParents", model.OperationSpec{Operation: OpRevokeParents, RevokeParents: &model.RevokeParentsParams{LoginName: "jdoe", ParentRoles: "gr_a"}}},
		{"changePassword", model.OperationSpec{Operation: OpChangePassword, ChangePassword: &model.ChangePasswordParams{LoginName: "jdoe", NewPassword: "secret"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := ValidateOperation(cfg, tc.op); err != nil {
				t.Fatalf("unexpected: %v", err)
			}
		})
	}
}

// A blank login and a missing params struct must both be refused, for every operation.
func TestValidateOperation_requiresLogin(t *testing.T) {
	cfg := testConfig()
	for _, tc := range []struct {
		name string
		op   model.OperationSpec
	}{
		{"blank login", model.OperationSpec{Operation: OpCreateRole, CreateRole: &model.CreateRoleParams{LoginName: "  "}}},
		{"nil params", model.OperationSpec{Operation: OpRemoveRole}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateOperation(cfg, tc.op)
			if err == nil || !strings.Contains(err.Error(), "login") {
				t.Fatalf("got: %v", err)
			}
		})
	}
}

// A rename needs both names, and they must differ (a same-name rename is a no-op that PostgreSQL
// would reject as "role already exists").
func TestValidateOperation_renameRoleNeedsADistinctNewName(t *testing.T) {
	cfg := testConfig()
	for _, tc := range []struct {
		name, from, to, want string
	}{
		{"blank old", " ", "b", "login name is required"},
		{"blank new", "a", "  ", "new login name is required"},
		{"same name", "a", "a", "same as the current"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateOperation(cfg, model.OperationSpec{Operation: OpRenameRole,
				RenameRole: &model.RenameRoleParams{LoginName: tc.from, NewLoginName: tc.to}})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got: %v, want %q", err, tc.want)
			}
		})
	}
	if err := ValidateOperation(cfg, model.OperationSpec{Operation: OpRenameRole}); err == nil {
		t.Fatal("nil params accepted")
	}
}

func TestValidateOperation_rejectsUnknownOperation(t *testing.T) {
	err := ValidateOperation(testConfig(), model.OperationSpec{Operation: "nope"})
	if err == nil || !strings.Contains(err.Error(), "unknown operation") {
		t.Fatalf("got: %v", err)
	}
}

func TestValidateOperation_setAttribute_multiKeyword(t *testing.T) {
	cfg := testConfig()
	ok := model.OperationSpec{
		Operation:    OpSetAttribute,
		SetAttribute: &model.SetAttributeParams{LoginName: "jdoe", Attribute: "NOSUPERUSER NOLOGIN"},
	}
	if err := ValidateOperation(cfg, ok); err != nil {
		t.Fatalf("multi-keyword attribute rejected: %v", err)
	}
	bad := model.OperationSpec{
		Operation:    OpSetAttribute,
		SetAttribute: &model.SetAttributeParams{LoginName: "jdoe", Attribute: "SUPERUSER BOGUS"},
	}
	if err := ValidateOperation(cfg, bad); err == nil {
		t.Fatal("expected an unknown keyword to be rejected")
	}
	empty := model.OperationSpec{
		Operation:    OpSetAttribute,
		SetAttribute: &model.SetAttributeParams{LoginName: "jdoe", Attribute: "   "},
	}
	if err := ValidateOperation(cfg, empty); err == nil {
		t.Fatal("expected empty attribute to be rejected")
	}
}

func TestValidateRoleBatch(t *testing.T) {
	cfg := testConfig()
	good := model.RoleBatchRequest{
		Clusters: []model.ClusterOps{
			{ClusterID: "c1", Operations: []model.OperationSpec{
				{Operation: OpCreateRole, CreateRole: &model.CreateRoleParams{LoginName: "jdoe"}},
				{Operation: OpSetComment, SetComment: &model.SetCommentParams{LoginName: "jdoe", Comment: "{}"}},
			}},
		},
	}
	if err := ValidateRoleBatch(cfg, good); err != nil {
		t.Fatalf("valid batch rejected: %v", err)
	}
	if err := ValidateRoleBatch(cfg, model.RoleBatchRequest{}); err == nil {
		t.Fatal("expected empty cluster list to be rejected")
	}
	emptyOps := model.RoleBatchRequest{Clusters: []model.ClusterOps{{ClusterID: "c1"}}}
	if err := ValidateRoleBatch(cfg, emptyOps); err == nil {
		t.Fatal("expected a cluster with no operations to be rejected")
	}
	badOp := model.RoleBatchRequest{
		Clusters: []model.ClusterOps{{ClusterID: "c1", Operations: []model.OperationSpec{
			{Operation: OpCreateRole, CreateRole: &model.CreateRoleParams{LoginName: ""}},
		}}},
	}
	if err := ValidateRoleBatch(cfg, badOp); err == nil {
		t.Fatal("expected a bad operation to propagate")
	}
}

func TestBuildArgs_allOperations(t *testing.T) {
	cfg := testConfig()

	tests := []struct {
		op   string
		spec model.OperationSpec
		want map[string]string
	}{
		{
			op: OpCreateRole,
			spec: model.OperationSpec{
				Operation: OpCreateRole,
				CreateRole: &model.CreateRoleParams{
					LoginName:     "u1",
					ParentRoles:   "gr_p",
					CommentFields: map[string]string{"full_name": `"Name"`, "e_mail": `"e@x.com"`},
				},
			},
			want: map[string]string{
				// Comment-field values are namespaced (model.CommentArgKey), so a field keyed
				// like a built-in cannot overwrite it.
				"loginname": "u1", "parent_roles": "gr_p", "cf:full_name": `"Name"`, "cf:e_mail": `"e@x.com"`,
			},
		},
		{
			op:   OpRemoveRole,
			spec: model.OperationSpec{Operation: OpRemoveRole, RemoveRole: &model.RemoveRoleParams{LoginName: "u1"}},
			want: map[string]string{"loginname": "u1", "rolename": "u1"},
		},
		{
			op:   OpGrantParents,
			spec: model.OperationSpec{Operation: OpGrantParents, GrantParents: &model.GrantParentsParams{LoginName: "u1", ParentRoles: "a,b"}},
			want: map[string]string{"loginname": "u1", "parent_roles": "a,b"},
		},
		{
			op:   OpRevokeParents,
			spec: model.OperationSpec{Operation: OpRevokeParents, RevokeParents: &model.RevokeParentsParams{LoginName: "u1", ParentRoles: "gr_x"}},
			want: map[string]string{"loginname": "u1", "parent_roles": "gr_x"},
		},
		{
			op:   OpChangePassword,
			spec: model.OperationSpec{Operation: OpChangePassword, ChangePassword: &model.ChangePasswordParams{LoginName: "u1", NewPassword: "pw"}},
			want: map[string]string{"loginname": "u1", "new_password": "pw"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.op, func(t *testing.T) {
			fn, args, err := BuildArgs(cfg, tc.spec)
			if err != nil {
				t.Fatal(err)
			}
			if fn.Call == "" {
				t.Fatal("empty call template")
			}
			for k, v := range tc.want {
				if args[k] != v {
					t.Fatalf("%s: got %q want %q", k, args[k], v)
				}
			}
		})
	}
}

// TestBuildQuery_allOperations verifies SQL from the (vanilla) default templates + command
// args, building each op in its own default execution mode.
func TestBuildQuery_allOperations(t *testing.T) {
	cfg := testConfig()

	tests := []struct {
		name       string
		operation  string
		spec       model.OperationSpec
		wantSubstr []string
	}{
		{
			name:      "create_role",
			operation: OpCreateRole,
			spec: model.OperationSpec{
				Operation:  OpCreateRole,
				CreateRole: &model.CreateRoleParams{LoginName: "jdoe", ParentRoles: "gr_extra"},
			},
			wantSubstr: []string{`CREATE ROLE "jdoe"`},
		},
		{
			name:       "remove_role",
			operation:  OpRemoveRole,
			spec:       model.OperationSpec{Operation: OpRemoveRole, RemoveRole: &model.RemoveRoleParams{LoginName: "jdoe"}},
			wantSubstr: []string{`DROP ROLE "jdoe"`},
		},
		{
			name:       "rename_role",
			operation:  OpRenameRole,
			spec:       model.OperationSpec{Operation: OpRenameRole, RenameRole: &model.RenameRoleParams{LoginName: "jdoe", NewLoginName: "John.Doe"}},
			wantSubstr: []string{`ALTER ROLE "jdoe" RENAME TO "John.Doe"`},
		},
		{
			name:       "grant_parents",
			operation:  OpGrantParents,
			spec:       model.OperationSpec{Operation: OpGrantParents, GrantParents: &model.GrantParentsParams{LoginName: "jdoe", ParentRoles: "gr_a,gr_b"}},
			wantSubstr: []string{`GRANT "gr_a", "gr_b" TO "jdoe"`},
		},
		{
			name:       "revoke_parents",
			operation:  OpRevokeParents,
			spec:       model.OperationSpec{Operation: OpRevokeParents, RevokeParents: &model.RevokeParentsParams{LoginName: "jdoe", ParentRoles: "gr_a,gr_b"}},
			wantSubstr: []string{`REVOKE "gr_a", "gr_b" FROM "jdoe"`},
		},
		{
			name:       "change_password",
			operation:  OpChangePassword,
			spec:       model.OperationSpec{Operation: OpChangePassword, ChangePassword: &model.ChangePasswordParams{LoginName: "jdoe", NewPassword: "s3cret"}},
			wantSubstr: []string{`ALTER ROLE "jdoe" PASSWORD 's3cret'`},
		},
		{
			name:       "set_comment",
			operation:  OpSetComment,
			spec:       model.OperationSpec{Operation: OpSetComment, SetComment: &model.SetCommentParams{LoginName: "jdoe", Comment: "hi"}},
			wantSubstr: []string{`COMMENT ON ROLE "jdoe" IS 'hi'`},
		},
		{
			name:       "set_attribute",
			operation:  OpSetAttribute,
			spec:       model.OperationSpec{Operation: OpSetAttribute, SetAttribute: &model.SetAttributeParams{LoginName: "jdoe", Attribute: "NOLOGIN"}},
			wantSubstr: []string{`ALTER ROLE "jdoe" WITH NOLOGIN`},
		},
		{
			name:       "set_config",
			operation:  OpSetConfig,
			spec:       model.OperationSpec{Operation: OpSetConfig, SetConfig: &model.SetConfigParams{LoginName: "jdoe", ConfigName: "search_path", ConfigValue: "public"}},
			wantSubstr: []string{`ALTER ROLE "jdoe" SET search_path = 'public'`},
		},
		{
			name:       "reset_config",
			operation:  OpResetConfig,
			spec:       model.OperationSpec{Operation: OpResetConfig, ResetConfig: &model.ResetConfigParams{LoginName: "jdoe", ConfigName: "search_path"}},
			wantSubstr: []string{`ALTER ROLE "jdoe" RESET search_path`},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fn, args, err := BuildArgs(cfg, tc.spec)
			if err != nil {
				t.Fatal(err)
			}
			q, _, _, err := calltemplate.Build(fn.Call, args, tc.operation, fn.Execution)
			if err != nil {
				t.Fatal(err)
			}
			for _, s := range tc.wantSubstr {
				if !strings.Contains(q, s) {
					t.Fatalf("query missing %q:\n%s", s, q)
				}
			}
			if strings.Contains(q, "${") {
				t.Fatalf("unresolved placeholders: %s", q)
			}
		})
	}
}

func TestBuild_removeRole_statementMode(t *testing.T) {
	cfg := testConfig()
	cfg.DBFunctions.RemoveRole = model.DBFunction{
		Call:      "DROP ROLE ${loginname}",
		Execution: model.ExecutionStatement,
	}
	fn, args, err := BuildArgs(cfg, model.OperationSpec{
		Operation:  OpRemoveRole,
		RemoveRole: &model.RemoveRoleParams{LoginName: "jdoe"},
	})
	if err != nil {
		t.Fatal(err)
	}
	sql, vals, useQuery, err := calltemplate.Build(fn.Call, args, OpRemoveRole, fn.Execution)
	if err != nil {
		t.Fatal(err)
	}
	if useQuery || sql != `DROP ROLE "jdoe"` || len(vals) != 0 {
		t.Fatalf("useQuery=%v sql=%q vals=%v", useQuery, sql, vals)
	}
}

func TestBuild_revokeParents_statementMode(t *testing.T) {
	cfg := testConfig()
	fn, args, err := BuildArgs(cfg, model.OperationSpec{
		Operation:     OpRevokeParents,
		RevokeParents: &model.RevokeParentsParams{LoginName: "test", ParentRoles: "Gr_devs_all_ro"},
	})
	if err != nil {
		t.Fatal(err)
	}
	sql, vals, useQuery, err := calltemplate.Build(fn.Call, args, OpRevokeParents, fn.Execution)
	if err != nil {
		t.Fatal(err)
	}
	if useQuery || sql != `REVOKE "Gr_devs_all_ro" FROM "test"` || len(vals) != 0 {
		t.Fatalf("useQuery=%v sql=%q vals=%v", useQuery, sql, vals)
	}
}

func TestBuild_grantParents_statementMode(t *testing.T) {
	cfg := testConfig()
	cfg.DBFunctions.GrantParents = model.DBFunction{
		Call:      "GRANT ${parent_roles} TO ${loginname}",
		Execution: model.ExecutionStatement,
	}
	fn, args, err := BuildArgs(cfg, model.OperationSpec{
		Operation:    OpGrantParents,
		GrantParents: &model.GrantParentsParams{LoginName: "test", ParentRoles: "Gr_devs_all_ro"},
	})
	if err != nil {
		t.Fatal(err)
	}
	sql, vals, useQuery, err := calltemplate.Build(fn.Call, args, OpGrantParents, fn.Execution)
	if err != nil {
		t.Fatal(err)
	}
	if useQuery || sql != `GRANT "Gr_devs_all_ro" TO "test"` || len(vals) != 0 {
		t.Fatalf("useQuery=%v sql=%q vals=%v", useQuery, sql, vals)
	}
}

func TestBuildQuery_removeRole_customTemplate(t *testing.T) {
	cfg := testConfig()
	cfg.DBFunctions.RemoveRole = model.DBFunction{
		Call: "admin_access.drop_user(${loginname})",
	}
	fn, args, err := BuildArgs(cfg, model.OperationSpec{
		Operation:  OpRemoveRole,
		RemoveRole: &model.RemoveRoleParams{LoginName: "testuser"},
	})
	if err != nil {
		t.Fatal(err)
	}
	q, vals, err := calltemplate.BuildQueryFromTemplate(fn.Call, args, OpRemoveRole)
	if err != nil {
		t.Fatal(err)
	}
	if q != `SELECT admin_access.drop_user($1)` {
		t.Fatalf("got: %s", q)
	}
	if len(vals) != 1 || vals[0] != "testuser" {
		t.Fatalf("vals: %v", vals)
	}
}

func TestValidateOperation_setConfig(t *testing.T) {
	cfg := testConfig()
	ok := model.OperationSpec{
		Operation: OpSetConfig,
		SetConfig: &model.SetConfigParams{LoginName: "t", ConfigName: "log_statement", ConfigValue: "all"},
	}
	if err := ValidateOperation(cfg, ok); err != nil {
		t.Fatalf("valid set_config rejected: %v", err)
	}
	bad := model.OperationSpec{
		Operation: OpSetConfig,
		SetConfig: &model.SetConfigParams{LoginName: "t", ConfigName: "bad name;", ConfigValue: "x"},
	}
	if err := ValidateOperation(cfg, bad); err == nil {
		t.Fatal("expected invalid setting name to be rejected")
	}
	if !ValidConfigName("auto_explain.log_min_duration") || ValidConfigName("a b") {
		t.Fatal("ValidConfigName wrong")
	}
	// set_config/reset_config now build through the call-template like every other op.
	fn, args, err := BuildArgs(cfg, ok)
	if err != nil || fn.Call == "" || args["config_name"] != "log_statement" || args["config_value"] != "all" {
		t.Fatalf("BuildArgs set_config: fn=%q args=%v err=%v", fn.Call, args, err)
	}
}

func TestRequiresProductionConfirm(t *testing.T) {
	cats := []model.Category{
		{ID: "uat", Confirm: false},
		{ID: "production", Confirm: true},
	}
	clusters := []model.Cluster{
		{ID: "1", Category: "uat"},
		{ID: "2", Category: "production"},
	}
	if !RequiresProductionConfirm(cats, clusters) {
		t.Fatal("expected true when a target's group has Confirm=true")
	}
	if RequiresProductionConfirm(cats, []model.Cluster{{Category: "uat"}}) {
		t.Fatal("expected false when no target's group requires confirm")
	}
	// A group without the flag never triggers, even if named 'production'.
	noFlag := []model.Category{{ID: "production", Confirm: false}}
	if RequiresProductionConfirm(noFlag, []model.Cluster{{Category: "production"}}) {
		t.Fatal("expected false when the group's Confirm flag is off")
	}
}
