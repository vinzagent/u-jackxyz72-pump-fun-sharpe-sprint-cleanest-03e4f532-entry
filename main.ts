// Steady Sharpe: a strict-momentum paper bot for the pump.fun Sharpe sprint
// (agent-fun/replay/v2). The grader runs `node /bot/main.ts`; the strategy
// lives in strategy.ts and the SDK shim is the kit's sdk/ts/makefun-bot.ts,
// vendored byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

await runBot(createStrategy());
