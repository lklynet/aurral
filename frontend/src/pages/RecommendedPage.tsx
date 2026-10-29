import { Fragment, useEffect, useMemo, useState } from "react";
import { Navigate, useParams } from "react-router";
import ArtistImage from "../components/ArtistImage";
import { useArtistTint } from "../components/CollectionHeader";
import { DiscoverRail } from "../components/DiscoverRail";
import { DotLoader } from "../components/DotLoader";
import { Pause, Play, ThumbsDown, ThumbsUp } from "../components/icons";
import RouteLink from "../components/RouteLink";
import { SkeletonRail, SkeletonStatus } from "../components/Skeletons";
import TooltipButton from "../components/TooltipButton";
import { useToast } from "../contexts/ToastContext";
import { useArtistPreviewPlayback } from "../hooks/useArtistPreviewPlayback";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import {
  RECOMMENDED_ALL_PATH,
  RECOMMENDED_PATH,
  recommendedListPath,
  rememberRecommendedView,
} from "../navigation/recommendedPath.ts";
import { formatRelativeTime } from "../utils/dateTime.ts";
import { getArtistFeedbackFlags } from "../utils/discoveryFeedback";
import { ArtistCard } from "./DiscoverCards";
import {
  artistMatchesGenre,
  DISCOVER_PREVIEW_ITEM_LIMIT,
  type DiscoverArtist,
} from "./discoverUtils";
import {
  buildRecommendedRails,
  firstGenre,
  matchesFilter,
  pickReason,
  recommendationContext,
  recommendationReason,
  type RecommendationContext,
} from "./recommendedRails";
import { RecommendedList } from "./RecommendedList";
import { useDiscoveryRecommendations, type DiscoverData } from "./useDiscoveryRecommendations";
import "./RecommendedPage.css";

type Recommendations = ReturnType<typeof useDiscoveryRecommendations>;
type FeedbackProps = Pick<Recommendations, "artistFeedbackLookup" | "handleDiscoveryFeedback">;

const BASED_ON_PREVIEW = 10;
const TASTE_GENRES = 8;
const listFormat = new Intl.ListFormat(undefined, { style: "long", type: "conjunction" });
const noLibraryLink = () => null;
const artistPath = (artist: DiscoverArtist) => {
  const id = artist.navigateTo || artist.id;
  return id ? `/artist/${id}` : null;
};

function RecommendedRail({
  title,
  mobileTitle,
  artists,
  viewAllTo,
  meta,
  artistFeedbackLookup,
  handleDiscoveryFeedback,
}: FeedbackProps & {
  title: string;
  mobileTitle?: string;
  artists: DiscoverArtist[];
  viewAllTo: string;
  meta: (artist: DiscoverArtist) => string;
}) {
  if (artists.length === 0) return null;
  return (
    <DiscoverRail title={title} mobileTitle={mobileTitle} viewAllTo={viewAllTo}>
      {artists.slice(0, DISCOVER_PREVIEW_ITEM_LIMIT).map((artist) => (
        <div key={artist.id ?? artist.name} className="artist-discover-shelf-card">
          <ArtistCard
            artist={{ ...artist, metaText: meta(artist) }}
            isInLibrary={false}
            getLibraryLink={noLibraryLink}
            onFeedback={handleDiscoveryFeedback}
            feedbackUsed={getArtistFeedbackFlags(artistFeedbackLookup, artist)}
          />
        </div>
      ))}
    </DiscoverRail>
  );
}

