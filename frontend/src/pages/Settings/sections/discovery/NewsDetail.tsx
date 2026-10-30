import { useState, type FormEvent } from "react";
import { Pencil, Trash2 } from "../../../../components/icons";
import PillToggle from "../../../../components/PillToggle";
import TooltipButton from "../../../../components/TooltipButton";
import { SettingsInput } from "../../components/SettingsField";
import { useServerSettings } from "../../SettingsProviders";
import type { SettingsState } from "../../utils";
import { SettingsActions, SettingsGroup, SettingsPage, SettingsRow } from "../../SettingsLayout";

const GROUPS = [
  ["major", "Music publications"],
  ["indie", "Indie and alternative"],
  ["discovery", "Discovery and curation"],
  ["hiphop", "Hip-hop and rap"],
  ["pop", "Pop and mainstream"],
  ["electronic", "Electronic and dance"],
  ["metal", "Metal and hard rock"],
  ["country", "Country and Americana"],
  ["jazz", "Jazz"],
  ["classical", "Classical"],
  ["regional", "Regional scenes"],
  ["concerts", "Live music"],
] as const;

type News = SettingsState["integrations"]["news"];
type NewsFeed = News["feeds"][number];
type FeedEditor = { index: number | null; name: string; url: string };

function validFeedUrl(value: string) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function useNews() {
  const { settings, updateSettings } = useServerSettings();
  const { news } = settings.integrations;
  const update = (patch: Partial<News>) =>
    updateSettings({
      ...settings,
      integrations: { ...settings.integrations, news: { ...news, ...patch } },
    });
  const updateFeeds = (feeds: NewsFeed[]) => update({ feeds });
  return { news, update, updateFeeds };
}

function FeedRow({
  feed,
  disabled,
  onToggle,
  onEdit,
  onDelete,
}: {
  feed: NewsFeed;
  disabled?: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  return (
    <SettingsRow label={feed.name} help={feed.url}>
      {onEdit ? (
        <TooltipButton
          label={`Edit ${feed.name}`}
          className="btn btn-ghost btn-icon btn-sm"
          onClick={onEdit}
        >
          <Pencil aria-hidden="true" />
        </TooltipButton>
      ) : null}
      {onDelete ? (
        <TooltipButton
          label={`Delete ${feed.name}`}
          className="btn btn-ghost btn-icon btn-sm"
          onClick={onDelete}
        >
          <Trash2 aria-hidden="true" />
        </TooltipButton>
      ) : null}
      <PillToggle
        checked={feed.enabled !== false}
        disabled={disabled}
        aria-label={`Show ${feed.name}`}
        onChange={(event) => onToggle(event.target.checked)}
      />
    </SettingsRow>
  );
}

function FeedForm({
  editor,
  onChange,
  onSubmit,
  onCancel,
}: {
  editor: FeedEditor;
  onChange: (editor: FeedEditor) => void;
  onSubmit: () => boolean;
  onCancel: () => void;
}) {
  const [invalid, setInvalid] = useState(false);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setInvalid(!onSubmit());
  };

  return (
    <form onSubmit={submit}>
      <SettingsRow label="Name" htmlFor="news-feed-name">
        <SettingsInput
          id="news-feed-name"
          autoComplete="off"
          value={editor.name}
          onChange={(event) => onChange({ ...editor, name: event.target.value })}
        />
      </SettingsRow>
      <SettingsRow label="Feed URL" htmlFor="news-feed-url">
        <SettingsInput
          id="news-feed-url"
          type="url"
          autoComplete="off"
          placeholder="https://example.com/feed.xml"
          value={editor.url}
          onChange={(event) => onChange({ ...editor, url: event.target.value })}
        />
      </SettingsRow>
      <SettingsActions
        status={
          invalid ? { tone: "error", message: "Enter a name and an HTTP or HTTPS feed URL." } : null
        }
      >
        <button type="submit" className="btn btn-primary btn-sm">
          {editor.index === null ? "Add feed" : "Save"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </SettingsActions>
    </form>
  );
}

export function NewsDetail() {
  const { news, update, updateFeeds } = useNews();
  const [editor, setEditor] = useState<FeedEditor | null>(null);
  const feeds = news.feeds.map((feed, index) => ({ feed, index }));
  const customFeeds = feeds.filter(({ feed }) => feed.group === "custom");

  const toggleFeed = (index: number, enabled: boolean) =>
    updateFeeds(news.feeds.map((feed, i) => (i === index ? { ...feed, enabled } : feed)));

  const saveFeed = () => {
    if (!editor) return false;
    const name = editor.name.trim();
    const url = editor.url.trim();
    if (!name || !validFeedUrl(url)) return false;
    updateFeeds(
      editor.index === null
        ? [
            ...news.feeds,
            {
              id: `custom-${Date.now()}`,
              name,
              url,
              group: "custom",
              enabled: true,
              builtIn: false,
            },
          ]
        : news.feeds.map((feed, i) => (i === editor.index ? { ...feed, name, url } : feed)),
    );
    setEditor(null);
    return true;
  };

  return (
    <SettingsPage title="News" back="Discovery">
      <SettingsGroup>
        <SettingsRow label="Enabled" htmlFor="news-enabled" help="Artist news from RSS feeds.">
          <PillToggle
            id="news-enabled"
            checked={news.enabled !== false}
            aria-label="Enabled"
            onChange={(event) => update({ enabled: event.target.checked })}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup
        title="Your feeds"
        actions={
          editor ? null : (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setEditor({ index: null, name: "", url: "" })}
            >
              Add feed
            </button>
          )
        }
      >
        {editor ? (
          <FeedForm
            editor={editor}
            onChange={setEditor}
            onSubmit={saveFeed}
            onCancel={() => setEditor(null)}
          />
        ) : customFeeds.length === 0 ? (
          <p className="settings-group__note">No feeds yet.</p>
        ) : (
          customFeeds.map(({ feed, index }) => (
            <FeedRow
              key={feed.id || `${feed.url}-${index}`}
              feed={feed}
              onToggle={(enabled) => toggleFeed(index, enabled)}
              onEdit={() => setEditor({ index, name: feed.name ?? "", url: feed.url })}
              onDelete={() => updateFeeds(news.feeds.filter((_feed, i) => i !== index))}
            />
          ))
        )}
      </SettingsGroup>
      {GROUPS.map(([id, label]) => {
        const groupEnabled = news.groups[id] !== false;
        return (
          <SettingsGroup
            key={id}
            title={label}
            actions={
              <PillToggle
                checked={groupEnabled}
                aria-label={`Show ${label}`}
                onChange={(event) =>
                  update({ groups: { ...news.groups, [id]: event.target.checked } })
                }
              />
            }
          >
            {feeds
              .filter(({ feed }) => feed.group === id)
              .map(({ feed, index }) => (
                <FeedRow
                  key={feed.id || `${feed.url}-${index}`}
                  feed={feed}
                  disabled={!groupEnabled}
                  onToggle={(enabled) => toggleFeed(index, enabled)}
                />
              ))}
          </SettingsGroup>
        );
      })}
    </SettingsPage>
  );
}
