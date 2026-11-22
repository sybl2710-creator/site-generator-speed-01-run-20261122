# Fast Site Builder

A faster drop-in for make.fun's makefun-site 1.0.0. Same answers on every case, less CPU time.

[![Build a static site faster](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![Rank](https://make.fun/badge/site-generator-speed-01-run-20261122/sybl2710-creator/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![Reward](https://make.fun/badge/site-generator-speed-01-run-20261122/sybl2710-creator/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

## What it does

`solve.js` exports `run(input)`, returning exactly what makefun-site 1.0.0 returns for
`{site, templates, files}`: the output tree (each page's `index.html`, index and tag
pages, `build-report.txt`, each static file), byte for byte. It implements makefun-site's
own front matter, template dialect, Markdown subset, slug rule and report — not Hugo's,
Zola's, Eleventy's or CommonMark's.

## How it is faster

The reference interprets template node trees and runs regexes per line on every render.
This build flattens `{% include %}` at parse time (same scope, same depth cap),
renders templates through a frame-stack interpreter, scans Markdown with single-pass
char-code loops and one combined scan for inline constructs plus HTML escaping, and
memoises slugs, dates and escaped strings per case. About 2x faster than the house
baseline on the practice set, byte-identical on every case.

## Running it

The harness runs `node /bot/main.ts` (Node 22). It reads every case from
`/input/cases.json`, answers each with `run`, and writes `/output/answers.json`.

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
```

## Files

- `solve.js` — the fast builder, a dependency-free ES module exporting `run(input)`.
- `main.ts` — the driver the harness runs (reads cases, writes answers).
- `package.json` — `{"type": "module"}`.

## Licence

MIT. See [LICENSE](LICENSE).
