package calltemplate

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/michal-bartak/pgcowboy/internal/model"
)

var pgParamRE = regexp.MustCompile(`\$[0-9]+`)

type fieldKind int

const (
	fieldIdentifier     fieldKind = iota
	fieldIdentifierList           // comma-separated role names (GRANT a, b TO …)
	fieldKeywordList              // space-separated keywords (ALTER ROLE … WITH SUPERUSER NOLOGIN)
	fieldConfigName               // a role-GUC name, emitted unquoted (ALTER ROLE … SET work_mem = …)
	fieldLiteral
	fieldCommentValue // a configured comment field: JSON-encoded value → typed SQL (NULL / number / bool / literal)
)

// gucNameRE validates a role-GUC name (optionally namespaced, e.g. auto_explain.log_min_duration).
// GUC names are case-insensitive bare identifiers, so they are embedded unquoted.
var gucNameRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$`)

// Build produces SQL for the given execution mode. useQuery is true for function mode (pgx Query).
// commentFields are the configured comment-field keys additionally allowed as placeholders for
// create_role / set_comment (nil for other operations / callers that don't offer them).
func Build(call string, args map[string]string, operation, execution string, commentFields ...string) (sql string, values []any, useQuery bool, err error) {
	execution = model.NormalizeExecution(execution)
	call = normalizeTemplate(call)
	if err := validateCallTemplate(call, operation, execution, commentFields); err != nil {
		return "", nil, false, err
	}

	switch execution {
	case model.ExecutionStatement:
		sql, err = buildEmbedded(call, args, operation, commentFields)
		return sql, nil, false, err
	case model.ExecutionBlock:
		// The template is a complete anonymous code block (e.g. DO $tag$ … $tag$;) written
		// by the user. The app runs it verbatim after embedding placeholder values; it adds
		// no DO/delimiter wrapper of its own. Delimiter choice and block structure are the
		// template author's responsibility.
		sql, err = buildEmbedded(call, args, operation, commentFields)
		return sql, nil, false, err
	default:
		sql, values, err = buildFunctionQuery(call, args, operation, commentFields)
		return sql, values, true, err
	}
}

// BuildQueryFromTemplate builds function-mode SQL (SELECT + binds). Kept for tests and clarity.
func BuildQueryFromTemplate(call string, args map[string]string, operation string, commentFields ...string) (query string, values []any, err error) {
	query, values, useQuery, err := Build(call, args, operation, model.ExecutionFunction, commentFields...)
	if err != nil {
		return "", nil, err
	}
	if !useQuery {
		return "", nil, fmt.Errorf("expected function execution mode")
	}
	return query, values, nil
}

func validateCallTemplate(call, operation, execution string, commentFields []string) error {
	execution = model.NormalizeExecution(execution)
	call = normalizeTemplate(call)
	if call == "" {
		return fmt.Errorf("call template is required")
	}
	if pgParamRE.MatchString(call) {
		return fmt.Errorf("use ${loginname} placeholders, not $1/$2 in the template")
	}

	switch execution {
	case model.ExecutionFunction:
		if strings.Contains(strings.ToUpper(call), "SELECT") {
			return fmt.Errorf("call template must not include SELECT")
		}
		if strings.Contains(call, ";") {
			return fmt.Errorf("call template must not contain semicolons")
		}
	case model.ExecutionStatement:
		if strings.Contains(call, ";") {
			return fmt.Errorf("statement template must not contain semicolons")
		}
	case model.ExecutionBlock:
		// A block template is a complete anonymous code block supplied by the user (DO $tag$
		// … $tag$;). The app runs it verbatim, so semicolons and the DO wrapper are allowed
		// and expected; nothing block-specific to reject here beyond the shared checks below.
	}

	if execution != model.ExecutionFunction && operation == "create_role" {
		if arrayOrNullRE.MatchString(call) || strings.Contains(call, "array_concat:") {
			return fmt.Errorf("create_role with ARRAY || syntax requires execution: function")
		}
	}

	if allowedPlaceholderNames(operation) == nil {
		return fmt.Errorf("unknown operation: %s", operation)
	}
	// Checked on the template, before any substitution, so the scan below is exhaustive and no
	// post-substitution "unresolved placeholder" guard is needed (one that would also trip on a
	// *value* containing "${").
	if leftoverPlaceholder(call) {
		return fmt.Errorf("malformed placeholder: use ${name} for a built-in or ${{comment_key}} for a comment field, with braces balanced")
	}
	for _, tok := range scanTokens(call) {
		ph, perr := parsePlaceholderToken(tok, operation)
		if perr != nil {
			return perr
		}
		if ph.kind != placeholderSimple {
			continue // array_concat validated its own field during parse
		}
		if _, kerr := placeholderKindFor(operation, ph, commentFields); kerr != nil {
			return kerr
		}
	}
	return nil
}

// ValidateCallTemplate validates a function-mode template (config save default).
func ValidateCallTemplate(call, operation string) error {
	return validateCallTemplate(call, operation, model.ExecutionFunction, nil)
}

// ValidateCallTemplateWithExecution validates for the given execution mode. commentFields are the
// configured comment-field keys allowed as placeholders for create_role / set_comment.
func ValidateCallTemplateWithExecution(call, operation, execution string, commentFields ...string) error {
	return validateCallTemplate(call, operation, execution, commentFields)
}

// allowedPlaceholderNames is the closed bare-namespace set for an operation. Comment fields are
// deliberately NOT merged in: they live in the ${{…}} namespace only.
func allowedPlaceholderNames(operation string) map[string]bool {
	out := AllowedPlaceholders(operation)
	if out == nil {
		return nil
	}
	if operation == "remove_role" {
		out["rolename"] = true
	}
	return out
}

// placeholderKindFor resolves how a placeholder is embedded/bound. It is the single source of
// truth: both the emitted SQL shape and the bound value are derived from the kind it returns, so
// they can no longer disagree on a name that exists in both namespaces.
func placeholderKindFor(operation string, ph parsedPlaceholder, commentFields []string) (fieldKind, error) {
	if ph.ns == nsCommentField {
		if !opSupportsCommentFields(operation) {
			return 0, fmt.Errorf(
				"${{%s}}: comment-field placeholders are only available for create_role and set_comment, not %s",
				ph.field, operation)
		}
		if !commentFieldSet(operation, commentFields)[ph.field] {
			return 0, fmt.Errorf("${{%s}} is not a configured comment field (Settings → Comment fields)", ph.field)
		}
		return fieldCommentValue, nil
	}
	field := ph.field
	if field == "rolename" {
		field = "loginname"
	}
	switch operation {
	case "remove_role":
		if field == "loginname" {
			return fieldIdentifier, nil
		}
	case "rename_role":
		// Both the current and the new name are role identifiers (double-quoted, case kept).
		if field == "loginname" || field == "new_loginname" {
			return fieldIdentifier, nil
		}
	case "grant_parents", "revoke_parents":
		switch field {
		case "loginname":
			return fieldIdentifier, nil
		case "parent_roles":
			return fieldIdentifierList, nil
		}
	case "change_password":
		switch field {
		case "loginname":
			return fieldIdentifier, nil
		case "new_password":
			return fieldLiteral, nil
		}
	case "set_comment":
		switch field {
		case "loginname":
			return fieldIdentifier, nil
		case "comment":
			return fieldLiteral, nil
		}
	case "set_attribute":
		switch field {
		case "loginname":
			return fieldIdentifier, nil
		case "attributes", "attribute":
			// One or more keywords (SUPERUSER NOLOGIN …): embedded unquoted, whitelisted upstream.
			// ${attribute} is the legacy alias for ${attributes}.
			return fieldKeywordList, nil
		}
	case "create_role":
		switch field {
		case "loginname":
			return fieldIdentifier, nil
		case "parent_roles":
			// Same field as grant/revoke: statement → double-quoted identifier list; function →
			// inline ARRAY['a','b'] literal (buildFunctionQuery special-cases fieldIdentifierList).
			return fieldIdentifierList, nil
		}
	case "set_config":
		switch field {
		case "loginname":
			return fieldIdentifier, nil
		case "config_name":
			return fieldConfigName, nil
		case "config_value":
			return fieldLiteral, nil
		}
	case "reset_config":
		switch field {
		case "loginname":
			return fieldIdentifier, nil
		case "config_name":
			return fieldConfigName, nil
		}
	}
	suffix := ""
	if opSupportsCommentFields(operation) {
		suffix = fmt.Sprintf("; use ${{%s}} for a configured comment field", ph.field)
	}
	return 0, fmt.Errorf("unknown placeholder ${%s} for operation %s%s", ph.field, operation, suffix)
}

// resolveValue looks a placeholder's value up in the namespace it was written in, so a comment
// field keyed like a built-in (comment, loginname, …) reads its own value rather than the
// built-in's.
func resolveValue(args map[string]string, ph parsedPlaceholder) (string, bool) {
	if ph.ns == nsCommentField {
		v, ok := args[model.CommentArgKey(ph.field)]
		return v, ok
	}
	return resolveArg(args, ph.field)
}

func resolveArg(args map[string]string, field string) (string, bool) {
	if v, ok := args[field]; ok {
		return v, true
	}
	if field == "rolename" {
		v, ok := args["loginname"]
		return v, ok
	}
	return "", false
}

// quoteSQLIdentifier double-quotes a role identifier so case is preserved and special
// characters are safe (embedded `"` are doubled). A comma is rejected because it is the
// delimiter for identifier lists (parent_roles); a NUL byte is invalid in an identifier.
func quoteSQLIdentifier(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", fmt.Errorf("identifier value is required")
	}
	if strings.ContainsAny(name, ",\x00") {
		return "", fmt.Errorf("invalid identifier %q: commas and NUL bytes are not allowed", name)
	}
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`, nil
}

func quoteSQLIdentifierList(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", fmt.Errorf("at least one role name is required")
	}
	parts := strings.Split(value, ",")
	quoted := make([]string, 0, len(parts))
	for _, p := range parts {
		q, err := quoteSQLIdentifier(p)
		if err != nil {
			return "", err
		}
		quoted = append(quoted, q)
	}
	return strings.Join(quoted, ", "), nil
}

// renderRoleArrayVerbatim renders a comma-separated role list as an inline text[] array literal for
// FUNCTION mode: ARRAY['gr_a', 'gr_b']. Elements are single-quoted but placed VERBATIM — no `'`→`''`
// doubling and no identifier double-quoting (per the ${parent_roles} function-mode contract). A
// value containing a single quote or NUL is rejected rather than embedded, as the only guard against
// producing broken / injectable SQL. An empty list becomes bare NULL.
func renderRoleArrayVerbatim(value string) (string, error) {
	parts := splitList(value)
	if len(parts) == 0 {
		return "NULL", nil
	}
	quoted := make([]string, len(parts))
	for i, p := range parts {
		if strings.ContainsAny(p, "'\x00") {
			return "", fmt.Errorf("invalid role name %q in ${parent_roles}: single quotes are not allowed", p)
		}
		quoted[i] = "'" + p + "'"
	}
	return "ARRAY[" + strings.Join(quoted, ", ") + "]", nil
}

