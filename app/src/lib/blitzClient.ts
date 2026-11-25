import * as anchor from "@coral-xyz/anchor";
import { BN, Idl, Program } from "@coral-xyz/anchor";
import {
  Commitment,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import blitzArenaIdl from "../idl/blitz_arena.json";
import {
  BASE_ENDPOINT,
  ER_ENDPOINT,
  ER_VALIDATOR,
  ER_WS_ENDPOINT,
  SOL_PRICE_FEED,
} from "./oracle";
import {
  ArenaState,
  ArenaStatus,
  Leverage,
  PositionSide,
  TradeAction,
  TraderSlot,
} from "./arenaEngine";

export const MAGIC_PROGRAM_ID = new PublicKey(
  "Magic11111111111111111111111111111111111111",
);
export const MAGIC_CONTEXT_ID = new PublicKey(
  "MagicContext1111111111111111111111111111111",
);

const idlAddress = (blitzArenaIdl as Idl & { address: string }).address;
export const PROGRAM_ID = new PublicKey(
  import.meta.env.VITE_BLITZ_PROGRAM_ID ?? idlAddress,
);

const ARENA_SEED = Buffer.from("arena");
const VAULT_SEED = Buffer.from("vault");
const OPERATOR_STORAGE_KEY = "blitzArenaOperatorKeypairV1";
const SESSION_STORAGE_KEY = "blitzArenaSessionKeypairV1";

export type BrowserWalletProvider = {
  isPhantom?: boolean;
  isSolflare?: boolean;
  publicKey: PublicKey | null;
  connect: () => Promise<{ publicKey: PublicKey }>;
  disconnect: () => Promise<void>;
  signTransaction: <T extends Transaction | VersionedTransaction>(
    tx: T,
  ) => Promise<T>;
  signAllTransactions: <T extends Transaction | VersionedTransaction>(
    txs: T[],
  ) => Promise<T[]>;
};

declare global {
  interface Window {
    solana?: BrowserWalletProvider;
    solflare?: BrowserWalletProvider;
  }
}

export type TxMetrics = {
  signature: string;
  latencyMs: number;
};

export function shortKey(key?: string | PublicKey | null): string {
  if (!key) return "—";
  const text = typeof key === "string" ? key : key.toBase58();
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

export function getBrowserWallet(): BrowserWalletProvider | null {
  if (typeof window === "undefined") return null;
  if (window.solana?.isPhantom) return window.solana;
  if (window.solflare?.isSolflare) return window.solflare;
  return window.solana ?? null;
}

export function loadOrCreateKeypair(storageKey: string): Keypair {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const secret = JSON.parse(raw) as number[];
      if (Array.isArray(secret) && secret.length === 64) {
        return Keypair.fromSecretKey(Uint8Array.from(secret));
      }
    }
  } catch {
    // Regenerate on malformed storage
  }
  const kp = Keypair.generate();
  localStorage.setItem(storageKey, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

export function getOperatorKeypair(): Keypair {
  return loadOrCreateKeypair(OPERATOR_STORAGE_KEY);
}

export function getSessionKeypair(): Keypair {
  return loadOrCreateKeypair(SESSION_STORAGE_KEY);
}

export function u64LeBytes(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value, 0);
  return buf;
}

export function arenaPda(arenaId: bigint): PublicKey {
  return PublicKey.findProgramAddressSync(
    [ARENA_SEED, u64LeBytes(arenaId)],
    PROGRAM_ID,
  )[0];
}

export function vaultPda(arenaId: bigint): PublicKey {
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, u64LeBytes(arenaId)],
    PROGRAM_ID,
  )[0];
}

export function delegationBufferPda(account: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("buffer"), account.toBuffer()],
    PROGRAM_ID,
  )[0];
}

export function delegationRecordPda(account: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("delegation"), account.toBuffer()],
    DELEGATION_PROGRAM_ID,
  )[0];
}

export function delegationMetadataPda(account: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("delegation-metadata"), account.toBuffer()],
    DELEGATION_PROGRAM_ID,
  )[0];
}

