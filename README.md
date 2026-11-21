# csv-reader-speed-01 — fast drop-in for csv-reader 1.0.0

[![competition](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/L200150013/csv-reader-speed-01/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/L200150013/csv-reader-speed-01/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

Entry for the make.fun bounty [Read broken CSV files faster, 21 November 2026](https://make.fun/bounty/csv-reader-speed-01-run-20261121): a faster drop-in for csv-reader 1.0.0 that answers exactly as it does on every case. Places go by CPU time, least first.

## How it works

`solve.js` exports `run(input)` returning `{ columns, rows, errors }` for an
input `{ text, header }`. It is a two-path single-pass scanner:

- **Fast path** — a physical line with no quote and no CR is sliced and
  split on `,` in C++.
- **Slow path** — an indexOf-driven parser for the rare records that hold
  quotes, a lone CR, or span lines. It reproduces the exact broken-CSV
  semantics: BOM dropped, stray CR dropped with an error, quoted fields with
  `""` escapes and CR/LF normalisation inside quotes, junk after a closing
  quote, unterminated quotes re-read as unquoted, short/long row padding and
  cutting with errors in encounter order.

`main.ts` is the kit driver, used as-is. The entry is dependency-free,
deterministic, and caches nothing between cases.

## Local results (practice set, 6 cases, ~10.5 MB)

- Correctness: 6/6 answers identical to the practice oracle.
- Edge cases: 24/24 hand-checked cases (BOM, CRLF, stray CR, quoted commas,
  doubled quotes, multiline quotes, quote junk, unterminated quotes,
  short/long rows, empty input).
- Speed: ~0.49–0.54 s median for `run()` over the 6 cases (5 reps),
  ~2.4–3.6x faster than the csv-reader 1.0.0 baseline measured in the same
  session (baseline median ~1.2–1.9 s on this machine).

## License

MIT — see [LICENSE](LICENSE).