// quoteSQLKeywordList renders a whitespace-separated keyword list (e.g. role attributes) as a
// single space-joined clause. Each token must be a bare identifier; the keyword whitelist is
// enforced upstream in commands.ValidateOperation.
func quoteSQLKeywordList(value string) (string, error) {
	kws := strings.Fields(value)
	if len(kws) == 0 {
		return "", fmt.Errorf("at least one keyword is required")
	}
	for _, kw := range kws {
		if !identRE.MatchString(kw) {
			return "", fmt.Errorf("invalid keyword %q: use letters, digits, underscore", kw)
		}
	}
	return strings.Join(kws, " "), nil
}

// validConfigName returns a role-GUC name embedded unquoted after validating its syntax
// (bare, optionally namespaced identifier). GUC names are case-insensitive, so they are not
// double-quoted; validation is the injection guard.
func validConfigName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if !IsGUCName(name) {
		return "", fmt.Errorf("invalid setting name: %q", name)
	}
	return name, nil
}

// renderCommentFieldSQL turns a comment field's JSON-encoded value into an embedded SQL literal:
// absent/empty/JSON null/empty-string → bare NULL (unquoted); JSON number → the numeric token
// verbatim; JSON bool → TRUE/FALSE; JSON string → a quoted literal; JSON array/object → the compact
// JSON text as a quoted literal. A value that fails to parse as JSON is treated as a plain string.
func renderCommentFieldSQL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "NULL"
	}
	var v any
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		return quoteSQLLiteral(raw) // not JSON: plain, non-empty string
	}
	switch t := v.(type) {
	case nil:
		return "NULL"
	case bool:
		if t {
			return "TRUE"
		}
		return "FALSE"
	case float64:
		return raw // re-emit the original JSON number token (avoids float reformatting)
	case string:
		if strings.TrimSpace(t) == "" {
			return "NULL"
		}
		return quoteSQLLiteral(t)
	default: // array / object → raw JSON text
		b, err := json.Marshal(v)
		if err != nil {
			return "NULL"
		}
		return quoteSQLLiteral(string(b))
	}
}

