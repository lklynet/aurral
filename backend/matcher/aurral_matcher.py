#!/usr/bin/env python3
"""Aurral internal track matcher.

Bridges Aurral's Node backend to the beets autotagging engine over a JSON
stdin/stdout protocol. One request per invocation; stdout carries exactly one
JSON document and all diagnostics go to stderr.

beets is an implementation detail: this process never reads a user beets
config, never touches a beets library database, and never performs network
lookups. All scoring is local (beets track_distance / assign_items).

The division of labor is deliberate: beets computes music-record distance;
Aurral owns every final decision. This module therefore reports distances,
penalty evidence, and the configured thresholds — never recommendations —
and imports no private beets symbols.
"""

from __future__ import annotations

import json
import sys

PROTOCOL_VERSION = 1

# Mirrors beets defaults for the knobs the matcher relies on. Pinned so the
# matcher behaves identically regardless of the beets version's defaults.
# These values are also echoed to callers so the Node decision engine can
# apply recommendation policy against exactly the numbers beets scored with.
MATCH_CONFIG = {
    "strong_rec_thresh": 0.04,
    "medium_rec_thresh": 0.25,
    "rec_gap_thresh": 0.25,
    "track_length_grace": 10,
    "track_length_max": 30,
    "distance_weights": {
        "data_source": 2.0,
        "artist": 3.0,
        "album": 3.0,
        "media": 1.0,
        "mediums": 1.0,
        "year": 1.0,
        "country": 0.5,
        "label": 0.5,
        "catalognum": 0.5,
        "albumdisambig": 0.5,
        "album_id": 5.0,
        "tracks": 2.0,
        "missing_tracks": 0.9,
        "unmatched_tracks": 0.6,
        "track_title": 3.0,
        "track_artist": 2.0,
        "track_index": 1.0,
        "track_length": 2.0,
        "track_id": 5.0,
        "medium": 1.0,
    },
}


