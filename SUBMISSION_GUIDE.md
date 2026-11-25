# 🏆 Panduan Deploy Devnet & Submit Solana Blitz v10

**Deadline:** Jumat, 27 November 2026 pukul **21.00 WIB** (22.00 SGT / 14.00 UTC)
**Link Submit:** https://build.magicblock.app/?stage=blitz#submit

---

## 1️⃣ Push ke GitHub Publik & Auto-Deploy ke Solana Devnet (Tanpa Install Rust/WSL!)

Karena Windows kamu belum ada Rust/Solana/WSL, proyek ini sudah dilengkapi workflow GitHub Actions (`.github/workflows/build-and-deploy.yml`) yang memakai toolchain resmi MagicBlock (`Rust 1.89.0`, `Solana Agave 3.1.9`, `Anchor 1.0.2`) di server Linux gratis:

1. Buat repo publik baru di GitHub bernama **`blitz-arena`**.
2. Push kode dari folder proyek ini:
   ```bash
   git remote add origin https://github.com/<USERNAME_KAMU>/blitz-arena.git
   git push -u origin main
   ```
   *(CI otomatis langsung meng-compile `programs/blitz-arena` + menjalankan unit test PnL/liquidation + build frontend!)*
3. Untuk deploy program onchain ke **Solana Devnet**:
   - Buka **https://faucet.solana.com** dan isi ~3 Devnet SOL ke wallet Devnet kamu (bisa pakai keypair baru atau export JSON keypair Devnet).
   - Di GitHub Repo → **Settings → Secrets and variables → Actions → New repository secret**:
     - `SOLANA_DEPLOYER_KEYPAIR`: paste isi array JSON `[12, 34, ...]` wallet Devnet yang sudah terisi ~3 SOL.
     - `PROGRAM_KEYPAIR` *(opsional — agar memakai Program ID `F3af5wwcApM79ZjGTXQs5UdGqQ9aEgkxUVYA255HZGao`)*: paste isi file keypair program dari folder scratch lokal jika ingin alamat tetap sama.
   - Buka tab **Actions → Build, Test & Deploy Blitz Arena → Run workflow**, ubah `deploy_devnet` menjadi **`true`**, lalu klik **Run workflow**.
   - Catat `DEPLOYED_PROGRAM_ID` dari log GitHub Actions!

---

## 2️⃣ Deploy Frontend Live ke Vercel (2 Menit)

1. Buka **https://vercel.com/new** dan import repo GitHub `blitz-arena`.
2. Atur **Root Directory** = `app` (Framework Preset: **Vite**).
3. Tambahkan Environment Variable (jika Program ID berubah):
   - `VITE_BLITZ_PROGRAM_ID` = `<DEPLOYED_PROGRAM_ID>`
4. Klik **Deploy**. Begitu Program ID sudah live di Devnet, tombol **Devnet ER ONCHAIN** di topbar otomatis terbuka dan langsung aktif!

---

## 3️⃣ Copy-Paste Form Submit (`build.magicblock.app/?stage=blitz#submit`)

* **Project Name:** `Blitz Arena`
* **Categories:** `Games`, `DeFi`, `Consumer`
* **Short Description (EN):**
  > Blitz Arena is a 60-second PvP micro-trading esports arena on Solana built for Entertainment Finance. Players escrow real SOL buy-ins on Solana L1, delegate the Arena PDA to MagicBlock Ephemeral Rollups (`devnet-as.magicblock.app`), and execute sub-50ms, zero-gas 10x–100x leveraged Long/Short/Flip trades against MagicBlock's live SOL/USD Ephemeral Oracle using zero-popup session keys. A native MagicBlock Scheduled Crank (`ScheduleCrankCpi`) ticks every 2 seconds to enforce real-time onchain liquidations (REKT) and automatically settles the highest-equity winner back to Solana L1 via `commit_and_undelegate` to claim the SOL pot.
* **Program ID (LIVE ON DEVNET):** `F3af5wwcApM79ZjGTXQs5UdGqQ9aEgkxUVYA255HZGao`
* **Program Explorer Link:** `https://explorer.solana.com/address/F3af5wwcApM79ZjGTXQs5UdGqQ9aEgkxUVYA255HZGao?cluster=devnet`
* **Verified L1 Delegation TX:** `https://explorer.solana.com/tx/3MAfPikoeid8FqZSDENm1cUNoPDhhfybArt9KLnD7Y3GmddXgRfdcaeQapgniChB2r5Ns1ijcqpTtVnE54yzdp35?cluster=devnet`
* **Verified L1 Prize Claim TX:** `https://explorer.solana.com/tx/VPAAzGQBj1vNfkBigrjtehWibGn7n7hk7eTqh72BJw64feYSconEhRSKjqJyf6Ld4ahR3uzB9eBHTNCwBTRh9Zg?cluster=devnet`
* **Operator / Deployer Wallet:** `F7JgBNLSaBBfMpFEUnNZjWUcHaWN4JL2cA8mkkHPpWMU`
* **ER Validator:** `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` (`https://devnet-as.magicblock.app`)
* **Oracle Account:** `ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu` (MagicBlock SOL/USD Ephemeral Oracle)

---

## 4️⃣ Skrip Video Demo 90–120 Detik (Tinggi Peluang Menang!)

1. **0:00–0:20 (Hook + Masalah):**
   Tunjukkan halaman Blitz Arena dengan harga **SOL/USD live streaming** dari MagicBlock Ephemeral Oracle (`ER ORACLE LIVE`). Jelaskan: *"Trading di L1 butuh 400ms+ dan popup wallet di tiap klik. Di Blitz Arena, kami ubah pergerakan harga SOL menjadi game PvP 60 detik berhadiah SOL pot dengan eksekusi <50ms dan 0 gas lewat MagicBlock Ephemeral Rollups."*
2. **0:20–0:55 (Live Gameplay + Hotkeys):**
   Klik **START 60s PVP BLITZ SPRINT** (tunjukkan log `create_arena` → `delegate_arena` → `schedule_round_crank`). Pakai leverage `50x`/`100x`, tekan tombol **LONG (`W`)**, tunjukkan garis entry hijau/merah & live PnL di chart, tekan **FLIP (`F`)** untuk balik arah instan dalam 1 tx (<50ms, 0 gas), lalu **CLOSE (`Space`)** sambil tunjukkan leaderboard PvP dan **MagicBlock Crank ticks** yang terus berdetak.
3. **0:55–1:25 (Settlement + Onchain Proof):**
   Biarkan timer menyentuh `0.0s` — tunjukkan Crank menyelesaikan ronde, `commit_and_undelegate` mengirim pemenang kembali ke Solana L1, dan klik **Claim SOL Pot** (+ klik link Solana Explorer di panel Telemetry!).
4. **1:25–1:45 (Tech Stack Close):**
   Tunjukkan sekilas `programs/blitz-arena/src/lib.rs` (`#[ephemeral]`, `#[delegate]`, `ScheduleCrankCpi`, `PriceUpdateV2`, `MagicIntentBundleBuilder::commit_and_undelegate`) lalu tutup dengan link repo & live demo.
