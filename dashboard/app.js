(function () {
  var D = RADAR_DATA, M = D.meta;
  var GAS = { Ethereum: 2.5, Solana: 0.02, Base: 0.05, Arbitrum: 0.08, Optimism: 0.08, Polygon: 0.03, Binance: 0.15, BSC: 0.15, Avalanche: 0.1, Blast: 0.05, Linea: 0.05, Scroll: 0.08, "zkSync Era": 0.1, zkSync: 0.1, Mantle: 0.05, Berachain: 0.05, Sui: 0.02, Aptos: 0.02 };
  var VLABEL = { F: "FARM", T: "THIN", S: "SKIP", L: "LIVE", K: "TRACKED" };
  var HOURS = 5.25, STEPS = 5;

  function parseRows() {
    return D.rows.split("\n").map(function (line, i) {
      var f = line.split("|");
      return {
        rank: i + 1, slug: f[0], name: f[1] || displayName(f[0]),
        expK: +f[2] * 100, p: +f[3], tvlM: +f[4],
        cat: D.categories[+f[5]] || "", chains: f[6] ? f[6].split(",").map(function (x) { return D.chains[+x]; }) : [],
        family: +f[7], verdict: f[8]
      };
    });
  }
  function displayName(slug) {
    return slug.split("-").map(function (w) { return w ? w[0].toUpperCase() + w.slice(1) : w; }).join(" ");
  }
  var ROWS = parseRows();
  var BY_SLUG = {};
  ROWS.forEach(function (r) { BY_SLUG[r.slug] = r; });
  // 50/50 rank blend of implied value and P(token) — the page's default
  // sort, over the launch candidates only (eligible pre-token rows), exactly
  // as the build computes it. Percentile ranks: 1 = best, 0 = worst; ties
  // break by slug. LIVE / TRACKED rows have no blend rank and follow by
  // board rank. The board file stays ranked by expected value because the
  // gate requires its dollar column to fall with rank.
  (function () {
    function pct(key, rows) {
      var order = rows.slice().sort(function (a, b) { return key(b) - key(a) || (a.slug < b.slug ? -1 : 1); });
      var m = {};
      order.forEach(function (r, i) { m[r.slug] = 1 - i / (order.length - 1); });
      return m;
    }
    var cand = ROWS.filter(function (r) { return r.verdict === "F" || r.verdict === "T" || r.verdict === "S"; });
    var pi = pct(implied, cand), pp = pct(function (r) { return r.p; }, cand);
    cand.forEach(function (r) { r.blend = 0.5 * pi[r.slug] + 0.5 * pp[r.slug]; });
    var order = cand.slice().sort(function (a, b) { return b.blend - a.blend || b.expK - a.expK || (a.slug < b.slug ? -1 : 1); });
    order.forEach(function (r, i) { r.blendRank = i + 1; });
  })();

  function fmtUsd(v) {
    if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
    if (v >= 1e3) return "$" + Math.round(v / 1e3) + "K";
    return "$" + Math.round(v);
  }
  function implied(r) { var p = Math.max(1, r.p) / 100; return (r.expK * 1000) / Math.sqrt(p); }
  function cheapestChain(r) {
    var c = r.chains[0] || "Ethereum";
    var g = GAS[c] === undefined ? 0.1 : GAS[c];
    return { chain: c, gas: g };
  }
  function econ(r) {
    var ev = r.expK * 1000, tvl = r.tvlM * 1e6;
    var cc = cheapestChain(r);
    var cost = 2 * STEPS * cc.gas + 5;
    var farmers = Math.max(1000, Math.round(1000 * Math.sqrt(tvl / 1e6)));
    var share = 0.05 * ev / farmers;
    return {
      chain: cc.chain, gas: cc.gas, cost: cost, hours: HOURS, farmers: farmers,
      share: share, perHour: share / HOURS, netPerHour: (share - cost) / HOURS,
      roi: share / cost, breakEven: share <= 0 ? 60 : Math.min(60, Math.round(cost / (share / 12))),
      minCap: Math.max(50, Math.ceil((3 * cost + 25) / 10) * 10)
    };
  }
  function stepsFor(r) {
    var e = econ(r);
    var perStep = "$" + (2 * e.gas).toFixed(2), mins = String(Math.round(e.hours / STEPS * 60));
    var tvl = "$" + Math.round(r.tvlM) + "M";
    var tpls = D.templates[r.family] || D.templates[D.templates.length - 1];
    return tpls.map(function (s) {
      var t = s.split("{name}").join(r.name).split("{chain}").join(e.chain).split("{tvl}").join(tvl);
      if (t.slice(-21) === "(no gas, ~{mins} min)") return t.split("{mins}").join(mins);
      return t + " (about " + perStep + " gas, ~" + mins + " min)";
    });
  }

  // ------------------------------------------------------------ state + views
  var params = new URLSearchParams(location.search);
  var state = {
    view: params.get("view") || "radar",
    q: params.get("q") || "", cat: params.get("cat") || "", verdict: params.get("verdict") || "",
    sort: params.get("sort") || "blend",
    dir: params.get("dir") === "asc" ? 1 : params.get("dir") === "desc" ? -1 :
      ((params.get("sort") || "blend") === "blend" || params.get("sort") === "name" || params.get("sort") === "cat" ? 1 : -1),
    slug: params.get("slug") || ""
  };
  function syncUrl() { /* views are set by link (?view=&slug=) on load; no rewrite needed */ }
  function visibleRows() {
    var rows = ROWS.filter(function (r) {
      if (state.view === "radar") { if (r.verdict !== "F" && r.verdict !== "T" && r.verdict !== "S") return false; }
      if (state.view === "live") { if (r.verdict !== "L") return false; }
      if (state.cat && r.cat !== state.cat) return false;
      if (state.verdict && r.verdict !== state.verdict) return false;
      if (state.q) {
        var q = state.q.toLowerCase();
        if (r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
      }
      return true;
    });
    var key = state.sort;
    var val = function (r) {
      return key === "tvl" ? r.tvlM : key === "implied" ? implied(r) : key === "p" ? r.p :
        key === "expected" ? r.expK : key === "perHour" ? econ(r).perHour :
        key === "name" ? r.name : key === "cat" ? r.cat :
        key === "blend" ? (r.blendRank !== undefined ? r.blendRank : 10000 + r.rank) : r.rank;
    };
    if (key !== "rank") rows = rows.slice().sort(function (a, b) {
      var va = val(a), vb = val(b);
      return (va < vb ? -1 : va > vb ? 1 : a.rank - b.rank) * state.dir;
    });
    return rows;
  }

  // ------------------------------------------------------------ render: stats
  function renderStats() {
    document.getElementById("asof").textContent = "Snapshot frozen " + M.asOf + " · DefiLlama";
    var s = [
      [M.n + " / " + M.n, "protocols accounted for"],
      [M.watchCovered + " / " + M.watchlistN, "watchlist covered"],
      [String(M.eligiblePre), "launch candidates ranked"],
      [M.implied.loo.toFixed(2) + "x", "implied LOO median error"],
      [M.implied.walkForward.toFixed(2) + "x", "walk-forward median error"],
      [M.odds.cvAuc.toFixed(2), "token-odds CV AUC"]
    ];
    document.getElementById("stats").innerHTML = s.map(function (x) {
      return '<div class="stat"><b>' + x[0] + '</b><span>' + x[1] + '</span></div>';
    }).join("");
    var catSel = document.getElementById("cat");
    D.categories.forEach(function (c) {
      var o = document.createElement("option"); o.value = c; o.textContent = c; catSel.appendChild(o);
    });
    document.getElementById("q").value = state.q;
    catSel.value = state.cat;
    document.getElementById("verdict").value = state.verdict;
  }

  // ------------------------------------------------------------ render: table
  var COLS = [
    ["blend", "#"], ["name", "Protocol"], ["cat", "Category"], ["chains", "Chains"],
    ["tvl", "TVL"], ["implied", "Implied"], ["p", "P(token)"], ["expected", "Expected value"],
    ["perHour", "$/hour"], ["verdict", "Verdict"]
  ];
  function renderTable() {
    var rows = visibleRows();
    document.getElementById("count").textContent = "Showing " + rows.length + " of " + ROWS.length + " · default: 50/50 rank blend (# = blend rank for candidates)";
    document.getElementById("headrow").innerHTML = COLS.map(function (c) {
      var arrow = state.sort === c[0] ? (state.dir === 1 ? " ↑" : " ↓") : "";
      var num = ["blend", "tvl", "implied", "p", "expected", "perHour"].indexOf(c[0]) >= 0 ? ' class="num"' : "";
      return '<th data-sort="' + c[0] + '"' + num + '>' + c[1] + arrow + '</th>';
    }).join("");
    document.getElementById("rows").innerHTML = rows.slice(0, 250).map(function (r) {
      var e = econ(r);
      return '<tr data-slug="' + r.slug + '"' + (state.slug === r.slug ? ' class="sel"' : "") + '>' +
        '<td class="num">' + (r.blendRank !== undefined ? r.blendRank : r.rank) + '</td>' +
        '<td><span class="nm">' + esc(r.name) + '</span><br><span class="sl">' + r.slug + '</span></td>' +
        '<td>' + esc(r.cat) + '</td><td>' + r.chains.map(esc).join(", ") + '</td>' +
        '<td class="num">' + fmtUsd(r.tvlM * 1e6) + '</td>' +
        '<td class="num">' + fmtUsd(implied(r)) + '</td>' +
        '<td class="num">' + r.p + '%</td>' +
        '<td class="num"><b>' + fmtUsd(r.expK * 1000) + '</b></td>' +
        '<td class="num">' + (r.verdict === "L" || r.verdict === "K" ? "—" : "$" + e.perHour.toFixed(2)) + '</td>' +
        '<td><span class="pill ' + r.verdict + '">' + VLABEL[r.verdict] + '</span></td></tr>';
    }).join("") + (rows.length > 250 ? '<tr><td colspan="10" style="color:var(--dim)">…and ' + (rows.length - 250) + ' more — narrow the search or a filter to see them.</td></tr>' : "");
  }
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  // ------------------------------------------------------------ render: detail
  function renderDetail() {
    var box = document.getElementById("detail");
    var r = BY_SLUG[state.slug];
    if (!r) { box.hidden = true; box.innerHTML = ""; return; }
    var e = econ(r), steps = stepsFor(r);
    var breakdown = "Implied " + fmtUsd(implied(r)) + " × √P(" + r.p + "%) = expected " + fmtUsd(r.expK * 1000) + ".";
    box.hidden = false;
    box.innerHTML =
      '<h2>' + esc(r.name) + '</h2>' +
      '<div class="meta">' + r.slug + ' · ' + esc(r.cat) + ' · ' + r.chains.map(esc).join(", ") +
      ' · TVL ' + fmtUsd(r.tvlM * 1e6) + ' · blend rank #' + (r.blendRank !== undefined ? r.blendRank : '—') + ' · board rank #' + r.rank + '</div>' +
      '<div class="kv">' +
      '<div><b>' + fmtUsd(implied(r)) + '</b><span>Implied value (peer-fitted)</span></div>' +
      '<div><b>' + r.p + '%</b><span>Share of peers this age with a token</span></div>' +
      '<div><b>' + fmtUsd(r.expK * 1000) + '</b><span>Expected value (board value)</span></div>' +
      '<div><b>' + VLABEL[r.verdict] + '</b><span>Farm verdict</span></div>' +
      '<div><b>$' + e.perHour.toFixed(2) + '/h</b><span>Expected share per hour</span></div>' +
      '<div><b>$' + e.share.toFixed(2) + '</b><span>Your expected share if it launches</span></div>' +
      '<div><b>$' + e.cost.toFixed(2) + '</b><span>Plan cost (' + e.hours.toFixed(2) + ' h, ' + esc(e.chain) + ' gas)</span></div>' +
      '<div><b>' + e.roi.toFixed(1) + 'x</b><span>Expected return on farming cost</span></div>' +
      '<div><b>' + e.breakEven + ' mo</b><span>Break-even if the token lands in 12 mo</span></div>' +
      '<div><b>$' + e.minCap + '</b><span>Minimum capital to farm it</span></div>' +
      '</div>' +
      '<p>' + breakdown + ' P(token) is the share of peer protocols of the same age, size and category that already record a token — it is not a forecast that this protocol will launch one.</p>' +
      '<h3>Farm plan — 5 steps</h3><ol>' + steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join("") + '</ol>' +
      '<p style="color:var(--muted);font-size:13px">Assumptions: airdrop pool 5% of expected value; ~' + e.farmers.toLocaleString("en-US") +
      ' active farmers estimated from TVL; cost is gas on the cheapest chain plus $5 for swaps and bridging. Change the assumptions and the verdict moves — that is the point of showing them.</p>';
  }

  // ------------------------------------------------------------ render: model
  function renderModel() {
    var im = M.implied, od = M.odds;
    document.getElementById("model").innerHTML =
      '<h2>Model &amp; honesty note</h2>' +
      '<h3>The one idea: token odds as expected value</h3>' +
      '<p>Version 3 ranked by implied value alone. This version adds a second signal — <b>P(token)</b>, the fitted share of peer protocols that already record a token — and shows <b>expected value = implied value × √(P)</b>. The square root bounds the multiplier: a young protocol with P = 25% keeps 50% of its implied value, not 25%. The page\u2019s <b>default sort is a 50/50 rank blend</b>: each candidate is ranked separately on value and on odds, and the two percentile ranks are averaged. The blend moves the board substantially — top-20 overlap with a value-only ranking is ' + od.blend.overlapTop20 + '/20, Spearman ' + od.blend.spearman.toFixed(2) + ' — which is the point: neither signal is trusted alone. The board file stays ranked by expected value — the gate needs its dollar column to fall with rank — and the detail panel shows both ranks.</p>' +
      '<h3>Implied value — fitted from the snapshot</h3>' +
      '<p><code>log(market cap) = ' + im.intercept + ' + ' + im.lnTvl + ' · ln(TVL) ' + (im.age < 0 ? '− ' : '+ ') + Math.abs(im.age) + ' · age − 0.5 · log1p(growth)</code></p>' +
      '<p>Fitted by least squares on ' + im.fitN + ' launch-eligible peers that already have a token. Leave-one-out median error <b>' + im.loo.toFixed(2) + 'x</b>; walk-forward (fit before ' + im.walkForwardCut + ', tested after) median error <b>' + im.walkForward.toFixed(2) + 'x</b>. Growth is winsorized at ±100% — one protocol reports +4448% — and enters with a fixed mild −0.5 elasticity: the fitted growth coefficient is an unstable −2.3, and the fixed value costs nothing in validation (LOO 3.09x vs 3.06x without growth).</p>' +
      '<h3>Token odds — fitted from the snapshot</h3>' +
      '<p>Logistic regression on all 758 protocols (log TVL, chain count, winsorized 7-day change, category). Age enters as a hinge, min(age, 4 years), so the fitted share rises with age and then stops: slope <b>+' + od.ageCoefPerYear.toFixed(2) + ' logit/year</b> below the knot, 0 above it. 5-fold cross-validated AUC <b>' + od.cvAuc.toFixed(2) + '</b> (folds ' + od.cvAucs.join(", ") + '). Momentum is a feature too, and its sign is negative: at age 2, a +50% week gives fitted P ' + Math.round(od.momentumAtAge2.plus50 * 100) + '%, a flat week ' + Math.round(od.momentumAtAge2.flat * 100) + '%, a −50% week ' + Math.round(od.momentumAtAge2.minus50 * 100) + '%. Fast growers are less likely to already have a token — a maturity signal, not a launch signal — so there is no momentum-boosted value column: momentum already acts through P, and multiplying by (1 + growth) would push the wrong way.</p>' +
      '<h3>Temporal check — the honest weak spot</h3>' +
      '<p>Listing dates exist for 645 of 758 protocols, so the odds model was also checked across time: fit before ' + od.temporal.cut + ' (' + od.temporal.nTrain + ' protocols, ' + Math.round(od.temporal.baseTrain * 100) + '% with a token), tested after (' + od.temporal.nTest + ', ' + Math.round(od.temporal.baseTest * 100) + '%). Temporal AUC is <b>' + od.temporal.auc.toFixed(2) + '</b>, well below the random-fold CV of ' + od.cvAuc.toFixed(2) + '. Part of the age signal is a cohort effect: older protocols simply had more time to launch — one more reason the blend never lets odds rank alone.</p>' +
      '<h3>The age curve — it rises, then plateaus</h3>' +
      '<table><thead><tr><th>Age bucket</th><th class="num">Protocols</th><th class="num">Fitted P</th><th class="num">Empirical share</th></tr></thead><tbody>' +
      M.buckets.map(function (b) { return '<tr><td>' + b[0] + '</td><td class="num">' + b[1] + '</td><td class="num">' + Math.round(b[3] * 100) + '%</td><td class="num">' + Math.round(b[2] * 100) + '%</td></tr>'; }).join("") +
      '</tbody></table>' +
      '<div class="note"><b>Read this before trusting the odds column.</b> P(token) is the share of peers that <i>already</i> have a token. It is not the probability that this protocol <i>will</i> launch one, and it punishes young protocols by construction — that is why the board uses its square root, sorts by the 50/50 blend instead of by P alone, and always shows the raw implied value beside it. A claim that launch odds fall with age would be false for this snapshot: they rise with age and plateau near 80%.</div>' +
      '<h3>Coverage — 758 / 758</h3>' +
      '<p>Every protocol in the snapshot is on this board: ' + M.eligiblePre + ' launch candidates, ' + M.liveCount + ' with a token (LIVE tab), ' + M.trackedCount + ' pre-token products tracked but not launch candidates (exchanges, bridges, wrapped or staked products — the house screen). Verdicts: FARM ' + M.verdictCounts.FARM + ' · THIN ' + M.verdictCounts.THIN + ' · SKIP ' + M.verdictCounts.SKIP + '.</p>' +
      '<h3>Assumptions behind every verdict</h3>' +
      '<p>Airdrop pool 5% of expected value; active farmers estimated as max(1000, 1000 × √(TVL / $1M)); cost is two transactions per step at the cheapest chain\u2019s gas price plus $5 for swaps and bridging; the plan takes 5.25 hours. FARM needs an 8x expected return on cost and $8 net per hour; THIN needs 2.5x; the rest is SKIP. These are stated estimates, not promises — no protocol here guarantees a token.</p>';
  }

  // ------------------------------------------------------------ events
  function render() {
    var isModel = state.view === "model";
    document.querySelectorAll("#tabs button").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-view") === state.view);
    });
    document.getElementById("controls").style.display = isModel ? "none" : "";
    document.querySelector(".tablewrap").style.display = isModel ? "none" : "";
    document.getElementById("model").hidden = !isModel;
    if (isModel) { renderModel(); document.getElementById("detail").hidden = true; }
    else { renderTable(); renderDetail(); }
    syncUrl();
  }
  document.querySelectorAll("#tabs button").forEach(function (b) {
    b.addEventListener("click", function () { state.view = b.getAttribute("data-view"); state.slug = ""; render(); });
  });
  document.getElementById("q").addEventListener("input", function (e) { state.q = e.target.value; renderTable(); syncUrl(); });
  document.getElementById("cat").addEventListener("change", function (e) { state.cat = e.target.value; renderTable(); syncUrl(); });
  document.getElementById("verdict").addEventListener("change", function (e) { state.verdict = e.target.value; renderTable(); syncUrl(); });
  document.getElementById("headrow").addEventListener("click", function (e) {
    var th = e.target.closest("th"); if (!th) return;
    var k = th.getAttribute("data-sort");
    if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = k === "name" || k === "cat" || k === "blend" ? 1 : -1; }
    renderTable(); syncUrl();
  });
  document.getElementById("rows").addEventListener("click", function (e) {
    var tr = e.target.closest("tr[data-slug]"); if (!tr) return;
    state.slug = state.slug === tr.getAttribute("data-slug") ? "" : tr.getAttribute("data-slug");
    renderTable(); renderDetail();
    if (state.slug) document.getElementById("detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
    syncUrl();
  });

  renderStats();
  render();
})();