class MatcherError(Exception):
    """Structured error reported to the caller as a JSON document."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def emit(payload: dict) -> None:
    json.dump(payload, sys.stdout, separators=(",", ":"), ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()


def configure_beets() -> None:
    """Apply the deterministic Aurral matcher configuration.

    Must run before the first Distance evaluation: beets caches the distance
    weights and track-length knobs on first access.
    """
    from beets import config

    for key, value in MATCH_CONFIG.items():
        config["match"][key].set(value)


def distance_thresholds() -> dict:
    return {
        "strongRecThresh": MATCH_CONFIG["strong_rec_thresh"],
        "mediumRecThresh": MATCH_CONFIG["medium_rec_thresh"],
        "recGapThresh": MATCH_CONFIG["rec_gap_thresh"],
    }


def text_or_none(value) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def positive_int_or_none(value) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def positive_float_or_none(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def read_duration_seconds(payload: dict) -> float | None:
    for key in ("durationMs", "duration_ms", "durationSec"):
        value = positive_float_or_none(payload.get(key))
        if value is None:
            continue
        if key.endswith("Sec"):
            return value
        return value / 1000.0
    return None


def read_artist(payload: dict) -> str | None:
    for key in ("artistName", "artist"):
        text = text_or_none(payload.get(key))
        if text:
            return text
    artists = payload.get("artists")
    if isinstance(artists, list):
        names = [text_or_none(entry) for entry in artists]
        names = [name for name in names if name]
        if names:
            return "; ".join(names)
    return None


def build_item(expected: dict):
    from beets.library import Item

    fields = {
        "title": text_or_none(expected.get("trackName")) or "",
        "artist": read_artist(expected) or "",
    }
    for key, target in (("albumName", "album"), ("album", "album")):
        text = text_or_none(expected.get(key))
        if text:
            fields[target] = text
            break
    duration = read_duration_seconds(expected)
    if duration is not None:
        fields["length"] = duration
    track_number = positive_int_or_none(expected.get("trackNumber"))
    if track_number is not None:
        fields["track"] = track_number
    disc_number = positive_int_or_none(expected.get("discNumber"))
    if disc_number is not None:
        fields["disc"] = disc_number
    year = positive_int_or_none(expected.get("releaseYear"))
    if year is not None:
        fields["year"] = year
    return Item(**fields)


def build_track_info(candidate: dict):
    from beets.autotag import TrackInfo

    fields = {
        "title": text_or_none(candidate.get("title")) or "",
        "artist": read_artist(candidate) or "",
        "data_source": text_or_none(candidate.get("source")) or "aurral",
    }
    album = text_or_none(candidate.get("album"))
    if album:
        fields["album"] = album
    duration = read_duration_seconds(candidate)
    if duration is not None:
        fields["length"] = duration
    track_number = positive_int_or_none(candidate.get("trackNumber"))
    if track_number is not None:
        fields["index"] = track_number
    disc_number = positive_int_or_none(candidate.get("discNumber"))
    if disc_number is not None:
        fields["medium"] = disc_number
    year = positive_int_or_none(candidate.get("year"))
    if year is not None:
        fields["year"] = year
    track_id = text_or_none(candidate.get("recordingMbid") or candidate.get("trackMbid"))
    if track_id:
        fields["track_id"] = track_id
    return TrackInfo(**fields)


def distance_evidence(distance) -> dict:
    penalties = {}
    for key in distance.keys():
        penalties[key] = round(distance[key], 6)
    return penalties


def build_item_for_candidate(expected: dict, candidate: dict):
    """Item copy whose MBID only competes when the candidate carries one.

    beets penalizes a present-vs-absent track_id pair as a full mismatch.
    Candidate MBIDs from most download sources simply do not exist, so an
    expected recording MBID must not veto them; Aurral compares identifiers
    in its own identity layer instead.
    """
    item = build_item(expected)
    candidate_mbid = text_or_none(candidate.get("recordingMbid") or candidate.get("trackMbid"))
    expected_mbid = text_or_none(expected.get("recordingMbid") or expected.get("trackMbid"))
    if expected_mbid and candidate_mbid:
        item.mb_trackid = expected_mbid
    return item


def operation_health(payload: dict) -> dict:
    import beets

    return {
        "ok": True,
        "operation": "health",
        "beetsVersion": beets.__version__,
        "thresholds": distance_thresholds(),
    }


def operation_rank_tracks(payload: dict) -> dict:
    from beets.autotag import track_distance

    expected = payload.get("expected")
    if not isinstance(expected, dict):
        raise MatcherError("invalid_request", "rank_tracks requires an expected track object")
    candidates = payload.get("candidates")
    if not isinstance(candidates, list):
        raise MatcherError("invalid_request", "rank_tracks requires a candidates list")
    if not text_or_none(expected.get("trackName")):
        raise MatcherError("invalid_request", "expected trackName is required")

    matches = []
    for index, candidate in enumerate(candidates):
        if not isinstance(candidate, dict):
            raise MatcherError("invalid_request", f"candidate {index} is not an object")
        title = text_or_none(candidate.get("title"))
        if not title:
            matches.append(
                {
                    "candidateIndex": index,
                    "skipped": True,
                    "reason": "missing-title",
                }
            )
            continue
        item = build_item_for_candidate(expected, candidate)
        track_info = build_track_info(candidate)
        distance = track_distance(item, track_info, incl_artist=True)
        matches.append(
            {
                "candidateIndex": index,
                "distance": round(distance.distance, 6),
                "maxDistance": round(distance.max_distance, 6),
                "rawDistance": round(distance.raw_distance, 6),
                "penalties": distance_evidence(distance),
            }
        )

    scored = sorted(
        (match for match in matches if not match.get("skipped")),
        key=lambda match: (match["distance"], match["candidateIndex"]),
    )
    best = scored[0] if scored else None
    runner_up = scored[1] if len(scored) >= 2 else None

    return {
        "ok": True,
        "operation": "rank_tracks",
        "matches": matches,
        "bestCandidateIndex": best["candidateIndex"] if best else None,
        "runnerUpCandidateIndex": runner_up["candidateIndex"] if runner_up else None,
        "gap": round(runner_up["distance"] - best["distance"], 6) if best and runner_up else None,
        "thresholds": distance_thresholds(),
    }


def operation_match_release(payload: dict) -> dict:
    from beets.autotag import assign_items, track_distance

    files = payload.get("files")
    release_tracks = payload.get("releaseTracks")
    if not isinstance(files, list) or not isinstance(release_tracks, list):
        raise MatcherError(
            "invalid_request",
            "match_release requires files and releaseTracks lists",
        )
    if not files or not release_tracks:
        raise MatcherError("invalid_request", "match_release requires non-empty lists")

    items = []
    for index, entry in enumerate(files):
        if not isinstance(entry, dict) or not text_or_none(entry.get("title")):
            raise MatcherError("invalid_request", f"file {index} needs a title")
        items.append(build_item(entry))
    tracks = []
    for index, entry in enumerate(release_tracks):
        if not isinstance(entry, dict) or not text_or_none(entry.get("title")):
            raise MatcherError("invalid_request", f"releaseTrack {index} needs a title")
        tracks.append(build_track_info(entry))

    pairs, extra_items, extra_tracks = assign_items(items, tracks)
    item_index = {id(item): index for index, item in enumerate(items)}
    track_index = {id(track): index for index, track in enumerate(tracks)}
    assignments = []
    for item, track in pairs:
        distance = track_distance(item, track, incl_artist=True)
        assignments.append(
            {
                "fileIndex": item_index[id(item)],
                "releaseTrackIndex": track_index[id(track)],
                "distance": round(distance.distance, 6),
                "penalties": distance_evidence(distance),
            }
        )
    assignments.sort(key=lambda entry: entry["fileIndex"])
    return {
        "ok": True,
        "operation": "match_release",
        "assignments": assignments,
        "unassignedFileIndexes": sorted(item_index[id(item)] for item in extra_items),
        "unassignedReleaseTrackIndexes": sorted(
            track_index[id(track)] for track in extra_tracks
        ),
    }


OPERATIONS = {
    "health": operation_health,
    "rank_tracks": operation_rank_tracks,
    "match_release": operation_match_release,
}


def handle_request(request: dict) -> dict:
    if not isinstance(request, dict):
        raise MatcherError("invalid_request", "request must be a JSON object")
    protocol = request.get("protocol", PROTOCOL_VERSION)
    if protocol != PROTOCOL_VERSION:
        raise MatcherError(
            "invalid_request",
            f"unsupported protocol version {protocol!r}",
        )
    operation = request.get("operation")
    handler = OPERATIONS.get(operation)
    if handler is None:
        raise MatcherError("unknown_operation", f"unknown operation {operation!r}")
    response = handler(request)
    response["protocol"] = PROTOCOL_VERSION
    return response


def main() -> int:
    try:
        request = json.load(sys.stdin)
    except ValueError as error:
        emit(
            {
                "ok": False,
                "error": {"code": "invalid_request", "message": f"invalid JSON: {error}"},
            }
        )
        return 2

    try:
        import beets  # noqa: F401
    except ImportError as error:
        log(f"beets unavailable: {error}")
        emit(
            {
                "ok": False,
                "error": {
                    "code": "beets_unavailable",
                    "message": "beets is not installed for this Python interpreter",
                },
            }
        )
        return 3

    try:
        configure_beets()
        response = handle_request(request)
    except MatcherError as error:
        emit({"ok": False, "error": {"code": error.code, "message": error.message}})
        return 2
    except Exception as error:  # pragma: no cover - defensive
        log(f"internal matcher error: {type(error).__name__}: {error}")
        emit(
            {
                "ok": False,
                "error": {
                    "code": "internal_error",
                    "message": f"{type(error).__name__}: {error}",
                },
            }
        )
        return 4

    emit(response)
    return 0


if __name__ == "__main__":
    sys.exit(main())
