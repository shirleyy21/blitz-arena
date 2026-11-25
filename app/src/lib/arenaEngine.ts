export type ArenaStatus = "lobby" | "active" | "finished";
export type PositionSide = "flat" | "long" | "short";
export type Leverage = 10 | 25 | 50 | 100;
export type TradeAction = "openLong" | "openShort" | "close" | "flip";
export type ExecutionMode = "onchain_er" | "live_oracle_duel";

export const STARTING_EQUITY_USD = 10_000;
export const HOT_STREAK_THRESHOLD = 3;
export const HOT_STREAK_BONUS_RATE = 0.05; // +5% realized profit bonus on >=3 streak

export type TraderSlot = {
  id: string;
  name: string;
  wallet: string;
  isUser: boolean;
  isBot?: boolean;
  equityUsd: number;
  positionSide: PositionSide;
  leverage: number;
  entryPrice: number;
  marginUsd: number;
  tradesCount: number;
  winsCount: number;
  streak: number;
  liquidated: boolean;
  claimed: boolean;
};

export type TradeMarker = {
  id: number;
  timestamp: number;
  price: number;
  action: TradeAction;
  leverage: number;
  pnlUsd?: number;
};

export type TelemetryEntry = {
  id: number;
  time: string;
  layer: "L1" | "ER" | "CRANK" | "ORACLE";
  tone: "info" | "success" | "warn" | "error";
  message: string;
  latencyMs?: number;
  signature?: string;
};

export type ArenaState = {
  arenaId: string;
  mode: ExecutionMode;
  status: ArenaStatus;
  entryFeeSol: number;
  potSol: number;
  durationSecs: number;
  startTsMs: number;
  endTsMs: number;
  crankScheduled: boolean;
  crankTicks: number;
  lastCrankPrice: number;
  finalPrice: number;
  winnerWallet: string;
  winnerName: string;
  winnerEquityUsd: number;
  delegatedToEr: boolean;
  committedToL1: boolean;
  players: TraderSlot[];
};

export function computeUnrealizedPnl(
  slot: TraderSlot,
  currentPrice: number,
): number {
  if (
    slot.liquidated ||
    slot.positionSide === "flat" ||
    slot.entryPrice <= 0 ||
    slot.marginUsd <= 0
  ) {
    return 0;
  }
  const delta = currentPrice - slot.entryPrice;
  const signedDelta = slot.positionSide === "long" ? delta : -delta;
  return (slot.marginUsd * slot.leverage * signedDelta) / slot.entryPrice;
}

export function computeMarkEquity(
  slot: TraderSlot,
  currentPrice: number,
): number {
  if (slot.liquidated) return 0;
  const mark = slot.equityUsd + computeUnrealizedPnl(slot, currentPrice);
  return Math.max(0, mark);
}

export function computeLiquidationPrice(slot: TraderSlot): number | null {
  if (
    slot.liquidated ||
    slot.positionSide === "flat" ||
    slot.entryPrice <= 0 ||
    slot.leverage <= 0
  ) {
    return null;
  }
  const moveFraction = 1 / slot.leverage;
  return slot.positionSide === "long"
    ? slot.entryPrice * (1 - moveFraction)
    : slot.entryPrice * (1 + moveFraction);
}

/** Exact TypeScript mirror of `programs/blitz-arena/src/math.rs` for 1-to-1 parity */
export function applyTradeAction(
  slot: TraderSlot,
  action: TradeAction,
  leverage: Leverage,
  livePrice: number,
): { next: TraderSlot; realizedPnl: number; triggeredBonus: boolean; rekt: boolean } {
  const next: TraderSlot = { ...slot };
  let realizedPnl = 0;
  let triggeredBonus = false;
  let rekt = false;

  if (next.liquidated) {
    return { next, realizedPnl: 0, triggeredBonus: false, rekt: true };
  }

  const settleOpen = () => {
    if (next.positionSide === "flat") return;
    const rawPnl = computeUnrealizedPnl(next, livePrice);
    let finalPnl = rawPnl;
    if (rawPnl > 0) {
      next.winsCount += 1;
      next.streak += 1;
      if (next.streak >= HOT_STREAK_THRESHOLD) {
        finalPnl += rawPnl * HOT_STREAK_BONUS_RATE;
        triggeredBonus = true;
      }
    } else if (rawPnl < 0) {
      next.streak = 0;
    }

    const updated = next.equityUsd + finalPnl;
    realizedPnl = finalPnl;
    if (updated <= 0) {
      next.equityUsd = 0;
      next.liquidated = true;
      next.streak = 0;
      rekt = true;
    } else {
      next.equityUsd = updated;
    }
    next.positionSide = "flat";
    next.entryPrice = 0;
    next.marginUsd = 0;
    next.leverage = 0;
  };

  if (action === "openLong" && next.positionSide === "flat") {
    next.positionSide = "long";
    next.leverage = leverage;
    next.entryPrice = livePrice;
    next.marginUsd = next.equityUsd;
    next.tradesCount += 1;
  } else if (action === "openShort" && next.positionSide === "flat") {
    next.positionSide = "short";
    next.leverage = leverage;
    next.entryPrice = livePrice;
    next.marginUsd = next.equityUsd;
    next.tradesCount += 1;
  } else if (action === "close" && next.positionSide !== "flat") {
    settleOpen();
  } else if (action === "flip" && next.positionSide !== "flat") {
    const nextSide: PositionSide =
      next.positionSide === "long" ? "short" : "long";
    settleOpen();
    if (!next.liquidated && next.equityUsd > 0) {
      next.positionSide = nextSide;
      next.leverage = leverage;
      next.entryPrice = livePrice;
      next.marginUsd = next.equityUsd;
      next.tradesCount += 1;
    }
  }

  return { next, realizedPnl, triggeredBonus, rekt };
}

