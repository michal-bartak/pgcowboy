package model

import "strings"

// DB function execution modes (config db_functions.<op>.execution).
const (
	ExecutionFunction  = "function"
	ExecutionStatement = "statement"
	ExecutionBlock     = "block"
)

// NormalizeExecution returns a valid execution mode; unknown values become function.
func NormalizeExecution(execution string) string {
	switch strings.ToLower(strings.TrimSpace(execution)) {
	case ExecutionStatement:
		return ExecutionStatement
	case ExecutionBlock:
		return ExecutionBlock
	default:
		return ExecutionFunction
	}
}

type Category struct {
	ID      string `yaml:"id" json:"id"`
	Label   string `yaml:"label" json:"label"`
	Color   string `yaml:"color,omitempty" json:"color,omitempty"`     // base hex, e.g. #e8a838
	Confirm bool   `yaml:"confirm,omitempty" json:"confirm,omitempty"` // require confirm popup before running
}

type CategoryInput struct {
	Label   string `json:"label"`
	Color   string `json:"color"`
	Confirm bool   `json:"confirm"`
}

type Cluster struct {
	ID          string `yaml:"id" json:"id"`
	Alias       string `yaml:"alias" json:"alias"`
	Host        string `yaml:"host" json:"host"`
	Port        int    `yaml:"port" json:"port"`
	Database    string `yaml:"database" json:"database"`
	Category    string `yaml:"category" json:"category"`
	SSLMode     string `yaml:"sslmode,omitempty" json:"sslmode,omitempty"`
	ConnectUser string `yaml:"connect_user,omitempty" json:"connectUser,omitempty"`
	// Password is an optional per-cluster password stored plain-text in the (private, 0600)
	// config. When set it wins over PGPASSWORD / ~/.pgpass; when empty the app falls back to
	// the environment / pgpass as before. See internal/pg/auth.go ResolvePassword.
	Password string `yaml:"password,omitempty" json:"password,omitempty"`
}

type DBFunction struct {
	Call      string   `yaml:"call" json:"call"`
	Execution string   `yaml:"execution,omitempty" json:"execution,omitempty"` // function | statement | block
	Name      string   `yaml:"name,omitempty" json:"name,omitempty"`           // deprecated, migrated on load
	Params    []string `yaml:"params,omitempty" json:"params,omitempty"`       // deprecated
}

type DBFunctions struct {
	CreateRole     DBFunction `yaml:"create_role" json:"createRole"`
	RemoveRole     DBFunction `yaml:"remove_role" json:"removeRole"`
	RenameRole     DBFunction `yaml:"rename_role" json:"renameRole"`
	GrantParents   DBFunction `yaml:"grant_parents" json:"grantParents"`
	RevokeParents  DBFunction `yaml:"revoke_parents" json:"revokeParents"`
	ChangePassword DBFunction `yaml:"change_password" json:"changePassword"`
	SetComment     DBFunction `yaml:"set_comment" json:"setComment"`
	SetAttribute   DBFunction `yaml:"set_attribute" json:"setAttribute"`
	SetConfig      DBFunction `yaml:"set_config" json:"setConfig"`
	ResetConfig    DBFunction `yaml:"reset_config" json:"resetConfig"`
}

// DBRead is one configurable introspection (read) query. Unlike DBFunction it has no
// execution mode: it is always run as a pgx Query taking a single $1 bind, and its result
// columns are scanned BY NAME against a fixed per-read contract (see DefaultConfig / sql/README).
// A deployment can point it at a privileged wrapper function or view (e.g.
// SELECT rolname, comment FROM admin.search_roles($1)) so a low-privilege connect user can
// still introspect, or so the read can add audit logging — as long as it returns the
// contract's named columns.
type DBRead struct {
	Query string `yaml:"query" json:"query"`
}

