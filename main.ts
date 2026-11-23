// Token Radar v6 — entrypoint.
// Reads /input/snapshot.json (or --input), fits the value model and the
// token-odds model from the snapshot itself, writes the ranked board, the
// dashboard data, copies dashboard/ + screenshots/ to the output directory,
// and writes /output/dossier.json with buildDossier from vendor/.
// Node 22, standard library only. Deterministic and offline: no random,
// no network, no timestamps in any output, so two runs are byte-identical.
//
// Usage (sandbox):  node main.ts
// Usage (local):    node main.ts --input <snapshot.json> --output <out dir>

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-board.ts";
import {
  FAMILY_ORDER,
  GAS_USD_PER_TX,
  ageYears,
  blendStats,
  blendStatsFromValues,
  cheapestGas,
  empiricalAgeBuckets,
  farmTemplateTable,
  fitImplied,
  fitTokenOdds,
  fittedOddsAtAge,
  fmtUsd,
  hasToken,
  launchEligible,
  median,
  planFamily,
  scoreAll,
  displayName,
  type Snapshot,
  type SnapshotProtocol,
} from "./lib/model.ts";

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));

function argValue(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function parseArgs(): { input: string; output: string } {
  const argv = process.argv.slice(2);
  const input = argValue(argv, "--input") ?? "/input/snapshot.json";
  const output =
    argValue(argv, "--output") ??
    process.env.MAKEFUN_OUTPUT_DIR ??
    "/output";
  return { input, output };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function main(): void {
  const { input, output } = parseArgs();
  const snapshot: Snapshot = JSON.parse(fs.readFileSync(input, "utf8"));
  const asOf = new Date(snapshot.as_of + "T00:00:00Z");
  const protocols: SnapshotProtocol[] = [...snapshot.protocols].sort((a, b) =>
    a.slug.localeCompare(b.slug),
  );
  const knownAges = protocols
    .map((p) => (p.listed_at ? ageYears(p, asOf, 0) : null))
    .filter((a): a is number => a !== null);
  const medianAge = median(knownAges);

  const impliedFit = fitImplied(protocols, asOf, medianAge);
  const oddsFit = fitTokenOdds(protocols, asOf, medianAge);
  const scored = scoreAll(protocols, asOf, medianAge, impliedFit, oddsFit);

  // Rank by expected value (implied x sqrt(P)), ties broken by slug so the
  // order is fully deterministic. The board file must stay in this order:
  // the gate requires implied_value_usd to fall as rank rises. The
  // dashboard's DEFAULT sort is different — the 50/50 rank blend of
  // implied value and P(token) — and the page says so; the detail panel
  // shows both ranks for every row.
  const ranked = [...scored].sort(
    (a, b) => b.expected - a.expected || a.protocol.slug.localeCompare(b.protocol.slug),
  );
  const blend = blendStats(scored);
  // The dashboard sorts the ROUNDED values it ships (expected to $100K,
  // P to whole percent), so the meta blend is computed from exactly those
  // rounded values — otherwise near-tied rows order differently in the page
  // than in this meta. The full-precision blend stays in the run summary.
  const blendRounded = blendStatsFromValues(
    scored
      .filter((r) => !hasToken(r.protocol) && r.eligible)
      .map((r) => {
        const expK = Math.round(r.expected / 100000);
        const pPct = Math.round(r.pToken * 100);
        return {
          slug: r.protocol.slug,
          implied: (expK * 100 * 1000) / Math.sqrt(Math.max(1, pPct) / 100),
          pToken: pPct / 100,
          expected: expK,
        };
      }),
  );
  const watchlist = new Set(snapshot.watchlist);
  const watchCovered = ranked.filter((r) => watchlist.has(r.protocol.slug)).length;

  // ------------------------------------------------------------ board.json
  const board = {
    as_of: snapshot.as_of,
    model:
      "expected value = implied value x sqrt(P(has token)); implied = peer-fitted log market cap on launch-eligible token-bearing protocols; P(has token) = logistic fit on all 758 snapshot protocols, age hinged at 4 years; the dashboard's default sort is the 50/50 rank blend of implied value and P(has token)",
    rows: ranked.map((r, i) => ({
      slug: r.protocol.slug,
      name: r.protocol.name,
      rank: i + 1,
      implied_value_usd: Math.max(1, Math.round(r.expected)),
      farm_steps: r.farmSteps,
    })),
  };
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "board.json"), JSON.stringify(board, null, 2) + "\n", "utf8");

  // ------------------------------------------------------------ dashboard
  const outDashboard = path.join(output, "dashboard");
  fs.mkdirSync(outDashboard, { recursive: true });
  for (const name of ["index.html", "app.css", "app.js"]) {
    fs.copyFileSync(path.join(REPO_ROOT, "dashboard", name), path.join(outDashboard, name));
  }

  // Chains table: only chains a row can actually show (its six cheapest,
  // plus its cheapest overall) — the full list of 303 names would cost 3KB.
  const gasOf = (c: string): number => GAS_USD_PER_TX[c] ?? 0.1;
  const chains: string[] = [];
  const chainIndex = new Map<string, number>();
  const addChain = (c: string): void => {
    if (!chainIndex.has(c)) {
      chainIndex.set(c, chains.length);
      chains.push(c);
    }
  };
  const sortedChains = (p: SnapshotProtocol): string[] =>
    [...p.chains].sort((a, b) => gasOf(a) - gasOf(b));
  for (const p of protocols) {
    for (const c of sortedChains(p).slice(0, 2)) addChain(c);
  }
  const categories: string[] = [];
  const catIndex = new Map<string, number>();
  for (const p of protocols) {
    const c = p.category ?? "Uncategorised";
    if (!catIndex.has(c)) {
      catIndex.set(c, categories.length);
      categories.push(c);
    }
  }
  const medianLogTvl =
    median(protocols.map((p) => Math.log10(Math.max(1, p.tvl_usd))));
  const medianChains = median(protocols.map((p) => p.chains.length));
  const bucketMids = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5];
  const buckets = empiricalAgeBuckets(protocols, asOf, medianAge).map((b, i) => [
    b.label,
    b.n,
    round3(b.rate),
    round3(fittedOddsAtAge(bucketMids[i], oddsFit, medianLogTvl, medianChains)),
  ]);

  const rows: string[] = ranked.map((r) => {
    const p = r.protocol;
    const name =
      p.name === displayName(p.slug) ? "" : p.name;
    const fields = [
      p.slug,
      name,
      Math.round(r.expected / 100000),
      Math.round(r.pToken * 100),
      Math.round(p.tvl_usd / 1000000),
      String(catIndex.get(p.category ?? "Uncategorised") ?? 0),
      sortedChains(p).slice(0, 2).map((c) => String(chainIndex.get(c) ?? 0)).join(","),
      String(FAMILY_ORDER.indexOf(planFamily(p))),
      r.econ.verdict === "FARM"
        ? "F"
        : r.econ.verdict === "THIN"
          ? "T"
          : r.econ.verdict === "SKIP"
            ? "S"
            : r.econ.verdict === "LIVE"
              ? "L"
              : "K",
    ];
    return fields.join("|");
  });

  const verdictCounts: Record<string, number> = { FARM: 0, THIN: 0, SKIP: 0, LIVE: 0, TRACKED: 0 };
  for (const r of scored) verdictCounts[r.econ.verdict]++;
  const eligiblePre = scored.filter((r) => !hasToken(r.protocol) && r.eligible).length;
  const liveCount = scored.filter((r) => hasToken(r.protocol)).length;
  const trackedCount = scored.filter((r) => !hasToken(r.protocol) && !r.eligible).length;

  const data = {
    meta: {
      asOf: snapshot.as_of,
      floorUsd: snapshot.floor_usd,
      n: protocols.length,
      watchlistN: snapshot.watchlist.length,
      watchCovered,
      eligiblePre,
      liveCount,
      trackedCount,
      verdictCounts,
      implied: {
        intercept: round3(impliedFit.intercept),
        lnTvl: round3(impliedFit.lnTvl),
        age: round3(impliedFit.age),
        growthCoef: impliedFit.growthCoef,
        loo: round2(impliedFit.loo),
        walkForward: round2(impliedFit.walkForward),
        walkForwardCut: impliedFit.walkForwardCut,
        fitN: impliedFit.fitN,
        medianAge: round2(impliedFit.medianAge),
      },
      odds: {
        cvAuc: round3(oddsFit.cvAuc),
        cvAucs: oddsFit.cvAucs.map((v) => round3(v)),
        ageCoefPerYear: round3(oddsFit.ageCoefPerYear),
        ageKnot: oddsFit.ageKnot,
        temporal: {
          cut: oddsFit.temporal.cut,
          nTrain: oddsFit.temporal.nTrain,
          nTest: oddsFit.temporal.nTest,
          auc: round3(oddsFit.temporal.auc),
          baseTrain: round3(oddsFit.temporal.baseTrain),
          baseTest: round3(oddsFit.temporal.baseTest),
        },
        momentumAtAge2: {
          plus50: round3(fittedOddsAtAge(2, oddsFit, medianLogTvl, medianChains, 0.5)),
          flat: round3(fittedOddsAtAge(2, oddsFit, medianLogTvl, medianChains, 0)),
          minus50: round3(fittedOddsAtAge(2, oddsFit, medianLogTvl, medianChains, -0.5)),
        },
        blend: {
          overlapTop20: blendRounded.overlapTop20,
          spearman: round3(blendRounded.spearman),
          top12: blendRounded.topBlend.slice(0, 12),
        },
      },
      buckets,
    },
    chains,
    categories,
    templates: farmTemplateTable(),
    rows: rows.join("\n"),
  };
  const dataJs = "const RADAR_DATA = " + JSON.stringify(data) + ";\n";
  fs.writeFileSync(path.join(outDashboard, "data.js"), dataJs, "utf8");

  // ------------------------------------------------------------ screenshots
  const srcShots = path.join(REPO_ROOT, "screenshots");
  const outShots = path.join(output, "screenshots");
  fs.mkdirSync(outShots, { recursive: true });
  if (fs.existsSync(srcShots)) {
    for (const f of fs.readdirSync(srcShots).sort()) {
      if (/\.(png|jpg|jpeg)$/i.test(f)) {
        fs.copyFileSync(path.join(srcShots, f), path.join(outShots, f));
      }
    }
  }

  // ------------------------------------------------------------ dossier
  const dossier = buildDossier(output, { text_max_bytes: 65536 });
  fs.writeFileSync(path.join(output, "dossier.json"), dossier);

  const summary = {
    protocols: protocols.length,
    boardRows: board.rows.length,
    watchlistCovered: `${watchCovered}/${snapshot.watchlist.length}`,
    eligiblePre,
    liveCount,
    trackedCount,
    verdictCounts,
    impliedLoo: round2(impliedFit.loo),
    impliedWalkForward: round2(impliedFit.walkForward),
    oddsCvAuc: round3(oddsFit.cvAuc),
    oddsAgeCoef: round3(oddsFit.ageCoefPerYear),
    oddsTemporalAuc: round3(oddsFit.temporal.auc),
    oddsTemporalCut: oddsFit.temporal.cut,
    oddsTemporalN: `${oddsFit.temporal.nTrain}/${oddsFit.temporal.nTest}`,
    blendOverlapTop20: blend.overlapTop20,
    blendSpearman: round3(blend.spearman),
    blendRoundedOverlapTop20: blendRounded.overlapTop20,
    blendRoundedSpearman: round3(blendRounded.spearman),
    topBlend: blend.topBlend.slice(0, 12),
    topBlendRounded: blendRounded.topBlend.slice(0, 12),
    topExpected: ranked.slice(0, 5).map((r) => ({
      slug: r.protocol.slug,
      expected: fmtUsd(r.expected),
      implied: fmtUsd(r.implied),
      p: round2(r.pToken),
    })),
    dossierBytes: dossier.length,
    boardBytes: fs.statSync(path.join(output, "board.json")).size,
    dataJsBytes: Buffer.byteLength(dataJs, "utf8"),
  };
  console.log(JSON.stringify(summary, null, 2));
}

main();
