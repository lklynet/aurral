import { createPortal } from "react-dom";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Download, FileUp, Monitor, Moon, Pencil, Plus, Sun, Trash2 } from "lucide-react";
import PillToggle from "../../../components/PillToggle";
import TooltipButton from "../../../components/TooltipButton.jsx";
import { ModalShell } from "../../../components/PlaylistModals.jsx";
import { useToast } from "../../../contexts/ToastContext";
import { useThemeDocument } from "../../../hooks/useThemeDocument.js";
import { normalizeHexColor } from "../../../utils/themeColor.js";
import {
  BUILT_IN_THEMES,
  findTheme,
  getThemePalette,
  getThemeSeed,
  isCustomTheme,
  normalizeTheme,
  previewTheme,
  removeCustomTheme,
  resolveThemeMode,
  restoreCustomTheme,
  saveCustomTheme,
  selectTheme,
  setMatchArtwork,
  setThemeAppearance,
  THEME_MODES,
} from "../../../utils/theme.js";
import { parseThemeText, serializeThemeFile, THEME_GALLERY_URL } from "../../../utils/themeImport.js";
import "./themeSettings.css";

const APPEARANCE_OPTIONS = [
  { id: "system", label: "System", Icon: Monitor },
  { id: "light", label: "Light", Icon: Sun },
  { id: "dark", label: "Dark", Icon: Moon },
];

const MODE_LABELS = { light: "Light", dark: "Dark" };

const SEED_FIELDS = [
  { role: "background", label: "Background" },
  { role: "text", label: "Text" },
  { role: "accent", label: "Accent" },
];

function MiniWindow({ palette, className = "" }) {
  return (
    <span
      className={`theme-settings__window${className ? ` ${className}` : ""}`}
      style={{
        "--window-chrome": palette.chrome,
        "--window-surface": palette.surface,
        "--window-border": palette.border,
        "--window-text": palette.text,
        "--window-muted": palette.textMuted,
        "--window-accent": palette.accent,
      }}
    >
      <span className="theme-settings__window-sidebar">
        <span className="is-active" />
        <span />
        <span />
      </span>
      <span className="theme-settings__window-main">
        <span className="is-title" />
        <span />
        <span className="is-short" />
        <span className="is-accent" />
      </span>
    </span>
  );
}

function ModePreview({ theme, appearance }) {
  const light = getThemePalette(theme, "light");
  const dark = getThemePalette(theme, "dark");
  return (
    <span className="theme-settings__mode-preview" aria-hidden="true">
      <MiniWindow palette={appearance === "light" ? light : dark} />
      {appearance === "system" ? <MiniWindow palette={light} className="is-system-light" /> : null}
    </span>
  );
}

function ThemeSwatch({ palette }) {
  return (
    <span
      className="theme-settings__swatch"
      style={{ background: palette.surface, borderColor: palette.border }}
      aria-hidden="true"
    >
      <span className="theme-settings__swatch-bar" style={{ background: palette.chrome }} />
      <span className="theme-settings__swatch-line" style={{ background: palette.text }} />
      <span className="theme-settings__swatch-line is-short" style={{ background: palette.textMuted }} />
      <span className="theme-settings__swatch-accent" style={{ background: palette.accent }} />
    </span>
  );
}

function ThemeCard({ theme, mode, active, onSelect, onEdit }) {
  const custom = isCustomTheme(theme);
  return (
    <div className={`theme-settings__card${active ? " is-active" : ""}${custom ? " is-custom" : ""}`}>
      <button type="button" className="theme-settings__card-select" aria-pressed={active} onClick={onSelect}>
        <ThemeSwatch palette={getThemePalette(theme, mode)} />
        <span className="theme-settings__card-copy">
          <span className="theme-settings__card-label">{theme.name}</span>
          <span className="theme-settings__card-meta">{custom ? "Yours" : "Built in"}</span>
        </span>
        {active ? <Check className="theme-settings__active-icon" aria-hidden="true" /> : null}
      </button>
      {custom ? (
        <TooltipButton
          type="button"
          className="btn btn-icon btn-xs btn-ghost theme-settings__edit"
          onClick={onEdit}
          label={`Edit ${theme.name}`}
        >
          <Pencil aria-hidden="true" />
        </TooltipButton>
      ) : null}
    </div>
  );
}

