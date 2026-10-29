package commands

import (
	"fmt"
	"strings"

	"github.com/michal-bartak/pgcowboy/internal/calltemplate"
	"github.com/michal-bartak/pgcowboy/internal/model"
)

const (
	OpCreateRole     = "create_role"
	OpRemoveRole     = "remove_role"
	OpRenameRole     = "rename_role"
	OpGrantParents   = "grant_parents"
	OpRevokeParents  = "revoke_parents"
	OpChangePassword = "change_password"
	OpSetComment     = "set_comment"
	OpSetAttribute   = "set_attribute"
	OpSetConfig      = "set_config"
	OpResetConfig    = "reset_config"
)

// ValidConfigName reports whether name is an acceptable role GUC name. Delegates to
// calltemplate, which embeds the name unquoted and so owns the rule — validating it here against
// a second copy of the pattern is how the two could have drifted apart.
func ValidConfigName(name string) bool {
	return calltemplate.IsGUCName(name)
}

// allowedAttributeKeywords are the ALTER ROLE attribute keywords the app may emit.
var allowedAttributeKeywords = map[string]bool{
	"SUPERUSER": true, "NOSUPERUSER": true,
	"CREATEROLE": true, "NOCREATEROLE": true,
	"CREATEDB": true, "NOCREATEDB": true,
	"INHERIT": true, "NOINHERIT": true,
	"LOGIN": true, "NOLOGIN": true,
	"REPLICATION": true, "NOREPLICATION": true,
	"BYPASSRLS": true, "NOBYPASSRLS": true,
}

// commentFieldArgs copies the per-cluster comment-field values (JSON-encoded; see
// model.CreateRoleParams.CommentFields) into a fresh args map, under prefixed keys so a field keyed
// like a built-in placeholder keeps its own entry. Built-in values are then layered on under their
// bare names, in any order. A nil/empty input yields an empty (non-nil) map.
func commentFieldArgs(fields map[string]string) map[string]string {
	args := make(map[string]string, len(fields)+2)
	for k, v := range fields {
		args[model.CommentArgKey(k)] = v
	}
	return args
}

func BuildArgs(cfg model.Config, op model.OperationSpec) (model.DBFunction, map[string]string, error) {
	switch op.Operation {
	case OpCreateRole:
		if op.CreateRole == nil {
			return model.DBFunction{}, nil, fmt.Errorf("create role parameters missing")
		}
		p := op.CreateRole
		args := commentFieldArgs(p.CommentFields)
		args["loginname"] = p.LoginName
		args["parent_roles"] = p.ParentRoles
		return cfg.DBFunctions.CreateRole, args, nil
	case OpRemoveRole:
		if op.RemoveRole == nil {
			return model.DBFunction{}, nil, fmt.Errorf("remove role parameters missing")
		}
		login := op.RemoveRole.LoginName
		return cfg.DBFunctions.RemoveRole, map[string]string{
			"loginname": login,
			"rolename":  login,
		}, nil
	case OpRenameRole:
		if op.RenameRole == nil {
			return model.DBFunction{}, nil, fmt.Errorf("rename role parameters missing")
		}
		return cfg.DBFunctions.RenameRole, map[string]string{
			"loginname":     op.RenameRole.LoginName,
			"new_loginname": op.RenameRole.NewLoginName,
		}, nil
	case OpGrantParents:
		if op.GrantParents == nil {
			return model.DBFunction{}, nil, fmt.Errorf("grant parents parameters missing")
		}
		return cfg.DBFunctions.GrantParents, map[string]string{
			"loginname":    op.GrantParents.LoginName,
			"parent_roles": op.GrantParents.ParentRoles,
		}, nil
	case OpRevokeParents:
		if op.RevokeParents == nil {
			return model.DBFunction{}, nil, fmt.Errorf("revoke parents parameters missing")
		}
		return cfg.DBFunctions.RevokeParents, map[string]string{
			"loginname":    op.RevokeParents.LoginName,
			"parent_roles": op.RevokeParents.ParentRoles,
		}, nil
	case OpChangePassword:
		if op.ChangePassword == nil {
			return model.DBFunction{}, nil, fmt.Errorf("change password parameters missing")
		}
		return cfg.DBFunctions.ChangePassword, map[string]string{
			"loginname":    op.ChangePassword.LoginName,
			"new_password": op.ChangePassword.NewPassword,
		}, nil
	case OpSetComment:
		if op.SetComment == nil {
			return model.DBFunction{}, nil, fmt.Errorf("set comment parameters missing")
		}
		args := commentFieldArgs(op.SetComment.CommentFields)
		args["loginname"] = op.SetComment.LoginName
		args["comment"] = op.SetComment.Comment
		return cfg.DBFunctions.SetComment, args, nil
	case OpSetAttribute:
		if op.SetAttribute == nil {
			return model.DBFunction{}, nil, fmt.Errorf("set attribute parameters missing")
		}
		return cfg.DBFunctions.SetAttribute, map[string]string{
			"loginname":  op.SetAttribute.LoginName,
			"attributes": op.SetAttribute.Attribute, // ${attributes} (plural)
			"attribute":  op.SetAttribute.Attribute, // legacy alias
		}, nil
	case OpSetConfig:
		if op.SetConfig == nil {
			return model.DBFunction{}, nil, fmt.Errorf("set config parameters missing")
		}
		return cfg.DBFunctions.SetConfig, map[string]string{
			"loginname":    op.SetConfig.LoginName,
			"config_name":  op.SetConfig.ConfigName,
			"config_value": op.SetConfig.ConfigValue,
		}, nil
	case OpResetConfig:
		if op.ResetConfig == nil {
			return model.DBFunction{}, nil, fmt.Errorf("reset config parameters missing")
		}
		return cfg.DBFunctions.ResetConfig, map[string]string{
			"loginname":   op.ResetConfig.LoginName,
			"config_name": op.ResetConfig.ConfigName,
		}, nil
	default:
		return model.DBFunction{}, nil, fmt.Errorf("unknown operation: %s", op.Operation)
	}
}

