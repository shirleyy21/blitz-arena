use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::error::BlitzError;
use crate::state::{
    Arena, ArenaStatus, PlayerSlot, PositionSide, HOT_STREAK_BONUS_BPS, HOT_STREAK_THRESHOLD,
};

pub const MAX_PRICE_AGE_SECONDS: u64 = 300;
const BPS_DENOM: i128 = 10_000;

/// Reads a fresh price from MagicBlock's Ephemeral Oracle (PriceUpdateV2 layout).
pub fn read_oracle_price(
    price_update_account: &UncheckedAccount,
    expected_feed: &Pubkey,
    expected_feed_id: &[u8; 32],
) -> Result<i64> {
    require_keys_eq!(
        price_update_account.key(),
        *expected_feed,
        BlitzError::InvalidPriceFeed
    );
    let info = price_update_account.to_account_info();
    let data_ref = info.data.borrow();
    let price_update = PriceUpdateV2::try_deserialize_unchecked(&mut data_ref.as_ref())
        .map_err(Into::<Error>::into)?;
    let price = price_update.get_price_no_older_than(
        &Clock::get()?,
        MAX_PRICE_AGE_SECONDS,
        expected_feed_id,
    )?;
    require!(price.price > 0, BlitzError::InvalidOraclePrice);
    Ok(price.price)
}

pub fn validate_leverage(leverage: u8) -> Result<()> {
    require!(
        matches!(leverage, 10 | 25 | 50 | 100),
        BlitzError::InvalidLeverage
    );
    Ok(())
}

/// Computes unrealized PnL in micro-USD (6 decimals) for an open leveraged position.
pub fn compute_unrealized_pnl(slot: &PlayerSlot, current_price: i64) -> Result<i128> {
    if slot.position_side == PositionSide::Flat || slot.entry_price <= 0 || slot.margin_micro_usd <= 0
    {
        return Ok(0);
    }

    let delta = (current_price as i128)
        .checked_sub(slot.entry_price as i128)
        .ok_or(BlitzError::MathOverflow)?;
    let signed_delta = match slot.position_side {
        PositionSide::Long => delta,
        PositionSide::Short => delta.checked_neg().ok_or(BlitzError::MathOverflow)?,
        PositionSide::Flat => 0,
    };

    let notional_delta = (slot.margin_micro_usd as i128)
        .checked_mul(slot.leverage as i128)
        .and_then(|v| v.checked_mul(signed_delta))
        .ok_or(BlitzError::MathOverflow)?;

    notional_delta
        .checked_div(slot.entry_price as i128)
        .ok_or(BlitzError::MathOverflow.into())
}

/// Closes a player's open position at `current_price`, applying liquidation or hot-streak bonus.
pub fn settle_player_position(slot: &mut PlayerSlot, current_price: i64) -> Result<()> {
    if slot.liquidated || slot.position_side == PositionSide::Flat {
        return Ok(());
    }

    let raw_pnl = compute_unrealized_pnl(slot, current_price)?;
    let mut final_pnl = raw_pnl;

    if raw_pnl > 0 {
        slot.wins_count = slot.wins_count.saturating_add(1);
        slot.streak = slot.streak.saturating_add(1);
        if slot.streak >= HOT_STREAK_THRESHOLD {
            let bonus = raw_pnl
                .checked_mul(HOT_STREAK_BONUS_BPS)
                .and_then(|v| v.checked_div(BPS_DENOM))
                .unwrap_or(0);
            final_pnl = final_pnl.saturating_add(bonus);
        }
    } else if raw_pnl < 0 {
        slot.streak = 0;
    }

    let updated = (slot.equity_micro_usd as i128)
        .checked_add(final_pnl)
        .ok_or(BlitzError::MathOverflow)?;

    if updated <= 0 {
        slot.equity_micro_usd = 0;
        slot.liquidated = true;
        slot.streak = 0;
    } else {
        slot.equity_micro_usd = i64::try_from(updated).map_err(|_| BlitzError::MathOverflow)?;
    }

    slot.position_side = PositionSide::Flat;
    slot.entry_price = 0;
    slot.margin_micro_usd = 0;
    slot.leverage = 0;

    Ok(())
}

/// Checks whether an open position has been liquidated at `current_price` during a crank tick.
pub fn check_liquidation(slot: &mut PlayerSlot, current_price: i64) -> Result<bool> {
    if slot.liquidated || slot.position_side == PositionSide::Flat {
        return Ok(false);
    }

    let pnl = compute_unrealized_pnl(slot, current_price)?;
    let mark_equity = (slot.equity_micro_usd as i128)
        .checked_add(pnl)
        .ok_or(BlitzError::MathOverflow)?;

    if mark_equity <= 0 {
        slot.equity_micro_usd = 0;
        slot.position_side = PositionSide::Flat;
        slot.entry_price = 0;
        slot.margin_micro_usd = 0;
        slot.leverage = 0;
        slot.streak = 0;
        slot.liquidated = true;
        return Ok(true);
    }
    Ok(false)
}

/// Force-closes all active positions at `final_price`, determines the winner, and marks the arena Finished.
pub fn finalize_arena_state(arena: &mut Arena, final_price: i64) -> Result<()> {
    let count = arena.player_count as usize;
    let mut best_equity: i64 = -1;
    let mut winner = Pubkey::default();

    for i in 0..count {
        settle_player_position(&mut arena.players[i], final_price)?;
        let eq = arena.players[i].equity_micro_usd;
        if eq > best_equity {
            best_equity = eq;
            winner = arena.players[i].wallet;
        }
    }

    arena.status = ArenaStatus::Finished;
    arena.final_price = final_price;
    arena.winner = winner;
    arena.winner_equity = best_equity.max(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::STARTING_EQUITY_MICRO_USD;

    #[test]
    fn leveraged_long_profit_and_hot_streak() {
        let mut slot = PlayerSlot {
            equity_micro_usd: STARTING_EQUITY_MICRO_USD,
            position_side: PositionSide::Long,
            leverage: 100,
            entry_price: 10_000_000_000, // $100.00
            margin_micro_usd: STARTING_EQUITY_MICRO_USD,
            streak: 2, // next win triggers 3-win hot streak (+5% bonus on profit)
            ..Default::default()
        };
        // +0.1% move at 100x = +10% raw profit (+$1,000) + 5% streak bonus (+$50)
        settle_player_position(&mut slot, 10_010_000_000).unwrap();
        assert_eq!(slot.position_side, PositionSide::Flat);
        assert_eq!(slot.streak, 3);
        assert_eq!(slot.equity_micro_usd, 11_050_000_000);
        assert!(!slot.liquidated);
    }

    #[test]
    fn leveraged_short_liquidation_on_crank() {
        let mut slot = PlayerSlot {
            equity_micro_usd: STARTING_EQUITY_MICRO_USD,
            position_side: PositionSide::Short,
            leverage: 100,
            entry_price: 10_000_000_000,
            margin_micro_usd: STARTING_EQUITY_MICRO_USD,
            ..Default::default()
        };
        // +1.2% price spike against 100x Short -> -120% -> REKT
        let rekt = check_liquidation(&mut slot, 10_120_000_000).unwrap();
        assert!(rekt);
        assert!(slot.liquidated);
        assert_eq!(slot.equity_micro_usd, 0);
        assert_eq!(slot.position_side, PositionSide::Flat);
    }
}
