# Library performance results

Use the Node version in `.nvmrc`. Run the full-size guard on a dedicated
runner. On shared development hosts, use a smaller seed for correctness
checks and enforce memory, CPU, and time limits. Smaller runs do not establish
the 350,000-track latency budgets.

Run three sequential passes with the same options and no other CPU-heavy
checks running:

```sh
npm run perf:library -- --check --tracks 350000 --repeats 5 --output /tmp/aurral-library-run-1.json
npm run perf:library -- --check --tracks 350000 --repeats 5 --output /tmp/aurral-library-run-2.json
npm run perf:library -- --check --tracks 350000 --repeats 5 --output /tmp/aurral-library-run-3.json
```

Each pass creates and removes its own synthetic database. Each bounded read
uses five fresh processes. Cold page samples clear the canonical read caches,
while warm page samples reuse them. Both groups reuse the SQLite connection,
and the operating system's file cache can stay warm. With five samples, p95 is
the slowest sample.

The guard requires broad `search3` median latency below 300 ms, one-song
`starred` median latency below 75 ms, and `getGenres` median latency below
75 ms after a scan. Target reads must complete with finite
statistics and nonempty results. Existing checks also require warm page p95
below 250 ms, cold page and selected read p95 below 750 ms, responses below
2 MiB, and request RSS growth below 64 MiB. Lidarr call-count and bounded
artist-projection checks remain part of the guard.

After the page reads, the targeted-scan probe adds one tagged FLAC metadata
fixture to the isolated Lidarr root. Each sample changes its title and forces
a rescan. The guard requires exactly one successfully indexed file, a matching
search result for the new title, no result for the previous title, and scan p95
below 750 ms. Scoped path lookup p95 must stay below 20 ms.

Compare all three runs against baseline runs with the same runtime, seed size,
and options. If timings vary enough to obscure the change, check host load and
repeat the comparison. Do not lower the budgets to accommodate a noisy run.
These results measure synthetic library reads, not browser or production
latency. The Lidarr probe uses a mock client and does not contact a service.

Each JSON result includes seed size, timings, response size, memory samples,
query plans, and individual check outcomes. Keep investigation results outside
the worktree. Timestamped files in this directory stay untracked.
