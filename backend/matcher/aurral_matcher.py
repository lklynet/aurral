#!/usr/bin/env python3
"""Small JSON bridge for the pinned beets matching primitives.

The bridge deliberately does not decide whether a result should be accepted.
It only exposes beets' track distance, item assignment, and a health probe.
All Aurral policy stays in the Node matcher.
"""

from __future__ import annotations

import json
import sys

PROTOCOL_VERSION = 1
BEETS_MATCH_CONFIG = {
    "track_length_grace": 10,
    "track_length_max": 30,
}


class MatcherError(Exception):
    """An input or protocol error that can be returned to Node."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def emit(payload: dict) -> None:
    json.dump(payload, sys.stdout, separators=(",", ":"), ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()


def text(value) -> str | None:
    value = str(value).strip() if value is not None else ""
    return value or None


def number(value, positive: bool = False):
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    if positive and value <= 0:
        return None
    return value


def duration_seconds(payload: dict) -> float | None:
    for key in ("durationMs", "duration_ms", "durationSec"):
        value = number(payload.get(key), positive=True)
        if value is not None:
            return value / 1000 if key != "durationSec" else value
    return None


def integer(value) -> int | None:
    value = number(value, positive=True)
    return int(value) if value is not None else None


def artist(payload: dict) -> str | None:
    for key in ("artistName", "artist"):
        value = text(payload.get(key))
        if value:
            return value
    names = [text(value) for value in payload.get("artists", [])]
    names = [value for value in names if value]
    return "; ".join(names) if names else None


def build_item(payload: dict, candidate: dict | None = None):
    from beets.library import Item

    fields = {"title": text(payload.get("title") or payload.get("trackName")) or ""}
    fields["artist"] = artist(payload) or ""
    if (duration := duration_seconds(payload)) is not None:
        fields["length"] = duration
    if (track := integer(payload.get("trackNumber") or payload.get("track"))) is not None:
        fields["track"] = track
    if (disc := integer(payload.get("discNumber") or payload.get("disc"))) is not None:
        fields["disc"] = disc
    item = Item(**fields)
    expected_mbid = text(payload.get("recordingMbid") or payload.get("trackMbid"))
    candidate_mbid = text((candidate or {}).get("recordingMbid") or (candidate or {}).get("trackMbid"))
    if expected_mbid and candidate_mbid:
        item.mb_trackid = expected_mbid
    return item


def build_track_info(payload: dict):
    from beets.autotag import TrackInfo

    fields = {
        "title": text(payload.get("title")) or "",
        "artist": artist(payload) or "",
        "data_source": text(payload.get("source")) or "aurral",
    }
    if duration := duration_seconds(payload):
        fields["length"] = duration
    if (track := integer(payload.get("trackNumber"))) is not None:
        fields["index"] = track
    if (disc := integer(payload.get("discNumber"))) is not None:
        fields["medium"] = disc
    mbid = text(payload.get("recordingMbid") or payload.get("trackMbid"))
    if mbid:
        fields["track_id"] = mbid
    return TrackInfo(**fields)


def distance_evidence(distance) -> dict:
    return {key: round(distance[key], 6) for key in distance.keys()}


def configure_beets() -> None:
    from beets import config

    for key, value in BEETS_MATCH_CONFIG.items():
        config["match"][key].set(value)


def operation_health(_: dict) -> dict:
    import beets

    return {
        "ok": True,
        "operation": "health",
        "beetsVersion": beets.__version__,
    }


def operation_track_distance(payload: dict) -> dict:
    from beets.autotag import track_distance

    expected = payload.get("expected")
    candidates = payload.get("candidates")
    if not isinstance(expected, dict) or not isinstance(candidates, list):
        raise MatcherError(
            "invalid_request",
            "track_distance requires an expected track object and candidates list",
        )
    if not text(expected.get("trackName")):
        raise MatcherError("invalid_request", "expected trackName is required")

    matches = []
    for index, candidate in enumerate(candidates):
        if not isinstance(candidate, dict):
            raise MatcherError("invalid_request", f"candidate {index} is not an object")
        if not text(candidate.get("title")):
            matches.append({"candidateIndex": index, "skipped": True, "reason": "missing-title"})
            continue
        distance = track_distance(
            build_item(expected, candidate),
            build_track_info(candidate),
            incl_artist=True,
        )
        matches.append(
            {
                "candidateIndex": index,
                "distance": round(distance.distance, 6),
                "maxDistance": round(distance.max_distance, 6),
                "rawDistance": round(distance.raw_distance, 6),
                "penalties": distance_evidence(distance),
            }
        )

    return {
        "ok": True,
        "operation": "track_distance",
        "matches": matches,
    }


def operation_assign_items(payload: dict) -> dict:
    from beets.autotag import assign_items

    files = payload.get("files")
    release_tracks = payload.get("releaseTracks")
    if not isinstance(files, list) or not isinstance(release_tracks, list) or not files or not release_tracks:
        raise MatcherError(
            "invalid_request",
            "assign_items requires non-empty files and releaseTracks lists",
        )

    items = []
    for index, entry in enumerate(files):
        if not isinstance(entry, dict) or not text(entry.get("title")):
            raise MatcherError("invalid_request", f"file {index} needs a title")
        items.append(build_item(entry))
    tracks = []
    for index, entry in enumerate(release_tracks):
        if not isinstance(entry, dict) or not text(entry.get("title")):
            raise MatcherError("invalid_request", f"releaseTrack {index} needs a title")
        tracks.append(build_track_info(entry))

    pairs, extra_items, extra_tracks = assign_items(items, tracks)
    item_index = {id(item): index for index, item in enumerate(items)}
    track_index = {id(track): index for index, track in enumerate(tracks)}
    assignments = []
    for item, track in pairs:
        assignments.append(
            {
                "fileIndex": item_index[id(item)],
                "releaseTrackIndex": track_index[id(track)],
            }
        )
    assignments.sort(key=lambda entry: entry["fileIndex"])
    return {
        "ok": True,
        "operation": "assign_items",
        "assignments": assignments,
        "unassignedFileIndexes": sorted(item_index[id(item)] for item in extra_items),
        "unassignedReleaseTrackIndexes": sorted(track_index[id(track)] for track in extra_tracks),
    }


OPERATIONS = {
    "health": operation_health,
    "track_distance": operation_track_distance,
    "assign_items": operation_assign_items,
}


def handle_request(request: dict) -> dict:
    if not isinstance(request, dict):
        raise MatcherError("invalid_request", "request must be a JSON object")
    if request.get("protocol", PROTOCOL_VERSION) != PROTOCOL_VERSION:
        raise MatcherError("invalid_request", "unsupported protocol version")
    handler = OPERATIONS.get(request.get("operation"))
    if handler is None:
        raise MatcherError("unknown_operation", f"unknown operation {request.get('operation')!r}")
    response = handler(request)
    response["protocol"] = PROTOCOL_VERSION
    return response


def main() -> int:
    try:
        request = json.load(sys.stdin)
    except ValueError as error:
        emit({"ok": False, "error": {"code": "invalid_request", "message": f"invalid JSON: {error}"}})
        return 2

    try:
        import beets  # noqa: F401
    except ImportError as error:
        print(f"beets unavailable: {error}", file=sys.stderr, flush=True)
        emit({
            "ok": False,
            "error": {
                "code": "beets_unavailable",
                "message": "beets is not installed for this Python interpreter",
            },
        })
        return 3

    try:
        configure_beets()
        emit(handle_request(request))
        return 0
    except MatcherError as error:
        emit({"ok": False, "error": {"code": error.code, "message": error.message}})
        return 2
    except Exception as error:  # pragma: no cover - defensive process boundary
        print(f"internal matcher error: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
        emit({
            "ok": False,
            "error": {"code": "internal_error", "message": f"{type(error).__name__}: {error}"},
        })
        return 4


if __name__ == "__main__":
    sys.exit(main())