function ColorField({ fieldKey, label, value, placeholder, onChange, onInvalidChange }) {
  const id = useId();
  const [text, setText] = useState(value || "");
  const invalid = text.trim() !== "" && !normalizeHexColor(text);
  useEffect(() => setText((current) => (normalizeHexColor(current) === value ? current : value || "")), [value]);
  useEffect(() => {
    onInvalidChange(fieldKey, invalid);
    return () => onInvalidChange(fieldKey, false);
  }, [fieldKey, invalid, onInvalidChange]);
  return (
    <div className="theme-settings__color-field">
      <label className="theme-settings__color-label" htmlFor={id}>{label}</label>
      <div className="theme-settings__color-inputs">
        <input
          type="color"
          className="theme-settings__color-swatch"
          value={value || placeholder}
          aria-label={`${label} color picker`}
          onChange={(event) => onChange(event.target.value)}
        />
        <input
          id={id}
          type="text"
          className="input theme-settings__color-text"
          value={text}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={invalid}
          onChange={(event) => {
            setText(event.target.value);
            const color = normalizeHexColor(event.target.value);
            if (color) onChange(color);
            else if (!event.target.value.trim()) onChange(null);
          }}
        />
      </div>
    </div>
  );
}

function ThemeEditor({ draft, title, onClose, onSaved, onRemoved, showError }) {
  const [name, setName] = useState(draft.name);
  const [seeds, setSeeds] = useState({ light: draft.light || null, dark: draft.dark || null });
  const [mode, setMode] = useState(() => {
    const current = resolveThemeMode();
    return seeds[current] ? current : seeds.dark ? "dark" : "light";
  });
  const [error, setError] = useState("");
  const [invalidFields, setInvalidFields] = useState(() => new Set());
  const nameId = useId();

  const setFieldInvalid = useCallback((fieldKey, invalid) => {
    setInvalidFields((current) => {
      if (current.has(fieldKey) === invalid) return current;
      const next = new Set(current);
      if (invalid) next.add(fieldKey);
      else next.delete(fieldKey);
      return next;
    });
  }, []);

  const validation = useMemo(() => {
    if (invalidFields.size) return { error: "Enter colors as hex values, like #1b1d2a." };
    try {
      return { theme: normalizeTheme({ id: draft.id || "draft", name: name || "Untitled", ...seeds }) };
    } catch (validationError) {
      return { error: validationError.message };
    }
  }, [draft.id, invalidFields, name, seeds]);

  useEffect(() => {
    if (validation.theme) previewTheme(validation.theme, mode);
  }, [mode, validation]);

  useEffect(() => () => previewTheme(null), []);

  const other = mode === "dark" ? "light" : "dark";
  const seed = seeds[mode];
  const generatedSeed = validation.theme ? getThemeSeed(validation.theme, mode) : null;

  const updateSeed = (role, color) => {
    setError("");
    setSeeds((current) => {
      const next = { ...current[mode] };
      if (color) next[role] = color;
      else delete next[role];
      return { ...current, [mode]: next };
    });
  };

  const handleSave = () => {
    try {
      const saved = saveCustomTheme({ id: draft.id, name, ...seeds });
      onSaved(saved);
    } catch (saveError) {
      setError(saveError.message);
    }
  };

  const handleExport = () => {
    const url = URL.createObjectURL(new Blob([serializeThemeFile({ name: name.trim() || "Untitled", ...seeds })], { type: "application/json" }));
    const link = Object.assign(document.createElement("a"), {
      href: url,
      download: `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "theme"}.aurral-theme.json`,
    });
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleRemove = () => {
    const removed = removeCustomTheme(draft.id);
    if (removed) onRemoved(removed);
    else showError?.("That theme was already removed.");
  };

  return createPortal(
    <ModalShell
      open
      title={title}
      onClose={onClose}
      className="theme-settings__dialog"
      footer={
        <>
          {draft.id ? (
            <button type="button" className="btn btn-ghost-danger theme-settings__footer-start" onClick={handleRemove}>
              <Trash2 aria-hidden="true" /> Remove theme
            </button>
          ) : null}
          {draft.id ? (
            <button type="button" className="btn btn-ghost" onClick={handleExport} disabled={Boolean(validation.error)}>
              <Download aria-hidden="true" /> Export
            </button>
          ) : null}
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={Boolean(validation.error)}>
            Save theme
          </button>
        </>
      }
    >
      <div className="theme-settings__editor">
        <div>
          <label className="artist-field-label" htmlFor={nameId}>Name</label>
          <input
            id={nameId}
            type="text"
            className="input"
            value={name}
            maxLength={48}
            onChange={(event) => {
              setName(event.target.value);
              setError("");
            }}
          />
        </div>
        <div className="theme-settings__tabs" role="group" aria-label="Colors to edit">
          {THEME_MODES.slice().reverse().map((tabMode) => (
            <button
              key={tabMode}
              type="button"
              aria-pressed={mode === tabMode}
              className={`theme-settings__tab${mode === tabMode ? " is-active" : ""}`}
              onClick={() => setMode(tabMode)}
            >
              {MODE_LABELS[tabMode]}
            </button>
          ))}
        </div>
        <div className="theme-settings__tab-panel">
          {seed ? (
            <>
              <div className="theme-settings__color-grid">
                {SEED_FIELDS.map(({ role, label }) => (
                  <ColorField
                    key={`${mode}-${role}`}
                    fieldKey={`${mode}-${role}`}
                    label={label}
                    value={seed[role]}
                    placeholder={role === "text" ? (mode === "dark" ? "#f5f5f5" : "#171717") : "#000000"}
                    onChange={(color) => updateSeed(role, color)}
                    onInvalidChange={setFieldInvalid}
                  />
                ))}
              </div>
              {seeds[other] ? (
                <button
                  type="button"
                  className="btn btn-ghost theme-settings__inline-action"
                  onClick={() => setSeeds((current) => ({ ...current, [mode]: null }))}
                >
                  Generate {mode} colors from {other}
                </button>
              ) : null}
            </>
          ) : (
            <div className="theme-settings__generated">
              <p className="settings-page__hint">
                {MODE_LABELS[mode]} colors are generated from your {other} colors.
              </p>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!generatedSeed}
                onClick={() => setSeeds((current) => ({ ...current, [mode]: generatedSeed }))}
              >
                Customize {mode} colors
              </button>
            </div>
          )}
          <p className="settings-page__hint">
            Aurral adjusts text and accent colors that would be hard to read.
          </p>
        </div>
        {error || validation.error ? (
          <p className="artist-error-text" role="alert">{error || validation.error}</p>
        ) : null}
      </div>
    </ModalShell>,
    document.body,
  );
}

