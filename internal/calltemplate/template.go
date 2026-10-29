// Package calltemplate parses DB function call templates (${builtin}, ${{comment_key}},
// ARRAY[...] || ${field}).
// It must not import config, pg, commands, or batch — keeps config validation cycle-free.
package calltemplate

import (
	"fmt"
	"regexp"
	"strings"
)

// TokenPattern is the placeholder grammar as a regexp source string. Exported because the
// frontend must carry its own copy (a different runtime renders the search-column templates),
// and a copy that cannot be deleted should at least be pinned: a test compares this against the
// literal in frontend/app.js so the two can't drift silently.
const TokenPattern = `\$\{\{([^{}]*)\}\}|\$\{([^{}]*)\}`

var (
	// tokenRE matches the two placeholder namespaces in one left-to-right pass: ${{name}} is
	// always a configured comment field, ${name} is always a built-in. Both name classes exclude
	// braces, so the bare branch CANNOT swallow a ${{…}} token — the precedence is structural,
	// not merely the order of the alternatives. Anything else containing "${" is malformed and is
	// caught by leftoverPlaceholder.
	tokenRE = regexp.MustCompile(TokenPattern)
	// identRE is THE definition of a bare SQL identifier for the whole app — letters, digits and
	// underscore, not starting with a digit. Placeholder names, role-name literals, preconfigured
	// role parents and comment-field keys are all the same shape, and used to be four separate
	// copies of this pattern across three packages. Reachable elsewhere via IsIdentifier.
	identRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	// ARRAY['gr_a', 'gr_b'] || ${parent_roles}
	arrayOrNullRE = regexp.MustCompile(`ARRAY\s*\[((?:\s*'[a-zA-Z_][a-zA-Z0-9_]*'\s*,?\s*)+)\]\s*\|\|\s*\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}`)
	// ARRAY[${parent_roles}, 'gr_a', 'gr_b'] → ARRAY['gr_a', 'gr_b'] || ${parent_roles}
	arrayLiteralFormRE  = regexp.MustCompile(`ARRAY\[\s*\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}((?:\s*,\s*'[a-zA-Z_][a-zA-Z0-9_]*')+)\s*\]`)
	arrayLiteralQuoteRE = regexp.MustCompile(`'([a-zA-Z_][a-zA-Z0-9_]*)'`)
)

type placeholderKind int

const (
	placeholderSimple placeholderKind = iota
	placeholderArrayConcat // deprecated: ${array_concat:field,lit1,lit2}
)

// placeholderNS is which namespace a token was written in. Keeping it on the parsed token is what
// lets the emitted SQL and the bound value derive from ONE fact: before the two namespaces were
// syntactically distinct, the shape came from a built-ins-first lookup while the value came from
// comment-field-set membership, and the two disagreed on every colliding name.
type placeholderNS int

const (
	nsBuiltin      placeholderNS = iota // ${name} — a closed set per operation
	nsCommentField                      // ${{name}} — a configured comment field, always
)

type parsedPlaceholder struct {
	kind     placeholderKind
	ns       placeholderNS
	field    string
	literals []string
	raw      string
}

// token renders the placeholder the way the user wrote it, for error messages.
func (p parsedPlaceholder) token() string {
	if p.ns == nsCommentField {
		return "${{" + p.field + "}}"
	}
	return "${" + p.field + "}"
}

// rawToken is one placeholder occurrence found by scanTokens.
type rawToken struct {
	start, end int
	ns         placeholderNS
	inner      string
}

// scanTokens returns every well-formed placeholder in order, with its namespace and offsets.
func scanTokens(call string) []rawToken {
	locs := tokenRE.FindAllStringSubmatchIndex(call, -1)
	out := make([]rawToken, 0, len(locs))
	for _, loc := range locs {
		t := rawToken{start: loc[0], end: loc[1]}
		if loc[2] >= 0 { // group 1 matched → ${{name}}
			t.ns, t.inner = nsCommentField, call[loc[2]:loc[3]]
		} else {
			t.ns, t.inner = nsBuiltin, call[loc[4]:loc[5]]
		}
		out = append(out, t)
	}
	return out
}

// leftoverPlaceholder reports a "${" that is not part of a well-formed token — i.e. a malformed
// placeholder such as ${x, ${{x} or ${a{b}. Checked against the TEMPLATE before substitution, so
// unlike the old post-substitution check it cannot be tripped by a *value* containing "${".
func leftoverPlaceholder(call string) bool {
	return strings.Contains(tokenRE.ReplaceAllString(call, ""), "${")
}

// --- Public token API -------------------------------------------------------------------
// The two-namespace placeholder syntax (${name} / ${{key}}) is also used by the Find-role
// search-column templates, which `config` validates. That package had its own copy of the
// token regex and its own "unfinished placeholder" scan; both now come from here, so the syntax
// is defined once even though the two consumers do different things with the result.

// TokenNS is which namespace a placeholder was written in.
type TokenNS int

const (
	// TokenBuiltin is ${name} — a closed, per-context set.
	TokenBuiltin TokenNS = iota
	// TokenCommentField is ${{name}} — always a comment key.
	TokenCommentField
)

