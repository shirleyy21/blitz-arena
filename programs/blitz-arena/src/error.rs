use anchor_lang::prelude::*;

#[error_code]
pub enum BlitzError {
    #[msg("Invalid round duration (must be between 15 and 300 seconds)")]
    InvalidDuration,
    #[msg("Invalid max players (must be between 1 and 8)")]
    InvalidMaxPlayers,
    #[msg("Arena is not in Lobby state")]
    ArenaNotInLobby,
    #[msg("Arena is not active")]
    ArenaNotActive,
    #[msg("Arena has already ended")]
    ArenaEnded,
    #[msg("Arena has not ended yet")]
    ArenaNotEnded,
    #[msg("Arena is not finished yet")]
    ArenaNotFinished,
    #[msg("Arena is full")]
    ArenaFull,
    #[msg("Player already joined this arena")]
    AlreadyJoined,
    #[msg("Player is not registered in this arena")]
    PlayerNotFound,
    #[msg("Unauthorized signer (must be player wallet or registered session key)")]
    Unauthorized,
    #[msg("Only the arena creator can start the round")]
    NotCreator,
    #[msg("Player has been liquidated (REKT)")]
    PlayerLiquidated,
    #[msg("Invalid leverage (allowed: 10, 25, 50, 100)")]
    InvalidLeverage,
    #[msg("Position is already open — close or flip instead")]
    PositionAlreadyOpen,
    #[msg("No open position to close or flip")]
    NoOpenPosition,
    #[msg("Oracle price feed account does not match arena configuration")]
    InvalidPriceFeed,
    #[msg("Oracle price must be positive")]
    InvalidOraclePrice,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Prize already claimed or empty pot")]
    NothingToClaim,
    #[msg("Signer is not the arena winner")]
    NotWinner,
    #[msg("Invalid crank parameters")]
    InvalidCrankArgs,
}
