#!/usr/bin/env node
/**
 * propline-parlay-ev — compute the true EV of a parlay against
 * PropLine's no-vig fair lines.
 *
 * Usage:
 *   PROPLINE_API_KEY=... npx tsx src/index.ts examples/sample-parlay.json
 *
 * The input JSON describes the parlay's legs. For each leg we hit
 * `client.getEventEv(sport, eventId)` and pull the no-vig fair
 * probability for the matching outcome. Then multiply per-leg fair
 * probabilities for the parlay's true probability, multiply per-leg
 * decimal odds for the payout multiple, and report the EV.
 */

import { readFileSync } from "node:fs";
import { PropLine } from "propline";
import {
  americanToDecimal,
  americanToImpliedProb,
  computeParlay,
  type ParlayLeg,
} from "./parlay.js";

interface ParlayInput {
  /** Total stake on the parlay (USD). */
  stake: number;
  legs: LegInput[];
}

interface LegInput {
  /** Display label for this leg ("Aaron Judge OVER 1.5 HR"). */
  label?: string;
  /** PropLine sport key. */
  sport: string;
  /** PropLine event ID. */
  event_id: string | number;
  /** Market key the leg lives on. */
  market: string;
  /** Player name for prop legs. Empty for h2h/totals/spreads. */
  player?: string;
  /** Numeric line / point. Null/omit for h2h moneylines. */
  point?: number | null;
  /** "Over", "Under", "Yes", "No", or a team name. */
  outcome: string;
  /** American odds offered by the book the user took. */
  price_american: number;
  /** Book key (informational; printed but not used for math). */
  book?: string;
}

interface CliArgs {
  jsonPath: string;
}

function parseArgs(argv: string[]): CliArgs {
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    printHelp();
    process.exit(argv.length === 0 ? 2 : 0);
  }
  return { jsonPath: argv[0]! };
}

function printHelp(): void {
  console.log(`
propline-parlay-ev

Usage:
  PROPLINE_API_KEY=... propline-parlay-ev <parlay.json>

The JSON file should match this shape:
{
  "stake": 100,
  "legs": [
    {
      "label": "Aaron Judge OVER 1.5 Total Bases",
      "sport": "baseball_mlb",
      "event_id": "11049",
      "market": "batter_total_bases",
      "player": "Aaron Judge",
      "point": 1.5,
      "outcome": "Over",
      "price_american": 130,
      "book": "draftkings"
    },
    ...
  ]
}

See examples/sample-parlay.json for a working example.
`);
}

async function main(): Promise<void> {
  const apiKey = process.env.PROPLINE_API_KEY;
  if (!apiKey) {
    console.error(
      "PROPLINE_API_KEY env var is required. Get a free key at https://prop-line.com",
    );
    process.exit(2);
  }
  const cli = parseArgs(process.argv.slice(2));
  const input = JSON.parse(readFileSync(cli.jsonPath, "utf8")) as ParlayInput;

  if (!Array.isArray(input.legs) || input.legs.length === 0) {
    console.error("Parlay must include at least one leg.");
    process.exit(1);
  }
  if (!Number.isFinite(input.stake) || input.stake <= 0) {
    console.error("Parlay stake must be a positive number.");
    process.exit(1);
  }

  const client = new PropLine(apiKey);

  // Cache one /ev call per (sport, event) regardless of how many legs
  // the parlay has on that event — a 5-leg same-game parlay should
  // still only hit the API once.
  const evCache = new Map<string, EventEv>();
  const fairProbs: number[] = [];
  const fairSources: string[] = [];

  for (const leg of input.legs) {
    const key = `${leg.sport}::${leg.event_id}`;
    let ev = evCache.get(key);
    if (!ev) {
      ev = (await client.getEventEv(leg.sport, leg.event_id)) as EventEv;
      evCache.set(key, ev);
    }
    const match = findFair(ev, leg);
    if (!match) {
      console.error(
        `\nNo no-vig fair line found for leg "${labelFor(leg)}" on ${leg.sport}/${leg.event_id}.\n` +
          `  Pinnacle / Bovada may not price this market — try a different book or skip the leg.`,
      );
      process.exit(1);
    }
    fairProbs.push(match.fairProb);
    fairSources.push(match.fairSource);
  }

  const parlayLegs: ParlayLeg[] = input.legs.map((l, i) => ({
    label: labelFor(l),
    priceAmerican: l.price_american,
    fairProb: fairProbs[i]!,
    book: l.book,
    fairSource: fairSources[i]!,
  }));

  const result = computeParlay(parlayLegs, input.stake);
  printResult(result);
}

function labelFor(l: LegInput): string {
  if (l.label) return l.label;
  const parts: string[] = [];
  if (l.player) parts.push(l.player);
  parts.push(l.market);
  parts.push(l.outcome);
  if (l.point !== null && l.point !== undefined) parts.push(String(l.point));
  return parts.join(" · ");
}

