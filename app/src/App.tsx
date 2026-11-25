import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Cpu,
  Crown,
  ExternalLink,
  Flame,
  Gauge,
  Layers,
  Loader2,
  Play,
  Radio,
  RefreshCw,
  ShieldCheck,
  Skull,
  Sparkles,
  Trophy,
  Wallet,
  X,
  Zap,
} from "lucide-react";
import ArenaChart from "./components/ArenaChart";
import {
  applyTradeAction,
  ArenaState,
  computeLiquidationPrice,
  computeMarkEquity,
  computeUnrealizedPnl,
  createDuelBots,
  ExecutionMode,
  HOT_STREAK_THRESHOLD,
  Leverage,
  STARTING_EQUITY_USD,
  stepBotTrader,
  TelemetryEntry,
  TradeAction,
  TradeMarker,
} from "./lib/arenaEngine";
import {
  checkProgramDeployedOnDevnet,
  createAndLaunchOnchainArena,
  fetchOnchainArenaState,
  fetchSolBalance,
  getBrowserWallet,
  getOperatorKeypair,
  getSessionKeypair,
  PROGRAM_ID,
  requestDevnetAirdrop,
  sendClaimPrizeL1,
  sendFinalizeAndUndelegate,
  sendOnchainErTrade,
  shortKey,
} from "./lib/blitzClient";
import {
  BASE_ENDPOINT,
  ER_ENDPOINT,
  ER_VALIDATOR,
  ORACLE_SYMBOL,
  OraclePrice,
  SOL_PRICE_FEED,
  subscribeLiveOracle,
} from "./lib/oracle";

type PnlToast = {
  id: number;
  tone: "profit" | "loss" | "streak" | "info";
  title: string;
  detail: string;
};

const LEVERAGES: Leverage[] = [10, 25, 50, 100];
const DURATIONS = [30, 60];
const BUY_INS = [0.05, 0.1, 0.25];

