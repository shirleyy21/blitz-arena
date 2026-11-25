use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::system_program::{self, Transfer};
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::crank::{ScheduleCrankCpi, ScheduleTaskArgs};
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

pub mod error;
pub mod math;
pub mod state;

use error::BlitzError;
use math::{
    check_liquidation, finalize_arena_state, read_oracle_price, settle_player_position,
    validate_leverage,
};
pub use state::{
    Arena, ArenaStatus, PlayerSlot, PositionSide, ScheduleRoundCrankArgs, TradeAction, MAX_PLAYERS,
    STARTING_EQUITY_MICRO_USD,
};

declare_id!("F3af5wwcApM79ZjGTXQs5UdGqQ9aEgkxUVYA255HZGao");

pub const ARENA_SEED: &[u8] = b"arena";
pub const VAULT_SEED: &[u8] = b"vault";

#[ephemeral]
#[program]
pub mod blitz_arena {
    use super::*;

    /// L1: Creates a new 60-second PvP micro-trading arena and escrows the creator's entry buy-in
    /// inside the L1 Vault PDA (which stays on Solana L1 while the Arena PDA delegates to MagicBlock ER).
    pub fn create_arena(
        ctx: Context<CreateArena>,
        arena_id: u64,
        entry_fee_lamports: u64,
        duration_secs: i64,
        max_players: u8,
        price_feed: Pubkey,
        price_feed_id: [u8; 32],
        session_key: Pubkey,
    ) -> Result<()> {
        require!(
            (15..=300).contains(&duration_secs),
            BlitzError::InvalidDuration
        );
        require!(
            (1..=MAX_PLAYERS as u8).contains(&max_players),
            BlitzError::InvalidMaxPlayers
        );

        if entry_fee_lamports > 0 {
            let cpi_ctx = CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.creator.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            );
            system_program::transfer(cpi_ctx, entry_fee_lamports)?;
        }

        let arena = &mut ctx.accounts.arena;
        arena.arena_id = arena_id;
        arena.creator = ctx.accounts.creator.key();
        arena.price_feed = price_feed;
        arena.price_feed_id = price_feed_id;
        arena.entry_fee_lamports = entry_fee_lamports;
        arena.pot_lamports = entry_fee_lamports;
        arena.duration_secs = duration_secs;
        arena.start_ts = 0;
        arena.end_ts = 0;
        arena.status = ArenaStatus::Lobby;
        arena.player_count = 1;
        arena.max_players = max_players;
        arena.crank_scheduled = false;
        arena.crank_ticks = 0;
        arena.last_crank_price = 0;
        arena.final_price = 0;
        arena.winner = Pubkey::default();
        arena.winner_equity = 0;
        arena.bump = ctx.bumps.arena;
        arena.vault_bump = ctx.bumps.vault;

        arena.players[0] = PlayerSlot {
            wallet: ctx.accounts.creator.key(),
            session_key,
            equity_micro_usd: STARTING_EQUITY_MICRO_USD,
            ..Default::default()
        };