// Token is one well-formed placeholder occurrence. Name is the trimmed inner text (which may be
// empty — callers decide whether that is an error in their context).
type Token struct {
	NS   TokenNS
	Name string
}

// ScanTemplate returns every well-formed placeholder in s, in order. Both inner-name classes
// exclude braces, so a bare ${…} can never swallow a ${{…}}: the precedence is structural.
func ScanTemplate(s string) []Token {
	raw := scanTokens(s)
	out := make([]Token, 0, len(raw))
	for _, t := range raw {
		ns := TokenBuiltin
		if t.ns == nsCommentField {
			ns = TokenCommentField
		}
		out = append(out, Token{NS: ns, Name: strings.TrimSpace(t.inner)})
	}
	return out
}

// HasMalformedPlaceholder reports a "${" that is not part of a well-formed token — ${x, ${{x}
// or ${a{b}. Checked against the template text, never against substituted values.
func HasMalformedPlaceholder(s string) bool {
	return leftoverPlaceholder(s)
}

// IsIdentifier reports whether s is a bare SQL identifier: letters, digits and underscore, not
// starting with a digit. This is the shared rule behind preconfigured role parents, comment-field
// keys, placeholder names and role-name literals — one definition rather than a copy per package.
func IsIdentifier(s string) bool {
	return identRE.MatchString(s)
}

// IsGUCName reports whether s is a valid role-GUC name: a bare identifier, optionally namespaced
// (auto_explain.log_min_duration). GUC names are case-insensitive, so they are embedded unquoted
// and this check IS the injection guard — which is exactly why it must not be duplicated.
func IsGUCName(s string) bool {
	return gucNameRE.MatchString(strings.TrimSpace(s))
}

// opSupportsCommentFields reports whether an operation offers ${{comment_key}} placeholders.
func opSupportsCommentFields(operation string) bool {
	return operation == "create_role" || operation == "set_comment"
}

// AllowedPlaceholders returns the placeholder names allowed in the bare ${…} namespace for an
// operation. This is a CLOSED set: a configured comment-field key is never a bare placeholder,
// it is written ${{key}} instead.
func AllowedPlaceholders(operation string) map[string]bool {
	var names []string
	switch operation {
	case "create_role":
		names = []string{"loginname", "parent_roles"}
	case "remove_role":
		names = []string{"loginname"}
	case "rename_role":
		names = []string{"loginname", "new_loginname"}
	case "grant_parents", "revoke_parents":
		names = []string{"loginname", "parent_roles"}
	case "change_password":
		names = []string{"loginname", "new_password"}
	case "set_comment":
		names = []string{"loginname", "comment"}
	case "set_attribute":
		// ${attributes} (plural) is the current name; ${attribute} kept as an alias for
		// backward compatibility with older configs.
		names = []string{"loginname", "attributes", "attribute"}
	case "set_config":
		names = []string{"loginname", "config_name", "config_value"}
	case "reset_config":
		names = []string{"loginname", "config_name"}
	default:
		return nil
	}
	out := make(map[string]bool, len(names))
	for _, n := range names {
		out[n] = true
	}
	return out
}

// commentFieldSet returns the configured comment-field keys valid as ${{key}} placeholders for the
// given operation (create_role / set_comment only); nil otherwise. Each key must be a bare
// identifier — that filter is what keeps a garbage configured key from ever being addressable.
func commentFieldSet(operation string, commentFields []string) map[string]bool {
	if !opSupportsCommentFields(operation) {
		return nil
	}
	if len(commentFields) == 0 {
		return nil
	}
	m := make(map[string]bool, len(commentFields))
	for _, f := range commentFields {
		f = strings.TrimSpace(f)
		if f != "" && identRE.MatchString(f) {
			m[f] = true
		}
	}
	return m
}

// parsePlaceholderToken turns one scanned token into a parsed placeholder. Membership in the
// comment-field set is NOT checked here — that lives in placeholderKindFor, so there is a single
// source of truth for "which namespace is this, and what may it hold".
func parsePlaceholderToken(tok rawToken, operation string) (parsedPlaceholder, error) {
	inner := strings.TrimSpace(tok.inner)
	if inner == "" {
		if tok.ns == nsCommentField {
			return parsedPlaceholder{}, fmt.Errorf("empty placeholder ${{}}: name a comment field")
		}
		return parsedPlaceholder{}, fmt.Errorf("empty placeholder")
	}

	if tok.ns == nsCommentField {
		if !identRE.MatchString(inner) {
			return parsedPlaceholder{}, fmt.Errorf(
				"invalid comment-field placeholder ${{%s}}: use letters, digits, underscore", inner)
		}
		return parsedPlaceholder{kind: placeholderSimple, ns: nsCommentField, field: inner, raw: inner}, nil
	}

	if strings.HasPrefix(inner, "array_concat:") {
		rest := strings.TrimPrefix(inner, "array_concat:")
		items := strings.Split(rest, ",")
		for i := range items {
			items[i] = strings.TrimSpace(items[i])
		}
		if len(items) < 2 {
			return parsedPlaceholder{}, fmt.Errorf("invalid ${array_concat:...}: use ARRAY['fixed', ...] || ${field} instead")
		}
		field := items[0]
		allowed := allowedPlaceholderNames(operation)
		if allowed == nil || !allowed[field] {
			return parsedPlaceholder{}, fmt.Errorf("unknown field %q in ${array_concat:...}", field)
		}
		literals := items[1:]
		for _, lit := range literals {
			if !identRE.MatchString(lit) {
				return parsedPlaceholder{}, fmt.Errorf("invalid role name %q", lit)
			}
		}
		return parsedPlaceholder{
			kind:     placeholderArrayConcat,
			field:    field,
			literals: literals,
			raw:      inner,
		}, nil
	}

	if !identRE.MatchString(inner) {
		return parsedPlaceholder{}, fmt.Errorf(
			"invalid placeholder ${%s}: use ${loginname} or ARRAY['fixed_role', ...] || ${parent_roles}",
			inner,
		)
	}
	return parsedPlaceholder{kind: placeholderSimple, ns: nsBuiltin, field: inner, raw: inner}, nil
}

