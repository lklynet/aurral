import ArtistImage from "./ArtistImage";
import SearchLibraryCheck from "./SearchLibraryCheck";
import { ArtistContextMenu } from "./ArtistContextMenu";
import { getArtistFeedbackFlags } from "../utils/discoveryFeedback";
import { getArtistRecordId } from "../utils/artistTaste";

function TagRecommendedArtistCover({ artist, artistId, artistImages, isInLibrary }) {
  const coverSrc = artistImages[artistId] || artist.image || artist.imageUrl || "";

  return (
    <div className="artist-discover-card__cover artist-discover-card__cover--recommended">
      <ArtistImage
        src={coverSrc}
        mbid={artistId}
        artistName={artist.name}
        alt={artist.name}
        className="artist-discover-card__image"
        showLoading={false}
        enableBackendFallback={false}
        enablePreviewPlayback
        isInLibrary={isInLibrary}
      />
    </div>
  );
}

function SearchArtistResults({
  artists,
  type,
  artistImages,
  libraryLookup,
  navigate,
  canAddArtist,
  onAddArtistToLibrary,
  onArtistFeedback,
  artistFeedbackLookup,
  variant = "square",
}) {
  const formatLifeSpan = (artist) => {
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

  const normalizeArtistType = (artist) => {
    const raw = artist?.artistType || artist?.type || null;
    if (!raw) return null;
    const types = {
      Person: "Solo Artist",
      Group: "Band",
      Orchestra: "Orchestra",
      Choir: "Choir",
      Character: "Character",
      Other: "Other",
    };
    return types[raw] || raw;
  };

  const normalizeArea = (artist) => {
    const value = artist?.area || artist?.area?.name || null;
    if (!value) return null;
    return String(value).trim() || null;
  };

  const openArtist = (artist) => {
    const artistId = getArtistRecordId(artist);
    navigate(`/artist/${artistId}`, {
      state: {
        artistName: artist.name,
        ...(typeof libraryLookup[artistId] === "boolean"
          ? { inLibrary: libraryLookup[artistId] }
          : {}),
      },
    });
  };

  const gridClassName =
    variant === "round" ? "artist-release-grid search-artist-grid--round" : "artist-release-grid";

  return (
    <div className={gridClassName}>
      {artists.map((artist, index) => {
        const artistId = getArtistRecordId(artist);
        const isRecommendedTagResult = type === "tag" && artist.tagResultSource === "recommended";
        const artistTypeLabel = normalizeArtistType(artist);
        const lifeSpan = formatLifeSpan(artist);
        const area = normalizeArea(artist);
        const country = artist?.country ? String(artist.country).trim() : null;
        const disambiguation = artist?.disambiguation ? String(artist.disambiguation).trim() : null;
        const disambiguationLine = [artistTypeLabel, area || country, lifeSpan, disambiguation]
          .filter(Boolean)
          .join(" • ");
        const artistMetaText = [
          type === "recommended" && artist.sourceArtist && `Similar to ${artist.sourceArtist}`,
        ]
          .filter(Boolean)
          .join(" • ");

        return (
          <article
            key={artistId || `artist-${index}`}
            className={`artist-discover-card artist-discover-card--artist${
              isRecommendedTagResult ? " artist-discover-card--recommended" : ""
            }`}
            onClick={() => openArtist(artist)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openArtist(artist);
              }
            }}
            tabIndex={0}
          >
            {isRecommendedTagResult ? (
              <TagRecommendedArtistCover
                artist={artist}
                artistId={artistId}
                artistImages={artistImages}
                isInLibrary={!!libraryLookup[artistId]}
              />
            ) : (
              <div className="artist-discover-card__cover">
                <ArtistImage
                  src={artistImages[artistId] || artist.image || artist.imageUrl}
                  mbid={artistId}
                  artistName={artist.name}
                  alt={artist.name}
                  className="artist-discover-card__image"
                  showLoading={false}
                  enableBackendFallback={false}
                  enablePreviewPlayback
                  isInLibrary={!!libraryLookup[artistId]}
                />
              </div>
            )}

            <div className="artist-discover-card__content">
              <div className="artist-discover-card__text">
                <div className="artist-card-title-row--discover">
                  <h3
                    className="artist-card-title--discover"
                    title={artist.name}
                  >
                    {artist.name}
                  </h3>
                  {libraryLookup[artistId] && <SearchLibraryCheck />}
                </div>
                {artistMetaText ? (
                  <p className="artist-card-meta--discover" title={artistMetaText}>
                    {artistMetaText}
                  </p>
                ) : null}
                {variant !== "round" && disambiguationLine ? (
                  <p className="artist-card-meta--discover" title={disambiguationLine}>
                    {disambiguationLine}
                  </p>
                ) : null}
              </div>

              <div onClick={(event) => event.stopPropagation()} role="none">
                <ArtistContextMenu
                  artist={artist}
                  isInLibrary={!!libraryLookup[artistId]}
                  canAddArtist={canAddArtist}
                  onAddToLibrary={onAddArtistToLibrary}
                  onFeedback={onArtistFeedback}
                  feedbackUsed={
                    artistFeedbackLookup
                      ? getArtistFeedbackFlags(artistFeedbackLookup, artist)
                      : undefined
                  }
                />
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

export default SearchArtistResults;