function ThemeImport({ onClose, onParsed }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const fileRef = useRef(null);
  const mountedRef = useRef(true);
  const textId = useId();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const parse = (source) => {
    try {
      onParsed(parseThemeText(source));
    } catch (parseError) {
      setError(parseError.message);
    }
  };

  return createPortal(
    <ModalShell
      open
      title="Import theme"
      description="Paste an Aurral theme file or a base16 or base24 scheme."
      onClose={onClose}
      className="theme-settings__dialog"
      footer={
        <>
          <button type="button" className="btn btn-ghost theme-settings__footer-start" onClick={() => fileRef.current?.click()}>
            <FileUp aria-hidden="true" /> Choose file
          </button>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => parse(text)} disabled={!text.trim()}>
            Continue
          </button>
        </>
      }
    >
      <div className="theme-settings__editor">
        <label className="artist-field-label" htmlFor={textId}>Theme</label>
        <textarea
          id={textId}
          className="arr-input arr-textarea theme-settings__import-text"
          value={text}
          rows={8}
          spellCheck={false}
          placeholder={'name: "Nord"\nvariant: "dark"\npalette:\n  base00: "#2E3440"\n  ...'}
          onChange={(event) => {
            setText(event.target.value);
            setError("");
          }}
        />
        <input
          ref={fileRef}
          type="file"
          accept=".json,.yaml,.yml,application/json,text/yaml"
          hidden
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            const contents = await file.text();
            if (!mountedRef.current) return;
            setText(contents);
            parse(contents);
          }}
        />
        <p className="settings-page__hint">
          Find hundreds of schemes in the{" "}
          <a href={THEME_GALLERY_URL} target="_blank" rel="noreferrer">Tinted Gallery</a>.
          Open a scheme&apos;s source file and paste it here.
        </p>
        {error ? <p className="artist-error-text" role="alert">{error}</p> : null}
      </div>
    </ModalShell>,
    document.body,
  );
}

