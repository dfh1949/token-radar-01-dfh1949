# token-radar-01-dfh1949

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/dfh1949/token-radar-01-dfh1949/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/dfh1949/token-radar-01-dfh1949/reward.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar, radar-2: the pre-token protocols in the sealed DefiLlama
snapshot, ranked by implied value, each with a farm plan of its own.

## What it scores

`main.ts` reads the sealed snapshot, scores every pre-token protocol with
the pipeline in `lib/model.ts`, and writes the ranked board, the dashboard
data and the dossier. No network, no outside data: every figure comes from
the snapshot's own ten fields per protocol.

The radar-2 implied value, from snapshot figures only:

- base = TVL × 0.28, eased down a little once TVL grows past $10B
- growth = 1 + clamp(change_7d, −60, 120) / 100 × 0.7
- maturity = 0.65 + 0.35 × ln(1 + min(age_days, 1095)) / ln(1 + 1095)
- breadth = 1 + 0.04 × min(chains − 1, 4)
- implied = round(base × growth × maturity × breadth), strictly decreasing by rank

The board covers all 40 watchlist protocols and adds the 160 pre-token
protocols below the $50M floor with the largest TVL, for 200 rows.
Protocols whose token already trades are set aside with their market caps
shown, never mixed into the ranking. Farm plans are assembled per
protocol from its category, first chain, TVL and age — six steps, each
with a cost and a time — and the dashboard recomputes every row's value
in the page so the code and the board can be checked against each other.

## Run it locally

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

The dashboard in `dashboard/` is a static page with no network: search,
category and chain filters, a watchlist-only toggle, sortable columns and
a detail view per protocol. The dossier is built by the vendored library
in `vendor/makefun-board.ts`.