export function createConnections() {
  const base = new Connection(BASE_ENDPOINT, "confirmed");
  const er = new Connection(ER_ENDPOINT, {
    commitment: "confirmed",
    wsEndpoint: ER_WS_ENDPOINT,
  });
  return { base, er };
}

export async function checkProgramDeployedOnDevnet(): Promise<boolean> {
  try {
    const { base } = createConnections();
    const info = await base.getAccountInfo(PROGRAM_ID, "confirmed");
    return Boolean(info && info.executable);
  } catch {
    return false;
  }
}

export async function fetchSolBalance(pubkey: PublicKey): Promise<number> {
  try {
    const { base } = createConnections();
    const lamports = await base.getBalance(pubkey, "confirmed");
    return lamports / LAMPORTS_PER_SOL;
  } catch {
    return 0;
  }
}

export async function requestDevnetAirdrop(
  pubkey: PublicKey,
  sol = 1,
): Promise<string> {
  const { base } = createConnections();
  const sig = await base.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
  await base.confirmTransaction(sig, "confirmed");
  return sig;
}

class LocalKeypairWallet implements anchor.Wallet {
  constructor(readonly payer: Keypair) {}
  get publicKey() {
    return this.payer.publicKey;
  }
  async signTransaction<T extends Transaction | VersionedTransaction>(
    tx: T,
  ): Promise<T> {
    if (tx instanceof VersionedTransaction) {
      tx.sign([this.payer]);
    } else {
      tx.partialSign(this.payer);
    }
    return tx;
  }
  async signAllTransactions<T extends Transaction | VersionedTransaction>(
    txs: T[],
  ): Promise<T[]> {
    return Promise.all(txs.map((t) => this.signTransaction(t)));
  }
}

function buildPrograms(signerWallet: anchor.Wallet) {
  const { base, er } = createConnections();
  const baseProvider = new anchor.AnchorProvider(
    base,
    signerWallet,
    anchor.AnchorProvider.defaultOptions(),
  );
  const erProvider = new anchor.AnchorProvider(
    er,
    signerWallet,
    anchor.AnchorProvider.defaultOptions(),
  );
  const idl = {
    ...blitzArenaIdl,
    address: PROGRAM_ID.toBase58(),
  } as Idl;
  return {
    base,
    er,
    baseProgram: new Program(idl, baseProvider),
    erProgram: new Program(idl, erProvider),
  };
}

async function sendTxWithKeypair(
  connection: Connection,
  tx: Transaction,
  feePayer: Keypair,
  extraSigners: Keypair[] = [],
  commitment: Commitment = "confirmed",
): Promise<TxMetrics> {
  const blockhash = await connection.getLatestBlockhash(commitment);
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = blockhash.blockhash;
  const unique = new Map<string, Keypair>();
  [feePayer, ...extraSigners].forEach((kp) =>
    unique.set(kp.publicKey.toBase58(), kp),
  );
  tx.partialSign(...unique.values());

  const start = performance.now();
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    preflightCommitment: commitment,
  });
  const latencyMs = Math.max(1, Math.round(performance.now() - start));

  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
    },
    commitment,
  );
  if (confirmation.value.err) {
    throw new Error(
      `Tx ${signature.slice(0, 8)} reverted: ${JSON.stringify(confirmation.value.err)}`,
    );
  }
  return { signature, latencyMs };
}

function mapStatus(raw: Record<string, unknown>): ArenaStatus {
  if ("active" in raw) return "active";
  if ("finished" in raw) return "finished";
  return "lobby";
}

function mapSide(raw: Record<string, unknown>): PositionSide {
  if ("long" in raw) return "long";
  if ("short" in raw) return "short";
  return "flat";
}