// commentFieldBindValue converts a comment field's JSON-encoded value into a typed Go value for a
// pgx bind (function mode): nil for NULL, the number/bool/string as-is, arrays/objects as JSON text.
func commentFieldBindValue(raw string) any {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var v any
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		return raw // not JSON: plain string
	}
	switch t := v.(type) {
	case nil:
		return nil
	case string:
		if strings.TrimSpace(t) == "" {
			return nil
		}
		return t
	case bool, float64:
		return t
	default: // array / object → JSON text
		b, err := json.Marshal(v)
		if err != nil {
			return nil
		}
		return string(b)
	}
}

func buildEmbedded(call string, args map[string]string, operation string, commentFields []string) (string, error) {
	var b strings.Builder
	last := 0
	for _, tok := range scanTokens(call) {
		b.WriteString(call[last:tok.start])
		ph, err := parsePlaceholderToken(tok, operation)
		if err != nil {
			return "", err
		}
		kind, err := placeholderKindFor(operation, ph, commentFields)
		if err != nil {
			return "", err
		}
		v, ok := resolveValue(args, ph)
		// A comment field is optional — an absent/empty value resolves to SQL NULL.
		if !ok && kind != fieldCommentValue {
			return "", fmt.Errorf("missing value for %s", ph.token())
		}
		switch kind {
		case fieldCommentValue:
			b.WriteString(renderCommentFieldSQL(v))
		case fieldIdentifier:
			quoted, err := quoteSQLIdentifier(v)
			if err != nil {
				return "", err
			}
			b.WriteString(quoted)
		case fieldIdentifierList:
			quoted, err := quoteSQLIdentifierList(v)
			if err != nil {
				return "", err
			}
			b.WriteString(quoted)
		case fieldKeywordList:
			quoted, err := quoteSQLKeywordList(v)
			if err != nil {
				return "", err
			}
			b.WriteString(quoted)
		case fieldConfigName:
			name, err := validConfigName(v)
			if err != nil {
				return "", err
			}
			b.WriteString(name)
		case fieldLiteral:
			b.WriteString(quoteSQLLiteral(v))
		}
		last = tok.end
	}
	b.WriteString(call[last:])
	return b.String(), nil
}

