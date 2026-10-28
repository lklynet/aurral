import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { DiscoverRail } from "../components/DiscoverRail";
import { resolveArtistPath, resolveLibraryArtistPath } from "../navigation/resolveLinks.ts";
import type { discoveryClient } from "../utils/api/clients/discovery.ts";
import { libraryLookupBatchQuery } from "../utils/api/endpoints/library.ts";
import { formatCompactNumber } from "../utils/numberFormat.ts";
import { ArtistCard, ViewAllCard, type DiscoverCardArtist } from "./DiscoverCards";

type TrendingArtist = NonNullable<
  InferResponseType<typeof discoveryClient.trending.$get, 200>["artists"]
>[number];

const getLibraryLink = (artist: DiscoverCardArtist) => {
  const to = resolveLibraryArtistPath({ mbid: artist.id, name: artist.name });
  return to ? { to } : null;
};

export function TrendingArtistsRail({
  title,
  artists,
  viewAllTo,
}: {
  title: string;
  artists: TrendingArtist[];
  viewAllTo?: string;
}) {
  const mbids = useMemo(
    () => artists.flatMap((artist) => (artist.mbid ? [artist.mbid] : [])),
    [artists],
  );
  const { data: libraryLookup = {} } = useQuery({
    ...libraryLookupBatchQuery(mbids),
    enabled: mbids.length > 0,
  });
  if (artists.length === 0) return null;
  return (
    <DiscoverRail title={title} viewAllTo={viewAllTo}>
      {artists.map((artist) => (
        <div key={artist.key} className="artist-discover-shelf-card">
          <ArtistCard
            artist={{
              id: artist.mbid,
              name: artist.name,
              imageUrl: artist.imageUrl,
              libraryPath: artist.mbid ? null : resolveArtistPath({ name: artist.name }),
              metaText: "",
              subtitle: artist.fans
                ? `No. ${artist.position} · ${formatCompactNumber(artist.fans)} fans`
                : `No. ${artist.position}`,
            }}
            isInLibrary={Boolean(artist.mbid && libraryLookup[artist.mbid])}
            getLibraryLink={getLibraryLink}
          />
        </div>
      ))}
      {viewAllTo ? (
        <div className="artist-discover-shelf-card">
          <ViewAllCard to={viewAllTo} />
        </div>
      ) : null}
    </DiscoverRail>
  );
}
