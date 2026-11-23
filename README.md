# token-radar-01-dfh1949

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/dfh1949/token-radar-01-dfh1949/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/dfh1949/token-radar-01-dfh1949/reward.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar, radar-2: the pre-token protocols in the sealed DefiLlama snapshot,
ranked by implied value, with a farm plan for each one.

## How it works

`main.ts` reads the sealed snapshot, scores every pre-token protocol with the
model in `lib/model.ts`, and writes the ranked board, the dashboard data and
the dossier. No network, no outside data: every figure comes from the snapshot.

Radar-2 implied value, from snapshot figures only:

- base = TVL x 0.28, with a small scale-down for very large TVL
- growth = 1 + clamp(change_7d, -60, 120) / 100 x 0.7
- maturity = 0.65 + 0.35 x ln(1 + min(age_days, 1095)) / ln(1 + 1095)
- breadth = 1 + 0.04 x min(chains - 1, 4)
- implied = round(base x growth x maturity x breadth), strictly decreasing by rank

The board covers all 40 watchlist protocols and adds 160 pre-token protocols
below the $50M floor, by TVL, for 200 rows. Live-token protocols are set aside
with their market caps shown, never mixed into the ranking.

## Run it locally

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

The dashboard in `dashboard/` is a static page with no network: search, filter
by category and chain, a watchlist-only toggle, sortable columns, and a detail
view per protocol showing the full implied-value breakdown and its farm plan.
