# Library performance results

Use the Node version in `.nvmrc`. Run three sequential passes with the same
options and no other CPU-heavy checks running:

```sh
npm run perf:library -- --check --tracks 350000 --repeats 5 --output /tmp/aurral-library-run-1.json
npm run perf:library -- --check --tracks 350000 --repeats 5 --output /tmp/aurral-library-run-2.json
npm run perf:library -- --check --tracks 350000 --repeats 5 --output /tmp/aurral-library-run-3.json
```

Each pass creates and removes its own synthetic database. Each bounded read
uses five fresh processes. Cold page samples also use fresh processes, while
warm page samples reuse a process. The operating system's file cache can stay
warm across both groups. With five samples, p95 is the slowest sample.

The guard requires broad `search3` median latency below 300 ms and one-song
`starred` median latency below 75 ms. Target reads must complete with finite
statistics and nonempty results. Existing checks also require warm page p95
below 250 ms, cold page and selected read p95 below 750 ms, responses below
2 MiB, and request RSS growth below 64 MiB. Lidarr call-count and bounded
artist-projection checks remain part of the guard.

Compare all three runs against baseline runs with the same runtime, seed size,
and options. If timings vary enough to obscure the change, check host load and
repeat the comparison. Do not lower the budgets to accommodate a noisy run.
These results measure synthetic library reads, not browser or production
latency. The Lidarr probe uses a mock client and does not contact a service.

Each JSON result includes seed size, timings, response size, memory samples,
query plans, and individual check outcomes. Keep investigation results outside
the worktree. Timestamped files in this directory stay untracked.