// DBReads holds the introspection queries used by the Alter-role flow. $1 is the search
// pattern (search_roles) or the role name (role_detail / role_parents / role_dependencies).
type DBReads struct {
	// SearchRoles must return columns: rolname (text), comment (text, nullable).
	SearchRoles DBRead `yaml:"search_roles" json:"searchRoles"`
	// RoleDetail must return one row with columns: rolsuper, rolcreaterole, rolcreatedb,
	// rolinherit, rolcanlogin, rolreplication, rolbypassrls (bool), comment (text, nullable),
	// rolconfig (text[], nullable).
	RoleDetail DBRead `yaml:"role_detail" json:"roleDetail"`
	// RoleParents must return one row per direct parent: rolname (text).
	RoleParents DBRead `yaml:"role_parents" json:"roleParents"`
	// RoleDependencies is the pre-flight check run before a role is dropped: one row per
	// object that depends on the role. Must return columns: database, dependency, class,
	// object (all text, nullable).
	RoleDependencies DBRead `yaml:"role_dependencies" json:"roleDependencies"`
}

// SettingsPayload is everything the Settings page stages, saved in ONE atomic call. It used to
// be seven separate bound methods invoked in sequence, each writing the config file: a rejection
// partway through left the earlier ones persisted while the UI reported failure. It also forced
// the caller to order the calls by hand, because the command templates are validated against the
// configured comment fields — here both arrive together and validation sees the new set directly.
type SettingsPayload struct {
	ParentRoles   []string       `json:"parentRoles"`
	CommentFields []CommentField `json:"commentFields"`
	SearchColumns []SearchColumn `json:"searchColumns"`
	DBFunctions   DBFunctions    `json:"dbFunctions"`
	DBReads       DBReads        `json:"dbReads"`
	Batch         BatchSettings  `json:"batch"`
	UI            UISettings     `json:"ui"`
}

// DefaultTemplates carries the built-in call templates and introspection queries to the
// frontend, so the Settings editor's "Default" button can revert a template without the SQL
// being duplicated in app.js. Config-file shape is irrelevant here — this type is only ever
// returned over the Wails bridge.
type DefaultTemplates struct {
	DBFunctions DBFunctions `json:"dbFunctions"`
	DBReads     DBReads     `json:"dbReads"`
}

type BatchSettings struct {
	MaxConcurrency int `yaml:"max_concurrency" json:"maxConcurrency"`
}

const (
	ThemeLight  = "light"
	ThemeDark   = "dark"
	ThemeSystem = "system"
)

const (
	CommentViewFields = "fields"
	CommentViewRaw    = "raw"
)

type UISettings struct {
	Theme string `yaml:"theme" json:"theme"` // light | dark | system
	// CommentDefaultView is the mode the comment editor opens in — in the role form and in
	// the Comments dialog alike: fields | raw. It is a preference, not a guarantee: a
	// plain-text comment has no fields to show and always opens in raw.
	CommentDefaultView string `yaml:"comment_default_view,omitempty" json:"commentDefaultView"`
	// StageCreateOnTargetAdd controls Alter-role behaviour when the user adds a target
	// cluster on which the role does not yet exist: when true, the role's creation is
	// auto-staged for that cluster; when false (default), the cluster is only brought into
	// scope (offered in the "Present on" editor) without staging a create.
	StageCreateOnTargetAdd bool `yaml:"stage_create_on_target_add,omitempty" json:"stageCreateOnTargetAdd"`
	// SuppressMD5RenameWarning hides the "a rename clears MD5-hashed passwords" note in the
	// Rename role confirmation — for sites that use SCRAM, LDAP etc. Off by default; also set by
	// the note's own "Suppress this warning" checkbox.
	SuppressMD5RenameWarning bool `yaml:"suppress_md5_rename_warning,omitempty" json:"suppressMd5RenameWarning"`
	// CheckForUpdates opts into the on-startup GitHub-Releases version check. Pointer so a
	// missing value (nil) defaults to ON, including for existing configs — use AutoCheck().
	CheckForUpdates *bool `yaml:"check_for_updates,omitempty" json:"checkForUpdates,omitempty"`
	// PasswordGen configures the role-form random password generator (which character classes,
	// length, exclude look-alikes). Pointer so a missing block (existing configs) falls back to
	// the built-in default via Normalized() — never nil after config load.
	PasswordGen *PasswordGen `yaml:"password_gen,omitempty" json:"passwordGen"`
}

