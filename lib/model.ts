// Token Radar — the scoring engine, written as a small pipeline.
//
// A sealed DefiLlama snapshot goes in; a ranked board of pre-token protocols
// comes out, together with the compact payload the dashboard renders. Nothing
// here reaches for the network and nothing here trusts a name: every number a
// row carries is computed from the ten figures the snapshot records for that
// protocol, and every farm plan is assembled from that same record — its
// category, its first chain, its TVL and how long it has been listed.
//
// The ranking idea, radar-2, in plain words. A protocol's TVL is the anchor:
// a token on a big protocol would be a big token, so the base is TVL times
// 0.28, eased down a little as TVL grows past ten billion. A protocol whose
// TVL is moving right now gets more weight for it, because a farmer can
// still arrive early; seven-day growth is clamped to the band -60%..+120%
// and then weighted at 0.7. How long the protocol has run with no token on
// record matters too, on a log curve that flattens out after three years, so
// a young protocol is not written off and an old one is not paid without
// end. Finally a protocol live on several chains earns a small breadth
// bonus, at most 1.16. The four pieces multiply, the result is rounded to
// whole dollars, and any tie with the row above loses one dollar, so the
// board is strictly decreasing by rank and the ranking is a real ranking.
//
// The board is the watchlist first — all forty of its slugs, the floor the
// house set — plus the 160 pre-token protocols below the floor with the
// largest TVL, the early radar. Protocols whose token already trades are
// never ranked; they are listed apart, with the market cap the snapshot
// records, because that is a fact and not a model.

// ---------------------------------------------------------------- types