func buildFunctionQuery(call string, args map[string]string, operation string, commentFields []string) (query string, values []any, err error) {
	if err := validateCallTemplate(call, operation, model.ExecutionFunction, commentFields); err != nil {
		return "", nil, err
	}

	n := 0
	values = make([]any, 0, 8)
	call, err = preprocessArrayOrNull(call, args, operation, &n, &values)
	if err != nil {
		return "", nil, err
	}

	var b strings.Builder
	b.WriteString("SELECT ")
	last := 0
	for _, tok := range scanTokens(call) {
		b.WriteString(call[last:tok.start])
		ph, perr := parsePlaceholderToken(tok, operation)
		if perr != nil {
			return "", nil, perr
		}
		v, ok := resolveValue(args, ph)
		switch ph.kind {
		case placeholderArrayConcat:
			if !ok {
				return "", nil, fmt.Errorf("missing value for %s", ph.token())
			}
			n++
			b.WriteString(fmt.Sprintf("$%d::text[]", n))
			values = append(values, buildArrayConcatValue(v, ph.literals))
		case placeholderSimple:
			kind, kerr := placeholderKindFor(operation, ph, commentFields)
			if kerr != nil {
				return "", nil, kerr
			}
			// A comment field is optional — an absent value binds as SQL NULL.
			if !ok && kind != fieldCommentValue {
				return "", nil, fmt.Errorf("missing value for %s", ph.token())
			}
			if kind == fieldIdentifierList {
				// parent_roles in function mode → inline ARRAY['a','b'] literal, not a bind.
				arr, aerr := renderRoleArrayVerbatim(v)
				if aerr != nil {
					return "", nil, aerr
				}
				b.WriteString(arr)
				break
			}
			n++
			b.WriteString(fmt.Sprintf("$%d", n))
			// Value AND shape both come from `kind`, so a comment field keyed like a built-in
			// can no longer have its value decoded as the other namespace's.
			if kind == fieldCommentValue {
				values = append(values, commentFieldBindValue(v))
			} else {
				values = append(values, v)
			}
		}
		last = tok.end
	}
	b.WriteString(call[last:])
	return b.String(), values, nil
}
