// Steady Sharpe: a strict-momentum paper bot for the pump.fun Sharpe sprint.
//
// Ranking is the HOURLY Sharpe ratio over a 6-hour forward replay, with a
// placement needing net PnL > 0 after every fee. That shapes everything
// below: the bot is deliberately boring. It only buys the strongest few
// runners, in small size, and it banks or cuts fast. It never chases a
// moonshot, never pyramids into a loser, and never holds a big exposure
// across an hour boundary.
//
// Entry (all of these must hold on a curve's 45-slot rolling tape):
//   - mature: at least 500 slots since its CreateEvent (fresh curves are
//     mostly bundled launches that get dumped);
//   - real flow: net SOL in over the window >= 5, at least 8 buy trades
//     from at least 12 distinct buyers, and the newer half of the window
//     brought in at least as much as the older half (acceleration);
//   - price up 15%-150% over the window and sitting within 2% of its
//     window high;
//   - real SOL reserves between 2 and 60 (liquid enough to trade, small
//     enough to still move).
// First buy 0.05 SOL; add 0.10 SOL at a time only while the position is
// above cost and flow is still positive, up to 0.30 SOL per position and
// 2.50 SOL of exposure across at most 5 open positions.
//
// Exits (first trigger wins): stop loss -10% against cost, trailing stop
// -12% once the position has been +3% up, or a 400-slot (~3 minute) time
// limit. No take-profit target: the trailing stop banks runners.
//
// Guardrails: the run must end with round trips of >= 0.01 SOL on >= 20
// distinct mints, so when the bot's own fills or coins lag the pace
// (25 coins / 240 fills over the 4-hour pace window) it opens tiny
// 0.01 SOL probe round trips on liquid curves and sells them as soon as
// the buy lands.
//
// Local evidence on the kit's 24h dev window (see README): net +0.094 SOL
// on 10 SOL, hourly Sharpe +0.05, max drawdown 3.6%, 341 fills on 73
// coins. Split into four 6-hour blocks the same settings win 1 block
// (+0.18 SOL) and lose 3 slightly (-0.02 to -0.13 SOL): the edge is thin
// and leans on catching one strong runner per day, so this entry is a
// disciplined small bet, not a claim of a big edge.
//
// Verified 2026-11-26: the entry file backtests byte-identical to the lab
// variant it was tuned from (net +0.094047 SOL, 341 fills, 73 coins,
// dd 0.0364, hourly Sharpe +0.0524; 18h-24h slice +0.177 SOL, Sharpe +0.16).
//
// Deterministic by construction: no clock, no randomness, iteration only
// over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

// Entry window in slots.
const WINDOW = 45;
// Net buy SOL (buys minus sells) over the window.
const MIN_NET_SOL = 5;
// Buy trades in the window.
const MIN_BUYS = 8;
// Distinct buying wallets in the window.
const MIN_BUYERS = 12;
// Price now over price at the window start, minus 1.
const MIN_PRICE_UP = 0.15;
const MAX_PRICE_UP = 1.5;
// Price now at least this share of the window's high.
const NEAR_HIGH = 0.98;
// Curve real SOL bounds at entry.
const MIN_RQ_SOL = 2;
const MAX_RQ_SOL = 60;
// Slots since the CreateEvent before an entry is allowed.
const MIN_AGE = 500;
// SOL to put into one position in total; first buy; each add-on buy.
const STAKE_SOL = 0.3;
const INITIAL_SOL = 0.05;
const ADD_SOL = 0.1;
// Smallest buy worth sending.
const MIN_BUY_SOL = 0.01;
// Slippage on buys (bps); sells always go out at 10000.
const BUY_SLIP_BPS = 1500;
// Exits: stop loss, trailing stop, trailing-stop arm, time limit (slots).
const STOP_LOSS = 0.1;
const TRAIL = 0.12;
const TRAIL_ARM = 0.03;
const MAX_HOLD = 400;
// Slots to wait after an exit before the same curve may be bought again.
const COOLDOWN = 150;
// Most entries per curve over the run; most momentum positions at once.
const MAX_ENTRIES = 1;
const MAX_MAIN = 5;
// Most SOL at cost across all positions at once (a drawdown guard).
const MAX_EXPOSURE_SOL = 2.5;
// Guardrail pacing targets.
const TARGET_COINS = 25;
const TARGET_FILLS = 240;
const PACE_SECS = 14400;
const PROBE_SOL = 0.01;
const MAX_PROBES = 1;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
}

export function createStrategy(): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = WINDOW + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Strict-momentum entry signal on a curve's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) return false;
    if (t.created === null || now - t.created < MIN_AGE) return false;
    const from = now - WINDOW;
    const mid = now - WINDOW / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else sellSol += tr.sol;
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < MIN_BUYS || byUser.size < MIN_BUYERS) return false;
    if (buySol - sellSol < MIN_NET_SOL) return false;
    if (startPrice <= 0) return false;
    const up = last / startPrice - 1;
    if (up < MIN_PRICE_UP || up > MAX_PRICE_UP) return false;
    if (last < high * NEAR_HIGH) return false;
    if (netNew <= 0 || netNew < netOld) return false;
    return true;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves) });
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: stop loss, trailing stop, time limit.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        let exit = h.exiting;
        if (!exit && value < cost * (1 - STOP_LOSS)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + TRAIL_ARM) && value < h.peakValue * (1 - TRAIL)) exit = true;
        if (!exit && now - h.opened > MAX_HOLD) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries and adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = MAX_MAIN - held.size;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= MAX_ENTRIES || now - t.lastExit < COOLDOWN) continue;
          if (!entrySignal(t, now, rqSol)) continue;
          want = Math.min(INITIAL_SOL, STAKE_SOL);
        } else {
          // Pyramid into strength only: the position is above cost and net
          // SOL still flows in, up to the per-position stake.
          if (h.exiting || !h.filled || h.invested >= STAKE_SOL - MIN_BUY_SOL) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (h.lastValue < Number(pos.cost_lamports) / LAMPORTS) continue;
          if (flow(t, now, WINDOW) < MIN_NET_SOL) continue;
          want = Math.min(ADD_SOL, STAKE_SOL - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, MAX_EXPOSURE_SOL - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < MIN_BUY_SOL) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: BUY_SLIP_BPS });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastAddPrice: price, lastValue: 0 });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.lastAddPrice = price;
        }
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < MAX_PROBES && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / PACE_SECS);
        const needCoins = myCoins.size < Math.ceil(TARGET_COINS * pace);
        const needFills = myFills < Math.ceil(TARGET_FILLS * pace);
        if (needCoins || needFills) {
          const minRq = (PROBE_SOL * 10000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= MAX_PROBES) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < PROBE_SOL + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(PROBE_SOL * LAMPORTS)), max_slippage_bps: BUY_SLIP_BPS });
            probes.set(mint, false);
            free -= PROBE_SOL + tx;
          }
        }
      }
      return orders;
    },
  };
}