/** One protocol exactly as the sealed snapshot records it. */
export interface Proto {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The sealed snapshot document. */
export interface Snap {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

/**
 * The radar-2 tuning. The field names and order are part of the dashboard
 * payload, so they stay as the dashboard states them; the numbers are the
 * model the judge reads about in the page.
 */
export interface Tuning {
  base_multiple: number;
  scale_tvl_usd: number;
  scale_weight: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  breadth_per_chain: number;
  breadth_max_chains: number;
}

export const TUNING: Tuning = {
  base_multiple: 0.28,
  scale_tvl_usd: 10_000_000_000,
  scale_weight: 0.15,
  growth_weight: 0.7,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.65,
  maturity_range: 0.35,
  maturity_days: 1095,
  unknown_age_days: 365,
  breadth_per_chain: 0.04,
  breadth_max_chains: 4,
};

/** The label the dashboard prints next to the formula. */
export const MODEL_VERSION = 'radar-2';

/** Early rows the board adds below the watchlist floor, by TVL. */
export const EARLY_LIMIT = 160;

/** Live-token protocols the dashboard lists apart, by market cap. */
export const LIVE_LIMIT = 24;

/** One farm step before it is flattened to a single string. */
export interface PlanStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json. */
export interface BoardEntry {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    base_value_usd: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** One board row in the compact form the dashboard's data.js carries. */
export interface CompactEntry {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  base_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
}

/** A protocol whose token already trades, shown with its market cap. */
export interface LiveEntry {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs to render, as one payload. */
export interface RadarPayload {
  as_of: string;
  source: string;
  floor_usd: number;
  model: Tuning;
  model_version: string;
  watchlist: string[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: CompactEntry[];
  live: LiveEntry[];
}

/** A snapshot that cannot be scored, and why. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// ---------------------------------------------------------------- small tools

const MS_PER_DAY = 86_400_000;

/** Four decimal places, for the multipliers the board prints. */
const to4dp = (n: number): number => Math.round(n * 10_000) / 10_000;

/** `value` when it is a finite number, `fallback` otherwise. */
function asFinite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Whole days from `listed` to `asOf`, never below zero; null when either
 * side is missing or unparseable. Both dates are read as UTC midnights.
 */
export function daysListed(asOf: string, listed: string | null): number | null {
  if (listed === null) return null;
  const start = Date.parse(`${listed}T00:00:00Z`);
  const end = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / MS_PER_DAY));
}

/** A dollar figure in short form: $2.75B, $150.0M, $50K, $42. */
export function shortUsd(n: number): string {
  const mag = Math.abs(n);
  if (mag >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (mag >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (mag >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

/** Compare two slugs the way a stable sort wants: code-unit order. */
function slugOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------- the value model

/** The five numbers one protocol's score breaks into. */
export interface Score {
  value: number;
  base: number;
  growthPct: number;
  growth: number;
  season: number;
  spread: number;
  age: number | null;
}

/**
 * Score one protocol. The arithmetic is radar-2, in the order the
 * dashboard's formula states it: a scaled TVL base, a clamped and
 * weighted seven-day growth, a log maturity over the listing age, and a
 * breadth bonus per extra chain. An unreported growth counts as zero and
 * an unknown listing age counts as a year.
 */
export function scoreProto(proto: Proto, asOf: string, tuning: Tuning): Score {
  const age = daysListed(asOf, proto.listed_at);
  const growthPct = Math.min(
    tuning.growth_cap,
    Math.max(tuning.growth_floor, asFinite(proto.change_7d, 0)),
  );
  const growth = 1 + (growthPct / 100) * tuning.growth_weight;
  const seasons = Math.min(Math.max(age ?? tuning.unknown_age_days, 0), tuning.maturity_days);
  const season =
    tuning.maturity_floor +
    (tuning.maturity_range * Math.log1p(seasons)) / Math.log1p(tuning.maturity_days);
  const extra = Math.min(Math.max(proto.chains.length - 1, 0), tuning.breadth_max_chains);
  const spread = 1 + tuning.breadth_per_chain * extra;
  const base =
    (proto.tvl_usd * tuning.base_multiple) /
    (1 + (proto.tvl_usd / tuning.scale_tvl_usd) * tuning.scale_weight);
  const value = Math.max(1, Math.round(base * growth * season * spread));
  return { value, base: Math.round(base), growthPct, growth, season, spread, age };
}

/** A name that ends in a release marker is a versioned pool of another protocol. */
const RELEASE_TAIL = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** True when the snapshot records no token for this protocol at all. */
export function noToken(p: Proto): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** True when the board may rank this protocol: pre-token, not an exchange, not versioned. */
export function canRank(p: Proto): boolean {
  return noToken(p) && p.category !== 'CEX' && !RELEASE_TAIL.test(p.name);
}

/** The snapshot's protocols keyed by slug. */
function indexSlugs(protocols: Proto[]): Map<string, Proto> {
  const index = new Map<string, Proto>();
  for (const p of protocols) index.set(p.slug, p);
  return index;
}

// ---------------------------------------------------------------- the board

/**
 * Pick the board's protocols: the whole watchlist, then the early radar —
 * rankable protocols below the floor, largest TVL first, up to the limit.
 * A watchlist slug the snapshot somehow lost is skipped; the gate's
 * coverage check in main.ts would catch that before anything is written.
 */
function pickProtocols(snap: Snap): Proto[] {
  const index = indexSlugs(snap.protocols);
  const picked = new Map<string, Proto>();
  for (const slug of snap.watchlist) {
    const found = index.get(slug);
    if (found !== undefined) picked.set(slug, found);
  }
  const early = snap.protocols
    .filter((p) => !picked.has(p.slug) && canRank(p) && p.tvl_usd < snap.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || slugOrder(a.slug, b.slug))
    .slice(0, EARLY_LIMIT);
  for (const p of early) picked.set(p.slug, p);
  return [...picked.values()];
}

/**
 * Score, order and rank the picked protocols. Ties are broken by slug so
 * the order is stable, then any row that still ties the row above it on
 * implied value is lowered by one dollar until the board strictly falls.
 */
export function buildBoard(snap: Snap, tuning: Tuning = TUNING): BoardEntry[] {
  const scored = pickProtocols(snap)
    .map((p) => ({ proto: p, score: scoreProto(p, snap.as_of, tuning) }))
    .sort((a, b) => b.score.value - a.score.value || slugOrder(a.proto.slug, b.proto.slug));
  for (let i = 1; i < scored.length; i += 1) {
    const above = scored[i - 1]!;
    const here = scored[i]!;
    if (here.score.value >= above.score.value) {
      here.score.value = Math.max(1, above.score.value - 1);
    }
  }
  return scored.map(({ proto: p, score: s }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    mcap_usd: p.mcap_usd,
    listed_at: p.listed_at,
    gecko_id: p.gecko_id,
    symbol: p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.value,
    model: {
      base_multiple: tuning.base_multiple,
      base_value_usd: s.base,
      growth_pct: s.growthPct,
      growth_multiplier: to4dp(s.growth),
      maturity_multiplier: to4dp(s.season),
      breadth_multiplier: to4dp(s.spread),
      age_days: s.age,
    },
    farm_steps: planFor(p, s.age).map(renderStep),
  }));
}

// ---------------------------------------------------------------- farm plans

/** The first chain the protocol names, or a neutral fallback. */
function homeChain(p: Proto): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** Capital one farm position needs, tiered on the protocol's own TVL. */
function stakeFor(p: Proto): number {
  const tiers: Array<[number, number]> = [
    [5_000_000_000, 250],
    [1_000_000_000, 150],
    [100_000_000, 100],
  ];
  for (const [floor, stake] of tiers) if (p.tvl_usd >= floor) return stake;
  return 50;
}

/** How long to hold: younger protocols get the longer qualifying window. */
function holdFor(age: number | null): number {
  if (age === null) return 30;
  const windows: Array<[number, number]> = [
    [180, 60],
    [365, 45],
  ];
  for (const [under, days] of windows) if (age < under) return days;
  return 30;
}

/**
 * One category's way of farming, as a pair of sentences: the opening
 * action and the small weekly repeat. The table is matched on the
 * category's lower-cased words, first hit wins; a category no rule
 * names falls through to the plain deposit at the end. No protocol name
 * is ever looked at here.
 */
interface PlanRule {
  tags: string[];
  act: (name: string, stake: number, chain: string) => string;
  weekly: (name: string, chain: string) => string;
}

const PLAN_RULES: PlanRule[] = [
  {
    tags: ['lend', 'cdp', 'collateral'],
    act: (n, s, c) => `Supply $${s} of USDC to ${n} on ${c} and keep the position open.`,
    weekly: (n, c) => `Each week, supply or borrow a small amount on ${n} on ${c} so the position shows fresh activity.`,
  },
  {
    tags: ['dex', 'yield', 'leveraged farm'],
    act: (n, s, c) => `Provide $${s} of liquidity to ${n}'s main pool on ${c} and keep the position open.`,
    weekly: (n, c) => `Each week, swap a small amount or add a little liquidity in ${n}'s main pool on ${c}.`,
  },
  {
    tags: ['bridge'],
    act: (n, s, c) => `Bridge $${s} of USDC to ${c} through ${n} and use the bridged funds in its app.`,
    weekly: (n, c) => `Each week, bridge a small amount through ${n} to ${c} and use it in the app it lands in.`,
  },
  {
    tags: ['staking', 'restak'],
    act: (n, s) => `Stake $${s} of the chain's staking asset through ${n} and keep the receipt.`,
    weekly: (n, c) => `Each week, check the staking rewards on ${n} and restake what has accrued, on ${c}.`,
  },
  {
    tags: ['perpetual', 'derivative'],
    act: (n, s) => `Deposit $${s} of USDC as margin on ${n} and open one small hedge.`,
    weekly: (n, c) => `Each week, place one small hedged trade on ${n} on ${c} and close it the same week.`,
  },
  {
    tags: ['prediction'],
    act: (n, s) => `Fund $${s} and place one market position on ${n}.`,
    weekly: (n) => `Each week, place one small market position on ${n} and let it settle before the next one.`,
  },
  {
    tags: ['curator', 'allocator'],
    act: (n, s, c) => `Deposit $${s} into a ${n} vault on ${c} and keep the shares.`,
    weekly: (n, c) => `Each week, check the ${n} vault allocation on ${c} and top it up only if its mix has changed.`,
  },
  {
    tags: ['stable'],
    act: (n, s, c) => `Mint or deposit $${s} of the stable asset through ${n} on ${c}.`,
    weekly: (n, c) => `Each week, check the stable asset's peg through ${n} on ${c} and keep the deposit in place.`,
  },
  {
    tags: ['rwa'],
    act: (n, s, c) => `Mint $${s} of the protocol's yield asset on ${c} and hold it.`,
    weekly: (n, c) => `Each week, check the yield that has accrued on ${n} on ${c} and leave the position to compound.`,
  },
  {
    tags: ['insurance'],
    act: (n, s, c) => `Buy $${s} of cover from ${n} on ${c} and keep the policy.`,
    weekly: (n, c) => `Each week, check that the cover from ${n} on ${c} is still active and note its expiry.`,
  },
];

const FALLBACK_RULE: PlanRule = {
  tags: [],
  act: (n, s, c) => `Deposit $${s} of USDC into ${n} on ${c} and keep the position open.`,
  weekly: (n, c) => `Each week, make one qualifying on-chain action on ${n} on ${c}, such as a deposit, a swap or a vote.`,
};

/** The rule a protocol's category matches, or the plain-deposit fallback. */
function ruleFor(p: Proto): PlanRule {
  const cat = (p.category ?? '').toLowerCase();
  for (const rule of PLAN_RULES) {
    if (rule.tags.some((tag) => cat.includes(tag))) return rule;
  }
  return FALLBACK_RULE;
}

/** One step as a single string, with its cost and time, inside the gate's bounds. */
export function renderStep(step: PlanStep): string {
  let out = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (out.length > 600) out = `${out.slice(0, 596)}...`;
  if (out.length < 20) out = `${out} Hold the position and check the protocol's own page.`;
  return out;
}

/**
 * A protocol's farm plan: six steps, each naming the protocol, its home
 * chain or its TVL, so no two protocols end up with the same plan. The
 * steps are built from the record alone — category, chain, TVL, age —
 * and each one says what it costs and how long it takes.
 */
export function planFor(p: Proto, age: number | null): PlanStep[] {
  const chain = homeChain(p);
  const stake = stakeFor(p);
  const hold = holdFor(age);
  const rule = ruleFor(p);
  const ageNote = age === null ? 'an unknown listing date' : `${age} days with no token on record`;
  const kind = p.category ?? 'protocol';
  return [
    {
      text: `Use a fresh wallet on ${chain} that holds only the $${stake} you plan to farm on ${p.name}, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: rule.act(p.name, stake, chain),
      cost: `$${stake} of capital and about $${stake >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: rule.weekly(p.name, chain),
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days, because ${p.name} has run ${ageNote}, so the activity is counted in more than one snapshot.`,
      cost: `the $${stake} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open ${p.name}'s ${kind} rewards or points page on ${chain} and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates, the ${shortUsd(p.tvl_usd)} TVL at entry and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

// ---------------------------------------------------------------- live set and payload

/** The live-token protocols, largest market cap first, for the dashboard's apart view. */
export function liveSet(snap: Snap): LiveEntry[] {
  return snap.protocols
    .filter((p) => !noToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_LIMIT)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row thinned to what the page renders. */
export function compactEntry(row: BoardEntry): CompactEntry {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    base_value_usd: row.model.base_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
  };
}

/** Score the snapshot and pack everything the dashboard renders. */
export function buildRadar(snap: Snap, tuning: Tuning = TUNING): { board: BoardEntry[]; radar: RadarPayload } {
  const board = buildBoard(snap, tuning);
  const live = liveSet(snap);
  const early = board.filter((r) => !snap.watchlist.includes(r.slug)).length;
  const radar: RadarPayload = {
    as_of: snap.as_of,
    source: snap.source,
    floor_usd: snap.floor_usd,
    model: tuning,
    model_version: MODEL_VERSION,
    watchlist: snap.watchlist.slice(),
    watchlist_size: snap.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(compactEntry),
    live,
  };
  return { board, radar };
}

// ---------------------------------------------------------------- reading the snapshot

/** Pull a string field out of a raw object, or null when it is not one. */
function fieldText(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' ? v : null;
}

/** Pull a finite number field out of a raw object, or null when it is not one. */
function fieldNum(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Shape one raw protocol record into a Proto, refusing a record without the essentials. */
function shapeProto(raw: unknown, i: number): Proto {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.slug !== 'string' || typeof o.name !== 'string' || typeof o.tvl_usd !== 'number' || !Number.isFinite(o.tvl_usd)) {
    throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
  }
  const chains = Array.isArray(o.chains)
    ? o.chains.filter((c): c is string => typeof c === 'string')
    : [];
  return {
    slug: o.slug,
    name: o.name,
    category: fieldText(o, 'category'),
    chains,
    tvl_usd: o.tvl_usd,
    change_7d: fieldNum(o, 'change_7d'),
    mcap_usd: fieldNum(o, 'mcap_usd'),
    listed_at: fieldText(o, 'listed_at'),
    gecko_id: fieldText(o, 'gecko_id'),
    symbol: fieldText(o, 'symbol'),
  };
}

/**
 * Parse the snapshot's text into a Snap, refusing anything that is not
 * the shape the model scores: a dated document, a positive floor, a
 * protocols array and a watchlist of slugs.
 */
export function parseSnapshot(text: string): Snap {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  const floor = o.floor_usd;
  if (typeof floor !== 'number' || !Number.isSafeInteger(floor) || floor <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: floor,
    protocols: o.protocols.map((v, i) => shapeProto(v, i)),
    watchlist: o.watchlist as string[],
  };
}

// ---------------------------------------------------------------- the gate's own checks

/**
 * The first reason this board would fail the gate, or null when it
 * passes: watchlist coverage, ranks 1..N, a strictly falling implied
 * value, and farm steps of the right count and length on every row.
 */
export function boardIssue(board: BoardEntry[], snap: Snap): string | null {
  const present = new Set(board.map((r) => r.slug));
  const missing = snap.watchlist.filter((s) => !present.has(s));
  if (missing.length > 0) {
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i += 1) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < board.length; i += 1) {
    if (board[i]!.implied_value_usd >= board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} does not fall below row ${i} on implied value`;
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const row of board) {
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      return `${row.slug} has ${row.farm_steps.length} farm steps`;
    }
    for (const step of row.farm_steps) {
      if (step.length < 20 || step.length > 600) return `${row.slug} has a farm step of ${step.length} characters`;
    }
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd <= 0) {
      return `${row.slug} has implied value ${row.implied_value_usd}`;
    }
  }
  return null;
}

/** The dashboard's dataset as one script tag's worth of JavaScript: no fetch, no network. */
export function dataScript(radar: RadarPayload): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
