package config

import (
	"testing"

	"github.com/michal-bartak/pgcowboy/internal/model"
)

func TestDefaultConfigUITheme(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.UI.Theme != model.ThemeSystem {
		t.Fatalf("default ui.theme = %q, want system", cfg.UI.Theme)
	}
}

func TestNormalizeCommentView(t *testing.T) {
	tests := []struct{ in, want string }{
		{"raw", model.CommentViewRaw},
		{"fields", model.CommentViewFields},
		{"", model.CommentViewRaw},
		{"invalid", model.CommentViewRaw},
		{" RAW ", model.CommentViewRaw},
		{" FIELDS ", model.CommentViewFields},
	}
	for _, tc := range tests {
		if got := model.NormalizeCommentView(tc.in); got != tc.want {
			t.Errorf("NormalizeCommentView(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestUpdateUIPersistsCommentView(t *testing.T) {
	s := tmpStore(t)
	if err := s.UpdateUI(model.UISettings{Theme: "dark", CommentDefaultView: "raw"}); err != nil {
		t.Fatal(err)
	}
	if got := s.Get().UI.CommentDefaultView; got != model.CommentViewRaw {
		t.Fatalf("comment view not persisted: %q", got)
	}
	// invalid normalizes to raw (the built-in default)
	if err := s.UpdateUI(model.UISettings{Theme: "dark", CommentDefaultView: "nope"}); err != nil {
		t.Fatal(err)
	}
	if got := s.Get().UI.CommentDefaultView; got != model.CommentViewRaw {
		t.Fatalf("invalid comment view should normalize to raw: %q", got)
	}
}

func TestUpdateUIPersistsStageCreateOnTargetAdd(t *testing.T) {
	s := tmpStore(t)
	if got := s.Get().UI.StageCreateOnTargetAdd; got != false {
		t.Fatalf("default stage_create_on_target_add = %v, want false", got)
	}
	if err := s.UpdateUI(model.UISettings{Theme: "dark", StageCreateOnTargetAdd: true}); err != nil {
		t.Fatal(err)
	}
	if got := s.Get().UI.StageCreateOnTargetAdd; got != true {
		t.Fatalf("stage_create_on_target_add not persisted: %v", got)
	}
}

func TestUpdateUIPersistsSuppressMD5RenameWarning(t *testing.T) {
	s := tmpStore(t)
	if s.Get().UI.SuppressMD5RenameWarning {
		t.Fatal("suppress_md5_rename_warning should default to off")
	}
	if err := s.UpdateUI(model.UISettings{Theme: "dark", SuppressMD5RenameWarning: true}); err != nil {
		t.Fatal(err)
	}
	if !s.Get().UI.SuppressMD5RenameWarning {
		t.Fatal("suppress_md5_rename_warning not persisted")
	}
}

func TestUICheckForUpdatesAndSeenVersion(t *testing.T) {
	s := tmpStore(t)
	// nil pointer (never set) → AutoCheck defaults ON.
	if !s.Get().UI.AutoCheck() {
		t.Fatal("AutoCheck should default to true when CheckForUpdates is nil")
	}
	// Explicit false round-trips and disables AutoCheck.
	off := false
	if err := s.UpdateUI(model.UISettings{Theme: "dark", CheckForUpdates: &off}); err != nil {
		t.Fatal(err)
	}
	got := s.Get().UI
	if got.CheckForUpdates == nil || *got.CheckForUpdates != false || got.AutoCheck() {
		t.Fatalf("CheckForUpdates=false not persisted / AutoCheck not off: %+v", got.CheckForUpdates)
	}
	// SetUpdateSeenVersion persists.
	if err := s.SetUpdateSeenVersion("0.4.0"); err != nil {
		t.Fatal(err)
	}
	if got := s.Get().UpdateSeenVersion; got != "0.4.0" {
		t.Fatalf("update_seen_version not persisted: %q", got)
	}
}

func TestDefaultConfigPasswordGen(t *testing.T) {
	pg := DefaultConfig().UI.PasswordGen
	if pg == nil {
		t.Fatal("default ui.password_gen is nil")
	}
	if pg.Length != model.PasswordGenDefaultLength || !pg.Lowercase || !pg.Digits || pg.Uppercase || pg.Symbols {
		t.Fatalf("default password_gen = %+v, want len 10 lowercase+digits only", *pg)
	}
}

func TestNormalizePasswordGen(t *testing.T) {
	// nil receiver → the built-in default.
	if got := (*model.PasswordGen)(nil).Normalized(); got == nil || got.Length != model.PasswordGenDefaultLength || !got.Lowercase || !got.Digits {
		t.Fatalf("nil.Normalized() = %+v, want default", got)
	}
	// Length clamping (0 → default, below min → min, above max → max).
	if got := (&model.PasswordGen{Length: 0, Lowercase: true}).Normalized(); got.Length != model.PasswordGenDefaultLength {
		t.Errorf("length 0 → %d, want %d", got.Length, model.PasswordGenDefaultLength)
	}
	if got := (&model.PasswordGen{Length: 3, Lowercase: true}).Normalized(); got.Length != model.PasswordGenMinLength {
		t.Errorf("length 3 → %d, want %d", got.Length, model.PasswordGenMinLength)
	}
	if got := (&model.PasswordGen{Length: 9999, Lowercase: true}).Normalized(); got.Length != model.PasswordGenMaxLength {
		t.Errorf("length 9999 → %d, want %d", got.Length, model.PasswordGenMaxLength)
	}
	// No class enabled → lowercase forced on.
	if got := (&model.PasswordGen{Length: 12}).Normalized(); !got.Lowercase {
		t.Errorf("all-classes-off should force lowercase on: %+v", *got)
	}
}

func TestUpdateUIPersistsPasswordGen(t *testing.T) {
	s := tmpStore(t)
	// Default present before any update.
	if pg := s.Get().UI.PasswordGen; pg == nil || pg.Length != model.PasswordGenDefaultLength {
		t.Fatalf("default password_gen not present: %+v", pg)
	}
	// Custom config round-trips (with normalization applied).
	custom := &model.PasswordGen{Length: 200, Uppercase: true, Symbols: true, ExcludeSimilar: true}
	if err := s.UpdateUI(model.UISettings{Theme: "dark", PasswordGen: custom}); err != nil {
		t.Fatal(err)
	}
	got := s.Get().UI.PasswordGen
	if got == nil || got.Length != model.PasswordGenMaxLength || !got.Uppercase || !got.Symbols || !got.ExcludeSimilar || got.Lowercase || got.Digits {
		t.Fatalf("password_gen not persisted/normalized: %+v", got)
	}
	// nil PasswordGen normalizes back to the default rather than persisting nil.
	if err := s.UpdateUI(model.UISettings{Theme: "dark"}); err != nil {
		t.Fatal(err)
	}
	if pg := s.Get().UI.PasswordGen; pg == nil || pg.Length != model.PasswordGenDefaultLength {
		t.Fatalf("nil password_gen should normalize to default: %+v", pg)
	}
}

func TestNormalizeTheme(t *testing.T) {
	tests := []struct {
		in, want string
	}{
		{"light", model.ThemeLight},
		{"dark", model.ThemeDark},
		{"system", model.ThemeSystem},
		{"", model.ThemeSystem},
		{"invalid", model.ThemeSystem},
	}
	for _, tc := range tests {
		if got := model.NormalizeTheme(tc.in); got != tc.want {
			t.Errorf("NormalizeTheme(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