export function ThemeSettings({ showSuccess, showError }) {
  const themeDocument = useThemeDocument();
  const [dialog, setDialog] = useState(null);
  const mode = resolveThemeMode(themeDocument.appearance);
  const selected = findTheme(themeDocument.themeId, themeDocument) || BUILT_IN_THEMES[0];
  const { addToast } = useToast();

  const openCreate = () => {
    setDialog({
      type: "editor",
      title: "Create theme",
      draft: {
        name: isCustomTheme(selected) ? `${selected.name} copy` : selected.id === "aurral" ? "My theme" : `My ${selected.name}`,
        light: selected.light,
        dark: selected.dark,
      },
    });
  };

  const handleRemoved = (removed) => {
    setDialog(null);
    addToast(
      {
        message: `${removed.theme.name} removed`,
        action: {
          label: "Undo",
          onClick: () => {
            try {
              restoreCustomTheme(removed);
            } catch (restoreError) {
              showError?.(restoreError.message);
            }
          },
        },
      },
      "success",
      8000,
    );
  };

  return (
    <div className="theme-settings">
      <section className="theme-settings__section" aria-labelledby="theme-mode-heading">
        <div className="theme-settings__section-heading">
          <h4 id="theme-mode-heading">Color scheme</h4>
        </div>
        <div className="theme-settings__mode-grid" role="group" aria-labelledby="theme-mode-heading">
          {APPEARANCE_OPTIONS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              className={`theme-settings__mode-card${themeDocument.appearance === id ? " is-active" : ""}`}
              aria-pressed={themeDocument.appearance === id}
              onClick={() => setThemeAppearance(id)}
            >
              <ModePreview theme={selected} appearance={id} />
              <span className="theme-settings__mode-card-label">
                <Icon aria-hidden="true" />
                {label}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="theme-settings__section" aria-labelledby="theme-themes-heading">
        <div className="theme-settings__section-heading">
          <h4 id="theme-themes-heading">Themes</h4>
          <div className="theme-settings__section-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setDialog({ type: "import" })}>
              <FileUp aria-hidden="true" /> Import
            </button>
            <button type="button" className="btn btn-secondary" onClick={openCreate}>
              <Plus aria-hidden="true" /> Create theme
            </button>
          </div>
        </div>
        <div className="theme-settings__grid" role="group" aria-labelledby="theme-themes-heading">
          {[...BUILT_IN_THEMES, ...themeDocument.themes].map((theme) => (
            <ThemeCard
              key={theme.id}
              theme={theme}
              mode={mode}
              active={selected.id === theme.id}
              onSelect={() => selectTheme(theme.id)}
              onEdit={() => setDialog({ type: "editor", title: "Edit theme", draft: theme })}
            />
          ))}
        </div>
        <div className="theme-settings__switch-row">
          <div className="theme-settings__switch-copy">
            <label className="theme-settings__switch-label" htmlFor="theme-match-artwork">Match album art</label>
            <p className="settings-page__hint">Tint the accent and background from the cover of what&apos;s playing.</p>
          </div>
          <PillToggle
            id="theme-match-artwork"
            checked={themeDocument.matchArtwork}
            aria-label="Match album art"
            onChange={(event) => setMatchArtwork(event.target.checked)}
          />
        </div>
      </section>

      {dialog?.type === "import" ? (
        <ThemeImport
          onClose={() => setDialog(null)}
          onParsed={(draft) => setDialog({ type: "editor", title: "Review imported theme", draft })}
        />
      ) : null}
      {dialog?.type === "editor" ? (
        <ThemeEditor
          key={dialog.draft.id || dialog.title}
          draft={dialog.draft}
          title={dialog.title}
          showError={showError}
          onClose={() => setDialog(null)}
          onSaved={(theme) => {
            setDialog(null);
            showSuccess?.(`${theme.name} saved`);
          }}
          onRemoved={handleRemoved}
        />
      ) : null}
    </div>
  );
}