        Ok(())
    }

    /// L1: Registers an additional player into a Lobby arena, escrowing their buy-in into the L1 Vault
    /// and registering an ephemeral session key for zero-popup sub-50ms ER trading.
    pub fn join_arena(
        ctx: Context<JoinArena>,
        arena_id: u64,
        session_key: Pubkey,
    ) -> Result<()> {
        let _ = arena_id;
        let arena = &mut ctx.accounts.arena;
        require!(arena.status == ArenaStatus::Lobby, BlitzError::ArenaNotInLobby);
        require!(arena.player_count < arena.max_players, BlitzError::ArenaFull);

        let player_key = ctx.accounts.player.key();
        let count = arena.player_count as usize;
        for i in 0..count {
            require!(arena.players[i].wallet != player_key, BlitzError::AlreadyJoined);
        }

        let fee = arena.entry_fee_lamports;
        if fee > 0 {
            let cpi_ctx = CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.player.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            );
            system_program::transfer(cpi_ctx, fee)?;
            arena.pot_lamports = arena
                .pot_lamports
                .checked_add(fee)
                .ok_or(BlitzError::MathOverflow)?;
        }

        arena.players[count] = PlayerSlot {
            wallet: player_key,
            session_key,
            equity_micro_usd: STARTING_EQUITY_MICRO_USD,
            ..Default::default()
        };
        arena.player_count = arena.player_count.saturating_add(1);

        Ok(())
    }

    /// L1: Transitions the Arena from Lobby to Active and locks in the exact start/end timestamps.
    /// Bundled in the same L1 transaction right before `delegate_arena`.
    pub fn start_arena(ctx: Context<StartArena>, arena_id: u64) -> Result<()> {
        let _ = arena_id;
        let arena = &mut ctx.accounts.arena;
        require!(arena.status == ArenaStatus::Lobby, BlitzError::ArenaNotInLobby);
        require_keys_eq!(arena.creator, ctx.accounts.creator.key(), BlitzError::NotCreator);

        let now = Clock::get()?.unix_timestamp;
        arena.status = ArenaStatus::Active;
        arena.start_ts = now;
        arena.end_ts = now
            .checked_add(arena.duration_secs)
            .ok_or(BlitzError::MathOverflow)?;

        Ok(())
    }

    /// L1: Delegates the Arena PDA to the MagicBlock Ephemeral Rollup validator so all trades and
    /// scheduled cranks execute with sub-50ms latency and zero gas fees.
    pub fn delegate_arena(ctx: Context<DelegateArena>, arena_id: u64) -> Result<()> {
        let validator = ctx.remaining_accounts.first().map(|acc| acc.key());
        let id_bytes = arena_id.to_le_bytes();
        ctx.accounts.delegate_arena(
            &ctx.accounts.payer,
            &[ARENA_SEED, &id_bytes],
            DelegateConfig {
                validator,
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// ER: Schedules a native MagicBlock Crank via CPI into MAGIC_PROGRAM_ID to automatically tick
    /// liquidations against the live Ephemeral Oracle and finalize the arena at T=duration.
    pub fn schedule_round_crank<'info>(
        ctx: Context<'info, ScheduleRoundCrank<'info>>,
        arena_id: u64,
        args: ScheduleRoundCrankArgs,
    ) -> Result<()> {
        require!(
            args.execution_interval_millis >= 250 && args.iterations > 0 && args.iterations <= 600,
            BlitzError::InvalidCrankArgs
        );

        let tick_ix = Instruction {
            program_id: crate::ID,
            accounts: vec![
                AccountMeta::new(ctx.accounts.arena.key(), false),
                AccountMeta::new_readonly(ctx.accounts.price_update.key(), false),
            ],
            data: anchor_lang::InstructionData::data(&crate::instruction::CrankTick { arena_id }),
        };

        ScheduleCrankCpi {
            payer: &ctx.accounts.payer,
            magic_program: &&ctx.accounts.magic_program,
            instruction_accounts: &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.arena.to_account_info(),
                ctx.accounts.price_update.to_account_info(),
            ],
            args: ScheduleTaskArgs {
                task_id: args.task_id,
                execution_interval_millis: args.execution_interval_millis,
                iterations: args.iterations,
                instructions: vec![tick_ix],
            },
        }
        .invoke()?;

        Ok(())
    }

    /// ER: Zero-fee, sub-50ms leveraged trading action (OpenLong, OpenShort, Close, Flip).
    /// Signed either directly by the player's wallet or their pre-authorized ephemeral session key.
    pub fn trade(
        ctx: Context<Trade>,
        arena_id: u64,
        action: TradeAction,
        leverage: u8,
    ) -> Result<()> {
        let _ = arena_id;
        let arena = &mut ctx.accounts.arena;
        require!(arena.status == ArenaStatus::Active, BlitzError::ArenaNotActive);

        let now = Clock::get()?.unix_timestamp;
        require!(now < arena.end_ts, BlitzError::ArenaEnded);

        let live_price = read_oracle_price(
            &ctx.accounts.price_update,
            &arena.price_feed,
            &arena.price_feed_id,
        )?;

        let signer_key = ctx.accounts.signer.key();
        let count = arena.player_count as usize;
        let idx = (0..count)
            .find(|&i| {
                arena.players[i].wallet == signer_key || arena.players[i].session_key == signer_key
            })
            .ok_or(BlitzError::Unauthorized)?;

        let slot = &mut arena.players[idx];
        require!(!slot.liquidated, BlitzError::PlayerLiquidated);

        match action {
            TradeAction::OpenLong => {
                require!(
                    slot.position_side == PositionSide::Flat,
                    BlitzError::PositionAlreadyOpen
                );
                validate_leverage(leverage)?;
                slot.position_side = PositionSide::Long;
                slot.leverage = leverage;
                slot.entry_price = live_price;
                slot.margin_micro_usd = slot.equity_micro_usd;
                slot.trades_count = slot.trades_count.saturating_add(1);
            }
            TradeAction::OpenShort => {
                require!(
                    slot.position_side == PositionSide::Flat,
                    BlitzError::PositionAlreadyOpen
                );
                validate_leverage(leverage)?;
                slot.position_side = PositionSide::Short;
                slot.leverage = leverage;
                slot.entry_price = live_price;
                slot.margin_micro_usd = slot.equity_micro_usd;
                slot.trades_count = slot.trades_count.saturating_add(1);
            }
            TradeAction::Close => {
                require!(
                    slot.position_side != PositionSide::Flat,
                    BlitzError::NoOpenPosition
                );
                settle_player_position(slot, live_price)?;
            }
            TradeAction::Flip => {
                require!(
                    slot.position_side != PositionSide::Flat,
                    BlitzError::NoOpenPosition
                );
                validate_leverage(leverage)?;
                let next_side = match slot.position_side {
                    PositionSide::Long => PositionSide::Short,
                    PositionSide::Short => PositionSide::Long,
                    PositionSide::Flat => unreachable!(),
                };
                settle_player_position(slot, live_price)?;
                if !slot.liquidated && slot.equity_micro_usd > 0 {
                    slot.position_side = next_side;
                    slot.leverage = leverage;
                    slot.entry_price = live_price;
                    slot.margin_micro_usd = slot.equity_micro_usd;
                    slot.trades_count = slot.trades_count.saturating_add(1);
                }
            }
        }

        arena.last_crank_price = live_price;
        Ok(())
    }

    /// ER (Automated via MagicBlock Crank): Permissionless heartbeat that marks liquidations
    /// against live oracle ticks and auto-finalizes the round as soon as Clock >= end_ts.
    pub fn crank_tick(ctx: Context<CrankTick>, arena_id: u64) -> Result<()> {
        let _ = arena_id;
        let arena = &mut ctx.accounts.arena;
        if arena.status != ArenaStatus::Active {
            return Ok(());
        }

        let live_price = read_oracle_price(
            &ctx.accounts.price_update,
            &arena.price_feed,
            &arena.price_feed_id,
        )?;

        arena.crank_scheduled = true;
        arena.crank_ticks = arena.crank_ticks.saturating_add(1);
        arena.last_crank_price = live_price;

        let now = Clock::get()?.unix_timestamp;
        if now >= arena.end_ts {
            finalize_arena_state(arena, live_price)?;
        } else {
            let count = arena.player_count as usize;
            for i in 0..count {
                let _ = check_liquidation(&mut arena.players[i], live_price)?;
            }
        }

        Ok(())
    }

    /// ER: Ensures final settlement is computed once end_ts is reached, flushes the account bytes,
    /// and invokes MagicBlock's `commit_and_undelegate` to return the Arena state & winner to Solana L1.
    pub fn finalize_and_undelegate(
        ctx: Context<FinalizeAndUndelegate>,
        arena_id: u64,
    ) -> Result<()> {
        let _ = arena_id;
        let arena = &mut ctx.accounts.arena;
        let now = Clock::get()?.unix_timestamp;

        if arena.status == ArenaStatus::Active {
            require!(now >= arena.end_ts, BlitzError::ArenaNotEnded);
            let live_price = read_oracle_price(
                &ctx.accounts.price_update,
                &arena.price_feed,
                &arena.price_feed_id,
            )?;
            finalize_arena_state(arena, live_price)?;
        }

        require!(
            arena.status == ArenaStatus::Finished,
            BlitzError::ArenaNotFinished
        );

        // Flush updated Arena state before MagicBlock commits & undelegates back to L1.
        ctx.accounts.arena.exit(&crate::ID)?;

        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.arena.to_account_info()])
        .build_and_invoke()?;

        Ok(())
    }

    /// L1: Releases the real SOL pot from the L1 Vault PDA to the verified ER winner.
    pub fn claim_prize(ctx: Context<ClaimPrize>, arena_id: u64) -> Result<()> {
        let arena = &mut ctx.accounts.arena;
        require!(
            arena.status == ArenaStatus::Finished,
            BlitzError::ArenaNotFinished
        );
        require_keys_eq!(arena.winner, ctx.accounts.winner.key(), BlitzError::NotWinner);
        require!(arena.pot_lamports > 0, BlitzError::NothingToClaim);

        let count = arena.player_count as usize;
        let idx = (0..count)
            .find(|&i| arena.players[i].wallet == ctx.accounts.winner.key())
            .ok_or(BlitzError::PlayerNotFound)?;
        require!(!arena.players[idx].claimed, BlitzError::NothingToClaim);

        let payout = arena.pot_lamports;
        arena.players[idx].claimed = true;
        arena.pot_lamports = 0;

        let id_bytes = arena_id.to_le_bytes();
        let vault_bump = [arena.vault_bump];
        let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, &id_bytes, &vault_bump]];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.winner.to_account_info(),
            },
            signer_seeds,
        );
        system_program::transfer(cpi_ctx, payout)?;

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(arena_id: u64)]
pub struct CreateArena<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init,
        payer = creator,
        space = 8 + Arena::LEN,
        seeds = [ARENA_SEED, &arena_id.to_le_bytes()],
        bump
    )]
    pub arena: Box<Account<'info, Arena>>,
    /// CHECK: System-owned SOL escrow vault PDA that always stays on Solana L1.
    #[account(
        mut,
        seeds = [VAULT_SEED, &arena_id.to_le_bytes()],
        bump
    )]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(arena_id: u64)]
