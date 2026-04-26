# propline-parlay-ev

Compute the **true** EV of a parlay using [PropLine's](https://prop-line.com) no-vig fair lines.

> Sportsbooks compound their per-leg vig when you parlay — a 5-leg parlay can be priced at 25%+ implied vig, even if each individual leg is only 5%. This tool prices each leg's no-vig fair probability (anchored to Pinnacle, with Bovada fallback), multiplies them for the parlay's true joint probability, and tells you whether the parlay is +EV or -EV.

A reference implementation (~300 LOC) of how to use the [`propline`](https://www.npmjs.com/package/propline) Node SDK's `getEventEv` to do this kind of evaluation outside the PropLine UI.

## Quickstart

```bash
git clone https://github.com/proplineapi/propline-parlay-ev
cd propline-parlay-ev
npm install

export PROPLINE_API_KEY=...   # Pro tier required for /ev (free at https://prop-line.com)
npm start -- examples/sample-parlay.json
```

Sample output:

```
Parlay legs:
Leg                                            Price   Book p   Fair p     Edge
─────────────────────────────────────────────────────────────────────────────
Phillies @ Braves · Total Under 8.5             -113    53.1%    53.7%   +0.94%
Braves moneyline                                -118    54.1%    54.4%   +0.45%
─────────────────────────────────────────────────────────────────────────────

Parlay summary:
  Stake:                  $100.00
  Decimal payout:         3.483× (american +248)
  Payout if win:          $348.34 (profit $248.34)
  Book's implied prob:    28.74%
  No-vig fair prob:       29.21%
  EV per dollar staked:   +1.78%
  Expected $:             +$1.78

Fair probabilities anchored to pinnacle.
Independence assumption: same-game correlations (e.g. NFL anytime
TD + same team's spread) skew this; cross-game parlays approximate
independence well enough.
```

## Input format

JSON file with a `stake` and a list of `legs`:

```json
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
    }
  ]
}
```

Per-leg fields:

| Field            | Required | Notes |
| ---------------- | -------- | ----- |
| `label`          | no       | Display string. Falls back to `player · market · outcome point`. |
| `sport`          | yes      | PropLine sport key (e.g. `baseball_mlb`). |
| `event_id`       | yes      | PropLine event ID. |
| `market`         | yes      | PropLine market key (e.g. `h2h`, `totals`, `batter_total_bases`). |
| `player`         | no       | Player name for prop legs. Empty for h2h/totals/spreads. PropLine's `(SEA)` team-suffix style is auto-stripped. |
| `point`          | no       | Numeric line / point. Null/omit for h2h moneylines. |
| `outcome`        | yes      | `Over`, `Under`, `Yes`, `No`, or a team name. |
| `price_american` | yes      | American odds offered by the book the user took. |
| `book`           | no       | PropLine book key. Informational only — the parlay's price comes from your input, not a lookup. |

See [`examples/sample-parlay.json`](examples/sample-parlay.json).

## How EV is computed

For each leg, we hit `client.getEventEv(sport, event_id)` and find the matching `(market, player, point, outcome)` tuple in the response. Each leg has:

- `decimal_leg = americanToDecimal(price_american)` — the book's payout multiple if this leg hits.
- `fair_prob_leg` — PropLine's no-vig fair probability for this outcome (Pinnacle preferred, Bovada fallback).
- `book_prob_leg = americanToImpliedProb(price_american)` — the book's implied probability *with vig*.

Then the parlay rolls them up:

```
parlay_decimal   = Π decimal_leg
parlay_fair_prob = Π fair_prob_leg
parlay_book_prob = Π book_prob_leg
ev_pct           = (parlay_fair_prob × (parlay_decimal - 1) - (1 - parlay_fair_prob)) × 100
```

See [`src/parlay.ts`](src/parlay.ts) for the full math.

## Caveats — read these

1. **Independence assumption.** Multiplying per-leg fair probabilities assumes the legs are independent. Cross-game parlays are reasonably independent. **Same-game parlays** (NFL anytime TD + same team's spread, NBA player points + team total) are not — sportsbook same-game-parlay pricing factors correlations in. This tool will tell you a same-game parlay is +EV when in reality the book's correlation adjustment may have already wiped that edge out. Treat SGPs cautiously.

2. **Pinnacle anchor coverage.** Pinnacle prices game lines on most major sports but doesn't offer the breadth of player props that DraftKings/FanDuel do. When Pinnacle doesn't price a leg, PropLine falls back to Bovada — still vigless after normalization, but a less sharp anchor. The `Fair p` column is only as good as the anchor.

3. **Tier requirements.** `/ev` is a Pro-tier endpoint ($19/mo). Free tier returns 403.

## Why this exists

If you put `5 legs at -110` into a sportsbook's parlay calculator, it'll give you `+2400` payout and tell you "great parlay!" The book is actually pricing the parlay at ~26% implied probability vs the no-vig joint probability of ~31% — they've vig'd you 5%. PropLine's `/ev` endpoint computes the no-vig view per leg, and this tool composes them into the parlay-level number you actually need to make the bet vs no-bet decision.

## License

MIT.