// PasswordGen configures the role-form random password generator.
type PasswordGen struct {
	Length         int  `yaml:"length,omitempty" json:"length"`
	Lowercase      bool `yaml:"lowercase" json:"lowercase"`
	Uppercase      bool `yaml:"uppercase" json:"uppercase"`
	Digits         bool `yaml:"digits" json:"digits"`
	Symbols        bool `yaml:"symbols" json:"symbols"`
	ExcludeSimilar bool `yaml:"exclude_similar,omitempty" json:"excludeSimilar"`
}

// Password generator length bounds and default (also the frontend #pwgen-length min/max).
const (
	PasswordGenMinLength     = 6
	PasswordGenMaxLength     = 128
	PasswordGenDefaultLength = 10
)

// DefaultPasswordGen is the built-in generator config: 10 chars, lowercase + digits.
func DefaultPasswordGen() *PasswordGen {
	return &PasswordGen{Length: PasswordGenDefaultLength, Lowercase: true, Digits: true}
}

// Normalized returns a valid PasswordGen: a nil receiver becomes the default; the length is
// clamped to [PasswordGenMinLength, PasswordGenMaxLength] (default when ≤0); and if no character
// class is enabled, lowercase is forced on so the generator always has a pool to draw from.
func (p *PasswordGen) Normalized() *PasswordGen {
	if p == nil {
		return DefaultPasswordGen()
	}
	out := *p
	switch {
	case out.Length <= 0:
		out.Length = PasswordGenDefaultLength
	case out.Length < PasswordGenMinLength:
		out.Length = PasswordGenMinLength
	case out.Length > PasswordGenMaxLength:
		out.Length = PasswordGenMaxLength
	}
	if !out.Lowercase && !out.Uppercase && !out.Digits && !out.Symbols {
		out.Lowercase = true
	}
	return &out
}

// AutoCheck reports whether the on-startup update check is enabled (nil = default ON).
func (u UISettings) AutoCheck() bool {
	return u.CheckForUpdates == nil || *u.CheckForUpdates
}

// NormalizeTheme returns a valid theme preference; unknown values become system.
func NormalizeTheme(theme string) string {
	switch strings.ToLower(strings.TrimSpace(theme)) {
	case ThemeLight:
		return ThemeLight
	case ThemeDark:
		return ThemeDark
	default:
		return ThemeSystem
	}
}

// NormalizeCommentView returns a valid comment-view preference; unknown values become raw,
// which is also the built-in default (a comment is plain text until a site decides otherwise).
func NormalizeCommentView(view string) string {
	if strings.ToLower(strings.TrimSpace(view)) == CommentViewFields {
		return CommentViewFields
	}
	return CommentViewRaw
}

// ClusterSet is everything persisted in clusters.yaml: the cluster inventory, the groups it
// references, and the remembered target selection. It is kept out of config.yaml because it is
// site-specific (and carries the optional plain-text per-cluster password), while config.yaml
// holds shareable app configuration — templates, comment fields, UI preferences.
//
// It is embedded anonymously in Config, so readers still write cfg.Clusters / cfg.Categories /
// cfg.Targets and the JSON wire shape stays flat (encoding/json and the Wails generator both
// flatten an embedded struct — see RunRequest/OperationSpec). The `yaml:"-"` on the embed in
// Config is the whole mechanism of the file split: a new cluster-scoped field added HERE lands
// in clusters.yaml automatically, and a new app-scoped field added to Config lands in
// config.yaml automatically. Neither needs a per-field tag to remember.
type ClusterSet struct {
	Categories []Category `yaml:"categories" json:"categories"`
	Clusters   []Cluster  `yaml:"clusters" json:"clusters"`
	// Targets is the last target selection on the Operations page (cluster groups and/or
	// specific clusters), remembered across re-renders and restarts. Empty = "all groups".
	Targets TargetSelection `yaml:"targets,omitempty" json:"targets"`
}