// ValidateOperation checks one operation's params (login present, attribute/config well-formed).
// It does NOT check cluster targeting — that is a request/batch-level concern.
func ValidateOperation(cfg model.Config, op model.OperationSpec) error {
	switch op.Operation {
	case OpCreateRole:
		if op.CreateRole == nil || strings.TrimSpace(op.CreateRole.LoginName) == "" {
			return fmt.Errorf("login name is required")
		}
		// parent_roles is optional (empty → the create_role template's fixed base groups only)
	case OpRemoveRole:
		if op.RemoveRole == nil || strings.TrimSpace(op.RemoveRole.LoginName) == "" {
			return fmt.Errorf("login name is required")
		}
	case OpRenameRole:
		if op.RenameRole == nil || strings.TrimSpace(op.RenameRole.LoginName) == "" {
			return fmt.Errorf("login name is required")
		}
		if strings.TrimSpace(op.RenameRole.NewLoginName) == "" {
			return fmt.Errorf("new login name is required")
		}
		if op.RenameRole.NewLoginName == op.RenameRole.LoginName {
			return fmt.Errorf("new login name is the same as the current one")
		}
		// The identifier itself (comma / NUL) is checked where it is quoted, in calltemplate.
	case OpGrantParents:
		if op.GrantParents == nil || strings.TrimSpace(op.GrantParents.LoginName) == "" {
			return fmt.Errorf("login name is required")
		}
	case OpRevokeParents:
		if op.RevokeParents == nil || strings.TrimSpace(op.RevokeParents.LoginName) == "" {
			return fmt.Errorf("login name is required")
		}
	case OpChangePassword:
		if op.ChangePassword == nil || strings.TrimSpace(op.ChangePassword.LoginName) == "" {
			return fmt.Errorf("login name is required")
		}
	case OpSetComment:
		if op.SetComment == nil || strings.TrimSpace(op.SetComment.LoginName) == "" {
			return fmt.Errorf("login name is required")
		}
	case OpSetAttribute:
		if op.SetAttribute == nil || strings.TrimSpace(op.SetAttribute.LoginName) == "" {
			return fmt.Errorf("login name is required")
		}
		// The attribute value may be a space-separated list of keywords (e.g. "NOSUPERUSER
		// NOLOGIN"), emitted as one ALTER ROLE ... WITH ...; validate each token.
		kws := strings.Fields(op.SetAttribute.Attribute)
		if len(kws) == 0 {
			return fmt.Errorf("at least one role attribute is required")
		}
		for _, kw := range kws {
			if !allowedAttributeKeywords[strings.ToUpper(kw)] {
				return fmt.Errorf("unsupported role attribute: %q", kw)
			}
		}
	case OpSetConfig:
		if op.SetConfig == nil || strings.TrimSpace(op.SetConfig.LoginName) == "" {
			return fmt.Errorf("login name is required")
		}
		if !ValidConfigName(op.SetConfig.ConfigName) {
			return fmt.Errorf("invalid setting name: %q", op.SetConfig.ConfigName)
		}
	case OpResetConfig:
		if op.ResetConfig == nil || strings.TrimSpace(op.ResetConfig.LoginName) == "" {
			return fmt.Errorf("login name is required")
		}
		if !ValidConfigName(op.ResetConfig.ConfigName) {
			return fmt.Errorf("invalid setting name: %q", op.ResetConfig.ConfigName)
		}
	default:
		return fmt.Errorf("unknown operation: %s", op.Operation)
	}
	return nil
}

// ValidateRoleBatch validates a per-cluster batch request: at least one cluster, each with at
// least one operation, and every operation well-formed.
func ValidateRoleBatch(cfg model.Config, req model.RoleBatchRequest) error {
	if len(req.Clusters) == 0 {
		return fmt.Errorf("select at least one cluster")
	}
	for _, co := range req.Clusters {
		if len(co.Operations) == 0 {
			return fmt.Errorf("cluster %q has no operations", co.ClusterID)
		}
		for _, op := range co.Operations {
			if op.Operation == "" {
				return fmt.Errorf("operation is required")
			}
			if err := ValidateOperation(cfg, op); err != nil {
				return err
			}
		}
	}
	return nil
}

// RequiresProductionConfirm reports whether any target cluster belongs to a group
// flagged Confirm (the per-group replacement for the old hardcoded "production" id).
func RequiresProductionConfirm(categories []model.Category, clusters []model.Cluster) bool {
	confirm := make(map[string]bool, len(categories))
	for _, cat := range categories {
		confirm[cat.ID] = cat.Confirm
	}
	for _, c := range clusters {
		if confirm[c.Category] {
			return true
		}
	}
	return false
}
