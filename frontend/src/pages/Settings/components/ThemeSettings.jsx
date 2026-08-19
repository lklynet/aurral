import { createPortal } from "react-dom";
import { useEffect, useId, useRef, useState } from "react";
import { Check, Loader2, Monitor, Moon, Palette, Plus, Search, Sun, Trash2, X } from "lucide-react";
import TooltipButton from "../../../components/TooltipButton.jsx";
import { useModalDialog } from "../../../hooks/useModalDialog.js";
import {
  applyThemePreview,
  applyThemeSelection,
  BUILT_IN_THEMES,
  createUniqueThemeName,
  getCustomThemes,
  getThemeColorsForMode,
  getThemeSettings,
  installCustomTheme,
  removeCustomTheme,
  replaceCustomTheme,
  setThemeSelection,
  THEME_APPEARANCES,
  subscribeToCustomThemes,
  subscribeToThemeChanges,
} from "../../../utils/theme.js";
import {
  importTerminalSexyTheme,
  loadTerminalSexyCatalog,
  searchTerminalSexyThemes,
  selectTerminalSexyFeaturedThemes,
} from "../../../utils/terminalSexyThemes.js";
import "./themeSettings.css";

const APPEARANCE_OPTIONS = [
  { id: "system", label: "System", Icon: Monitor },
  { id: "light", label: "Light", Icon: Sun },
  { id: "dark", label: "Dark", Icon: Moon },
].filter((option) => THEME_APPEARANCES.includes(option.id));

function previewMode(theme, mode) {
  if (mode === "dark" && getThemeColorsForMode(theme, "dark")) return "dark";
  if (mode === "light" && getThemeColorsForMode(theme, "light")) return "light";
  return theme.appearance;
}

function ModePreviewPane() {
  return (
    <>
      <span className="theme-settings__mode-preview-sidebar">
        <span />
        <span />
        <span />
        <span />
      </span>
      <span className="theme-settings__mode-preview-main">
        <span className="theme-settings__mode-preview-toolbar" />
        <span className="theme-settings__mode-preview-line" />
        <span className="theme-settings__mode-preview-line is-short" />
        <span className="theme-settings__mode-preview-composer">
          <span />
          <b />
        </span>
      </span>
      <span className="theme-settings__mode-preview-panel">
        <span />
        <span />
        <span />
      </span>
    </>
  );
}

function ModePreview({ appearance }) {
  const light = getThemeColorsForMode(BUILT_IN_THEMES[0], "light");
  const dark = getThemeColorsForMode(BUILT_IN_THEMES[0], "dark");
  const colors = appearance === "dark" ? dark : light;
  return (
    <span
      className={`theme-settings__mode-preview is-${appearance}`}
      style={{
        "--theme-preview-canvas": colors.surface,
        "--theme-preview-chrome": colors.chrome,
        "--theme-preview-raised": colors.surfaceRaised,
        "--theme-preview-border": colors.border,
        "--theme-preview-text": colors.text,
        "--theme-preview-muted": colors.textMuted,
        "--theme-preview-accent": colors.accent,
        "--theme-preview-light-canvas": light.surface,
        "--theme-preview-light-chrome": light.chrome,
        "--theme-preview-light-raised": light.surfaceRaised,
        "--theme-preview-light-border": light.border,
        "--theme-preview-light-text": light.text,
        "--theme-preview-light-muted": light.textMuted,
        "--theme-preview-light-accent": light.accent,
        "--theme-preview-dark-canvas": dark.surface,
        "--theme-preview-dark-chrome": dark.chrome,
        "--theme-preview-dark-raised": dark.surfaceRaised,
        "--theme-preview-dark-border": dark.border,
        "--theme-preview-dark-text": dark.text,
        "--theme-preview-dark-muted": dark.textMuted,
        "--theme-preview-dark-accent": dark.accent,
      }}
      aria-hidden="true"
    >
      {appearance === "system" ? <ModePreviewPane /> : <span className="theme-settings__mode-preview-pane"><ModePreviewPane /></span>}
    </span>
  );
}