func normalizeTemplate(call string) string {
	call = strings.TrimSpace(call)
	// ARRAY[${parent_roles}, 'a', 'b'] → ARRAY['a', 'b'] || ${parent_roles}
	call = arrayLiteralFormRE.ReplaceAllStringFunc(call, func(match string) string {
		sub := arrayLiteralFormRE.FindStringSubmatch(match)
		if len(sub) < 3 {
			return match
		}
		field := sub[1]
		var literals []string
		for _, m := range arrayLiteralQuoteRE.FindAllStringSubmatch(sub[2], -1) {
			literals = append(literals, m[1])
		}
		if len(literals) == 0 {
			return match
		}
		quoted := make([]string, len(literals))
		for i, lit := range literals {
			quoted[i] = quoteSQLLiteral(lit)
		}
		return fmt.Sprintf("ARRAY[%s] || ${%s}", strings.Join(quoted, ", "), field)
	})
	return call
}

// quoteSQLLiteral renders a value as a single-quoted SQL string literal. A value containing
// a backslash is emitted as an E'…' escape string with both backslashes and single quotes
// doubled, so the result is safe regardless of the server's standard_conforming_strings
// setting (with it off, a plain '…' literal treats backslash as an escape char and a lone
// trailing backslash could swallow the closing quote). Backslash-free values keep the plain
// '…' form.
func quoteSQLLiteral(s string) string {
	if strings.Contains(s, `\`) {
		return `E'` + strings.NewReplacer(`\`, `\\`, `'`, `''`).Replace(s) + `'`
	}
	return `'` + strings.ReplaceAll(s, `'`, `''`) + `'`
}

func parseQuotedLiteralsFromArrayList(list string) []string {
	var out []string
	for _, m := range arrayLiteralQuoteRE.FindAllStringSubmatch(list, -1) {
		out = append(out, m[1])
	}
	return out
}

func formatFixedArraySQL(literals []string) string {
	quoted := make([]string, len(literals))
	for i, lit := range literals {
		quoted[i] = quoteSQLLiteral(lit)
	}
	return "ARRAY[" + strings.Join(quoted, ", ") + "]::text[]"
}

// preprocessArrayOrNull expands ARRAY['a','b'] || ${field} — empty field becomes || NULL.
// arrayOrNullRE only matches the bare ${…} namespace, so a comment field can never be the
// concatenated field; that is by construction, not by an extra check here.
func preprocessArrayOrNull(call string, args map[string]string, operation string, n *int, values *[]any) (string, error) {
	allowed := allowedPlaceholderNames(operation)
	var err error
	call = arrayOrNullRE.ReplaceAllStringFunc(call, func(match string) string {
		if err != nil {
			return match
		}
		sub := arrayOrNullRE.FindStringSubmatch(match)
		if len(sub) < 3 {
			return match
		}
		literals := parseQuotedLiteralsFromArrayList(sub[1])
		field := sub[2]
		if allowed == nil || !allowed[field] {
			err = fmt.Errorf("unknown placeholder ${%s} in ARRAY[...] || ${...}", field)
			return match
		}
		fixed := formatFixedArraySQL(literals)
		v, ok := args[field]
		if !ok {
			err = fmt.Errorf("missing value for ${%s}", field)
			return match
		}
		parts := splitList(v)
		if len(parts) == 0 {
			return fixed + " || NULL"
		}
		*n++
		*values = append(*values, parts)
		return fmt.Sprintf("%s || $%d::text[]", fixed, *n)
	})
	return call, err
}

// splitList splits a comma-separated value into trimmed, non-empty items — lets a single
// parent_roles placeholder carry several preconfigured role parents at once.
func splitList(v string) []string {
	var out []string
	for _, part := range strings.Split(v, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func buildArrayConcatValue(fieldValue string, literals []string) []string {
	parent := strings.TrimSpace(fieldValue)
	if parent == "" {
		out := make([]string, len(literals))
		copy(out, literals)
		return out
	}
	out := make([]string, 0, 1+len(literals))
	out = append(out, parent)
	return append(out, literals...)
}

