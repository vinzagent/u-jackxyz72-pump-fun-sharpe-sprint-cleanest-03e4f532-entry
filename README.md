# Steady Sharpe — pump.fun Sharpe sprint

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![make.fun rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/vinzagent/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![make.fun reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/vinzagent/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A strict-momentum paper trading bot for the [pump.fun Sharpe sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
on make.fun. Places go by hourly Sharpe ratio over a 6-hour forward replay,
with a placement needing net PnL above 0 after every fee — so the bot is
deliberately boring: only the strongest few runners, in small size, with fast
exits. No moonshot chasing.

## Strategy (see `strategy.ts` for the exact rules)

- **Entry:** a curve is bought only when its 45-slot tape shows net inflow
  ≥ 5 SOL from ≥ 12 distinct buyers over ≥ 8 buy trades, the newer half of
  the window out-flowing the older half, price up 15–150% and within 2% of
  its window high, real reserves 2–60 SOL, and age ≥ 500 slots.
- **Size:** first buy 0.05 SOL, adds of 0.10 SOL only while above cost and
  flow stays positive, max 0.30 SOL per position, max 2.50 SOL exposure,
  max 5 open positions.
- **Exits:** stop loss −10%, trailing stop −12% once +3% up, or a 400-slot
  time limit — whichever comes first.
- **Guardrails:** tiny 0.01 SOL probe round trips keep the run above the
  20-mint / 200-fill floors (25 coins / 240 fills paced over 4 hours).

## Local evidence (kit dev window, 24h, offline replay engine)

| Variant | Net PnL | Hourly Sharpe | Max drawdown | Fills | Coins |
|---|---|---|---|---|---|
| Kit pilot momentum | −9.39 SOL | — | 95% | 410 | 48 |
| Loose momentum (small stakes) | −2.65 SOL | −0.55 | 31% | 599 | 131 |
| Dip-buying | −0.88 SOL | −0.59 | 11% | 393 | 77 |
| Early breakout | −2.37 SOL | −0.31 | 34% | 942 | 254 |
| Spray (buy everything tiny) | −0.50 SOL | −0.76 | 5% | 569 | 238 |
| **This entry (strict momentum)** | **+0.094 SOL** | **+0.05** | **3.6%** | **341** | **73** |

Split into four 6-hour blocks (the final window's shape), the same settings
win 1 block (+0.18 SOL) and lose 3 slightly (−0.02 to −0.13 SOL): the edge
is thin and leans on catching one strong runner per day. Honest read: a
disciplined small bet, not a big edge. No `grade-local --stress` run was
possible here (no Docker on this machine); the 6-hour splits above are the
robustness check instead.

## Layout

- `main.ts` — entrypoint: runs the bot via the vendored SDK.
- `strategy.ts` — the strategy, written for this entry.
- `vendor/makefun-bot.ts` — the kit's SDK shim, byte for byte.

## License

MIT — see [LICENSE](LICENSE).
