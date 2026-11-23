// Token Radar's dashboard, radar-2.
//
// It reads window.RADAR — the dataset main.ts writes beside dashboard/ —
// and renders the ranked board, the filters, the per-protocol detail view
// and the live-token table. No network anywhere: every byte it shows
// arrived in data.js, and the page never fetches anything.
//
// Rendering is string templates plus one innerHTML per render, with every
// protocol-supplied string escaped on the way in. State lives in one
// object and is mirrored into the URL hash, so a board view, a filter or
// an open protocol can be linked to.

(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;

  var mount = document.getElementById('board');
  var WATCH = {};
  (DATA.watchlist || []).forEach(function (slug) { WATCH[slug] = true; });

  var view = {
    q: '',
    category: 'all',
    chain: 'all',
    watchOnly: false,
    tab: 'pre-token',
    sortKey: 'implied',
    sortDir: -1,
    open: null,
  };

  // ---------------------------------------------------------- formatting

  var dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  /** A dollar figure as $2.75B, $150.0M, $50K or $42; 'n/a' for nothing. */
  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var mag = Math.abs(n);
    if (mag >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (mag >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (mag >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return dollars.format(n);
  }

  /** A percentage with its sign, two decimals; 'n/a' for nothing. */
  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  /** An age in days as 2.4y, 90d or 'unknown'. */
  function ageLabel(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }

  /** Escape a string for interpolation into an HTML template. */
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** The chains a row names, first two, or a neutral phrase. */
  function chainList(row, all) {
    var chains = row.chains || [];
    if (all) return chains.length ? chains.join(', ') : 'an unnamed chain';
    return chains.length ? chains.slice(0, 2).join(', ') : 'an unnamed chain';
  }

  // ---------------------------------------------------------- the model, again

  // Radar-2 recomputed in the page from the snapshot figures, so the page
  // can check the number board.json carries: base is TVL x 0.28 with the
  // large-cap scale-down, growth is weighted 0.7 inside its clamp, maturity
  // is the log curve over age, breadth adds 0.04 per extra chain to 1.16.
  function recompute(row) {
    var m = DATA.model;
    var raw = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    var growth = Math.min(m.growth_cap, Math.max(m.growth_floor, raw));
    var growthMult = 1 + (growth / 100) * m.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? m.unknown_age_days : row.age_days;
    var maturity = m.maturity_floor + m.maturity_range * (Math.log1p(Math.min(Math.max(age, 0), m.maturity_days)) / Math.log1p(m.maturity_days));
    var extra = Math.min(Math.max((row.chains || []).length - 1, 0), m.breadth_max_chains);
    var breadth = 1 + m.breadth_per_chain * extra;
    var base = (row.tvl_usd * m.base_multiple) / (1 + (row.tvl_usd / m.scale_tvl_usd) * m.scale_weight);
    return Math.max(1, Math.round(base * growthMult * maturity * breadth));
  }

  // ---------------------------------------------------------- farm plans

  // The farm plan is the same derivation main.ts writes into board.json:
  // category, home chain, TVL and age decide the action, the capital, the
  // hold and every cost and time. No name is special-cased.
  function homeChain(p) {
    return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain';
  }

  function stakeFor(p) {
    var tiers = [[5e9, 250], [1e9, 150], [1e8, 100]];
    for (var i = 0; i < tiers.length; i++) {
      if (p.tvl_usd >= tiers[i][0]) return tiers[i][1];
    }
    return 50;
  }

  function holdFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }

  var PLAN_RULES = [
    {
      tags: ['lend', 'cdp', 'collateral'],
      act: function (n, s, c) { return 'Supply $' + s + ' of USDC to ' + n + ' on ' + c + ' and keep the position open.'; },
      weekly: function (n, c) { return 'Each week, supply or borrow a small amount on ' + n + ' on ' + c + ' so the position shows fresh activity.'; },
    },
    {
      tags: ['dex', 'yield', 'leveraged farm'],
      act: function (n, s, c) { return 'Provide $' + s + ' of liquidity to ' + n + "'s main pool on " + c + ' and keep the position open.'; },
      weekly: function (n, c) { return 'Each week, swap a small amount or add a little liquidity in ' + n + "'s main pool on " + c + '.'; },
    },
    {
      tags: ['bridge'],
      act: function (n, s, c) { return 'Bridge $' + s + ' of USDC to ' + c + ' through ' + n + ' and use the bridged funds in its app.'; },
      weekly: function (n, c) { return 'Each week, bridge a small amount through ' + n + ' to ' + c + ' and use it in the app it lands in.'; },
    },
    {
      tags: ['staking', 'restak'],
      act: function (n, s) { return 'Stake $' + s + " of the chain's staking asset through " + n + ' and keep the receipt.'; },
      weekly: function (n, c) { return 'Each week, check the staking rewards on ' + n + ' and restake what has accrued, on ' + c + '.'; },
    },
    {
      tags: ['perpetual', 'derivative'],
      act: function (n, s) { return 'Deposit $' + s + ' of USDC as margin on ' + n + ' and open one small hedge.'; },
      weekly: function (n, c) { return 'Each week, place one small hedged trade on ' + n + ' on ' + c + ' and close it the same week.'; },
    },
    {
      tags: ['prediction'],
      act: function (n, s) { return 'Fund $' + s + ' and place one market position on ' + n + '.'; },
      weekly: function (n) { return 'Each week, place one small market position on ' + n + ' and let it settle before the next one.'; },
    },
    {
      tags: ['curator', 'allocator'],
      act: function (n, s, c) { return 'Deposit $' + s + ' into a ' + n + ' vault on ' + c + ' and keep the shares.'; },
      weekly: function (n, c) { return 'Each week, check the ' + n + ' vault allocation on ' + c + ' and top it up only if its mix has changed.'; },
    },
    {
      tags: ['stable'],
      act: function (n, s, c) { return 'Mint or deposit $' + s + ' of the stable asset through ' + n + ' on ' + c + '.'; },
      weekly: function (n, c) { return 'Each week, check the stable asset\'s peg through ' + n + ' on ' + c + ' and keep the deposit in place.'; },
    },
    {
      tags: ['rwa'],
      act: function (n, s, c) { return 'Mint $' + s + " of the protocol's yield asset on " + c + ' and hold it.'; },
      weekly: function (n, c) { return 'Each week, check the yield that has accrued on ' + n + ' on ' + c + ' and leave the position to compound.'; },
    },
    {
      tags: ['insurance'],
      act: function (n, s, c) { return 'Buy $' + s + ' of cover from ' + n + ' on ' + c + ' and keep the policy.'; },
      weekly: function (n, c) { return 'Each week, check that the cover from ' + n + ' on ' + c + ' is still active and note its expiry.'; },
    },
  ];

  function ruleFor(p) {
    var cat = (p.category || '').toLowerCase();
    for (var i = 0; i < PLAN_RULES.length; i++) {
      var rule = PLAN_RULES[i];
      for (var j = 0; j < rule.tags.length; j++) {
        if (cat.indexOf(rule.tags[j]) >= 0) return rule;
      }
    }
    return {
      act: function (n, s, c) { return 'Deposit $' + s + ' of USDC into ' + n + ' on ' + c + ' and keep the position open.'; },
      weekly: function (n, c) { return 'Each week, make one qualifying on-chain action on ' + n + ' on ' + c + ', such as a deposit, a swap or a vote.'; },
    };
  }

  function renderStep(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }

  function planSteps(p) {
    var chain = homeChain(p);
    var stake = stakeFor(p);
    var hold = holdFor(p.age_days);
    var rule = ruleFor(p);
    var ageNote = p.age_days === null || p.age_days === undefined
      ? 'an unknown listing date'
      : p.age_days + ' days with no token on record';
    var kind = p.category || 'protocol';
    return [
      {
        text: 'Use a fresh wallet on ' + chain + ' that holds only the $' + stake + ' you plan to farm on ' + p.name + ', and keep its seed phrase offline.',
        cost: 'under $3 of gas for the first transaction',
        time: '5 minutes',
      },
      {
        text: rule.act(p.name, stake, chain),
        cost: '$' + stake + ' of capital and about $' + (stake >= 150 ? 8 : 4) + ' of gas',
        time: '15 minutes to set up',
      },
      {
        text: rule.weekly(p.name, chain),
        cost: 'about $2 of gas a week',
        time: '10 minutes a week',
      },
      {
        text: 'Hold the position for at least ' + hold + ' days, because ' + p.name + ' has run ' + ageNote + ', so the activity is counted in more than one snapshot.',
        cost: 'the $' + stake + ' stays in the position',
        time: hold + ' days',
      },
      {
        text: "Before you withdraw, open " + p.name + "'s " + kind + " rewards or points page on " + chain + " and claim only from the link it publishes.",
        cost: 'no fee to check, and never pay to claim',
        time: '10 minutes',
      },
      {
        text: 'Write the wallet, the dates, the ' + money(p.tvl_usd) + ' TVL at entry and every transaction in a farm log so you can repeat the position or unwind it.',
        cost: 'nothing but the log',
        time: '5 minutes',
      },
    ].map(renderStep);
  }

  // ---------------------------------------------------------- hash state

  function loadHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) view.q = params.get('q');
    if (params.get('p')) view.open = params.get('p');
    if (params.get('category')) view.category = params.get('category');
    if (params.get('chain')) view.chain = params.get('chain');
    if (params.get('watch') === '1') view.watchOnly = true;
  }

  function saveHash() {
    var params = new URLSearchParams();
    if (view.q) params.set('q', view.q);
    if (view.category !== 'all') params.set('category', view.category);
    if (view.chain !== 'all') params.set('chain', view.chain);
    if (view.watchOnly) params.set('watch', '1');
    if (view.open) params.set('p', view.open);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  // ---------------------------------------------------------- filtering and sorting

  function visibleRows() {
    var q = view.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (view.category !== 'all' && r.category !== view.category) return false;
      if (view.chain !== 'all' && !(r.chains || []).includes(view.chain)) return false;
      if (view.watchOnly && !WATCH[r.slug]) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function sortValue(row, key) {
    if (key === 'name') return row.name.toLowerCase();
    if (key === 'tvl') return row.tvl_usd;
    if (key === 'growth') return row.change_7d === null ? -Infinity : row.change_7d;
    if (key === 'age') return row.age_days === null ? Infinity : row.age_days;
    return row.implied_value_usd;
  }

  function sortedRows(list) {
    var key = view.sortKey;
    return list.slice().sort(function (a, b) {
      var av = sortValue(a, key);
      var bv = sortValue(b, key);
      var cmp = av < bv ? -1 : av > bv ? 1 : 0;
      if (cmp !== 0) return cmp * view.sortDir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function uniqueSorted(values) {
    return Array.from(new Set(values)).sort();
  }

  // ---------------------------------------------------------- templates

  function headerHtml() {
    return '<header class="top">' +
      '<div class="brand"><span class="mark"></span><span class="brand-name">Token Radar</span></div>' +
      '<div class="top-meta"><span>Snapshot ' + esc(DATA.as_of) + '</span>' +
      '<span>DefiLlama protocol index</span>' +
      '<span>' + esc(DATA.model_version) + ' model</span></div>' +
      '</header>';
  }

  function ledeHtml() {
    var facts = [
      ['Watchlist covered', DATA.watchlist_size + ' / ' + DATA.watchlist_size],
      ['Pre-token rows scored', String(DATA.board_size)],
      ['Early rows below the floor', String(DATA.early_size)],
      ['Live-token protocols set aside', String(DATA.live_size)],
    ];
    return '<section class="lede"><div>' +
      '<h1>' + DATA.watchlist_size + ' watchlist protocols, ranked by implied value</h1>' +
      '<p>The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. ' +
      'The early radar adds ' + DATA.early_size + ' pre-token protocols below that floor. Implied value is a model, not a promise.</p>' +
      '</div><div class="facts">' +
      facts.map(function (f) {
        return '<div class="fact"><span>' + f[0] + '</span><b>' + f[1] + '</b></div>';
      }).join('') +
      '</div></section>';
  }

  function controlsHtml() {
    var categories = uniqueSorted(DATA.rows.map(function (r) { return r.category || 'Other'; }));
    var chains = uniqueSorted(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []));
    var options = function (list, current, allLabel) {
      var out = '<option value="all"' + (current === 'all' ? ' selected' : '') + '>' + allLabel + '</option>';
      list.forEach(function (item) {
        out += '<option value="' + esc(item) + '"' + (item === current ? ' selected' : '') + '>' + esc(item) + '</option>';
      });
      return out;
    };
    return '<div class="controls">' +
      '<div class="field"><label for="q">Search</label>' +
      '<input type="search" id="q" placeholder="Search name, category or chain" value="' + esc(view.q) + '" aria-label="Search the board"></div>' +
      '<div class="field"><label for="category">Category</label>' +
      '<select id="category" aria-label="Filter by category">' + options(categories, view.category, 'All categories') + '</select></div>' +
      '<div class="field"><label for="chain">Chain</label>' +
      '<select id="chain" aria-label="Filter by chain">' + options(chains, view.chain, 'All chains') + '</select></div>' +
      '<div class="field check"><label for="watchlist">Watchlist only</label>' +
      '<input type="checkbox" id="watchlist"' + (view.watchOnly ? ' checked' : '') + '></div>' +
      '<div class="field"><span class="sub">Token status</span><div class="tabs">' +
      '<button type="button" data-tab="pre-token" aria-pressed="' + (view.tab === 'pre-token') + '">Pre-token</button>' +
      '<button type="button" data-tab="live" aria-pressed="' + (view.tab === 'live') + '">Live token</button>' +
      '</div></div>' +
      '<span class="count">' + (view.tab === 'pre-token' ? visibleRows().length + ' rows shown' : DATA.live.length + ' live-token protocols') + '</span>' +
      '</div>';
  }

  function sortHead(key, label) {
    var arrow = view.sortKey === key
      ? '<span aria-hidden="true">' + (view.sortDir < 0 ? ' v' : ' ^') + '</span>'
      : '';
    return '<th scope="col"><button type="button" data-sort="' + key + '">' + label + arrow + '</button></th>';
  }

  function boardRowHtml(row, maxImplied) {
    var growth = row.change_7d === null ? 'n/a' : pct(row.change_7d);
    var growthClass = row.change_7d === null ? '' : row.change_7d >= 0 ? 'pos' : 'neg';
    var width = Math.max(3, Math.round((row.implied_value_usd / maxImplied) * 100));
    return '<tr data-slug="' + esc(row.slug) + '" data-selected="' + (view.open === row.slug) + '" tabindex="0">' +
      '<td class="num">' + row.rank + '</td>' +
      '<td><div class="name"><b>' + esc(row.name) + '</b>' +
      '<span class="sub">' + esc(row.category || 'Other') + ' on ' + esc(chainList(row, false)) + '</span></div></td>' +
      '<td class="num">' + money(row.tvl_usd) + '</td>' +
      '<td class="num ' + growthClass + '">' + growth + '</td>' +
      '<td class="num">' + ageLabel(row.age_days) + '</td>' +
      '<td><div class="implied"><div class="bar" aria-hidden="true"><i style="width:' + width + '%"></i></div>' +
      '<span class="num">' + money(row.implied_value_usd) + '</span></div></td>' +
      '<td><span class="status">' + (WATCH[row.slug] ? 'watchlist · no token' : 'no token') + '</span></td>' +
      '</tr>';
  }

  function boardHtml() {
    var list = sortedRows(visibleRows());
    if (list.length === 0) {
      return '<div class="panel"><div class="empty"><h2>No protocol matches that filter</h2>' +
        '<p>Clear the search or pick another category to see the board again.</p>' +
        '<button class="button primary" type="button" data-clear="1">Clear filters</button></div></div>';
    }
    var maxImplied = list[0].implied_value_usd || 1;
    return '<div class="panel"><div class="table-wrap"><table>' +
      '<caption class="sub">Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.</caption>' +
      '<thead><tr>' +
      sortHead('implied', 'Rank') + sortHead('name', 'Protocol') + sortHead('tvl', 'TVL') +
      sortHead('growth', '7d') + sortHead('age', 'Age') + sortHead('implied', 'Implied value') +
      '<th scope="col">Token</th></tr></thead>' +
      '<tbody>' + list.map(function (r) { return boardRowHtml(r, maxImplied); }).join('') + '</tbody>' +
      '</table></div></div>';
  }

  function liveHtml() {
    var rows = DATA.live.map(function (r) {
      return '<tr><td class="num">live</td>' +
        '<td><div class="name"><b>' + esc(r.name) + '</b>' +
        '<span class="sub">' + esc(r.category || 'Other') + ' on ' + esc(chainList(r, false)) + '</span></div></td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg') + '">' + pct(r.change_7d) + '</td>' +
        '<td class="num">' + money(r.mcap_usd) + '</td>' +
        '<td><span class="status">already trades</span></td></tr>';
    }).join('');
    return '<div class="panel"><div class="table-wrap"><table>' +
      '<caption class="sub">Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.</caption>' +
      '<thead><tr><th scope="col">Status</th><th scope="col">Protocol</th><th scope="col">TVL</th>' +
      '<th scope="col">7d</th><th scope="col">Market cap</th><th scope="col">Token</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div></div>';
  }

  function modelHtml() {
    var m = DATA.model;
    var formula = 'implied = round( tvl_usd x ' + m.base_multiple +
      ' / (1 + tvl_usd / ' + m.scale_tvl_usd + ' x ' + m.scale_weight +
      ') x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight +
      ') x (' + m.maturity_floor + ' + ' + m.maturity_range +
      ' x ln(1 + min(age_days, ' + m.maturity_days + ')) / ln(1 + ' + m.maturity_days +
      ')) x (1 + ' + m.breadth_per_chain + ' x min(chains - 1, ' + m.breadth_max_chains + ')) )';
    return '<section class="panel model">' +
      '<h2>How implied value is computed — radar-2</h2>' +
      '<p class="sub">Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.</p>' +
      '<div class="formula">' + esc(formula) + '</div>' +
      '<p class="sub">TVL and seven-day growth come from the snapshot. Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ' + m.unknown_age_days + ' days. Breadth counts the chains a protocol is live on. Ties in implied value are lowered by $1 so ranks are strictly decreasing. The early radar is every pre-token protocol below the watchlist floor, by TVL, and the live-token protocols are set aside with their market caps shown.</p>' +
      '</section>';
  }

  function detailHtml(row) {
    var steps = planSteps(row);
    var again = recompute(row);
    var check = again === row.implied_value_usd
      ? ', the same number board.json carries.'
      : ', which differs from the board: the data would be stale.';
    var pairs = [
      ['TVL', money(row.tvl_usd)],
      ['Base value (TVL x 0.28, scaled)', money(row.base_value_usd)],
      ['Seven-day growth', pct(row.change_7d)],
      ['Age with no token', ageLabel(row.age_days)],
      ['Chains live on', String((row.chains || []).length)],
      ['Growth multiplier', String(row.growth_multiplier)],
      ['Maturity multiplier', String(row.maturity_multiplier)],
      ['Breadth multiplier', String(row.breadth_multiplier)],
      ['Implied value', money(row.implied_value_usd)],
    ];
    var stepsHtml = steps.map(function (s) {
      var at = s.indexOf(' Cost: ');
      var action = at >= 0 ? s.slice(0, at) : s;
      var tail = at >= 0 ? s.slice(at + 1) : '';
      return '<li><b>' + esc(action) + '</b><span class="cost">' + esc(tail) + '</span></li>';
    }).join('');
    return '<div class="detail-head"><div>' +
      '<span class="brand-name">Rank ' + row.rank + ' of ' + DATA.board_size + '</span>' +
      '<h2 id="detail-title">' + esc(row.name) + '</h2>' +
      '<p class="sub">' + esc(row.category || 'Other') + ' on ' + esc(chainList(row, true)) + '</p>' +
      '</div><button class="close" type="button" aria-label="Close details" data-close="1">Close</button></div>' +
      '<section class="detail-section"><h3>Implied value</h3><div class="equation">' +
      pairs.map(function (pair) {
        return '<div><span>' + pair[0] + '</span><b class="num">' + esc(pair[1]) + '</b></div>';
      }).join('') +
      '</div><p class="sub">Model ' + esc(DATA.model_version) + ': the same function scores every protocol. ' +
      'The page recomputes this row as ' + money(again) + check + ' This is an estimate, not a price.</p></section>' +
      '<section class="detail-section"><h3>Farm plan</h3><ol class="steps">' + stepsHtml + '</ol></section>';
  }

  // ---------------------------------------------------------- render and wire

  var dialog = document.createElement('dialog');
  dialog.className = 'detail';
  dialog.id = 'detail';
  dialog.setAttribute('aria-labelledby', 'detail-title');
  dialog.addEventListener('close', function () {
    view.open = null;
    saveHash();
  });

  function openDetail(slug) {
    var row = null;
    for (var i = 0; i < DATA.rows.length; i++) {
      if (DATA.rows[i].slug === slug) { row = DATA.rows[i]; break; }
    }
    if (!row) return;
    view.open = slug;
    saveHash();
    dialog.innerHTML = detailHtml(row);
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function wire() {
    var q = document.getElementById('q');
    if (q) {
      q.addEventListener('input', function () { view.q = q.value; saveHash(); render(); });
    }
    var cat = document.getElementById('category');
    if (cat) {
      cat.addEventListener('change', function () { view.category = cat.value; saveHash(); render(); });
    }
    var chain = document.getElementById('chain');
    if (chain) {
      chain.addEventListener('change', function () { view.chain = chain.value; saveHash(); render(); });
    }
    var watch = document.getElementById('watchlist');
    if (watch) {
      watch.addEventListener('change', function () { view.watchOnly = watch.checked; saveHash(); render(); });
    }
    var tabs = mount.querySelectorAll('[data-tab]');
    tabs.forEach(function (btn) {
      btn.addEventListener('click', function () { view.tab = btn.getAttribute('data-tab'); render(); });
    });
    var sorts = mount.querySelectorAll('[data-sort]');
    sorts.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.getAttribute('data-sort');
        if (view.sortKey === key) view.sortDir = -view.sortDir;
        else { view.sortKey = key; view.sortDir = -1; }
        render();
      });
    });
    var rows = mount.querySelectorAll('tr[data-slug]');
    rows.forEach(function (tr) {
      var slug = tr.getAttribute('data-slug');
      tr.addEventListener('click', function () { openDetail(slug); });
      tr.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(slug); }
      });
    });
    var clear = mount.querySelector('[data-clear]');
    if (clear) {
      clear.addEventListener('click', function () {
        view.q = ''; view.category = 'all'; saveHash(); render();
      });
    }
    var closer = dialog.querySelector('[data-close]');
    if (closer) {
      closer.addEventListener('click', function () { dialog.close(); });
    }
  }

  function render() {
    mount.innerHTML = '<div class="shell">' +
      headerHtml() + ledeHtml() + controlsHtml() +
      (view.tab === 'pre-token' ? boardHtml() : liveHtml()) +
      (view.tab === 'pre-token' ? modelHtml() : '') +
      '</div>';
    mount.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) mount.appendChild(dialog);
    wire();
    if (view.open) openDetail(view.open);
  }

  loadHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
