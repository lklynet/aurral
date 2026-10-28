import ArtistImage from "./ArtistImage";
import SearchLibraryCheck from "./SearchLibraryCheck";
import { ArtistContextMenu } from "./ArtistContextMenu";
import { getArtistFeedbackFlags } from "../utils/discoveryFeedback";
import { getArtistRecordId } from "../utils/artistTaste";
import Tooltip from "./Tooltip";
import RouteLink from "./RouteLink";
import type { SearchImageMap } from "./SearchMixedResultList";
import type { ArtistFeedbackAction } from "../utils/artistTaste";

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
  artistImages: SearchImageMap;
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

function SearchArtistResults({
  artists,
  artistImages,
  libraryLookup,
  onArtistFeedback,
  artistFeedbackLookup,
  variant = "square",
  gridColumns,
}: SearchArtistResultsProps) {
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

  const normalizeArtistType = (artist: SearchArtist) => {
    const raw = artist?.artistType || artist?.type || null;
    if (!raw) return null;
    const types: Partial<Record<string, string>> = {
      Person: "Solo artist",
      Group: "Band",
      Orchestra: "Orchestra",
      Choir: "Choir",
      Character: "Character",
      Other: "Other",
    };
    return types[raw] || raw;
  };

  const normalizeArea = (artist: SearchArtist) => {
    const value = artist?.area || null;
    if (!value) return null;
    return String(value).trim() || null;
  };

  const artistLinkState = (artist: SearchArtist, artistKey: string) => ({
    artistName: artist.name,
    artistImage: artistImages[artistKey] || artist.image || artist.imageUrl || undefined,
    ...(typeof libraryLookup[artistKey] === "boolean"
      ? { inLibrary: libraryLookup[artistKey] }
      : {}),
  });

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
        const artistKey = String(artistId);
        const artistTypeLabel = normalizeArtistType(artist);
        const lifeSpan = formatLifeSpan(artist);
        const area = normalizeArea(artist);
        const country = artist?.country ? String(artist.country).trim() : null;
        const disambiguation = artist?.disambiguation ? String(artist.disambiguation).trim() : null;
        const disambiguationLine = [artistTypeLabel, area || country, lifeSpan, disambiguation]
          .filter(Boolean)
          .join(" • ");

        const cover = (
          <div
            className={`artist-discover-card__cover${isList ? " artist-list-cover" : ""}`}
            data-artwork
          >
            <ArtistImage
              src={artistImages[artistKey] || artist.image || artist.imageUrl}
              mbid={artistId}
              artistName={artist.name}
              alt={artist.name}
              className="artist-discover-card__image"
              showLoading={false}
              enableBackendFallback={false}
              enablePreviewPlayback
              isInLibrary={!!libraryLookup[artistKey]}
            />
          </div>
        );

        const artistPath = `/artist/${artistId}`;
        const linkState = artistLinkState(artist, artistKey);
        const contextMenu = (
          <div className="artist-discover-card__menu">
            <ArtistContextMenu
              artist={artist}
              isInLibrary={!!libraryLookup[artistKey]}
              onFeedback={onArtistFeedback}
              menuLayout={isList ? "inline" : "text"}
              feedbackUsed={
                artistFeedbackLookup
                  ? getArtistFeedbackFlags(artistFeedbackLookup, artist)
                  : undefined
              }
            />
          </div>
        );

        if (isList) {
          return (
            <article
              key={artistId || `artist-${index}`}
              className="artist-release-list-item search-artist-results__item"
              data-artwork-scope
            >
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
                {disambiguationLine ? (
                  <Tooltip content={disambiguationLine}>
                    <p className="artist-release-card__meta artist-truncate">
                      {disambiguationLine}
                    </p>
                  </Tooltip>
                ) : null}
              </RouteLink>
              {contextMenu}
            </article>
          );
        }

        return (
          <article
            key={artistId || `artist-${index}`}
            className="artist-discover-card artist-discover-card--artist"
            data-artwork-scope
            data-library-menu-target
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
                  {libraryLookup[artistKey] && <SearchLibraryCheck />}
                </div>
                {variant !== "round" && disambiguationLine ? (
                  <Tooltip content={disambiguationLine}>
                    <p className="artist-card-meta--discover">{disambiguationLine}</p>
                  </Tooltip>
                ) : null}
              </RouteLink>

              {contextMenu}
            </div>
          </article>
        );
      })}
    </div>
  );
}

export default SearchArtistResults;
