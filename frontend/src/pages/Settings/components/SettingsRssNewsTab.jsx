import { Plus, Trash2 } from "lucide-react";
import PillToggle from "../../../components/PillToggle";
import { SettingsInput } from "./SettingsField";
import { SettingsArrFieldSet, SettingsArrFormGroup } from "./arr/SettingsArrLayout";

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

  const addFeed = () => updateNews({
    feeds: [...feeds, {
      id: `custom-${Date.now()}`,
      name: "",
      url: "",
      group: "custom",
      enabled: true,
      builtIn: false,
    }],
  });

  const renderFeed = (feed, index) => (
    <div className="settings-news-feed" key={feed.id || `${feed.url}-${index}`}>
      {feed.builtIn ? (
        <div className="settings-news-feed__details">
          <span className="settings-news-feed__name">{feed.name}</span>
          <span className="settings-news-feed__url">{feed.url}</span>
        </div>
      ) : (
        <div className="settings-news-feed__fields">
          <SettingsInput value={feed.name || ""} placeholder="Feed name" onChange={(event) => updateFeed(index, { name: event.target.value })} />
          <SettingsInput value={feed.url || ""} placeholder="https://example.com/feed.xml" onChange={(event) => updateFeed(index, { url: event.target.value })} />
        </div>
      )}
      <div className="settings-news-feed__actions">
        <PillToggle checked={feed.enabled !== false} onChange={(event) => updateFeed(index, { enabled: event.target.checked })} aria-label={`Enable ${feed.name || "RSS feed"}`} />
        {!feed.builtIn ? (
          <button type="button" className="arr-btn arr-btn--danger" onClick={() => removeFeed(index)}>
            <Trash2 className="artist-icon-xs" aria-hidden /> Remove
          </button>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="arr-page">
      <form onSubmit={handleSaveSettings} className="arr-form" autoComplete="off">
        <SettingsArrFieldSet legend="RSS News">
          <SettingsArrFormGroup label="Enable RSS News">
            <PillToggle checked={news.enabled !== false} onChange={(event) => updateNews({ enabled: event.target.checked })} />
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
          <p className="arr-form-help">Feeds you add appear here and are not affected by built-in category toggles.</p>
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
    </div>
  );
}