function AppearanceModeCard({ option, active, onSelect }) {
  const Icon = option.Icon;
  return (
    <button
      type="button"
      className={`theme-settings__mode-card${active ? " is-active" : ""}`}
      aria-pressed={active}
      onClick={onSelect}
    >
      <ModePreview appearance={option.id} />
      <span className="theme-settings__mode-card-label">
        <Icon aria-hidden="true" />
        {option.label}
      </span>
    </button>
  );
}

function ThemeSwatch({ colors, loading = false }) {
  return (
    <span
      className={`theme-settings__swatch${loading ? " is-loading" : ""}`}
      style={colors ? { background: colors.surface, borderColor: colors.border } : undefined}
      aria-hidden="true"
    >
      {colors ? (
        <>
          <span className="theme-settings__swatch-bar" style={{ background: colors.chrome }} />
          <span className="theme-settings__swatch-line" style={{ background: colors.text }} />
          <span className="theme-settings__swatch-line is-short" style={{ background: colors.textMuted }} />
          <span className="theme-settings__swatch-accent" style={{ background: colors.accent }} />
        </>
      ) : <Palette />}
    </span>
  );
}

function ThemeCard({ theme, active, mode, custom, onSelect, onRemove }) {
  const colors = getThemeColorsForMode(theme, previewMode(theme, mode)) || theme.colors;
  return (
    <div className={`theme-settings__card${active ? " is-active" : ""}${custom ? " is-custom" : ""}`}>
      <button
        type="button"
        className="theme-settings__card-select"
        aria-pressed={active}
        onClick={onSelect}
      >
        <ThemeSwatch colors={colors} />
        <span className="theme-settings__card-copy">
          <span className="theme-settings__card-label">{theme.label}</span>
          <span className="theme-settings__card-meta">{custom ? "Added" : "Built in"}</span>
        </span>
        {active ? <Check className="theme-settings__active-icon" aria-hidden="true" /> : null}
      </button>
      {custom && onRemove ? (
        <TooltipButton
          type="button"
          className="btn btn-icon btn-xs btn-ghost-danger theme-settings__remove"
          onClick={onRemove}
          label={`Remove ${theme.label}`}
        >
          <Trash2 aria-hidden="true" />
        </TooltipButton>
      ) : null}
    </div>
  );
}

function schemeModeLabel(scheme) {
  const modes = Object.keys(scheme.sources || {}).filter((mode) => mode === "light" || mode === "dark");
  return modes.length > 1 ? modes.join(" + ") : modes[0] || "classic";
}

function SchemeCard({ scheme, theme, mode, active, loading, installing, installBusy, installed, onPreview, onAdd }) {
  const colors = theme ? getThemeColorsForMode(theme, previewMode(theme, mode)) || theme.colors : null;
  return (
    <article className={`theme-settings__scheme-card${active ? " is-previewing" : ""}`}>
      <button
        type="button"
        className="theme-settings__scheme-preview"
        aria-pressed={active}
        aria-label={`Preview ${scheme.label}`}
        onClick={onPreview}
        disabled={loading || installing}
      >
        <ThemeSwatch colors={colors} loading={loading} />
        <span className="theme-settings__card-copy">
          <span className="theme-settings__card-label">{scheme.label}</span>
          <span className="theme-settings__card-meta">{scheme.category} · {schemeModeLabel(scheme)}</span>
        </span>
        {active ? <span className="theme-settings__scheme-state">Preview</span> : null}
      </button>
      <div className="theme-settings__scheme-actions">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={loading || installing || installBusy || installed}
          onClick={onAdd}
        >
          {loading || installing ? <Loader2 className="theme-settings__spin" aria-hidden="true" /> : installed ? <Check aria-hidden="true" /> : <Plus aria-hidden="true" />}
          {loading ? "Loading…" : installing ? "Adding…" : installed ? "Added" : "Add"}
        </button>
      </div>
    </article>
  );
}