interface EventEv {
  id: string | number;
  home_team: string;
  away_team: string;
  lines: Array<{
    market_key: string;
    description: string;
    point: number | null;
    fair_source: string;
    fair_probs: Record<string, number>;
    outcomes: Array<{
      name: string;
      point?: number | null;
    }>;
  }>;
}

function normalizeName(s: string): string {
  return s
    .replace(/\s*\([^)]+\)\s*$/, "")
    .trim()
    .toLowerCase();
}

function findFair(
  ev: EventEv,
  leg: LegInput,
): { fairProb: number; fairSource: string } | null {
  const wantPlayer = normalizeName(leg.player ?? "");
  const wantOutcome = leg.outcome.toLowerCase();
  for (const line of ev.lines ?? []) {
    if (line.market_key !== leg.market) continue;
    if (wantPlayer) {
      if (normalizeName(line.description ?? "") !== wantPlayer) continue;
    }
    if (leg.point !== null && leg.point !== undefined) {
      // Spreads: the line's point is the favorite's signed handicap;
      // each leg's actual point lives on the outcome row. Match
      // against any leg whose own point matches.
      if (leg.market === "spreads") {
        const oc = (line.outcomes ?? []).find(
          (o) =>
            o.name.toLowerCase() === wantOutcome &&
            (o.point ?? null) === leg.point,
        );
        if (!oc) continue;
      } else if (line.point !== leg.point) {
        continue;
      }
    }
    // Find the matching named outcome (case-insensitive).
    const matchKey = Object.keys(line.fair_probs).find(
      (k) => k.toLowerCase() === wantOutcome,
    );
    if (!matchKey) continue;
    return {
      fairProb: line.fair_probs[matchKey]!,
      fairSource: line.fair_source,
    };
  }
  return null;
}

function fmtPrice(p: number): string {
  return p > 0 ? `+${p}` : String(p);
}

function fmtPct(n: number, decimals = 2): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(decimals)}%`;
}

function fmtUsd(n: number): string {
  const sign = n >= 0 ? "+" : "−";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function pad(s: string, n: number, right = false): string {
  if (s.length >= n) return s;
  const fill = " ".repeat(n - s.length);
  return right ? fill + s : s + fill;
}

function printResult(r: ReturnType<typeof computeParlay>): void {
  console.log("\nParlay legs:");
  console.log(
    pad("Leg", 42) +
      pad("Price", 9, true) +
      pad("Book p", 9, true) +
      pad("Fair p", 9, true) +
      pad("Edge", 9, true),
  );
  console.log("─".repeat(42 + 9 + 9 + 9 + 9));
  for (let i = 0; i < r.legs.length; i++) {
    const l = r.legs[i]!;
    const bookProb = r.legImpliedProbs[i]!;
    const fairProb = l.fairProb;
    // Per-leg implied EV: fairProb × decimal - 1.
    const legEvPct = (fairProb * americanToDecimal(l.priceAmerican) - 1) * 100;
    console.log(
      pad(l.label.slice(0, 42), 42) +
        pad(fmtPrice(l.priceAmerican), 9, true) +
        pad(`${(bookProb * 100).toFixed(1)}%`, 9, true) +
        pad(`${(fairProb * 100).toFixed(1)}%`, 9, true) +
        pad(fmtPct(legEvPct), 9, true),
    );
  }
  console.log("─".repeat(42 + 9 + 9 + 9 + 9));
  console.log("\nParlay summary:");
  console.log(
    `  Stake:                  $${r.stake.toFixed(2)}\n` +
      `  Decimal payout:         ${r.parlayDecimal.toFixed(3)}× ` +
      `(american ${decimalToAmerican(r.parlayDecimal)})\n` +
      `  Payout if win:          $${r.parlayPayout.toFixed(2)} ` +
      `(profit $${(r.parlayPayout - r.stake).toFixed(2)})\n` +
      `  Book's implied prob:    ${(r.parlayBookProb * 100).toFixed(2)}%\n` +
      `  No-vig fair prob:       ${(r.parlayFairProb * 100).toFixed(2)}%\n` +
      `  EV per dollar staked:   ${fmtPct(r.evPct)}\n` +
      `  Expected $:             ${fmtUsd(r.evDollars)}`,
  );

  console.log(
    `\nFair probabilities anchored to ${[...new Set(r.legs.map((l) => l.fairSource).filter(Boolean))].join(", ") || "n/a"}.\n` +
      `Independence assumption: same-game correlations (e.g. NFL anytime\n` +
      `TD + same team's spread) skew this; cross-game parlays approximate\n` +
      `independence well enough.`,
  );
  // Touch the helper so typecheck doesn't drop the import.
  void americanToImpliedProb;
}

function decimalToAmerican(decimal: number): string {
  if (decimal >= 2) return `+${Math.round((decimal - 1) * 100)}`;
  return String(Math.round(-100 / (decimal - 1)));
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
