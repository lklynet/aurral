import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "../../../components/icons";
import { artistShowsQueryOptions } from "../../../utils/api/endpoints/artists.ts";
import {
  formatDistance,
  formatShowTime,
  getEventUrl,
  parseShowDate,
} from "../../../utils/shows.ts";
import type { getArtistShows } from "../../../../../backend/services/nearbyShowsService.ts";

const COLLAPSED_LIMIT = 6;
const YEAR_AHEAD_MS = 365 * 86_400_000;

type ArtistShow = Awaited<ReturnType<typeof getArtistShows>>[number];

function TourDate({ show }: { show: ArtistShow }) {
  const day = parseShowDate(show.date) || parseShowDate(show.dateTime);
  const farAhead = day ? day.getTime() - Date.now() >= YEAR_AHEAD_MS : false;
  const month = day?.toLocaleDateString(undefined, {
    month: "short",
    ...(farAhead && { year: "numeric" }),
  });
  const when = [day?.toLocaleDateString(undefined, { weekday: "short" }), formatShowTime(show.time)]
    .filter(Boolean)
    .join(" ");
  const place = [show.city, show.region].filter(Boolean).join(", ") || show.venueName || "";
  const venue = [when, show.city ? show.venueName : null].filter(Boolean).join(" · ");
  const distance = formatDistance(show.distance);
  const url = getEventUrl(show.url);
  const content = (
    <>
      <span className="artist-gig__date">
        <span className="artist-gig__month">{month}</span>
        <span className="artist-gig__day">{day?.getDate()}</span>
      </span>
      <span className="artist-gig__city">{place}</span>
      <span className="artist-gig__venue">{venue}</span>
      {distance ? (
        <span className={show.near ? "artist-gig__near" : "artist-gig__distance"}>
          {show.near ? `Near you · ${distance}` : distance}
        </span>
      ) : null}
      {url ? (
        <span className="artist-gig__tickets">
          <span>Tickets</span>
          <ExternalLink aria-hidden="true" />
        </span>
      ) : null}
    </>
  );
  const className = `artist-gig${distance ? "" : " is-unlocated"}`;
  return url ? (
    <a className={className} href={url} target="_blank" rel="noreferrer">
      {content}
    </a>
  ) : (
    <div className={className}>{content}</div>
  );
}

export function ArtistDetailsTour({ mbid, artistName }: { mbid: string; artistName: string }) {
  const headingId = useId();
  const { data } = useQuery(artistShowsQueryOptions(mbid, artistName));
  const [expanded, setExpanded] = useState(false);
  const shows = data?.shows ?? [];
  if (shows.length === 0) return null;
  const visible = expanded ? shows : shows.slice(0, COLLAPSED_LIMIT);

  return (
    <section className="artist-section" aria-labelledby={headingId}>
      <div className="artist-section-head">
        <h2 className="artist-section-title" id={headingId}>
          On tour
        </h2>
      </div>
      <ul
        className={`artist-tour${expanded ? " is-expanded" : ""}`}
        style={{ "--artist-tour-rows": Math.ceil(visible.length / 2) }}
      >
        {visible.map((show) => (
          <li key={show.id}>
            <TourDate show={show} />
          </li>
        ))}
      </ul>
      {shows.length > 3 ? (
        <button
          type="button"
          className={`section-show-all artist-tour__more${shows.length > COLLAPSED_LIMIT ? "" : " is-phone-only"}`}
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show fewer dates" : `Show all ${shows.length} dates`}
        </button>
      ) : null}
    </section>
  );
}