function TopPick({
  artist,
  basedOn,
  context,
  artistFeedbackLookup,
  handleDiscoveryFeedback,
}: FeedbackProps & {
  artist: DiscoverArtist;
  basedOn: DiscoverData["basedOn"];
  context: RecommendationContext;
}) {
  const { showInfo } = useToast();
  const mbid = artist.navigateTo || artist.id;
  const { canPlayArtistPreview, isArtistPreviewActive, isLoadingPreview, playArtistPreview } =
    useArtistPreviewPlayback({ mbid, artistName: artist.name });
  const reason = pickReason(artist, context.seeds);
  const seeds = reason.kind === "like" ? reason.names : [];
  const seedIds = new Map(basedOn.flatMap((seed) => (seed.name ? [[seed.name, seed.id]] : [])));
  const feedbackUsed = getArtistFeedbackFlags(artistFeedbackLookup, artist);
  const to = artistPath(artist);
  const preview = async () => {
    if (!(await playArtistPreview())) showInfo(`No preview found for ${artist.name}`);
  };
  const feedback = (action: "more_like_this" | "less_like_this") =>
    handleDiscoveryFeedback(artist, action, { isSelected: Boolean(feedbackUsed[action]) });

  return (
    <section className="recommended-spotlight" aria-label="Top pick">
      <ArtistImage
        src={artist.image}
        mbid={mbid}
        artistName={artist.name}
        alt=""
        className="recommended-spotlight__cover"
        loading="eager"
        showLoading={false}
        thumbnail={false}
        sizes="200px"
      />
      <div className="recommended-spotlight__main">
        <h2 className="recommended-spotlight__title">
          {to ? <RouteLink to={to}>{artist.name}</RouteLink> : artist.name}
        </h2>
        <p className="recommended-spotlight__by">
          Top pick
          {seeds.length > 0 ? (
            <>
              {" · Because you like "}
              {listFormat.formatToParts(seeds.slice(0, 3)).map((part, index) => {
                const seedId = part.type === "element" ? seedIds.get(part.value) : null;
                return seedId ? (
                  <RouteLink key={index} to={`/artist/${seedId}`}>
                    {part.value}
                  </RouteLink>
                ) : (
                  <Fragment key={index}>{part.value}</Fragment>
                );
              })}
            </>
          ) : reason.names.length > 0 ? (
            ` · via ${listFormat.format(reason.names.slice(0, 3))}`
          ) : null}
        </p>
        <div className="recommended-spotlight__actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={preview}
            disabled={!canPlayArtistPreview || isLoadingPreview}
          >
            {isLoadingPreview ? (
              <DotLoader size="sm" label={null} />
            ) : isArtistPreviewActive ? (
              <Pause aria-hidden="true" />
            ) : (
              <Play aria-hidden="true" />
            )}
            {isArtistPreviewActive ? "Pause" : "Preview"}
          </button>
          <TooltipButton
            type="button"
            label="More like this"
            className={`btn btn-icon-square${feedbackUsed.more_like_this ? " is-selected" : ""}`}
            aria-pressed={Boolean(feedbackUsed.more_like_this)}
            onClick={() => feedback("more_like_this")}
          >
            <ThumbsUp aria-hidden="true" />
          </TooltipButton>
          <TooltipButton
            type="button"
            label="Less like this"
            className={`btn btn-icon-square${feedbackUsed.less_like_this ? " is-selected" : ""}`}
            aria-pressed={Boolean(feedbackUsed.less_like_this)}
            onClick={() => feedback("less_like_this")}
          >
            <ThumbsDown aria-hidden="true" />
          </TooltipButton>
        </div>
      </div>
      {seeds.length > 0 ? (
        <div className="recommended-spotlight__why">
          <p className="recommended-spotlight__stat">
            {seeds.length}
            <span>of your artists</span>
          </p>
          <div className="recommended-spotlight__seeds">
            {seeds.slice(0, 3).map((seed) => (
              <ArtistImage
                key={seed}
                mbid={seedIds.get(seed)}
                artistName={seed}
                alt={seed}
                className="recommended-spotlight__seed"
                showLoading={false}
              />
            ))}
          </div>
          {artist.matchedTags.length > 0 ? (
            <p className="recommended-spotlight__caption">
              {artist.matchedTags.slice(0, 3).join(" · ")}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function TasteAndSeeds({ data, context }: { data: DiscoverData; context: RecommendationContext }) {
  const [showAllSeeds, setShowAllSeeds] = useState(false);
  const { recommendations, topGenres, basedOn } = data;
  const genres = useMemo(
    () =>
      topGenres
        .map((name) => ({
          name,
          count: recommendations.filter((artist) => artistMatchesGenre(artist, name)).length,
        }))
        .filter((genre) => genre.count > 0)
        .slice(0, TASTE_GENRES)
        .sort((left, right) => right.count - left.count),
    [recommendations, topGenres],
  );
  const seeds = useMemo(
    () =>
      basedOn
        .flatMap((seed) => {
          const name = seed.name;
          if (!name) return [];
          const count = recommendations.filter((artist) =>
            matchesFilter(artist, { kind: "seed", value: name }, context),
          ).length;
          return count > 0 ? [{ name, id: seed.id, count }] : [];
        })
        .sort((left, right) => right.count - left.count),
    [basedOn, context, recommendations],
  );
  if (genres.length === 0 && seeds.length === 0) return null;
  const topCount = Math.max(1, ...genres.map((genre) => genre.count));
  const shownSeeds = showAllSeeds ? seeds : seeds.slice(0, BASED_ON_PREVIEW);

  return (
    <div className="recommended-pair">
      {genres.length > 0 ? (
        <section aria-labelledby="recommended-taste-title">
          <div className="artist-discover-rail__header">
            <h2 id="recommended-taste-title" className="artist-section-title--discover">
              Your taste
            </h2>
          </div>
          <ul className="recommended-bars">
            {genres.map((genre) => (
              <li key={genre.name}>
                <RouteLink
                  to={recommendedListPath({ genre: genre.name })}
                  className="recommended-bars__row"
                  aria-label={`${genre.name}, ${genre.count} picks`}
                >
                  <span className="recommended-bars__name">{genre.name}</span>
                  <span className="recommended-bars__track">
                    <span
                      className="recommended-bars__bar"
                      style={{ width: `${Math.max(2, (100 * genre.count) / topCount)}%` }}
                    />
                  </span>
                  <span className="recommended-bars__count">{genre.count}</span>
                </RouteLink>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {seeds.length > 0 ? (
        <section aria-labelledby="recommended-seeds-title">
          <div className="artist-discover-rail__header">
            <h2 id="recommended-seeds-title" className="artist-section-title--discover">
              Based on
            </h2>
          </div>
          <ul className="recommended-seeds">
            {shownSeeds.map((seed) => (
              <li key={seed.name}>
                <RouteLink
                  to={recommendedListPath({ seed: seed.name })}
                  className="recommended-seeds__row"
                >
                  <ArtistImage
                    mbid={seed.id}
                    artistName={seed.name}
                    alt=""
                    className="recommended-seeds__avatar"
                    showLoading={false}
                  />
                  <span className="recommended-seeds__name">{seed.name}</span>
                  <span className="recommended-seeds__count">{seed.count}</span>
                </RouteLink>
              </li>
            ))}
          </ul>
          {seeds.length > BASED_ON_PREVIEW ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm recommended-seeds__more"
              onClick={() => setShowAllSeeds((shown) => !shown)}
              aria-expanded={showAllSeeds}
            >
              {showAllSeeds ? "Show fewer" : `Show all ${seeds.length}`}
            </button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function ForYou({ data, ...feedback }: FeedbackProps & { data: DiscoverData }) {
  const [now] = useState(Date.now);
  const context = useMemo(
    () => recommendationContext(data.recommendations, data.basedOn, now),
    [data.basedOn, data.recommendations, now],
  );
  const rails = useMemo(
    () => buildRecommendedRails(data.recommendations, context),
    [context, data.recommendations],
  );
  const reason = (artist: DiscoverArtist) => recommendationReason(artist, context.seeds);
  return (
    <>
      {rails.topPick ? (
        <TopPick artist={rails.topPick} basedOn={data.basedOn} context={context} {...feedback} />
      ) : null}
      <RecommendedRail
        title="New this week"
        artists={rails.fresh}
        viewAllTo={recommendedListPath({ show: "new" })}
        meta={reason}
        {...feedback}
      />
      {rails.seedRails.map(({ seed, artists }) => (
        <RecommendedRail
          key={seed}
          title={`Because you like ${seed}`}
          mobileTitle={seed}
          artists={artists}
          viewAllTo={recommendedListPath({ seed })}
          meta={firstGenre}
          {...feedback}
        />
      ))}
      <RecommendedRail
        title="Close to home"
        artists={rails.closeToHome}
        viewAllTo={recommendedListPath({ show: "close" })}
        meta={reason}
        {...feedback}
      />
      <RecommendedRail
        title="Further out"
        artists={rails.furtherOut}
        viewAllTo={recommendedListPath({ show: "further" })}
        meta={reason}
        {...feedback}
      />
      <TasteAndSeeds data={data} context={context} />
    </>
  );
}

function RecommendedView({ view }: { view: "for-you" | "all" }) {
  useDocumentTitle("Recommended");
  const { data, error, isPending, isFetching, refetch, discoveryStatus, ...feedback } =
    useDiscoveryRecommendations();

  useEffect(() => rememberRecommendedView(view), [view]);

  const recommendations = data?.recommendations ?? [];
  const topMatch = recommendations[0];
  const tint = useArtistTint(
    topMatch?.image,
    topMatch ? topMatch.navigateTo || topMatch.id : null,
    topMatch?.name,
  );
  const lastUpdated = discoveryStatus?.lastUpdated || data?.lastUpdated || null;
  const updating = Boolean(discoveryStatus?.isUpdating);
  const meta = [
    data?.basedOn.length ? `From ${data.basedOn.length} of your artists` : null,
    updating
      ? discoveryStatus?.updateProgressMessage || "Building your recommendations"
      : lastUpdated
        ? `updated ${formatRelativeTime(new Date(lastUpdated))}`
        : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const renderContent = () => {
    if (!data && isPending) {
      return (
        <SkeletonStatus label="Loading recommendations">
          <SkeletonRail kind="artist" />
          <SkeletonRail kind="artist" />
          <SkeletonRail kind="artist" />
        </SkeletonStatus>
      );
    }
    if (!data || recommendations.length === 0) {
      if (error) {
        return (
          <div className="search-empty-panel" role="alert">
            <h2 className="search-empty-panel__title">Recommendations didn’t load</h2>
            <p className="search-empty-panel__message">{error}</p>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={isFetching}
              onClick={() => refetch()}
            >
              Try again
            </button>
          </div>
        );
      }
      if (updating) {
        return (
          <div className="search-empty-panel" role="status">
            <h2 className="search-empty-panel__title">Building your recommendations</h2>
            <p className="search-empty-panel__message">
              <DotLoader size="xs" label={null} />{" "}
              {discoveryStatus?.updateProgressMessage || "This takes a few minutes."}
            </p>
          </div>
        );
      }
      return (
        <div className="search-empty-panel" role="status">
          <h2 className="search-empty-panel__title">No recommendations yet</h2>
          <p className="search-empty-panel__message">
            Add artists you like to get recommendations.
          </p>
          <RouteLink to="/search" className="btn btn-primary">
            Search artists
          </RouteLink>
        </div>
      );
    }
    return view === "all" ? (
      <RecommendedList data={data} {...feedback} />
    ) : (
      <ForYou data={data} {...feedback} />
    );
  };

  return (
    <div className="recommended-page" style={tint ? { "--collection-tint": tint } : undefined}>
      <header className="recommended-page__header">
        <h1 className="page-title">Recommended</h1>
        {meta ? <p className="recommended-page__meta">{meta}</p> : null}
        <nav className="recommended-page__views" aria-label="Recommended views">
          <RouteLink
            to={RECOMMENDED_PATH}
            className={view === "for-you" ? "is-active" : undefined}
            aria-current={view === "for-you" ? "page" : undefined}
          >
            For you
          </RouteLink>
          <RouteLink
            to={RECOMMENDED_ALL_PATH}
            className={view === "all" ? "is-active" : undefined}
            aria-current={view === "all" ? "page" : undefined}
          >
            All
            {recommendations.length > 0 ? <span>{recommendations.length}</span> : null}
          </RouteLink>
        </nav>
      </header>
      {renderContent()}
    </div>
  );
}

export default function RecommendedPage() {
  const { view } = useParams();
  if (view && view !== "all") return <Navigate to={RECOMMENDED_PATH} replace />;
  return <RecommendedView view={view === "all" ? "all" : "for-you"} />;
}
