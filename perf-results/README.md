# Library performance results

Run the synthetic 350,000-track benchmark with:

```sh
npm run perf:library -- --check
```

Each run writes a JSON file containing seed size, SQLite page timings, full
canonical and legacy read timings, JSON size, memory samples, and the Lidarr
indexer call probe. Pass `--output perf-results/baseline.json` when a result
should be kept under a stable name. Timestamped result files stay untracked.