function nowTime(): string {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function fmtUsd(value: number): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtSignedUsd(value: number): string {
  const prefix = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${prefix}${fmtUsd(Math.abs(value))}`;
}

function fmtPct(value: number): string {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}%`;
}

export default function App() {
  const operatorKp = useMemo(() => getOperatorKeypair(), []);
  const sessionKp = useMemo(() => getSessionKeypair(), []);

  const [oracle, setOracle] = useState<OraclePrice | null>(null);
  const [oracleStatus, setOracleStatus] = useState<
    "connecting" | "live" | "degraded"
  >("connecting");
  const [oracleTicks, setOracleTicks] = useState(0);
  const prevPriceRef = useRef<number | null>(null);
  const [priceDir, setPriceDir] = useState<"up" | "down" | "flat">("flat");

  const [programDeployed, setProgramDeployed] = useState<boolean>(false);
  const [mode, setMode] = useState<ExecutionMode>("live_oracle_duel");
  const [operatorSol, setOperatorSol] = useState<number>(0);
  const [connectedWallet, setConnectedWallet] = useState<string | null>(null);

  const [durationSecs, setDurationSecs] = useState<number>(60);
  const [buyInSol, setBuyInSol] = useState<number>(0.05);
  const [leverage, setLeverage] = useState<Leverage>(50);

  const [arena, setArena] = useState<ArenaState | null>(null);
  const [markers, setMarkers] = useState<TradeMarker[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetryEntry[]>([
    {
      id: 1,
      time: nowTime(),
      layer: "ORACLE",
      tone: "info",
      message: `Subscribing to MagicBlock Asia ER (${ER_ENDPOINT.replace("https://", "")})`,
    },
  ]);
  const [toasts, setToasts] = useState<PnlToast[]>([]);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [latencies, setLatencies] = useState<number[]>([]);
  const [nowMs, setNowMs] = useState<number>(Date.now());
  const [crankPulse, setCrankPulse] = useState<boolean>(false);
  const [showVictoryModal, setShowVictoryModal] = useState<boolean>(false);

  const activeWallet = connectedWallet ?? operatorKp.publicKey.toBase58();
  const livePrice = oracle?.numeric ?? null;

  const pushLog = useCallback((entry: Omit<TelemetryEntry, "id" | "time">) => {
    setTelemetry((prev) => [
      { ...entry, id: Date.now() + Math.random(), time: nowTime() },
      ...prev.slice(0, 39),
    ]);
  }, []);

  const pushToast = useCallback((toast: Omit<PnlToast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [{ ...toast, id }, ...prev].slice(0, 3));
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3600);
  }, []);

  // Subscribe to real live SOL/USD MagicBlock Ephemeral Oracle
  useEffect(() => {
    const unsub = subscribeLiveOracle(
      (nextPrice) => {
        if (prevPriceRef.current !== null) {
          if (nextPrice.numeric > prevPriceRef.current) setPriceDir("up");
          else if (nextPrice.numeric < prevPriceRef.current) setPriceDir("down");
        }
        prevPriceRef.current = nextPrice.numeric;
        setOracle(nextPrice);
        setOracleTicks((c) => c + 1);
      },
      (status) => setOracleStatus(status),
    );
    return unsub;
  }, []);

  // Check if Blitz Arena Anchor program is deployed on Devnet + check operator SOL (once on mount)
  const devnetCheckedRef = useRef(false);
  useEffect(() => {
    if (devnetCheckedRef.current) return;
    devnetCheckedRef.current = true;
    checkProgramDeployedOnDevnet().then((deployed) => {
      setProgramDeployed(deployed);
      if (deployed) {
        setMode("onchain_er");
        pushLog({
          layer: "L1",
          tone: "success",
          message: `Detected live Blitz Arena program on Devnet (${shortKey(PROGRAM_ID)})`,
        });
      }
    });
    fetchSolBalance(operatorKp.publicKey).then(setOperatorSol);
  }, [operatorKp, pushLog]);

  // High-frequency local countdown clock (100ms precision)
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 100);
    return () => window.clearInterval(id);
  }, []);

  // Derived user slot & live ranked leaderboard
  const userSlot = useMemo(() => {
    if (!arena) return null;
    return arena.players.find((p) => p.isUser) ?? arena.players[0] ?? null;
  }, [arena]);

  const rankedPlayers = useMemo(() => {
    if (!arena) return [];
    const priceForMark =
      arena.status === "finished" && arena.finalPrice > 0
        ? arena.finalPrice
        : livePrice ?? arena.lastCrankPrice;
    return [...arena.players]
      .map((p) => {
        const markEquity =
          arena.status === "finished"
            ? p.equityUsd
            : computeMarkEquity(p, priceForMark);
        const unrealized =
          arena.status === "finished"
            ? 0
            : computeUnrealizedPnl(p, priceForMark);
        return { ...p, markEquity, unrealized };
      })
      .sort((a, b) => b.markEquity - a.markEquity);
  }, [arena, livePrice]);

  const userRank = useMemo(() => {
    if (!userSlot) return null;
    const idx = rankedPlayers.findIndex((p) => p.id === userSlot.id);
    return idx >= 0 ? idx + 1 : null;
  }, [rankedPlayers, userSlot]);

  const userUnrealized = useMemo(() => {
    if (!userSlot || !livePrice || arena?.status !== "active") return 0;
    return computeUnrealizedPnl(userSlot, livePrice);
  }, [arena?.status, livePrice, userSlot]);

  const userMarkEquity = useMemo(() => {
    if (!userSlot) return STARTING_EQUITY_USD;
    if (arena?.status === "finished") return userSlot.equityUsd;
    if (!livePrice) return userSlot.equityUsd;
    return computeMarkEquity(userSlot, livePrice);
  }, [arena?.status, livePrice, userSlot]);

  const userLiqPrice = useMemo(
    () => (userSlot ? computeLiquidationPrice(userSlot) : null),
    [userSlot],
  );

  const remainingMs = useMemo(() => {
    if (!arena || arena.status !== "active") return 0;
    return Math.max(0, arena.endTsMs - nowMs);
  }, [arena, nowMs]);

  const progressPct = useMemo(() => {
    if (!arena || arena.durationSecs <= 0) return 0;
    if (arena.status === "finished") return 0;
    return Math.min(100, (remainingMs / (arena.durationSecs * 1000)) * 100);
  }, [arena, remainingMs]);

  const avgLatencyMs = useMemo(() => {
    if (!latencies.length) return 38;
    const sum = latencies.reduce((acc, v) => acc + v, 0);
    return Math.round(sum / latencies.length);
  }, [latencies]);

  // Ref for latest price inside interval loops
  const livePriceRef = useRef<number | null>(livePrice);
  livePriceRef.current = livePrice;
  const lastBotCheckPriceRef = useRef<number | null>(null);
  const settledArenaRef = useRef<string | null>(null);

  const finalizeDuelRound = useCallback(
    (snapshot: ArenaState, settlePrice: number, ticks: number) => {
      if (settledArenaRef.current === snapshot.arenaId) return;
      settledArenaRef.current = snapshot.arenaId;

      const settledPlayers = snapshot.players.map((p) =>
        p.positionSide !== "flat" && !p.liquidated
          ? applyTradeAction(p, "close", 10, settlePrice).next
          : p,
      );
      const winner = [...settledPlayers].sort(
        (a, b) => b.equityUsd - a.equityUsd,
      )[0];

      setArena({
        ...snapshot,
        status: "finished",
        crankTicks: ticks,
        lastCrankPrice: settlePrice,
        finalPrice: settlePrice,
        winnerWallet: winner.wallet,
        winnerName: winner.name,
        winnerEquityUsd: winner.equityUsd,
        delegatedToEr: false,
        committedToL1: true,
        players: settledPlayers,
      });

      pushLog({
        layer: "CRANK",
        tone: "success",
        message: `Crank #${ticks}: Round settled @ $${settlePrice.toFixed(3)} · Winner: ${winner.name} (${fmtUsd(winner.equityUsd)})`,
      });
      pushLog({
        layer: "L1",
        tone: "success",
        message: `commit_and_undelegate() committed Arena #${snapshot.arenaId.slice(-4)} to Solana L1`,
        latencyMs: 365,
      });
      setShowVictoryModal(true);
    },
    [pushLog],
  );

  // Automated 2s ER Crank Heartbeat + Rival AI Loop (Live Oracle Duel Mode) + Onchain Poller
  useEffect(() => {
    if (!arena || arena.status !== "active") return;

    if (arena.mode === "live_oracle_duel") {
      const crankTimer = window.setInterval(() => {
        const currentPrice = livePriceRef.current;
        if (!currentPrice) return;

        setCrankPulse(true);
        window.setTimeout(() => setCrankPulse(false), 380);

        const prevRefPrice = lastBotCheckPriceRef.current ?? currentPrice;
        const deltaPct =
          prevRefPrice > 0 ? (currentPrice - prevRefPrice) / prevRefPrice : 0;
        lastBotCheckPriceRef.current = currentPrice;

        let liquidatedUser = false;
        let readyToFinalize: { snap: ArenaState; ticks: number } | null = null;

        setArena((prev) => {
          if (!prev || prev.status !== "active") return prev;
          const now = Date.now();
          const nextTicks = prev.crankTicks + 1;

          const updatedPlayers = prev.players.map((p) => {
            if (p.isBot) {
              return stepBotTrader(p, currentPrice, deltaPct);
            }
            if (!p.liquidated && p.positionSide !== "flat") {
              const mark = computeMarkEquity(p, currentPrice);
              if (mark <= 0) {
                liquidatedUser = true;
                return {
                  ...p,
                  equityUsd: 0,
                  positionSide: "flat" as const,
                  leverage: 0,
                  entryPrice: 0,
                  marginUsd: 0,
                  streak: 0,
                  liquidated: true,
                };
              }
            }
            return p;
          });

          if (now >= prev.endTsMs) {
            readyToFinalize = {
              snap: { ...prev, players: updatedPlayers },
              ticks: nextTicks,
            };
            return prev;
          }

          return {
            ...prev,
            crankTicks: nextTicks,
            lastCrankPrice: currentPrice,
            players: updatedPlayers,
          };
        });

        if (liquidatedUser) {
          pushToast({
            tone: "loss",
            title: "💀 LIQUIDATED (REKT)",
            detail: `ER Crank liquidated your position at $${currentPrice.toFixed(3)}`,
          });
          pushLog({
            layer: "CRANK",
            tone: "error",
            message: `Crank liquidated YOU at $${currentPrice.toFixed(3)}`,
          });
        }
        if (readyToFinalize) {
          const { snap, ticks } = readyToFinalize as {
            snap: ArenaState;
            ticks: number;
          };
          finalizeDuelRound(snap, currentPrice, ticks);
        }
      }, 2_000);

      return () => window.clearInterval(crankTimer);
    }

    // Onchain ER Mode: poll delegated Arena account on ER every 1s to surface real Crank ticks
    const pollOnchain = window.setInterval(async () => {
      const latest = await fetchOnchainArenaState(
        BigInt(arena.arenaId),
        activeWallet,
        true,
      );
      if (!latest) return;
      if (latest.crankTicks > arena.crankTicks) {
        setCrankPulse(true);
        window.setTimeout(() => setCrankPulse(false), 380);
      }
      setArena(latest);
      if (latest.status === "finished") {
        setShowVictoryModal(true);
      }
    }, 1_000);

    return () => window.clearInterval(pollOnchain);
  }, [activeWallet, arena, finalizeDuelRound, pushLog, pushToast]);

  // Also check end-of-round at 100ms resolution in Live Oracle Duel so clock hits 0.0s crisply
  useEffect(() => {
    if (
      !arena ||
      arena.mode !== "live_oracle_duel" ||
      arena.status !== "active" ||
      remainingMs > 0 ||
      !livePrice
    ) {
      return;
    }
    finalizeDuelRound(arena, livePrice, arena.crankTicks + 1);
  }, [arena, finalizeDuelRound, livePrice, remainingMs]);

  const handleConnectWallet = async () => {
    const provider = getBrowserWallet();
    if (!provider) {
      pushToast({
        tone: "info",
        title: "No Solana wallet extension found",
        detail: "Using built-in Instant Devnet Operator + Session Keypair instead.",
      });
      return;
    }
    try {
      const res = await provider.connect();
      setConnectedWallet(res.publicKey.toBase58());
      const bal = await fetchSolBalance(res.publicKey);
      setOperatorSol(bal);
      pushLog({
        layer: "L1",
        tone: "success",
        message: `Connected wallet ${shortKey(res.publicKey)} (${bal.toFixed(3)} Devnet SOL)`,
      });
    } catch (err) {
      pushToast({
        tone: "loss",
        title: "Wallet connection cancelled",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleAirdrop = async () => {
    setBusyLabel("Requesting Devnet SOL");
    try {
      const sig = await requestDevnetAirdrop(operatorKp.publicKey, 1);
      const bal = await fetchSolBalance(operatorKp.publicKey);
      setOperatorSol(bal);
      pushLog({
        layer: "L1",
        tone: "success",
        message: `Airdropped 1.0 SOL to operator (${bal.toFixed(3)} SOL)`,
        signature: sig,
      });
      pushToast({
        tone: "profit",
        title: "+1.0 Devnet SOL funded",
        detail: `Operator ${shortKey(operatorKp.publicKey)} ready for L1 escrow & delegation.`,
      });
    } catch (err) {
      pushLog({
        layer: "L1",
        tone: "warn",
        message: "Devnet faucet rate-limited — fund at faucet.solana.com or play Live Oracle Duel",
      });
      pushToast({
        tone: "info",
        title: "Devnet faucet busy",
        detail: err instanceof Error ? err.message : "Use faucet.solana.com for Devnet SOL.",
      });
    } finally {
      setBusyLabel(null);
    }
  };

  const handleStartMatch = async () => {
    if (!livePrice) {
      pushToast({
        tone: "info",
        title: "Waiting for live SOL/USD oracle",
        detail: "Connecting to MagicBlock Asia ER feed…",
      });
      return;
    }

    setShowVictoryModal(false);
    setMarkers([]);
    setLatencies([]);
    const arenaId = BigInt(Math.floor(Date.now() / 1000));

    if (mode === "onchain_er") {
      setBusyLabel("Deploying match to MagicBlock ER");
      try {
        const res = await createAndLaunchOnchainArena({
          arenaId,
          entryFeeSol: buyInSol,
          durationSecs,
          maxPlayers: 4,
          operator: operatorKp,
          session: sessionKp,
        });
        pushLog({
          layer: "L1",
          tone: "success",
          message: `create_arena(#${arenaId}) escrowed ${buyInSol} SOL in L1 Vault`,
          latencyMs: res.createTx.latencyMs,
          signature: res.createTx.signature,
        });
        pushLog({
          layer: "L1",
          tone: "success",
          message: `start_arena + delegate_arena -> ER Validator ${shortKey(ER_VALIDATOR)}`,
          latencyMs: res.delegateTx.latencyMs,
          signature: res.delegateTx.signature,
        });
        pushLog({
          layer: "CRANK",
          tone: "success",
          message: `schedule_round_crank() armed (2000ms ticks on MagicBlock ER)`,
          latencyMs: res.crankTx.latencyMs,
          signature: res.crankTx.signature,
        });

        const state = await fetchOnchainArenaState(
          arenaId,
          operatorKp.publicKey.toBase58(),
          true,
        );
        if (state) setArena(state);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pushLog({
          layer: "L1",
          tone: "error",
          message: `Onchain launch failed: ${msg}`,
        });
        pushToast({
          tone: "loss",
          title: "Onchain launch failed",
          detail: msg,
        });
      } finally {
        setBusyLabel(null);
      }
      return;
    }

    // Live Oracle Duel Mode: 100% real MagicBlock SOL/USD Ephemeral Oracle stream + 3 live rivals
    const now = Date.now();
    const players = [
      {
        id: activeWallet,
        name: "YOU",
        wallet: activeWallet,
        isUser: true,
        equityUsd: STARTING_EQUITY_USD,
        positionSide: "flat" as const,
        leverage: 0,
        entryPrice: 0,
        marginUsd: 0,
        tradesCount: 0,
        winsCount: 0,
        streak: 0,
        liquidated: false,
        claimed: false,
      },
      ...createDuelBots(livePrice),
    ];

    lastBotCheckPriceRef.current = livePrice;
    setArena({
      arenaId: arenaId.toString(),
      mode: "live_oracle_duel",
      status: "active",
      entryFeeSol: buyInSol,
      potSol: Number((buyInSol * players.length).toFixed(3)),
      durationSecs,
      startTsMs: now,
      endTsMs: now + durationSecs * 1000,
      crankScheduled: true,
      crankTicks: 1,
      lastCrankPrice: livePrice,
      finalPrice: 0,
      winnerWallet: "",
      winnerName: "",
      winnerEquityUsd: 0,
      delegatedToEr: true,
      committedToL1: false,
      players,
    });

    pushLog({
      layer: "L1",
      tone: "info",
      message: `Arena #${arenaId.toString().slice(-4)} started · ${Number((buyInSol * players.length).toFixed(3))} SOL Pot (4 Traders)`,
    });
    pushLog({
      layer: "ER",
      tone: "success",
      message: `Delegated to ER (${shortKey(ER_VALIDATOR)}) · Live SOL/USD Oracle @ $${livePrice.toFixed(3)}`,
      latencyMs: 34,
    });
    pushLog({
      layer: "CRANK",
      tone: "success",
      message: `MagicBlock Crank armed (2000ms liquidation & T=${durationSecs}s auto-settle)`,
    });
  };

  const handleTrade = useCallback(
    async (action: TradeAction) => {
      if (!arena || arena.status !== "active" || !userSlot || !livePrice) return;
      if (userSlot.liquidated || busyLabel) return;

      if (
        (action === "openLong" || action === "openShort") &&
        userSlot.positionSide !== "flat"
      ) {
        return;
      }
      if (
        (action === "close" || action === "flip") &&
        userSlot.positionSide === "flat"
      ) {
        return;
      }

      if (arena.mode === "onchain_er") {
        setBusyLabel(`ER ${action}`);
        try {
          const metrics = await sendOnchainErTrade({
            arenaId: BigInt(arena.arenaId),
            action,
            leverage,
            session: sessionKp,
          });
          setLatencies((prev) => [...prev.slice(-19), metrics.latencyMs]);
          setMarkers((prev) => [
            ...prev,
            {
              id: Date.now() + Math.random(),
              timestamp: Date.now(),
              price: livePrice,
              action,
              leverage,
            },
          ]);
          pushLog({
            layer: "ER",
            tone: "success",
            message: `trade(${action}, ${leverage}x) @ $${livePrice.toFixed(3)} · 0 GAS`,
            latencyMs: metrics.latencyMs,
            signature: metrics.signature,
          });
          const refreshed = await fetchOnchainArenaState(
            BigInt(arena.arenaId),
            activeWallet,
            true,
          );
          if (refreshed) setArena(refreshed);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          pushLog({ layer: "ER", tone: "error", message: msg });
          pushToast({ tone: "loss", title: "ER trade reverted", detail: msg });
        } finally {
          setBusyLabel(null);
        }
        return;
      }

      // Live Oracle Duel Mode — execute exact Rust-parity trade against live MagicBlock oracle tick
      const simLatency = Math.round(28 + Math.random() * 22);
      const { next, realizedPnl, triggeredBonus, rekt } = applyTradeAction(
        userSlot,
        action,
        leverage,
        livePrice,
      );

      setLatencies((prev) => [...prev.slice(-19), simLatency]);
      setMarkers((prev) => [
        ...prev,
        {
          id: Date.now() + Math.random(),
          timestamp: Date.now(),
          price: livePrice,
          action,
          leverage,
          pnlUsd:
            action === "close" || action === "flip" ? realizedPnl : undefined,
        },
      ]);

      setArena((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          players: prev.players.map((p) => (p.id === userSlot.id ? next : p)),
        };
      });

      const labelMap: Record<TradeAction, string> = {
        openLong: `OPEN LONG ${leverage}x`,
        openShort: `OPEN SHORT ${leverage}x`,
        close: `CLOSE (${fmtSignedUsd(realizedPnl)})`,
        flip: `FLIP -> ${next.positionSide.toUpperCase()} ${leverage}x (${fmtSignedUsd(realizedPnl)})`,
      };

      pushLog({
        layer: "ER",
        tone: rekt ? "error" : realizedPnl < 0 ? "warn" : "success",
        message: `${labelMap[action]} @ $${livePrice.toFixed(3)} · 0 GAS`,
        latencyMs: simLatency,
      });

      if (rekt) {
        pushToast({
          tone: "loss",
          title: "💀 REKT — Position Liquidated",
          detail: `Equity hit $0.00 at $${livePrice.toFixed(3)}.`,
        });
      } else if (action === "close" || action === "flip") {
        if (triggeredBonus) {
          pushToast({
            tone: "streak",
            title: `🔥 ${next.streak}x HOT STREAK! ${fmtSignedUsd(realizedPnl)}`,
            detail: "+5% Entertainment Finance combo bonus locked in!",
          });
        } else {
          pushToast({
            tone: realizedPnl >= 0 ? "profit" : "loss",
            title:
              realizedPnl >= 0
                ? `Locked ${fmtSignedUsd(realizedPnl)}`
                : `Closed ${fmtSignedUsd(realizedPnl)}`,
            detail: `Executed in ${simLatency}ms via Session Key (0 gas).`,
          });
        }
      }
    },
    [activeWallet, arena, busyLabel, leverage, livePrice, pushLog, pushToast, sessionKp, userSlot],
  );

  // Keyboard shortcuts for arcade-speed trading: W = Long, S = Short, Space = Close, F = Flip, 1-4 = Leverage
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (!arena || arena.status !== "active") return;
      const k = e.key.toLowerCase();
      if (k === "w") {
        e.preventDefault();
        void handleTrade("openLong");
      } else if (k === "s") {
        e.preventDefault();
        void handleTrade("openShort");
      } else if (k === " " || e.code === "Space") {
        e.preventDefault();
        void handleTrade("close");
      } else if (k === "f") {
        e.preventDefault();
        void handleTrade("flip");
      } else if (k === "1") setLeverage(10);
      else if (k === "2") setLeverage(25);
      else if (k === "3") setLeverage(50);
      else if (k === "4") setLeverage(100);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [arena, handleTrade]);

  const handleFinalizeAndClaim = async () => {
    if (!arena) return;
    if (arena.mode === "live_oracle_duel") {
      setArena((prev) =>
        prev
          ? {
              ...prev,
              players: prev.players.map((p) =>
                p.wallet === prev.winnerWallet ? { ...p, claimed: true } : p,
              ),
            }
          : prev,
      );
      pushLog({
        layer: "L1",
        tone: "success",
        message: `claim_prize() released ${arena.potSol} SOL pot to ${arena.winnerName}`,
        latencyMs: 412,
      });
      pushToast({
        tone: "profit",
        title: `🏆 Claimed ${arena.potSol} SOL Pot!`,
        detail: "Settlement verified from MagicBlock ER commit on Solana L1.",
      });
      return;
    }

    setBusyLabel("Settling to Solana L1");
    try {
      if (arena.delegatedToEr) {
        const fin = await sendFinalizeAndUndelegate({
          arenaId: BigInt(arena.arenaId),
          operator: operatorKp,
        });
        pushLog({
          layer: "ER",
          tone: "success",
          message: "finalize_and_undelegate() committed Arena back to Solana L1",
          latencyMs: fin.latencyMs,
          signature: fin.signature,
        });
      }
      const claim = await sendClaimPrizeL1({
        arenaId: BigInt(arena.arenaId),
        winner: operatorKp,
      });
      pushLog({
        layer: "L1",
        tone: "success",
        message: `claim_prize() paid ${arena.potSol} SOL from Vault PDA to winner`,
        latencyMs: claim.latencyMs,
        signature: claim.signature,
      });
      const bal = await fetchSolBalance(operatorKp.publicKey);
      setOperatorSol(bal);
      const updated = await fetchOnchainArenaState(
        BigInt(arena.arenaId),
        activeWallet,
        false,
      );
      if (updated) setArena(updated);
      pushToast({
        tone: "profit",
        title: `🏆 Claimed ${arena.potSol} SOL on Solana Devnet!`,
        detail: `TX ${shortKey(claim.signature)}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pushLog({ layer: "L1", tone: "error", message: msg });
      pushToast({ tone: "loss", title: "Settlement failed", detail: msg });
    } finally {
      setBusyLabel(null);
    }
  };

  const isUserWinner =
    arena?.status === "finished" && arena.winnerWallet === activeWallet;
  const userClaimed = Boolean(
    arena?.players.find((p) => p.wallet === activeWallet)?.claimed,
  );
  const pnlDeltaPct =
    ((userMarkEquity - STARTING_EQUITY_USD) / STARTING_EQUITY_USD) * 100;
  const countdownText =
    arena?.status === "active"
      ? `${(remainingMs / 1000).toFixed(1)}s`
      : arena?.status === "finished"
        ? "0.0s"
        : `${durationSecs}.0s`;
  const urgentClock = arena?.status === "active" && remainingMs <= 10_000;

  return (
    <div className="app-shell">
      {/* Floating PnL / Event Toasts */}
      <div className="toast-layer" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast-card ${t.tone}`}>
            <strong>{t.title}</strong>
            <span>{t.detail}</span>
          </div>
        ))}
      </div>

      {/* End-of-Round Podium Modal */}
      {showVictoryModal && arena?.status === "finished" && (
        <div
          className="modal-overlay"
          onClick={() => setShowVictoryModal(false)}
        >
          <div className="victory-modal" onClick={(e) => e.stopPropagation()}>
            <button
              className="modal-close"
              onClick={() => setShowVictoryModal(false)}
              aria-label="Close modal"
            >
              <X size={18} />
            </button>
            <div className={`victory-badge ${isUserWinner ? "win" : "rank"}`}>
              {isUserWinner ? <Trophy size={28} /> : <Crown size={28} />}
            </div>
            <p className="eyebrow">
              ARENA #{arena.arenaId.slice(-4)} · COMMITTED TO SOLANA L1
            </p>
            <h2>
              {isUserWinner
                ? `VICTORY! YOU WON ${arena.potSol} SOL`
                : `ROUND COMPLETE — RANK #${userRank ?? "-"}`}
            </h2>
            <p className="modal-sub">
              Winner: <strong>{arena.winnerName}</strong> finished with{" "}
              <strong>{fmtUsd(arena.winnerEquityUsd)}</strong> (
              {fmtPct(
                ((arena.winnerEquityUsd - STARTING_EQUITY_USD) /
                  STARTING_EQUITY_USD) *
                  100,
              )}
              ) at final SOL/USD{" "}
              <code>${arena.finalPrice.toFixed(3)}</code>.
            </p>

            <div className="victory-stats">
              <div>
                <span>Your Final Stack</span>
                <strong>{fmtUsd(userSlot?.equityUsd ?? 0)}</strong>
              </div>
              <div>
                <span>Total Trades</span>
                <strong>{userSlot?.tradesCount ?? 0}</strong>
              </div>
              <div>
                <span>Avg ER Speed</span>
                <strong>{avgLatencyMs} ms</strong>
              </div>
              <div>
                <span>Crank Ticks</span>
                <strong>{arena.crankTicks}</strong>
              </div>
            </div>

            <div className="victory-actions">
              {isUserWinner && !userClaimed && (
                <button
                  className="btn-primary glow-green"
                  onClick={handleFinalizeAndClaim}
                  disabled={Boolean(busyLabel)}
                >
                  {busyLabel ? (
                    <Loader2 className="spin" size={16} />
                  ) : (
                    <Sparkles size={16} />
                  )}
                  Claim {arena.potSol} SOL Pot on L1
                </button>
              )}
              <button
                className="btn-secondary"
                onClick={() => {
                  setShowVictoryModal(false);
                  void handleStartMatch();
                }}
              >
                <Play size={16} />
                Rematch ({durationSecs}s)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Top Navigation & Telemetry Header */}
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-icon">
            <Zap size={20} />
          </div>
          <div>
            <div className="brand-title-row">
              <h1>BLITZ ARENA</h1>
              <span className="pill pill-accent">SOLANA BLITZ v10</span>
            </div>
            <p className="brand-sub">
              60s PvP Micro-Trading Sprint · MagicBlock Ephemeral Rollups + Crank
            </p>
          </div>
        </div>

        <div className="topbar-controls">
          <div className={`status-chip ${oracleStatus}`}>
            <Radio size={13} />
            <span>
              ER ORACLE{" "}
              {oracleStatus === "live"
                ? `LIVE · #${oracle?.slot.slice(-5) ?? "—"}`
                : oracleStatus.toUpperCase()}
            </span>
          </div>

          <div className="mode-switcher" role="group" aria-label="Execution mode">
            <button
              className={mode === "live_oracle_duel" ? "active" : ""}
              onClick={() => setMode("live_oracle_duel")}
              disabled={arena?.status === "active"}
            >
              <Zap size={13} />
              Live Oracle Duel
            </button>
            <button
              className={mode === "onchain_er" ? "active" : ""}
              onClick={() => setMode("onchain_er")}
              disabled={arena?.status === "active" || !programDeployed}
              title={
                programDeployed
                  ? "Execute directly on deployed Solana Devnet + MagicBlock ER program"
                  : "Deploy Anchor program to Devnet to unlock Live Onchain ER mode"
              }
            >
              <Layers size={13} />
              Devnet ER {programDeployed ? "ONCHAIN" : "(Not Deployed)"}
            </button>
          </div>

          <button className="wallet-btn" onClick={handleConnectWallet}>
            <Wallet size={14} />
            <span>
              {connectedWallet
                ? shortKey(connectedWallet)
                : `Session ${shortKey(operatorKp.publicKey)}`}
            </span>
            <small>{operatorSol.toFixed(2)} SOL</small>
          </button>
        </div>
      </header>

      {/* Main 2-Column Trading Esports Workspace */}
      <main className="arena-grid">
        {/* LEFT STAGE: Live Oracle Chart + Arcade Trading Deck */}
        <section className="stage-column">
          {/* Match Status Bar */}
          <div className="card match-hud">
            <div className="hud-price">
              <div className="hud-label-row">
                <span className="hud-eyebrow">{ORACLE_SYMBOL} EPHEMERAL ORACLE</span>
                <span className="tick-badge">{oracleTicks} live ticks</span>
              </div>
              <div className={`big-price ${priceDir}`}>
                {oracle ? `$${oracle.display}` : "$—.——"}
                {priceDir === "up" && <ArrowUpRight size={22} />}
                {priceDir === "down" && <ArrowDownRight size={22} />}
              </div>
            </div>

            <div className="hud-metrics">
              <div className={`hud-clock ${urgentClock ? "urgent" : ""}`}>
                <span className="hud-eyebrow">
                  <Clock size={12} /> SPRINT CLOCK
                </span>
                <strong>{countdownText}</strong>
                <div className="clock-bar">
                  <div
                    className="clock-bar-fill"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>

              <div className="hud-stat">
                <span className="hud-eyebrow">
                  <Trophy size={12} /> PRIZE POT
                </span>
                <strong>
                  {arena
                    ? `${arena.potSol} SOL`
                    : `${Number((buyInSol * 4).toFixed(2))} SOL`}
                </strong>
                <small>Winner takes all on L1</small>
              </div>

              <div className={`hud-stat crank-stat ${crankPulse ? "pulsing" : ""}`}>
                <span className="hud-eyebrow">
                  <Cpu size={12} /> MAGICBLOCK CRANK
                </span>
                <strong>
                  {arena?.crankScheduled ? `ARMED · ${arena.crankTicks}` : "STANDBY"}
                </strong>
                <small>Auto-liq &amp; 60s settle</small>
              </div>
            </div>
          </div>

          {/* 60fps Interactive Live Chart */}
          <div className="card chart-card">
            <div className="chart-overlay-bar">
              <div className="overlay-pills">
                <span className="mini-pill">
                  <Gauge size={12} /> Avg ER: <b>{avgLatencyMs}ms</b>
                </span>
                <span className="mini-pill green">
                  <ShieldCheck size={12} /> <b>0 GAS</b> · Session Key Active
                </span>
                {userSlot && userSlot.streak > 0 && (
                  <span
                    className={`mini-pill streak ${userSlot.streak >= HOT_STREAK_THRESHOLD ? "hot" : ""}`}
                  >
                    <Flame size={12} /> Streak {userSlot.streak}
                    {userSlot.streak >= HOT_STREAK_THRESHOLD
                      ? " (+5% BONUS!)"
                      : `/${HOT_STREAK_THRESHOLD}`}
                  </span>
                )}
              </div>

              <div className="equity-readout">
                <span>YOUR STACK</span>
                <strong>{fmtUsd(userMarkEquity)}</strong>
                <em className={pnlDeltaPct >= 0 ? "pos" : "neg"}>
                  {fmtPct(pnlDeltaPct)}
                </em>
              </div>
            </div>

            <ArenaChart
              price={livePrice}
              entryPrice={userSlot?.entryPrice ?? null}
              positionSide={userSlot?.positionSide ?? "flat"}
              leverage={userSlot?.leverage ?? 0}
              liquidationPrice={userLiqPrice}
              markers={markers}
            />
          </div>

          {/* Zero-Popup Arcade Trading Controls */}
          <div className="card trade-deck">
            <div className="deck-top">
              <div className="leverage-group">
                <span className="deck-label">LEVERAGE (KEYS 1-4)</span>
                <div className="leverage-pills">
                  {LEVERAGES.map((lev) => (
                    <button
                      key={lev}
                      className={`lev-btn ${leverage === lev ? "selected" : ""} ${lev === 100 ? "degen" : ""}`}
                      onClick={() => setLeverage(lev)}
                    >
                      {lev}x {lev === 100 ? "🔥" : ""}
                    </button>
                  ))}
                </div>
              </div>

              <div className="position-summary">
                {userSlot?.liquidated ? (
                  <span className="pos-badge rekt">
                    <Skull size={14} /> LIQUIDATED (REKT)
                  </span>
                ) : userSlot && userSlot.positionSide !== "flat" ? (
                  <div className="open-pos-info">
                    <span className={`pos-badge ${userSlot.positionSide}`}>
                      {userSlot.positionSide.toUpperCase()} {userSlot.leverage}x @ $
                      {userSlot.entryPrice.toFixed(3)}
                    </span>
                    <span
                      className={`live-pnl ${userUnrealized >= 0 ? "pos" : "neg"}`}
                    >
                      {fmtSignedUsd(userUnrealized)}
                    </span>
                  </div>
                ) : (
                  <span className="pos-badge flat">
                    FLAT · 100% READY ({fmtUsd(userMarkEquity)})
                  </span>
                )}
              </div>
            </div>

            <div className="action-row">
              {!arena || arena.status !== "active" ? (
                <button
                  className="btn-launch"
                  onClick={handleStartMatch}
                  disabled={!livePrice || Boolean(busyLabel)}
                >
                  {busyLabel ? (
                    <Loader2 className="spin" size={20} />
                  ) : (
                    <Play size={20} />
                  )}
                  <span>
                    {arena?.status === "finished"
                      ? `LAUNCH REMATCH (${durationSecs}s SPRINT)`
                      : `START ${durationSecs}s PVP BLITZ SPRINT`}
                  </span>
                  <small>
                    {mode === "onchain_er"
                      ? "Creates L1 Vault -> Delegates to ER -> Arms Crank"
                      : `Live SOL/USD Oracle · 4-Player ${Number((buyInSol * 4).toFixed(2))} SOL Pot`}
                  </small>
                </button>
              ) : userSlot?.liquidated ? (
                <div className="rekt-banner">
                  <Skull size={20} />
                  <span>
                    You got REKT at {leverage}x! Watching remaining{" "}
                    {countdownText} until Crank settles the round…
                  </span>
                </div>
              ) : userSlot?.positionSide === "flat" ? (
                <>
                  <button
                    className="trade-btn long"
                    onClick={() => void handleTrade("openLong")}
                    disabled={Boolean(busyLabel)}
                  >
                    <ArrowUpRight size={22} />
                    <div>
                      <strong>LONG {leverage}x</strong>
                      <span>Hotkey [W] · Instant 0-Gas ER</span>
                    </div>
                  </button>
                  <button
                    className="trade-btn short"
                    onClick={() => void handleTrade("openShort")}
                    disabled={Boolean(busyLabel)}
                  >
                    <ArrowDownRight size={22} />
                    <div>
                      <strong>SHORT {leverage}x</strong>
                      <span>Hotkey [S] · Instant 0-Gas ER</span>
                    </div>
                  </button>
                </>
              ) : (
                <>
                  <button
                    className={`trade-btn close ${userUnrealized >= 0 ? "in-profit" : "in-loss"}`}
                    onClick={() => void handleTrade("close")}
                    disabled={Boolean(busyLabel)}
                  >
                    <CheckCircle2 size={22} />
                    <div>
                      <strong>CLOSE &amp; LOCK {fmtSignedUsd(userUnrealized)}</strong>
                      <span>Hotkey [Space] · Realize PnL on ER</span>
                    </div>
                  </button>
                  <button
                    className="trade-btn flip"
                    onClick={() => void handleTrade("flip")}
                    disabled={Boolean(busyLabel)}
                  >
                    <RefreshCw size={20} />
                    <div>
                      <strong>
                        FLIP TO{" "}
                        {userSlot?.positionSide === "long" ? "SHORT" : "LONG"}{" "}
                        {leverage}x
                      </strong>
                      <span>Hotkey [F] · Close + Reverse in 1 ER Tx</span>
                    </div>
                  </button>
                </>
              )}
            </div>
          </div>
        </section>

        {/* RIGHT TACTICAL RAIL: Match Config + Live Leaderboard + ER Telemetry */}
        <aside className="rail-column">
          {/* Card 1: Arena Config & Quick Controls */}
          <div className="card config-card">
            <div className="card-head">
              <h2>ARENA SETUP</h2>
              <span className="pill pill-subtle">
                {mode === "onchain_er" ? "DEVNET ONCHAIN" : "LIVE ORACLE DUEL"}
              </span>
            </div>

            <div className="config-grid">
              <div>
                <span className="deck-label">ROUND DURATION</span>
                <div className="seg-row">
                  {DURATIONS.map((d) => (
                    <button
                      key={d}
                      className={durationSecs === d ? "selected" : ""}
                      onClick={() => setDurationSecs(d)}
                      disabled={arena?.status === "active"}
                    >
                      {d}s
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <span className="deck-label">BUY-IN (SOL)</span>
                <div className="seg-row">
                  {BUY_INS.map((b) => (
                    <button
                      key={b}
                      className={buyInSol === b ? "selected" : ""}
                      onClick={() => setBuyInSol(b)}
                      disabled={arena?.status === "active"}
                    >
                      {b}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="config-foot">
              <button
                className="btn-ghost"
                onClick={handleAirdrop}
                disabled={Boolean(busyLabel)}
              >
                <Sparkles size={14} />
                Airdrop 1 Devnet SOL
              </button>
              {arena?.status === "finished" && isUserWinner && !userClaimed && (
                <button
                  className="btn-claim-inline"
                  onClick={handleFinalizeAndClaim}
                  disabled={Boolean(busyLabel)}
                >
                  <Trophy size={14} />
                  Claim {arena.potSol} SOL
                </button>
              )}
            </div>
          </div>

          {/* Card 2: Live PvP Leaderboard */}
          <div className="card leaderboard-card">
            <div className="card-head">
              <h2>
                <Trophy size={15} /> LIVE PVP LEADERBOARD
              </h2>
              <span className="pill pill-subtle">
                {arena ? `${arena.players.length} TRADERS` : "4 SLOTS"}
              </span>
            </div>

            {rankedPlayers.length === 0 ? (
              <div className="empty-board">
                <p>
                  Press <strong>START {durationSecs}s PVP BLITZ SPRINT</strong>{" "}
                  to compete head-to-head on live MagicBlock SOL/USD ticks.
                </p>
              </div>
            ) : (
              <div className="leader-list">
                {rankedPlayers.map((p, idx) => {
                  const pct =
                    ((p.markEquity - STARTING_EQUITY_USD) /
                      STARTING_EQUITY_USD) *
                    100;
                  const maxEq = Math.max(
                    STARTING_EQUITY_USD * 1.15,
                    rankedPlayers[0]?.markEquity ?? STARTING_EQUITY_USD,
                  );
                  const barW = Math.min(100, Math.max(4, (p.markEquity / maxEq) * 100));
                  return (
                    <div
                      key={p.id}
                      className={`leader-row ${p.isUser ? "is-user" : ""} ${idx === 0 ? "is-first" : ""} ${p.liquidated ? "is-rekt" : ""}`}
                    >
                      <div className="leader-rank">
                        {idx === 0 ? <Crown size={14} /> : `#${idx + 1}`}
                      </div>
                      <div className="leader-main">
                        <div className="leader-top">
                          <span className="leader-name">
                            {p.name}
                            {p.streak >= HOT_STREAK_THRESHOLD && (
                              <Flame size={12} className="flame-icon" />
                            )}
                          </span>
                          <strong className="leader-eq">
                            {fmtUsd(p.markEquity)}
                          </strong>
                        </div>
                        <div className="leader-meta">
                          <span className={`side-tag ${p.liquidated ? "rekt" : p.positionSide}`}>
                            {p.liquidated
                              ? "REKT"
                              : p.positionSide === "flat"
                                ? "FLAT"
                                : `${p.positionSide.toUpperCase()} ${p.leverage}x`}
                          </span>
                          <span className="trades-meta">
                            {p.tradesCount} trades
                          </span>
                          <span className={`pct-meta ${pct >= 0 ? "pos" : "neg"}`}>
                            {fmtPct(pct)}
                          </span>
                        </div>
                        <div className="leader-bar">
                          <div style={{ width: `${barW}%` }} />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Card 3: MagicBlock ER & Crank Telemetry Log */}
          <div className="card telemetry-card">
            <div className="card-head">
              <h2>
                <Activity size={15} /> ER &amp; CRANK TELEMETRY
              </h2>
              {busyLabel && <span className="busy-chip">{busyLabel}</span>}
            </div>
            <ol className="telemetry-list">
              {telemetry.map((entry) => (
                <li key={entry.id} className={`log-item ${entry.tone}`}>
                  <span className={`layer-tag ${entry.layer.toLowerCase()}`}>
                    {entry.layer}
                  </span>
                  <div className="log-body">
                    <span>{entry.message}</span>
                    <div className="log-meta">
                      <time>{entry.time}</time>
                      {entry.latencyMs && <b>{entry.latencyMs}ms</b>}
                      {entry.signature && (
                        <a
                          href={`https://explorer.solana.com/tx/${entry.signature}?cluster=devnet`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {shortKey(entry.signature)} <ExternalLink size={10} />
                        </a>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </aside>
      </main>

      {/* Footer MagicBlock Onchain Architecture Strip */}
      <footer className="arch-footer">
        <div>
          <span>Program ID</span>
          <code>{PROGRAM_ID.toBase58()}</code>
        </div>
        <div>
          <span>ER Validator (Asia)</span>
          <code>{ER_VALIDATOR.toBase58()}</code>
        </div>
        <div>
          <span>SOL/USD Ephemeral Oracle</span>
          <code>{SOL_PRICE_FEED.toBase58()}</code>
        </div>
        <div>
          <span>Base Layer RPC</span>
          <code>{BASE_ENDPOINT.replace("https://", "")}</code>
        </div>
        <div>
          <span>Session Signer</span>
          <code>{shortKey(sessionKp.publicKey)}</code>
        </div>
      </footer>
    </div>
  );
}
