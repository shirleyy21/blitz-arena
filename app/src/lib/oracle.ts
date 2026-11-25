import { Connection, PublicKey } from "@solana/web3.js";

export const BASE_ENDPOINT =
  import.meta.env.VITE_PROVIDER_ENDPOINT ?? "https://rpc.magicblock.app/devnet";

export const ER_ENDPOINT =
  import.meta.env.VITE_EPHEMERAL_PROVIDER_ENDPOINT ??
  "https://devnet-as.magicblock.app";

export const ER_WS_ENDPOINT =
  import.meta.env.VITE_EPHEMERAL_WS_ENDPOINT ??
  "wss://devnet-as.magicblock.app";

export const ER_VALIDATOR = new PublicKey(
  import.meta.env.VITE_VALIDATOR ??
    "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57",
);

export const ORACLE_SYMBOL = "SOL/USD";
export const SOL_PRICE_FEED = new PublicKey(
  "ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu",
);

export type OraclePrice = {
  raw: bigint;
  numeric: number;
  display: string;
  exponent: number;
  publishTime: number;
  slot: string;
  receivedAt: number;
};

// Accepted 8-byte discriminators: MagicBlock Ephemeral Oracle + canonical Pyth PriceUpdateV2.
const PRICE_UPDATE_DISCRIMINATORS = [
  Buffer.from([234, 161, 14, 36, 172, 239, 15, 232]),
  Buffer.from([34, 241, 35, 99, 157, 126, 244, 205]),
];

export function formatOraclePrice(raw: bigint, exponent: number): string {
  const scale = Math.abs(exponent);
  if (scale === 0) return raw.toString();
  const sign = raw < 0n ? "-" : "";
  const absRaw = raw < 0n ? -raw : raw;
  const denom = 10n ** BigInt(scale);
  const whole = absRaw / denom;
  const frac = (absRaw % denom).toString().padStart(scale, "0");
  return `${sign}${whole}.${frac.slice(0, 4)}`;
}

export function decodeOraclePrice(data: Buffer): OraclePrice {
  if (data.length < 133) {
    throw new Error("Oracle account data too short");
  }
  const disc = data.subarray(0, 8);
  if (!PRICE_UPDATE_DISCRIMINATORS.some((d) => disc.equals(d))) {
    throw new Error("Unrecognized oracle PriceUpdateV2 discriminator");
  }

  const raw = data.readBigInt64LE(73);
  const exponent = data.readInt32LE(89);
  const publishTime = Number(data.readBigInt64LE(93));
  const slot = data.readBigUInt64LE(125).toString();
  const scale = Math.abs(exponent);
  const numeric = Number(raw) / Math.pow(10, scale);

  return {
    raw,
    numeric,
    display: formatOraclePrice(raw, exponent),
    exponent,
    publishTime,
    slot,
    receivedAt: Date.now(),
  };
}

export async function fetchLiveOraclePrice(
  connection?: Connection,
): Promise<OraclePrice> {
  const conn =
    connection ??
    new Connection(ER_ENDPOINT, {
      commitment: "confirmed",
      wsEndpoint: ER_WS_ENDPOINT,
    });
  const info = await conn.getAccountInfo(SOL_PRICE_FEED, "confirmed");
  if (!info) {
    throw new Error(`${ORACLE_SYMBOL} Ephemeral Oracle account not found`);
  }
  return decodeOraclePrice(info.data);
}

export function subscribeLiveOracle(
  onPrice: (price: OraclePrice) => void,
  onStatus: (status: "connecting" | "live" | "degraded") => void,
): () => void {
  const conn = new Connection(ER_ENDPOINT, {
    commitment: "confirmed",
    wsEndpoint: ER_WS_ENDPOINT,
  });

  let disposed = false;
  let subId: number | null = null;
  let lastReceived = 0;

  onStatus("connecting");

  const emit = (price: OraclePrice) => {
    if (disposed) return;
    lastReceived = Date.now();
    onStatus("live");
    onPrice(price);
  };

  fetchLiveOraclePrice(conn)
    .then(emit)
    .catch(() => {
      if (!disposed) onStatus("degraded");
    });

  try {
    const id = conn.onAccountChange(
      SOL_PRICE_FEED,
      (account) => {
        try {
          emit(decodeOraclePrice(account.data));
        } catch {
          // Ignore malformed transient frames
        }
      },
      "confirmed",
    );
    if (disposed) {
      void conn.removeAccountChangeListener(id);
    } else {
      subId = id;
    }
  } catch {
    if (!disposed) onStatus("degraded");
  }

  // Backup heartbeat poll in case corporate/ISP WebSocket drops frames
  const pollTimer = window.setInterval(() => {
    if (disposed) return;
    if (Date.now() - lastReceived > 1_100) {
      fetchLiveOraclePrice(conn)
        .then(emit)
        .catch(() => {
          if (!disposed && Date.now() - lastReceived > 6_000) {
            onStatus("degraded");
          }
        });
    }
  }, 1_000);

  return () => {
    disposed = true;
    window.clearInterval(pollTimer);
    if (subId !== null) {
      void conn.removeAccountChangeListener(subId);
    }
  };
}