export function decodeOnchainArena(
  account: any,
  userWallet: string,
  delegatedToEr: boolean,
): ArenaState {
  const count = Number(account.playerCount ?? 0);
  const players: TraderSlot[] = [];
  for (let i = 0; i < count; i += 1) {
    const p = account.players[i];
    const walletStr = (p.wallet as PublicKey).toBase58();
    players.push({
      id: walletStr,
      name: walletStr === userWallet ? "YOU" : shortKey(walletStr),
      wallet: walletStr,
      isUser: walletStr === userWallet,
      equityUsd: Number(p.equityMicroUsd.toString()) / 1_000_000,
      positionSide: mapSide(p.positionSide),
      leverage: Number(p.leverage),
      entryPrice: Number(p.entryPrice.toString()) / 1e8,
      marginUsd: Number(p.marginMicroUsd.toString()) / 1_000_000,
      tradesCount: Number(p.tradesCount),
      winsCount: Number(p.winsCount),
      streak: Number(p.streak),
      liquidated: Boolean(p.liquidated),
      claimed: Boolean(p.claimed),
    });
  }

  const winnerWallet = (account.winner as PublicKey).toBase58();
  const winnerSlot = players.find((p) => p.wallet === winnerWallet);

  return {
    arenaId: account.arenaId.toString(),
    mode: "onchain_er",
    status: mapStatus(account.status),
    entryFeeSol: Number(account.entryFeeLamports.toString()) / LAMPORTS_PER_SOL,
    potSol: Number(account.potLamports.toString()) / LAMPORTS_PER_SOL,
    durationSecs: Number(account.durationSecs.toString()),
    startTsMs: Number(account.startTs.toString()) * 1000,
    endTsMs: Number(account.endTs.toString()) * 1000,
    crankScheduled: Boolean(account.crankScheduled),
    crankTicks: Number(account.crankTicks),
    lastCrankPrice: Number(account.lastCrankPrice.toString()) / 1e8,
    finalPrice: Number(account.finalPrice.toString()) / 1e8,
    winnerWallet,
    winnerName: winnerSlot?.name ?? shortKey(winnerWallet),
    winnerEquityUsd: Number(account.winnerEquity.toString()) / 1_000_000,
    delegatedToEr,
    committedToL1: !delegatedToEr && mapStatus(account.status) === "finished",
    players,
  };
}