export function createDuelBots(entryPrice: number): TraderSlot[] {
  return [
    {
      id: "bot-shark",
      name: "SOL_Shark",
      wallet: "Shrk9vM4k2xL8pQ1nR7yT3wV5cB2fD6hJ8kM9nP4qS2t",
      isUser: false,
      isBot: true,
      equityUsd: STARTING_EQUITY_USD,
      positionSide: "long",
      leverage: 50,
      entryPrice,
      marginUsd: STARTING_EQUITY_USD,
      tradesCount: 1,
      winsCount: 0,
      streak: 0,
      liquidated: false,
      claimed: false,
    },
    {
      id: "bot-sniper",
      name: "ER_Sniper",
      wallet: "Snpr4xW7zK2mN9vP3qR6tY8uJ1hG5fD2sA4eC7bV9xM1",
      isUser: false,
      isBot: true,
      equityUsd: STARTING_EQUITY_USD,
      positionSide: "short",
      leverage: 25,
      entryPrice,
      marginUsd: STARTING_EQUITY_USD,
      tradesCount: 1,
      winsCount: 0,
      streak: 0,
      liquidated: false,
      claimed: false,
    },
    {
      id: "bot-degen",
      name: "100x_Wizard",
      wallet: "Wzrd8cV5bN2mK4jH7gF9dS1aP3oI6uY8tR5eW2qL4xZ9",
      isUser: false,
      isBot: true,
      equityUsd: STARTING_EQUITY_USD,
      positionSide: "long",
      leverage: 100,
      entryPrice,
      marginUsd: STARTING_EQUITY_USD,
      tradesCount: 1,
      winsCount: 0,
      streak: 0,
      liquidated: false,
      claimed: false,
    },
  ];
}

/** Reactive AI rival ticks synced to live MagicBlock SOL/USD price moves */
export function stepBotTrader(
  bot: TraderSlot,
  livePrice: number,
  recentDeltaPct: number,
): TraderSlot {
  if (bot.liquidated) return bot;
  const mark = computeMarkEquity(bot, livePrice);
  if (mark <= 0) {
    return {
      ...bot,
      equityUsd: 0,
      positionSide: "flat",
      entryPrice: 0,
      marginUsd: 0,
      leverage: 0,
      streak: 0,
      liquidated: true,
    };
  }

  const pnlPct =
    bot.equityUsd > 0 ? computeUnrealizedPnl(bot, livePrice) / bot.equityUsd : 0;

  // Distinct bot personalities: Sniper takes small scalps, Shark rides momentum, Wizard YOLO flips
  if (bot.id === "bot-sniper") {
    if (bot.positionSide !== "flat" && (pnlPct > 0.018 || pnlPct < -0.02)) {
      return applyTradeAction(bot, "close", 25, livePrice).next;
    }
    if (bot.positionSide === "flat" && Math.random() < 0.45) {
      const action: TradeAction = recentDeltaPct >= 0 ? "openShort" : "openLong";
      return applyTradeAction(bot, action, 25, livePrice).next;
    }
  } else if (bot.id === "bot-shark") {
    if (bot.positionSide !== "flat" && (pnlPct > 0.035 || pnlPct < -0.03)) {
      return applyTradeAction(bot, "flip", 50, livePrice).next;
    }
    if (bot.positionSide === "flat" && Math.random() < 0.5) {
      const action: TradeAction = recentDeltaPct >= 0 ? "openLong" : "openShort";
      return applyTradeAction(bot, action, 50, livePrice).next;
    }
  } else {
    if (bot.positionSide !== "flat" && (pnlPct > 0.06 || pnlPct < -0.045)) {
      return applyTradeAction(bot, "flip", 100, livePrice).next;
    }
    if (bot.positionSide === "flat" && Math.random() < 0.6) {
      const action: TradeAction = Math.random() > 0.5 ? "openLong" : "openShort";
      return applyTradeAction(bot, action, 100, livePrice).next;
    }
  }

  return bot;
}
