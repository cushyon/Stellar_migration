use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VaultError {
    // Vault operations (10-16)
    InvalidDepositAmount = 10,
    InvalidWithdrawAmount = 11,
    InsufficientShares = 12,
    InvalidMintAmount = 13,
    InvalidRedeemAmount = 14,
    InsufficientAllowance = 15,
    InsufficientBalance = 16,

    // Strategy safety (20-29)
    UnauthorizedOperator = 20,
    TokenNotAllowed = 21,
    TradeSizeExceeded = 22,
    CooldownNotElapsed = 23,
    SlippageExceeded = 24,
    UnauthorizedGuardian = 25,
    NonceMismatch = 26,
    DeadlineExpired = 27,
    FloorBreached = 28,
    RouterNotAllowed = 29,

    // Math / system (30-31)
    MathOverflow = 30,
    AlreadyInitialized = 31,

    // Oracle / circuit breaker (40-43)
    OracleStale = 40,
    OracleDeviation = 41,
    PriceUnavailable = 42,
    /// Realized output below the oracle-implied minimum (hard protocol cap,
    /// independent of the operator-supplied `min_amount_out`).
    SlippageCapExceeded = 43,
}