// ClustersFile is the on-disk shape of clusters.yaml.
type ClustersFile struct {
	Version    int `yaml:"version"`
	ClusterSet `yaml:",inline"`
}

type Config struct {
	Version int `yaml:"version" json:"version"`
	// ClusterSet is persisted in clusters.yaml, never here — see its doc comment.
	ClusterSet  `yaml:"-"`
	DBFunctions DBFunctions   `yaml:"db_functions" json:"dbFunctions"`
	DBReads     DBReads       `yaml:"db_reads" json:"dbReads"`
	Batch       BatchSettings `yaml:"batch" json:"batch"`
	UI          UISettings    `yaml:"ui" json:"ui"`
	// ParentRoles are preconfigured role parents offered as pick-list choices when assigning
	// role parents (Create role / Alter role), instead of typing role names.
	ParentRoles []string `yaml:"parent_roles,omitempty" json:"parentRoles"`
	// CommentFields are the JSON keys the app surfaces as labeled inputs when a role
	// comment holds JSON (Create role / Alter role). Ordered; keys not listed here are
	// still shown generically. Empty by default and never defaulted on load, so a user who
	// removes every field keeps an empty list.
	CommentFields []CommentField `yaml:"comment_fields,omitempty" json:"commentFields"`
	// SearchColumns are the extra columns shown next to the role name in the Find-role
	// results, each built from a display template over the role's comment. Ordered. No
	// omitempty: an explicitly empty list means "role name only" and must round-trip as
	// `search_columns: []`, while an absent key (older config) still gets the default
	// "Comment" column.
	SearchColumns []SearchColumn `yaml:"search_columns" json:"searchColumns"`
	// WindowWidth/WindowHeight are the last OS window size (Wails WindowGetSize, not the
	// webview viewport), restored on next launch. 0 = use the built-in default.
	WindowWidth  int `yaml:"window_width,omitempty" json:"windowWidth,omitempty"`
	WindowHeight int `yaml:"window_height,omitempty" json:"windowHeight,omitempty"`
	// UpdateSeenVersion is the latest release version the startup update popup last showed;
	// used to suppress re-popping for a version the user already dismissed (the About dialog
	// still surfaces it). Manual checks ignore this.
	UpdateSeenVersion string `yaml:"update_seen_version,omitempty" json:"updateSeenVersion,omitempty"`
}

// TargetSelection remembers the Operations-page target selection. An empty selection
// (both lists empty/absent) is treated by the UI as the default "all groups selected".
type TargetSelection struct {
	CategoryIDs []string `yaml:"category_ids,omitempty" json:"categoryIds"`
	ClusterIDs  []string `yaml:"cluster_ids,omitempty" json:"clusterIds"`
}

// CommentField maps a JSON comment key to a human label shown in the role form.
type CommentField struct {
	Key   string `yaml:"key" json:"key"`
	Label string `yaml:"label" json:"label"`
}

// SearchColumn is one extra column in the Find-role results. Template is display-only text
// (rendered by the frontend, never SQL): ${<key>} resolves to that key's value in the role's
// JSON comment, and the reserved ${comment} to the raw comment. An unresolved key renders
// empty. Label is the column header; blank is allowed.
type SearchColumn struct {
	Label    string `yaml:"label" json:"label"`
	Template string `yaml:"template" json:"template"`
}

// CommentArgPrefix namespaces a comment field's value in an operation's args map. Without it a
// field keyed like a built-in placeholder (comment, loginname, …) would share one map entry with
// that built-in, so ${comment} and ${{comment}} could not both be resolved for the same call.
// It is applied inside commands.BuildArgs — the Wails wire format (CreateRoleParams.CommentFields /
// SetCommentParams.CommentFields) stays keyed by the bare key.
const CommentArgPrefix = "cf:"