function LoadingSchemeCard() {
  return (
    <div className="theme-settings__scheme-card is-loading" aria-hidden="true">
      <span className="theme-settings__swatch is-loading" />
      <span className="theme-settings__loading-copy" />
    </div>
  );
}

function SchemeSearchModal({
  open,
  query,
  results,
  searching,
  error,
  previewing,
  loading,
  installing,
  mode,
  onClose,
  onQueryChange,
  onSearch,
  onPreview,
  onAdd,
  isInstalled,
  isPreviewing,
  getTheme,
  selectedThemeId,
  onSelect,
  onRemove,
}) {
  const titleId = useId();
  const { dialogRef, handleBackdropClick } = useModalDialog({ open, onClose });
  if (!open) return null;
  return createPortal(
    <div className="artist-modal-backdrop theme-settings__modal-backdrop" onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className="theme-settings__search-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="theme-settings__modal-header">
          <div>
            <h3 id={titleId}>Find a scheme</h3>
            <p>Search terminal.sexy, preview a scheme, then add it.</p>
          </div>
          <TooltipButton
            type="button"
            className="btn btn-icon btn-xs btn-ghost"
            onClick={onClose}
            label="Close"
          >
            <X aria-hidden="true" />
          </TooltipButton>
        </div>
        <form className="theme-settings__search" role="search" onSubmit={(event) => { event.preventDefault(); onSearch(); }}>
          <Search aria-hidden="true" />
          <input
            type="search"
            value={query}
            autoFocus
            placeholder="Try Solarized, Monokai, or Dawn"
            aria-label="Search terminal.sexy schemes"
            onChange={(event) => onQueryChange(event.target.value)}
          />
          <button type="submit" className="btn btn-secondary" disabled={!query.trim() || searching || Boolean(installing)}>
            {searching ? <Loader2 className="theme-settings__spin" aria-hidden="true" /> : <Search aria-hidden="true" />} Search
          </button>
        </form>
        {previewing ? <p className="theme-settings__preview-note" role="status">Previewing {previewing.label}. Add it to keep this theme.</p> : null}
        {error ? <p className="theme-settings__error" role="alert">{error}</p> : null}
        {searching ? <p className="theme-settings__status" role="status"><Loader2 className="theme-settings__spin" aria-hidden="true" /> Finding schemes…</p> : null}
        {results ? (
          results.length ? (
            <div className="theme-settings__grid">
              {results.map((scheme) => {
                const theme = getTheme(scheme);
                return theme && isInstalled(scheme) ? (
                  <ThemeCard
                    key={scheme.id}
                    theme={theme}
                    active={selectedThemeId === theme.id && !previewing}
                    mode={mode}
                    custom
                    onSelect={() => onSelect(theme.id)}
                    onRemove={() => onRemove(theme)}
                  />
                ) : (
                  <SchemeCard
                    key={scheme.id}
                    scheme={scheme}
                    theme={theme}
                    mode={mode}
                    active={isPreviewing(scheme)}
                    loading={loading === scheme.id}
                    installing={installing === scheme.id}
                    installBusy={Boolean(installing)}
                    installed={isInstalled(scheme)}
                    onPreview={() => void onPreview(scheme)}
                    onAdd={() => void onAdd(scheme)}
                  />
                );
              })}
            </div>
          ) : <p className="theme-settings__empty">No terminal.sexy schemes found. Try a broader search.</p>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

export function ThemeSettings({ showSuccess, showError }) {
  const [settings, setSettings] = useState(getThemeSettings);
  const [customThemes, setCustomThemes] = useState(getCustomThemes);
  const [featuredThemes, setFeaturedThemes] = useState(null);
  const [featuredError, setFeaturedError] = useState("");
  const [terminalSexySearchOpen, setTerminalSexySearchOpen] = useState(false);
  const [terminalSexyQuery, setTerminalSexyQuery] = useState("");
  const [terminalSexyResults, setTerminalSexyResults] = useState(null);
  const [terminalSexySearching, setTerminalSexySearching] = useState(false);
  const [terminalSexyInstalling, setTerminalSexyInstalling] = useState(null);
  const [terminalSexyPreviewing, setTerminalSexyPreviewing] = useState(null);
  const [terminalSexyLoading, setTerminalSexyLoading] = useState(null);
  const [terminalSexyError, setTerminalSexyError] = useState("");
  const themeCacheRef = useRef(new Map());
  const searchAbortRef = useRef(null);
  const previewAbortRef = useRef(null);
  const previewRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    const refresh = () => {
      const nextSettings = getThemeSettings();
      setSettings(nextSettings);
      setCustomThemes([...getCustomThemes()]);
      if (previewRef.current) applyThemePreview(previewRef.current.theme, nextSettings.appearance);
    };
    const unsubscribeTheme = subscribeToThemeChanges(refresh);
    const unsubscribeCustom = subscribeToCustomThemes(refresh);
    return () => {
      unsubscribeTheme();
      unsubscribeCustom();
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    const loadFeatured = async () => {
      try {
        const catalog = await loadTerminalSexyCatalog();
        const schemes = selectTerminalSexyFeaturedThemes(catalog);
        const resolved = await Promise.all(schemes.map(async (scheme) => {
          try {
            const theme = await importTerminalSexyTheme(scheme, { signal: controller.signal });
            themeCacheRef.current.set(scheme.id, theme);
            const existing = getCustomThemes().find((item) => item.id === theme.id);
            if (existing && !existing.variants && theme.variants) {
              try {
                replaceCustomTheme(theme);
                if (!previewRef.current && getThemeSettings().themeId === theme.id) applyThemeSelection(getThemeSettings());
              } catch (migrationError) {
                if (!controller.signal.aborted) setFeaturedError(migrationError instanceof Error ? migrationError.message : "An existing theme could not be updated.");
              }
            }
            return { ...scheme, theme };
          } catch (error) {
            if (!controller.signal.aborted) setFeaturedError(error instanceof Error ? error.message : "Featured terminal.sexy schemes could not be loaded.");
            return null;
          }
        }));
        if (!controller.signal.aborted && mountedRef.current) {
          const available = resolved.filter(Boolean);
          setFeaturedThemes(available);
          if (!available.length) setFeaturedError("Featured terminal.sexy schemes could not be loaded. Search to retry.");
        }
      } catch (error) {
        if (!controller.signal.aborted && mountedRef.current) {
          setFeaturedThemes([]);
          setFeaturedError(error instanceof Error ? error.message : "Featured terminal.sexy schemes could not be loaded.");
        }
      }
    };
    void loadFeatured();
    return () => controller.abort();
  }, []);

  useEffect(() => () => {
    mountedRef.current = false;
    searchAbortRef.current?.abort();
    previewAbortRef.current?.abort();
    if (previewRef.current) applyThemeSelection(getThemeSettings());
  }, []);

  const clearPreview = () => {
    const hadPreview = Boolean(previewRef.current);
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    previewRef.current = null;
    setTerminalSexyPreviewing(null);
    setTerminalSexyLoading(null);
    if (hadPreview) applyThemeSelection(getThemeSettings());
  };

  const rememberTheme = (scheme, theme) => {
    themeCacheRef.current.set(scheme.id, theme);
    return theme;
  };

  const handleModeChange = (appearance) => {
    setThemeSelection(settings.themeId, appearance);
    if (previewRef.current) applyThemePreview(previewRef.current.theme, appearance);
  };

  const handleSelect = (themeId) => {
    clearPreview();
    setThemeSelection(themeId, settings.appearance);
  };

  const openSearch = () => {
    setTerminalSexyError("");
    setTerminalSexyResults(null);
    setTerminalSexySearchOpen(true);
  };

  const closeSearch = () => {
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    clearPreview();
    setTerminalSexySearching(false);
    setTerminalSexyError("");
    setTerminalSexyResults(null);
    setTerminalSexySearchOpen(false);
  };

  const handleTerminalSexySearch = async () => {
    const query = terminalSexyQuery.trim();
    if (!query) return;
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setTerminalSexySearching(true);
    setTerminalSexyError("");
    setTerminalSexyResults(null);
    try {
      const results = await searchTerminalSexyThemes(query, { signal: controller.signal });
      if (!controller.signal.aborted && mountedRef.current) setTerminalSexyResults(results);
    } catch (searchError) {
      if (!controller.signal.aborted && mountedRef.current) setTerminalSexyError(searchError instanceof Error ? searchError.message : "Terminal.sexy search failed.");
    } finally {
      if (searchAbortRef.current === controller && mountedRef.current) {
        searchAbortRef.current = null;
        setTerminalSexySearching(false);
      }
    }
  };

  const handleTerminalSexyPreview = async (scheme) => {
    setTerminalSexyError("");
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    setTerminalSexyLoading(null);
    const cached = themeCacheRef.current.get(scheme.id);
    if (cached) {
      previewRef.current = { schemeId: scheme.id, theme: cached };
      setTerminalSexyPreviewing({ schemeId: scheme.id, label: scheme.label });
      applyThemePreview(cached, settings.appearance);
      return;
    }
    const controller = new AbortController();
    previewAbortRef.current = controller;
    setTerminalSexyLoading(scheme.id);
    try {
      const theme = rememberTheme(scheme, await importTerminalSexyTheme(scheme, { signal: controller.signal }));
      if (!controller.signal.aborted && mountedRef.current) {
        previewRef.current = { schemeId: scheme.id, theme };
        setTerminalSexyPreviewing({ schemeId: scheme.id, label: scheme.label });
        applyThemePreview(theme, settings.appearance);
      }
    } catch (previewError) {
      if (!controller.signal.aborted && mountedRef.current) {
        const message = previewError instanceof Error ? previewError.message : `Could not preview ${scheme.label}.`;
        setTerminalSexyError(message);
        showError?.(message);
      }
    } finally {
      if (previewAbortRef.current === controller && mountedRef.current) {
        previewAbortRef.current = null;
        setTerminalSexyLoading(null);
      }
    }
  };

  const handleTerminalSexyInstall = async (scheme) => {
    if (terminalSexyInstalling) return;
    const existing = getCustomThemes().find((theme) => theme.id === scheme.id);
    if (existing) {
      clearPreview();
      setThemeSelection(existing.id, settings.appearance);
      setTerminalSexySearchOpen(false);
      return;
    }
    setTerminalSexyInstalling(scheme.id);
    setTerminalSexyError("");
    try {
      const theme = themeCacheRef.current.get(scheme.id) || await importTerminalSexyTheme(scheme);
      const unique = createUniqueThemeName(theme, [...BUILT_IN_THEMES, ...getCustomThemes()]);
      const installed = installCustomTheme(unique);
      clearPreview();
      setThemeSelection(installed.id, settings.appearance);
      setTerminalSexySearchOpen(false);
      showSuccess?.(`${installed.label} added`);
    } catch (installError) {
      const message = installError instanceof Error ? installError.message : "That terminal.sexy scheme could not be added.";
      setTerminalSexyError(message);
      showError?.(message);
    } finally {
      setTerminalSexyInstalling(null);
    }
  };

  const handleFeaturedThemeSelect = (scheme) => {
    const existing = getCustomThemes().find((theme) => theme.id === scheme.theme.id);
    try {
      const installed = existing || installCustomTheme(scheme.theme);
      clearPreview();
      setThemeSelection(installed.id, settings.appearance);
    } catch (selectError) {
      const message = selectError instanceof Error ? selectError.message : `Could not select ${scheme.label}.`;
      showError?.(message);
    }
  };

  const handleRemove = (theme) => {
    if (!window.confirm(`Remove the added theme “${theme.label}”?`)) return;
    clearPreview();
    removeCustomTheme(theme.id);
    if (settings.themeId === theme.id) setThemeSelection("aurral", "system");
  };

  const isInstalled = (scheme) => customThemes.some((theme) => theme.id === scheme.id);
  const isPreviewing = (scheme) => terminalSexyPreviewing?.schemeId === scheme.id;
  const featuredThemeIds = new Set((featuredThemes || []).map((scheme) => scheme.theme?.id).filter(Boolean));

  return (
    <div className="theme-settings">
      <p className="theme-settings__description">Choose a theme, preview terminal.sexy schemes, and add the ones you want to keep.</p>

      <section className="theme-settings__section" aria-labelledby="theme-mode-heading">
        <div className="theme-settings__section-heading">
          <div>
            <h4 id="theme-mode-heading">Color scheme</h4>
          </div>
        </div>
        <div className="theme-settings__mode-grid" aria-label="Color scheme mode">
          {APPEARANCE_OPTIONS.map((option) => (
            <AppearanceModeCard
              key={option.id}
              option={option}
              active={settings.appearance === option.id}
              onSelect={() => handleModeChange(option.id)}
            />
          ))}
        </div>
      </section>

      <section className="theme-settings__section" aria-labelledby="theme-themes-heading">
        <div className="theme-settings__section-heading">
          <div>
            <h4 id="theme-themes-heading">Themes</h4>
          </div>
          <div className="theme-settings__section-actions">
            {featuredThemes === null ? <span className="theme-settings__section-status" role="status">Loading schemes…</span> : null}
            <button type="button" className="btn btn-secondary" onClick={openSearch}>
              <Search aria-hidden="true" /> Find a scheme
            </button>
          </div>
        </div>
        <div className="theme-settings__grid" aria-label="Themes">
          {BUILT_IN_THEMES.map((theme) => (
            <ThemeCard
              key={theme.id}
              theme={theme}
              active={settings.themeId === theme.id && !terminalSexyPreviewing}
              mode={settings.appearance}
              onSelect={() => handleSelect(theme.id)}
            />
          ))}
          {featuredThemes === null ? Array.from({ length: 5 }, (_, index) => <LoadingSchemeCard key={index} />) : featuredThemes.map((scheme) => (
            <ThemeCard
              key={scheme.id}
              theme={scheme.theme}
              active={settings.themeId === scheme.theme.id && !terminalSexyPreviewing}
              mode={settings.appearance}
              onSelect={() => handleFeaturedThemeSelect(scheme)}
            />
          ))}
          {customThemes.filter((theme) => !featuredThemeIds.has(theme.id)).map((theme) => (
            <ThemeCard
              key={theme.id}
              theme={theme}
              active={settings.themeId === theme.id && !terminalSexyPreviewing}
              mode={settings.appearance}
              custom
              onSelect={() => handleSelect(theme.id)}
              onRemove={() => handleRemove(theme)}
            />
          ))}
        </div>
        {featuredError ? <p className="theme-settings__error" role="alert">{featuredError}</p> : null}
      </section>

      <SchemeSearchModal
        open={terminalSexySearchOpen}
        query={terminalSexyQuery}
        results={terminalSexyResults}
        searching={terminalSexySearching}
        error={terminalSexyError}
        previewing={terminalSexyPreviewing}
        loading={terminalSexyLoading}
        installing={terminalSexyInstalling}
        mode={settings.appearance}
        onClose={closeSearch}
        onQueryChange={setTerminalSexyQuery}
        onSearch={() => void handleTerminalSexySearch()}
        onPreview={handleTerminalSexyPreview}
        onAdd={handleTerminalSexyInstall}
        isInstalled={isInstalled}
        isPreviewing={isPreviewing}
        getTheme={(scheme) => themeCacheRef.current.get(scheme.id) || customThemes.find((theme) => theme.id === scheme.id)}
        selectedThemeId={settings.themeId}
        onSelect={handleSelect}
        onRemove={handleRemove}
      />
    </div>
  );
}
