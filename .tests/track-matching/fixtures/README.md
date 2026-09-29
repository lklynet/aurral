# Track matching fixtures

These cases come from the deadwax evaluation corpus at commit `417e4d7` in
`lklynet/deadwax`. The source files are `tests/evaluation/cases.jsonl`,
`hard-cases.jsonl`, `r22/session-cases.jsonl`, and
`r22/source-releases.jsonl`. The MusicBrainz sample metadata is CC0 1.0.
Provider paths, durations, and damaged tags in the constructed cases are
fabricated. Each case retains its source and license in `provenance`.

The development and acceptance files contain complete cases. Album and loose
track cases derived from a session name that session in `generatedFrom`.
Cases and release records were grouped by every recording and release MBID
before assignment to a split. A SHA-256 of each group's sorted identities
assigned the whole group to one split. Do not tune matching rules against
`acceptance.jsonl`.

`source-releases.jsonl` provides release tracklists for the session cases.
The loader and report functions live in `../fixture-corpus.js`.
`correctIds` records adjudicated ground truth. `contradictedIds` records only
explicit recording-ID conflicts visible in candidate metadata or downloaded
file tags. A wrong match with no visible conflict still counts under `wrong`.