// CommentArgKey is the args-map key holding the ${{key}} placeholder's value.
func CommentArgKey(key string) string { return CommentArgPrefix + key }

// CommentFieldKeys returns the configured comment-field keys in order. These are the placeholder
// names (${{<key>}}) additionally offered to the create_role / set_comment call templates.
func (c Config) CommentFieldKeys() []string {
	keys := make([]string, 0, len(c.CommentFields))
	for _, f := range c.CommentFields {
		if f.Key != "" {
			keys = append(keys, f.Key)
		}
	}
	return keys
}

// ClustersConfig is the whole clusters+categories set, saved atomically from the staged
// Clusters editor. A cluster/category with an empty ID is treated as new.
type ClustersConfig struct {
	Clusters   []Cluster  `json:"clusters"`
	Categories []Category `json:"categories"`
}

type ClusterInput struct {
	Alias       string `json:"alias"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	Database    string `json:"database"`
	Category    string `json:"category"`
	SSLMode     string `json:"sslMode"`
	ConnectUser string `json:"connectUser"`
	Password    string `json:"password"`
}

type AuthContext struct {
	User     string `json:"user"`
	Password string `json:"password"`
}

type CreateRoleParams struct {
	LoginName string `json:"loginName"`
	// ParentRoles is a comma-separated role list for the create_role template's ${parent_roles}
	// placeholder (same field/name as grant_parents). The Create form leaves it empty and grants
	// parents via follow-up grant_parents ops; it matters for a custom create_role template.
	ParentRoles string `json:"parentRoles"`
	// CommentFields carries the configured comment-field placeholders (${<key>}) offered to the
	// create_role template. Each value is the JSON encoding of that key's value in the role's
	// comment (e.g. `"John"`, `42`, `true`, `null`); an absent key resolves to SQL NULL. Replaces
	// the former hardcoded fullName/email placeholders.
	CommentFields map[string]string `json:"commentFields,omitempty"`
}

type RemoveRoleParams struct {
	LoginName string `json:"loginName"`
}

type GrantParentsParams struct {
	LoginName   string `json:"loginName"`
	ParentRoles string `json:"parentRoles"`
}

type RevokeParentsParams struct {
	LoginName   string `json:"loginName"`
	ParentRoles string `json:"parentRoles"`
}

type ChangePasswordParams struct {
	LoginName   string `json:"loginName"`
	NewPassword string `json:"newPassword"`
}

type SetCommentParams struct {
	LoginName string `json:"loginName"`
	Comment   string `json:"comment"`
	// CommentFields carries the configured comment-field placeholders (${<key>}) offered to the
	// set_comment template — same JSON-encoded-value convention as CreateRoleParams.CommentFields.
	CommentFields map[string]string `json:"commentFields,omitempty"`
}

// SetAttributeParams sets one ALTER ROLE attribute keyword (e.g. SUPERUSER / NOSUPERUSER).
type SetAttributeParams struct {
	LoginName string `json:"loginName"`
	Attribute string `json:"attribute"`
}

// SetConfigParams sets one role GUC: ALTER ROLE <login> SET <name> = '<value>'.
type SetConfigParams struct {
	LoginName   string `json:"loginName"`
	ConfigName  string `json:"configName"`
	ConfigValue string `json:"configValue"`
}

// RenameRoleParams renames a role: ALTER ROLE <login> RENAME TO <new login>.
type RenameRoleParams struct {
	LoginName    string `json:"loginName"`
	NewLoginName string `json:"newLoginName"`
}

// ResetConfigParams clears one role GUC: ALTER ROLE <login> RESET <name>.
type ResetConfigParams struct {
	LoginName  string `json:"loginName"`
	ConfigName string `json:"configName"`
}

// OperationSpec is a single operation and its parameters, with no cluster targeting.
// Exactly one of the *Params pointers is non-nil, matching Operation.
type OperationSpec struct {
	Operation      string                `json:"operation"`
	CreateRole     *CreateRoleParams     `json:"createRole,omitempty"`
	RemoveRole     *RemoveRoleParams     `json:"removeRole,omitempty"`
	RenameRole     *RenameRoleParams     `json:"renameRole,omitempty"`
	GrantParents   *GrantParentsParams   `json:"grantParents,omitempty"`
	RevokeParents  *RevokeParentsParams  `json:"revokeParents,omitempty"`
	ChangePassword *ChangePasswordParams `json:"changePassword,omitempty"`
	SetComment     *SetCommentParams     `json:"setComment,omitempty"`
	SetAttribute   *SetAttributeParams   `json:"setAttribute,omitempty"`
	SetConfig      *SetConfigParams      `json:"setConfig,omitempty"`
	ResetConfig    *ResetConfigParams    `json:"resetConfig,omitempty"`
}

// RunRequest targets clusters with a single operation. OperationSpec is embedded so the JSON
// wire shape is unchanged (operation + param pointers promote to the top level).
type RunRequest struct {
	OperationSpec
	CategoryIDs       []string    `json:"categoryIds"`
	ClusterIDs        []string    `json:"clusterIds"`
	Auth              AuthContext `json:"auth"`
	ConfirmProduction bool        `json:"confirmProduction"`
}

// ClusterOps is one cluster's ordered operation list (e.g. create_role, then
// grants/attributes/configs/comment), run as a single transaction on that cluster.
type ClusterOps struct {
	ClusterID  string          `json:"clusterId"`
	Operations []OperationSpec `json:"operations"`
}

// RoleBatchRequest applies, per cluster, an ordered list of operations inside one transaction.
type RoleBatchRequest struct {
	Clusters          []ClusterOps `json:"clusters"`
	Auth              AuthContext  `json:"auth"`
	ConfirmProduction bool         `json:"confirmProduction"`
}

type ClusterResult struct {
	ClusterID  string `json:"clusterId"`
	Alias      string `json:"alias"`
	Host       string `json:"host"`
	Category   string `json:"category"`
	Status     string `json:"status"`
	Message    string `json:"message"`
	DurationMs int64  `json:"durationMs"`
	// Queries are the SQL statements executed on this cluster, in order (including the failing
	// one on rollback). Display-only; function-mode ops have their bind params inlined.
	Queries []string `json:"queries,omitempty"`
}

// ClusterProgress is a live per-cluster event during a role batch run.
// Phase is "running" (work started for this cluster) or "done" (result ready).
type ClusterProgress struct {
	ClusterID  string `json:"clusterId"`
	Alias      string `json:"alias"`
	Host       string `json:"host"`
	Category   string `json:"category"`
	Phase      string   `json:"phase"`  // "running" | "done"
	Status     string   `json:"status"` // "" while running; "ok"/"error" when done
	Message    string   `json:"message"`
	DurationMs int64    `json:"durationMs"`
	Queries    []string `json:"queries,omitempty"` // executed SQL (set on the "done" event)
}

type TestConnectionRequest struct {
	ClusterID string      `json:"clusterId"`
	Auth      AuthContext `json:"auth"`
}

// AppVersion is build metadata shown in the UI (not config file version).
type AppVersion struct {
	Version   string `json:"version"`
	Commit    string `json:"commit"`
	BuildDate string `json:"buildDate"`
	RepoURL   string `json:"repoURL"`
	DocsURL   string `json:"docsURL"`
}

// UpdateInfo is the result of a GitHub-Releases version check.
type UpdateInfo struct {
	CurrentVersion  string `json:"currentVersion"`
	LatestVersion   string `json:"latestVersion"`   // bare (no leading v); "" if no release found
	UpdateAvailable bool   `json:"updateAvailable"` // LatestVersion is newer than CurrentVersion
	ReleaseURL      string `json:"releaseURL"`      // GitHub release page (html_url)
	ReleaseName     string `json:"releaseName,omitempty"`
	Notes           string `json:"notes,omitempty"` // release body (may be truncated for display)
}

// RoleSearchRequest searches roles by a substring matched against role name and
// comment across the selected clusters/categories.
type RoleSearchRequest struct {
	Term        string      `json:"term"`
	CategoryIDs []string    `json:"categoryIds"`
	ClusterIDs  []string    `json:"clusterIds"`
	Auth        AuthContext `json:"auth"`
}

// RoleDetailsRequest loads one login's per-cluster state across the selected
// clusters/categories.
type RoleDetailsRequest struct {
	LoginName   string      `json:"loginName"`
	CategoryIDs []string    `json:"categoryIds"`
	ClusterIDs  []string    `json:"clusterIds"`
	Auth        AuthContext `json:"auth"`
}

// RoleDependenciesRequest runs the pre-flight dependency check for one login across the
// selected clusters/categories, before the role is dropped there.
type RoleDependenciesRequest struct {
	LoginName   string      `json:"loginName"`
	CategoryIDs []string    `json:"categoryIds"`
	ClusterIDs  []string    `json:"clusterIds"`
	Auth        AuthContext `json:"auth"`
}

// RoleDependency is one object that depends on a role (one row of the role_dependencies read).
type RoleDependency struct {
	Database   string `json:"database"`
	Dependency string `json:"dependency"`
	Class      string `json:"class"`
	Object     string `json:"object"`
}

// ClusterRoleDependencies is one role's dependencies on one cluster. It mirrors
// ClusterRoleDetail (same identity fields + DurationMs/Queries) so the popup can show the
// executed SQL the same way the run-status popup does.
type ClusterRoleDependencies struct {
	ClusterID    string           `json:"clusterId"`
	Alias        string           `json:"alias"`
	Host         string           `json:"host"`
	Category     string           `json:"category"`
	Dependencies []RoleDependency `json:"dependencies"`
	Error        string           `json:"error,omitempty"` // per-cluster connect/query error, if any
	DurationMs   int64            `json:"durationMs"`
	Queries      []string         `json:"queries,omitempty"`
}

// RoleMatch is one role found on one cluster during a search. Per-cluster failures live on the
// enclosing ClusterRoleMatches, not here.
type RoleMatch struct {
	ClusterID string `json:"clusterId"`
	Alias     string `json:"alias"`
	Host      string `json:"host"`
	Category  string `json:"category"`
	LoginName string `json:"loginName"`
	Comment   string `json:"comment"`
}

// ClusterRoleMatches is one cluster's search outcome — its matches, or why it could not be
// scanned. It mirrors ClusterRoleDetail (same identity fields + DurationMs/Queries) so a search
// reports through the same status chip, and unlike a flat match list it also represents a cluster
// that was scanned successfully but matched nothing.
type ClusterRoleMatches struct {
	ClusterID  string      `json:"clusterId"`
	Alias      string      `json:"alias"`
	Host       string      `json:"host"`
	Category   string      `json:"category"`
	Matches    []RoleMatch `json:"matches"`
	Error      string      `json:"error,omitempty"` // per-cluster connect/query error, if any
	DurationMs int64       `json:"durationMs"`
	Queries    []string    `json:"queries,omitempty"`
}

// ClusterRoleDetail is one login's state on one cluster (parents = direct memberships).
type ClusterRoleDetail struct {
	ClusterID  string            `json:"clusterId"`
	Alias      string            `json:"alias"`
	Host       string            `json:"host"`
	Category   string            `json:"category"`
	Exists     bool              `json:"exists"`
	Comment    string            `json:"comment"`
	Parents    []string          `json:"parents"`
	Attributes map[string]bool   `json:"attributes"`
	Settings   map[string]string `json:"settings"`
	Error      string            `json:"error,omitempty"`
	// DurationMs/Queries mirror ClusterResult so the load reports through the same run-status chip.
	DurationMs int64    `json:"durationMs"`
	Queries    []string `json:"queries,omitempty"`
}
