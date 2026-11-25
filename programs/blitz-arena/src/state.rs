use anchor_lang::prelude::*;

pub const MAX_PLAYERS: usize = 8;
/// Every trader starts each 60-second sprint with $10,000.000000 virtual stack (6 decimals).
pub const STARTING_EQUITY_MICRO_USD: i64 = 10_000_000_000;
/// Hot-streak bonus (+5% on realized profit when streak >= 3 consecutive winning trades).
pub const HOT_STREAK_THRESHOLD: u8 = 3;
pub const HOT_STREAK_BONUS_BPS: i128 = 500; // 5%

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, Debug)]
pub enum ArenaStatus {
    #[default]
    Lobby,
    Active,
    Finished,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, Debug)]
pub enum PositionSide {
    #[default]
    Flat,
    Long,
    Short,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum TradeAction {
    OpenLong,
    OpenShort,
    Close,
    Flip,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct PlayerSlot {
    pub wallet: Pubkey,
    pub session_key: Pubkey,
    pub equity_micro_usd: i64,
    pub position_side: PositionSide,
    pub leverage: u8,
    pub entry_price: i64,
    pub margin_micro_usd: i64,
    pub trades_count: u16,
    pub wins_count: u16,
    pub streak: u8,
    pub liquidated: bool,
    pub claimed: bool,
}

impl PlayerSlot {
    pub const LEN: usize = 32 + 32 + 8 + 1 + 1 + 8 + 8 + 2 + 2 + 1 + 1 + 1;
}

/// Core match account delegated to MagicBlock Ephemeral Rollups during live trading.
/// Real SOL buy-ins stay escrowed in the separate L1 Vault PDA (`[b"vault", arena_id]`).
#[account]
pub struct Arena {
    pub arena_id: u64,
    pub creator: Pubkey,
    pub price_feed: Pubkey,
    pub price_feed_id: [u8; 32],
    pub entry_fee_lamports: u64,
    pub pot_lamports: u64,
    pub duration_secs: i64,
    pub start_ts: i64,
    pub end_ts: i64,
    pub status: ArenaStatus,
    pub player_count: u8,
    pub max_players: u8,
    pub crank_scheduled: bool,
    pub crank_ticks: u32,
    pub last_crank_price: i64,
    pub final_price: i64,
    pub winner: Pubkey,
    pub winner_equity: i64,
    pub bump: u8,
    pub vault_bump: u8,
    pub players: [PlayerSlot; MAX_PLAYERS],
}

impl Arena {
    pub const LEN: usize =
        8 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 1 + 4 + 8 + 8 + 32 + 8 + 1 + 1
            + (PlayerSlot::LEN * MAX_PLAYERS);
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct ScheduleRoundCrankArgs {
    pub task_id: i64,
    pub execution_interval_millis: i64,
    pub iterations: i64,
}