pub struct JoinArena<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(
        mut,
        seeds = [ARENA_SEED, &arena_id.to_le_bytes()],
        bump = arena.bump
    )]
    pub arena: Box<Account<'info, Arena>>,
    /// CHECK: System-owned SOL escrow vault PDA on Solana L1.
    #[account(
        mut,
        seeds = [VAULT_SEED, &arena_id.to_le_bytes()],
        bump = arena.vault_bump
    )]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(arena_id: u64)]
pub struct StartArena<'info> {
    pub creator: Signer<'info>,
    #[account(
        mut,
        seeds = [ARENA_SEED, &arena_id.to_le_bytes()],
        bump = arena.bump
    )]
    pub arena: Box<Account<'info, Arena>>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(arena_id: u64)]
pub struct DelegateArena<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Arena PDA delegated to the MagicBlock Ephemeral Rollup validator.
    #[account(mut, del, seeds = [ARENA_SEED, &arena_id.to_le_bytes()], bump)]
    pub arena: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(arena_id: u64)]
pub struct ScheduleRoundCrank<'info> {
    /// CHECK: MagicBlock MAGIC_PROGRAM_ID for ScheduleCrankCpi.
    pub magic_program: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: UncheckedAccount to avoid Anchor re-serializing stale data after crank CPI.
    #[account(mut, seeds = [ARENA_SEED, &arena_id.to_le_bytes()], bump)]
    pub arena: UncheckedAccount<'info>,
    /// CHECK: Live MagicBlock Ephemeral Oracle PriceUpdateV2 account.
    pub price_update: UncheckedAccount<'info>,
    /// CHECK: Program ID account required by ScheduleCrankCpi.
    pub program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(arena_id: u64)]
