import { useState } from "react";
import { Pencil, Plus, Save, Trash2 } from "lucide-react";
import PillToggle from "../../../components/PillToggle";
import { SettingsInput } from "./SettingsField";
import { SettingsArrFieldSet, SettingsArrFormGroup } from "./arr/SettingsArrLayout";
import { SettingsIntegrationModal } from "./SettingsIntegrationCards";

const GROUPS = [
  ["major", "Major Music Publications & Magazines"],
  ["indie", "Indie & Alternative Music Blogs"],
  ["discovery", "Music Discovery & Curation"],
  ["hiphop", "Hip-Hop & Rap"],
  ["pop", "Pop & Mainstream"],
  ["electronic", "Electronic & Dance Music"],
  ["metal", "Metal & Hard Rock"],
  ["country", "Country & Americana"],
  ["jazz", "Jazz"],
  ["classical", "Classical & Contemporary Classical"],
  ["specialty", "Genre Specialty"],
  ["regional", "Regional Music Scenes"],
  ["concerts", "Concerts, Festivals & Live Music"],
];

export function SettingsRssNewsTab({ settings, updateSettings, handleSaveSettings }) {
  const [feedEditor, setFeedEditor] = useState(null);
  const [feedError, setFeedError] = useState("");
  const news = settings.integrations?.news || { enabled: true, feeds: [], groups: {} };
  const feeds = Array.isArray(news.feeds) ? news.feeds : [];

  const updateNews = (patch) => updateSettings({
    ...settings,
    integrations: { ...settings.integrations, news: { ...news, ...patch } },
  });

  const updateFeed = (index, patch) => updateNews({
    feeds: feeds.map((feed, feedIndex) => feedIndex === index ? { ...feed, ...patch } : feed),
  });

  const removeFeed = (index) => updateNews({ feeds: feeds.filter((_, feedIndex) => feedIndex !== index) });

  const saveFeed = () => {
    const name = String(feedEditor?.draft?.name || "").trim();
    const url = String(feedEditor?.draft?.url || "").trim();
    try {
      const parsed = new URL(url);
      if (!name || !/^https?:$/.test(parsed.protocol) || !parsed.hostname) throw new Error();
    } catch {
      setFeedError("Enter a feed name and a valid HTTP or HTTPS feed URL.");
      return;
    }
    const nextFeed = { ...feedEditor.draft, name, url };
    updateNews({
      feeds: feedEditor.index === null
        ? [...feeds, nextFeed]
        : feeds.map((feed, index) => index === feedEditor.index ? nextFeed : feed),
    });
    setFeedEditor(null);
    setFeedError("");
  };

  const addFeed = () => {
    setFeedError("");
    setFeedEditor({ index: null, draft: {
      id: `custom-${Date.now()}`,
      name: "",
      url: "",
      group: "custom",
      enabled: false,
      builtIn: false,
    } });
  };

  const editFeed = (index) => {
    setFeedError("");
    setFeedEditor({ index, draft: { ...feeds[index] } });
  };

  const renderFeed = (feed, index) => (
    <div className="settings-news-feed" key={feed.id || `${feed.url}-${index}`}>
      {feed.builtIn ? (
        <div className="settings-news-feed__details">
          <span className="settings-news-feed__name">{feed.name}</span>
          <span className="settings-news-feed__url">{feed.url}</span>
        </div>
      ) : (
        <div className="settings-news-feed__details">
          <span className="settings-news-feed__name">{feed.name}</span>
          <span className="settings-news-feed__url">{feed.url}</span>
        </div>
      )}
      <div className="settings-news-feed__actions">
        <PillToggle checked={feed.enabled !== false} onChange={(event) => updateFeed(index, { enabled: event.target.checked })} aria-label={`Enable ${feed.name || "RSS feed"}`} />
        {!feed.builtIn ? (
          <>
            <button type="button" className="arr-btn arr-btn--ghost arr-btn--icon" onClick={() => editFeed(index)} aria-label={`Edit ${feed.name}`} title={`Edit ${feed.name}`}>
              <Pencil className="artist-icon-xs" aria-hidden />
            </button>
            <button type="button" className="arr-btn arr-btn--danger arr-btn--icon" onClick={() => removeFeed(index)} aria-label={`Delete ${feed.name}`} title={`Delete ${feed.name}`}>
              <Trash2 className="artist-icon-xs" aria-hidden />
            </button>
          </>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="arr-page">
      <form onSubmit={handleSaveSettings} className="arr-form" autoComplete="off">
        <SettingsArrFieldSet legend="RSS News">
          <SettingsArrFormGroup label="Enable RSS News" labelFor="enable-rss-news">
            <PillToggle id="enable-rss-news" checked={news.enabled !== false} onChange={(event) => updateNews({ enabled: event.target.checked })} />
          </SettingsArrFormGroup>
        </SettingsArrFieldSet>

        <SettingsArrFieldSet
          legend="Custom feeds"
          actions={
            <button type="button" className="arr-btn" onClick={addFeed}>
              <Plus className="artist-icon-xs" aria-hidden /> Add feed
            </button>
          }
        >
          <div className="settings-news-feeds settings-news-feeds--page">
            {feeds.map((feed, index) => feed.group === "custom" ? renderFeed(feed, index) : null)}
          </div>
        </SettingsArrFieldSet>

        <div className="settings-news-categories">
            {GROUPS.map(([id, label]) => {
              const categoryEnabled = news.groups?.[id] !== false;
              const categoryFeeds = feeds
                .map((feed, index) => ({ feed, index }))
                .filter(({ feed }) => feed.group === id);
              return (
                <section className={`settings-news-category${categoryEnabled ? "" : " is-disabled"}`} key={id}>
                  <div className="settings-news-category__header">
                    <div>
                      <h3>{label}</h3>
                    </div>
                    <PillToggle checked={categoryEnabled} onChange={(event) => updateNews({ groups: { ...news.groups, [id]: event.target.checked } })} aria-label={`Enable ${label}`} />
                  </div>
                  <fieldset className="settings-news-category__feeds" disabled={!categoryEnabled}>
                    <div className="settings-news-feeds settings-news-feeds--page">
                      {categoryFeeds.map(({ feed, index }) => renderFeed(feed, index))}
                    </div>
                  </fieldset>
                </section>
              );
            })}
          </div>
      </form>
      {feedEditor ? (
        <SettingsIntegrationModal
          title={feedEditor.index === null ? "Add RSS feed" : "Edit RSS feed"}
          onClose={() => setFeedEditor(null)}
          saveReminder={false}
          showDone={false}
          footerActions={<button type="button" className="arr-btn arr-btn--primary arr-btn--icon" onClick={saveFeed} aria-label="Save feed" title="Save feed"><Save className="artist-icon-sm" aria-hidden /></button>}
        >
          <div className="settings-modal__section-body">
            <label className="settings-modal__label" htmlFor="rss-feed-editor-name">Feed name</label>
            <SettingsInput id="rss-feed-editor-name" name="rss-feed-editor-name" value={feedEditor.draft.name} placeholder="Feed name" onChange={(event) => setFeedEditor({ ...feedEditor, draft: { ...feedEditor.draft, name: event.target.value } })} />
            <label className="settings-modal__label" htmlFor="rss-feed-editor-url">Feed URL</label>
            <SettingsInput id="rss-feed-editor-url" name="rss-feed-editor-url" type="url" value={feedEditor.draft.url} placeholder="https://example.com/feed.xml" onChange={(event) => setFeedEditor({ ...feedEditor, draft: { ...feedEditor.draft, url: event.target.value } })} />
            {feedError ? <p className="settings-modal__hint" role="alert">{feedError}</p> : null}
          </div>
        </SettingsIntegrationModal>
      ) : null}
    </div>
  );
}
