import { Fragment } from "react";
import RouteLink from "../../components/RouteLink";
import { formatArtistCredit, type ArtistCredit } from "../../../../lib/artistCredit.ts";

export function trackArtistCredit(
  credit: ArtistCredit | null | undefined,
  albumArtist: { name: string; mbid: string | null },
) {
  const text = credit?.length ? formatArtistCredit(credit) : "";
  if (!credit || !text || text.toLowerCase() === albumArtist.name.toLowerCase()) return null;
  if (albumArtist.mbid && credit.every(({ mbid }) => mbid === albumArtist.mbid)) return null;
  return credit;
}

export function ArtistCreditLinks({ credit }: { credit: ArtistCredit }) {
  return (
    <>
      {credit.map(({ name, mbid, joinPhrase }, index) => (
        <Fragment key={index}>
          {mbid ? (
            <RouteLink to={`/artist/${encodeURIComponent(mbid)}`} state={{ artistName: name }}>
              {name}
            </RouteLink>
          ) : (
            name
          )}
          {joinPhrase}
        </Fragment>
      ))}
    </>
  );
}