pub struct Trade<'info> {
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [ARENA_SEED, &arena_id.to_le_bytes()],
        bump = arena.bump
    )]
    pub arena: Box<Account<'info, Arena>>,
    /// CHECK: Live MagicBlock Ephemeral Oracle PriceUpdateV2 account; verified against arena.price_feed.
    pub price_update: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(arena_id: u64)]
pub struct CrankTick<'info> {
    #[account(
        mut,
        seeds = [ARENA_SEED, &arena_id.to_le_bytes()],
        bump = arena.bump
    )]
    pub arena: Box<Account<'info, Arena>>,
    /// CHECK: Live MagicBlock Ephemeral Oracle PriceUpdateV2 account; verified against arena.price_feed.
    pub price_update: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
#[instruction(arena_id: u64)]
pub struct FinalizeAndUndelegate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [ARENA_SEED, &arena_id.to_le_bytes()],
        bump = arena.bump
    )]
    pub arena: Box<Account<'info, Arena>>,
    /// CHECK: Live MagicBlock Ephemeral Oracle PriceUpdateV2 account; verified against arena.price_feed.
    pub price_update: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(arena_id: u64)]
pub struct ClaimPrize<'info> {
    #[account(mut)]
    pub winner: Signer<'info>,
    #[account(
        mut,
        seeds = [ARENA_SEED, &arena_id.to_le_bytes()],
        bump = arena.bump
    )]
    pub arena: Box<Account<'info, Arena>>,
    /// CHECK: System-owned SOL escrow vault PDA on Solana L1.
    #[account(
        mut,
        seeds = [VAULT_SEED, &arena_id.to_le_bytes()],
        bump = arena.vault_bump
    )]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
