# ⚡ BLITZ ARENA — 60s PvP Micro-Trading Sprint on Solana

🌐 **Live Demo:** https://blitz-arena-nine.vercel.app/
🔗 **Devnet Program ID:** [`F3af5wwcApM79ZjGTXQs5UdGqQ9aEgkxUVYA255HZGao`](https://explorer.solana.com/address/F3af5wwcApM79ZjGTXQs5UdGqQ9aEgkxUVYA255HZGao?cluster=devnet)

**Built for Solana Blitz v10 (Theme: Entertainment Finance)** — powered by **MagicBlock Ephemeral Rollups**, **MagicBlock Ephemeral Oracle (SOL/USD)**, and **MagicBlock Scheduled Cranks**.

> *Games are becoming markets, and markets are becoming entertainment.*
> Blitz Arena turns live Solana price action into a 60-second winner-takes-all PvP arcade sprint with **sub-50ms execution**, **zero gas fees**, **up to 100x leverage**, **hot-streak combos**, and **automated onchain crank liquidations & settlement**.

---

## 🎯 How It Works (L1 ↔ MagicBlock ER Lifecycle)

```mermaid
sequenceDiagram
    participant Players as Players (L1 Wallets + Session Keys)
    participant L1 as Solana L1 (Blitz Arena + Vault PDA)
    participant ER as MagicBlock ER (devnet-as.magicblock.app)
    participant Oracle as Ephemeral Oracle (SOL/USD)
    participant Crank as MagicBlock Scheduled Crank

    Players->>L1: create_arena / join_arena (Escrow real SOL buy-in in Vault PDA)
    Players->>L1: start_arena + delegate_arena (Delegate Arena PDA -> ER Validator)
    Players->>ER: schedule_round_crank (Arm 2s interval ticks via ScheduleCrankCpi)
    loop 60-Second Trading Sprint (Zero Gas, Sub-50ms)
        Players->>ER: trade(OpenLong / OpenShort / Close / Flip, 10x–100x) via Session Key
        ER->>Oracle: Read live PriceUpdateV2 (SOL/USD)
        Crank->>ER: crank_tick() every 2000ms (check REKT liquidations + end_ts)
    end
    Crank->>ER: Auto-close all open positions at T=60s & crown highest equity winner
    Players->>ER: finalize_and_undelegate() via MagicIntentBundleBuilder
    ER-->>L1: Commit final Arena state & winner back to Solana L1
    Players->>L1: claim_prize() releases real SOL pot from Vault PDA to Winner
```

---

## 🧩 MagicBlock Primitives Integrated

| Primitive | Usage in Blitz Arena | Implementation |
| --- | --- | --- |
| **Ephemeral Rollups (`#[ephemeral]`, `#[delegate]`, `#[commit]`)** | Delegates the `Arena` PDA to `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` (`devnet-as.magicblock.app`) while keeping real SOL escrowed safely in the L1 `Vault` PDA. | `programs/blitz-arena/src/lib.rs` |
| **MagicBlock Automation (`ScheduleCrankCpi`)** | Schedules `crank_tick` every 2 seconds inside ER to enforce real-time liquidations (`REKT`) and auto-finalize the match at `T = duration_secs`. | `schedule_round_crank` & `crank_tick` |
| **MagicBlock Ephemeral Oracle (`PriceUpdateV2`)** | Reads sub-second **SOL/USD** (`ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu`) inside every onchain trade and crank tick, and streams live ticks to the 60fps canvas chart via WebSocket. | `programs/blitz-arena/src/math.rs`, `app/src/lib/oracle.ts` |
| **Session-Key Zero-Popup UX** | Registers an ephemeral session pubkey per player on L1 join so players fire rapid `LONG / SHORT / CLOSE / FLIP` ER transactions with keyboard hotkeys (`W`, `S`, `Space`, `F`) and zero wallet popups while L1 prize claims stay locked to the main wallet. | `PlayerSlot.session_key` |

---

## 🚀 Quick Start (Frontend — Live MagicBlock Oracle Out of the Box)

```bash
cd app
npm install
npm run dev
```

Open `http://localhost:5173`. The app immediately connects to MagicBlock Asia Devnet (`wss://devnet-as.magicblock.app`) and streams live **SOL/USD** ticks from `ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu`.

---

## 🛠️ Build & Deploy Anchor Program to Solana Devnet

### Option A — Automated GitHub Actions (Zero Local Rust/WSL Needed!)
1. Push this repository to a **public GitHub repo**.
2. Go to **GitHub Repo → Settings → Secrets and variables → Actions** and add:
   - `SOLANA_DEPLOYER_KEYPAIR`: JSON array of a Devnet wallet funded with ~3 Devnet SOL (from `https://faucet.solana.com`).
   - `PROGRAM_KEYPAIR` *(optional)*: JSON array for deterministic Program ID (`F3af5wwcApM79ZjGTXQs5UdGqQ9aEgkxUVYA255HZGao`).
3. Open **Actions → Build, Test & Deploy Blitz Arena → Run workflow** with `deploy_devnet = true`.
4. Copy the printed `DEPLOYED_PROGRAM_ID` into Vercel env var `VITE_BLITZ_PROGRAM_ID` (if changed) and deploy `app/` to Vercel!

### Option B — Linux / macOS / WSL / GitHub Codespaces
```bash
# Exact MagicBlock toolchain
agave-install init 3.1.9
rustup install 1.89.0
avm use 1.0.2

# Build, test, and deploy to Devnet
bash scripts/deploy-devnet.sh
```

---

## 📦 Live Devnet Deployment & Verified Onchain Proof

* **Program ID (Live on Solana Devnet):** [`F3af5wwcApM79ZjGTXQs5UdGqQ9aEgkxUVYA255HZGao`](https://explorer.solana.com/address/F3af5wwcApM79ZjGTXQs5UdGqQ9aEgkxUVYA255HZGao?cluster=devnet)
* **Base Layer RPC:** `https://rpc.magicblock.app/devnet`
* **ER Validator (Asia):** `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` (`https://devnet-as.magicblock.app`)
* **SOL/USD Ephemeral Oracle:** `ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu`
* **Delegation Program:** `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`
* **Magic Program:** `Magic11111111111111111111111111111111111111`

### ✅ Verified End-to-End Onchain Run (Arena `#1795631852`)
1. **L1 `create_arena` (SOL escrow in Vault PDA):** [`65BMPp…UQgujTD`](https://explorer.solana.com/tx/65BMPpPGsJ66PvLBMReTXUQcZ8vzxUsgHfKbdifdFqhokuqn1tYJoHCokf1ocsN9UHwiE6mU4ku1ybb62UQgujTD?cluster=devnet) *(122 ms)*
2. **L1 `start_arena + delegate_arena` (L1 → MagicBlock ER):** [`3MAfPi…E54yzdp35`](https://explorer.solana.com/tx/3MAfPikoeid8FqZSDENm1cUNoPDhhfybArt9KLnD7Y3GmddXgRfdcaeQapgniChB2r5Ns1ijcqpTtVnE54yzdp35?cluster=devnet) *(118 ms)*
3. **ER `schedule_round_crank` (2s ticks, auto-finalized after 7 ticks):** `4kbk2JYdkCch9uSB97pUv1vAQP5KAYbNRADJtvgQXRpKJtZyFQnYqeKb4ZdFghaBTAHuaiJsZByNNVbGDqSbThGn`
4. **ER `trade(OpenLong 50x)` via Session Key (0 Gas):** `4tmYegW5Mz3VQCtTxwhWdEkK8tKymnes2BBZWmwnAjqZ8vftQsrf9m7C4hsCSe6vtSQH7PFWJYrkcps1g4TAkrdv` *(86 ms)*
5. **ER `trade(Flip -> Short 50x)` via Session Key (0 Gas):** `5t98PU27ScFq7z3e9ZrrVqRMGaaueY5MWy9Aq3nW3RTexy8Vq6gwGxmhgztA7kAcuoAUB8qrAo2oAbMBys1HUTox` *(59 ms)*
6. **ER `finalize_and_undelegate` (ER → L1 commit):** `MzZ3ApNNXjFZJAUHRamTE2y9BMV91D4cf5RPQg1DS5uow4xyLEwFTUB8Q6m4v8JsjFa9EN6DSNwASRMnryTxnWi` *(75 ms)*
7. **L1 `claim_prize` (Vault SOL pot paid to Winner):** [`VPAAzG…BTRh9Zg`](https://explorer.solana.com/tx/VPAAzGQBj1vNfkBigrjtehWibGn7n7hk7eTqh72BJw64feYSconEhRSKjqJyf6Ld4ahR3uzB9eBHTNCwBTRh9Zg?cluster=devnet) *(430 ms)*
