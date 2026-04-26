/**
 * Parlay EV math.
 *
 * Each leg has:
 *   - The book's *offered* price (what the user took)
 *   - The leg's *no-vig fair probability* (PropLine derives this from
 *     Pinnacle / Bovada with vig stripped)
 *
 * Independent-legs assumption: the joint probability is the product of
 * the per-leg fair probabilities. Sportsbooks correlation-adjust some
 * same-game parlays (NFL TD scorer + spread, NBA player + team total),
 * but for cross-game parlays — the natural use case for a +EV parlay —
 * independence is a reasonable first approximation.
 *
 * Parlay decimal payout = product of per-leg decimals.
 * Parlay fair prob     = product of per-leg fair probs.
 *
 * EV per dollar staked:
 *   ev = fair_prob × (decimal_total - 1) - (1 - fair_prob)
 *
 * Positive = +EV. Negative = -EV. Zero = breakeven.
 */

export interface ParlayLeg {
  /** A label for this leg in printed output (player + market + line). */
  label: string;
  /** The American odds offered by the book the user took. */
  priceAmerican: number;
  /** No-vig fair probability of this leg (0..1). */
  fairProb: number;
  /** Optional metadata for explaining the leg. */
  book?: string;
  fairSource?: string;
}

export interface ParlayResult {
  legs: ParlayLeg[];
  /** Implied (vigged) per-leg probabilities — i.e. what the book is
   *  pricing this leg at. Useful when comparing book-implied vs no-vig. */
  legImpliedProbs: number[];
  /** Per-leg decimal payouts. */
  legDecimals: number[];
  /** Decimal payout if all legs hit. */
  parlayDecimal: number;
  /** Parlay's no-vig joint probability (product of per-leg fair probs). */
  parlayFairProb: number;
  /** Book's parlay-implied probability — product of per-leg vigged
   *  probabilities. The gap between this and parlayFairProb is the
   *  parlay's vig (a 5-leg parlay can compound to 25% vig easily). */
  parlayBookProb: number;
  /** EV percent on a unit stake. Positive = +EV. */
  evPct: number;
  /** EV in dollars on a stake. */
  evDollars: number;
  /** What the parlay would pay back on `stake` if it hit. */
  parlayPayout: number;
  stake: number;
}

export function americanToDecimal(price: number): number {
  if (price > 0) return price / 100 + 1;
  return 100 / -price + 1;
}

export function americanToImpliedProb(price: number): number {
  if (price > 0) return 100 / (price + 100);
  return -price / (-price + 100);
}

export function computeParlay(
  legs: ParlayLeg[],
  stake: number,
): ParlayResult {
  const legDecimals = legs.map((l) => americanToDecimal(l.priceAmerican));
  const legImpliedProbs = legs.map((l) =>
    americanToImpliedProb(l.priceAmerican),
  );

  const parlayDecimal = legDecimals.reduce((a, b) => a * b, 1);
  const parlayFairProb = legs.reduce((a, l) => a * l.fairProb, 1);
  const parlayBookProb = legImpliedProbs.reduce((a, p) => a * p, 1);

  // Standard EV formula: probability of win × profit - probability of
  // loss × stake. On a $1 unit, profit-if-win = decimal - 1, loss = 1.
  const evPerUnit =
    parlayFairProb * (parlayDecimal - 1) - (1 - parlayFairProb);
  const evPct = evPerUnit * 100;
  const evDollars = stake * evPerUnit;
  const parlayPayout = stake * parlayDecimal;

  return {
    legs,
    legImpliedProbs,
    legDecimals,
    parlayDecimal,
    parlayFairProb,
    parlayBookProb,
    evPct,
    evDollars,
    parlayPayout,
    stake,
  };
}
