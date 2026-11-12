import ArtistImage from "./ArtistImage";
import SearchLibraryCheck from "./SearchLibraryCheck";
import { ArtistContextMenu } from "./ArtistContextMenu";
import { getArtistFeedbackFlags } from "../utils/discoveryFeedback";
import { getArtistRecordId } from "../utils/artistTaste";
import Tooltip from "./Tooltip";
import RouteLink from "./RouteLink";
import type { ArtistFeedbackAction } from "../utils/artistTaste";
import { artworkHoverTint } from "../utils/imageColors.ts";

type SearchArtistLifeSpan = {
  begin?: string | null;
  end?: string | null;
  ended?: boolean | null;
};

type SearchArtist = {
  id?: string | number | null;
  mbid?: string | null;
  foreignArtistId?: string | null;
  name?: string | null;
  image?: string | null;
  imageUrl?: string | null;
  artistType?: string | null;
  type?: string | null;
  area?: string | null;
  country?: string | null;
  disambiguation?: string | null;
  begin?: string | null;
  end?: string | null;
  ended?: boolean | null;
  "life-span"?: SearchArtistLifeSpan | null;
  lifeSpan?: SearchArtistLifeSpan | null;
};

interface SearchArtistResultsProps {
  artists: SearchArtist[];
  libraryLookup: Record<string, boolean | undefined>;
  onArtistFeedback?: (
    artist: SearchArtist,
    action: ArtistFeedbackAction,
    options: { isSelected: boolean },
  ) => unknown;
  artistFeedbackLookup?: Parameters<typeof getArtistFeedbackFlags>[0];
  variant?: string;
  gridColumns?: number;
}

const formatLifeSpan = (artist: SearchArtist) => {
  const begin = artist?.begin || artist?.["life-span"]?.begin || artist?.lifeSpan?.begin;
  if (!begin) return null;
  const ended = artist?.ended ?? artist?.["life-span"]?.ended ?? artist?.lifeSpan?.ended ?? false;
  const end = artist?.end || artist?.["life-span"]?.end || artist?.lifeSpan?.end || null;
  const beginYear = String(begin).split("-")[0];
  if (ended && end) {
    const endYear = String(end).split("-")[0];
    return `${beginYear} - ${endYear}`;
  }
  return `${beginYear} - Present`;
};

const ARTIST_TYPES: Partial<Record<string, string>> = {
  Person: "Solo artist",
  Group: "Band",
  Orchestra: "Orchestra",
  Choir: "Choir",
  Character: "Character",
  Other: "Other",
};

const normalizeArtistType = (artist: SearchArtist) => {
  const raw = artist?.artistType || artist?.type || null;
  if (!raw) return null;
  return ARTIST_TYPES[raw] || raw;
};

const describeArtist = (artist: SearchArtist, variant: string) => {
  const disambiguation = artist?.disambiguation ? String(artist.disambiguation).trim() : null;
  if (variant === "round") return disambiguation;
  const area = artist?.area ? String(artist.area).trim() : null;
  const country = artist?.country ? String(artist.country).trim() : null;
  return (
    [normalizeArtistType(artist), area || country, formatLifeSpan(artist), disambiguation]
      .filter(Boolean)
      .join(" • ") || null
  );
};

type SearchArtistCardProps = Pick<
  SearchArtistResultsProps,
  "onArtistFeedback" | "artistFeedbackLookup"
> & {
  artist: SearchArtist;
  isInLibrary: boolean;
  variant?: string;
};

export function SearchArtistCard({
  artist,
  isInLibrary,
  onArtistFeedback,
  artistFeedbackLookup,
  variant = "round",
}: SearchArtistCardProps) {
  const artistId = getArtistRecordId(artist);
  const isList = variant === "list";
  const description = describeArtist(artist, variant);
  const linkState = {
    artistName: artist.name,
    artistImage: artist.image || artist.imageUrl || undefined,
    inLibrary: isInLibrary,
  };
  const artistPath = `/artist/${artistId}`;

  const cover = (
    <div
      className={`artist-discover-card__cover${isList ? " artist-list-cover" : ""}`}
      data-artwork
    >
      <ArtistImage
        src={artist.image || artist.imageUrl}
        mbid={artistId}
        artistName={artist.name}
        alt={artist.name}
        className="artist-discover-card__image"
        enablePreviewPlayback
        isInLibrary={isInLibrary}
      />
    </div>
  );

  const contextMenu = (
    <div className="artist-discover-card__menu">
      <ArtistContextMenu
        artist={artist}
        isInLibrary={isInLibrary}
        onFeedback={onArtistFeedback}
        menuLayout={isList ? "inline" : "text"}
        feedbackUsed={
          artistFeedbackLookup ? getArtistFeedbackFlags(artistFeedbackLookup, artist) : undefined
        }
      />
    </div>
  );

  if (isList) {
    return (
      <article className="artist-release-list-item search-artist-results__item" data-artwork-scope>
        {cover}
        <RouteLink
          to={artistPath}
          state={linkState}
          className="artist-min-0 card-link"
          aria-label={`Open ${artist.name}`}
        >
          <Tooltip content={artist.name}>
            <h2 className="artist-release-card__title artist-truncate">{artist.name}</h2>
          </Tooltip>
          {description ? (
            <Tooltip content={description}>
              <p className="artist-release-card__meta artist-truncate">{description}</p>
            </Tooltip>
          ) : null}
        </RouteLink>
        {contextMenu}
      </article>
    );
  }

  return (
    <article
      className="artist-discover-card artist-discover-card--artist"
      data-artwork-scope
      data-library-menu-target
      {...artworkHoverTint}
    >
      {cover}

      <div className="artist-discover-card__content">
        <RouteLink
          to={artistPath}
          state={linkState}
          className="artist-discover-card__text card-link"
          aria-label={`Open ${artist.name}`}
        >
          <div className="artist-card-title-row--discover">
            <Tooltip content={artist.name}>
              <h3 className="artist-card-title--discover">{artist.name}</h3>
            </Tooltip>
            {isInLibrary && <SearchLibraryCheck size="sm" />}
          </div>
          {description ? (
            <Tooltip content={description}>
              <p className="artist-card-meta--discover">{description}</p>
            </Tooltip>
          ) : null}
        </RouteLink>

        {contextMenu}
      </div>
    </article>
  );
}

function SearchArtistResults({
  artists,
  libraryLookup,
  onArtistFeedback,
  artistFeedbackLookup,
  variant = "square",
  gridColumns,
}: SearchArtistResultsProps) {
  const isList = variant === "list";
  const gridClassName = isList
    ? "artist-release-list search-artist-list"
    : variant === "round"
      ? "artist-release-grid search-artist-grid--round"
      : "artist-release-grid";
  const gridStyle =
    !isList && gridColumns
      ? { gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))` }
      : undefined;

  return (
    <div className={gridClassName} style={gridStyle}>
      {artists.map((artist, index) => {
        const artistId = getArtistRecordId(artist);
        return (
          <SearchArtistCard
            key={artistId || `artist-${index}`}
            artist={artist}
            isInLibrary={!!libraryLookup[String(artistId)]}
            onArtistFeedback={onArtistFeedback}
            artistFeedbackLookup={artistFeedbackLookup}
            variant={variant}
          />
        );
      })}
    </div>
  );
}

export default SearchArtistResults;