export async function createAndLaunchOnchainArena(params: {
  arenaId: bigint;
  entryFeeSol: number;
  durationSecs: number;
  maxPlayers: number;
  operator: Keypair;
  session: Keypair;
  spawnSecondLocalRival?: boolean;
}): Promise<{
  createTx: TxMetrics;
  delegateTx: TxMetrics;
  crankTx: TxMetrics;
}> {
  const wallet = new LocalKeypairWallet(params.operator);
  const { base, er, baseProgram, erProgram } = buildPrograms(wallet);
  const arena = arenaPda(params.arenaId);
  const vault = vaultPda(params.arenaId);
  const entryLamports = Math.round(params.entryFeeSol * LAMPORTS_PER_SOL);

  // 1. L1 Create Arena + escrow SOL buy-in
  const createTxObj = await (baseProgram as any).methods
    .createArena(
      new BN(params.arenaId.toString()),
      new BN(entryLamports),
      new BN(params.durationSecs),
      params.maxPlayers,
      SOL_PRICE_FEED,
      Array.from(SOL_PRICE_FEED.toBytes()),
      params.session.publicKey,
    )
    .accountsPartial({
      creator: params.operator.publicKey,
      arena,
      vault,
      systemProgram: SystemProgram.programId,
    })
    .transaction();

  const createTx = await sendTxWithKeypair(base, createTxObj, params.operator);

  // 2. L1 Atomic Start Arena + Delegate Arena PDA to MagicBlock ER Validator
  const startIx = await (baseProgram as any).methods
    .startArena(new BN(params.arenaId.toString()))
    .accountsPartial({
      creator: params.operator.publicKey,
      arena,
    })
    .instruction();

  const delegateIx = await (baseProgram as any).methods
    .delegateArena(new BN(params.arenaId.toString()))
    .accountsPartial({
      payer: params.operator.publicKey,
      bufferArena: delegationBufferPda(arena),
      delegationRecordArena: delegationRecordPda(arena),
      delegationMetadataArena: delegationMetadataPda(arena),
      arena,
      ownerProgram: PROGRAM_ID,
      delegationProgram: DELEGATION_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([
      { pubkey: ER_VALIDATOR, isSigner: false, isWritable: false },
    ])
    .instruction();

  const delegateTx = await sendTxWithKeypair(
    base,
    new Transaction().add(startIx, delegateIx),
    params.operator,
  );

  // 3. ER Schedule Native MagicBlock Crank (ticks every 2000ms for duration + 8s buffer)
  const iterations = Math.ceil((params.durationSecs + 8) / 2);
  const crankTxObj = await (erProgram as any).methods
    .scheduleRoundCrank(new BN(params.arenaId.toString()), {
      taskId: new BN(Date.now()),
      executionIntervalMillis: new BN(2000),
      iterations: new BN(iterations),
    })
    .accountsPartial({
      magicProgram: MAGIC_PROGRAM_ID,
      payer: params.operator.publicKey,
      arena,
      priceUpdate: SOL_PRICE_FEED,
      program: PROGRAM_ID,
    })
    .transaction();

  const crankTx = await sendTxWithKeypair(
    er,
    crankTxObj,
    params.operator,
    [],
    "processed",
  );

  return { createTx, delegateTx, crankTx };
}

export async function sendOnchainErTrade(params: {
  arenaId: bigint;
  action: TradeAction;
  leverage: Leverage;
  session: Keypair;
}): Promise<TxMetrics> {
  const wallet = new LocalKeypairWallet(params.session);
  const { er, erProgram } = buildPrograms(wallet);
  const arena = arenaPda(params.arenaId);

  const actionArg =
    params.action === "openLong"
      ? { openLong: {} }
      : params.action === "openShort"
        ? { openShort: {} }
        : params.action === "close"
          ? { close: {} }
          : { flip: {} };

  const tx = await (erProgram as any).methods
    .trade(new BN(params.arenaId.toString()), actionArg, params.leverage)
    .accountsPartial({
      signer: params.session.publicKey,
      arena,
      priceUpdate: SOL_PRICE_FEED,
    })
    .transaction();

  return sendTxWithKeypair(er, tx, params.session, [], "processed");
}

export async function sendFinalizeAndUndelegate(params: {
  arenaId: bigint;
  operator: Keypair;
}): Promise<TxMetrics> {
  const wallet = new LocalKeypairWallet(params.operator);
  const { er, erProgram } = buildPrograms(wallet);
  const arena = arenaPda(params.arenaId);

  const tx = await (erProgram as any).methods
    .finalizeAndUndelegate(new BN(params.arenaId.toString()))
    .accountsPartial({
      payer: params.operator.publicKey,
      arena,
      priceUpdate: SOL_PRICE_FEED,
      magicProgram: MAGIC_PROGRAM_ID,
      magicContext: MAGIC_CONTEXT_ID,
    })
    .transaction();

  return sendTxWithKeypair(er, tx, params.operator, [], "confirmed");
}

export async function sendClaimPrizeL1(params: {
  arenaId: bigint;
  winner: Keypair;
}): Promise<TxMetrics> {
  const wallet = new LocalKeypairWallet(params.winner);
  const { base, baseProgram } = buildPrograms(wallet);
  const arena = arenaPda(params.arenaId);
  const vault = vaultPda(params.arenaId);

  const tx = await (baseProgram as any).methods
    .claimPrize(new BN(params.arenaId.toString()))
    .accountsPartial({
      winner: params.winner.publicKey,
      arena,
      vault,
      systemProgram: SystemProgram.programId,
    })
    .transaction();

  return sendTxWithKeypair(base, tx, params.winner, [], "confirmed");
}

export async function fetchOnchainArenaState(
  arenaId: bigint,
  userWallet: string,
  preferEr: boolean,
): Promise<ArenaState | null> {
  const dummy = new LocalKeypairWallet(getOperatorKeypair());
  const { baseProgram, erProgram } = buildPrograms(dummy);
  const arena = arenaPda(arenaId);
  const primary = preferEr ? erProgram : baseProgram;
  const fallback = preferEr ? baseProgram : erProgram;

  try {
    const acc = await (primary as any).account.arena.fetch(arena);
    return decodeOnchainArena(acc, userWallet, preferEr);
  } catch {
    try {
      const acc = await (fallback as any).account.arena.fetch(arena);
      return decodeOnchainArena(acc, userWallet, !preferEr);
    } catch {
      return null;
    }
  }
}
