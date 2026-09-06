// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.28;

/// @title IPyth — the slice of Pyth's EVM interface this project actually calls.
///
/// Vendored rather than pulled from the `pyth-sdk-solidity` npm package: this is
/// four functions and one struct, and the real SDK drags in its own `PythStructs` contract
/// plus error/event files we never reference. Declaring `Price` locally is ABI-identical to
/// Pyth's — struct encoding depends on field types and order, not on the declaring scope —
/// so calls decode against the deployed contract exactly as the official interface would.
///
/// Signatures verified against pyth-crosschain
/// (`target_chains/ethereum/sdk/solidity/{IPyth,PythStructs}.sol`). Field order below is
/// load-bearing: reordering it silently misdecodes every price read.
interface IPyth {
    struct Price {
        int64 price; // scaled by 10**expo; may be negative in principle, never for MON/USD
        uint64 conf; // confidence interval, same scale as `price`
        int32 expo; // typically -8
        uint256 publishTime;
    }

    /// @notice Reverts (`StalePrice`) if no price for `id` is within `age` seconds.
    /// @dev Preferred over `getPriceUnsafe`: staleness is enforced by Pyth rather than by
    ///      us remembering to compare `publishTime` at every call site.
    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (Price memory price);

    /// @notice Wei required as `msg.value` when submitting `updateData` to `updatePriceFeeds`.
    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256 feeAmount);

    /// @notice Pushes signed off-chain price updates (from Hermes) on-chain.
    function updatePriceFeeds(bytes[] calldata updateData) external payable;
}
