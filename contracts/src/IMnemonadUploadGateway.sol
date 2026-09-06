// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.28;

/// @title IMnemonadUploadGateway — the one call `Mnemonad` makes into a paid-upload gateway.
/// @dev Kept to a single function on purpose. The registry must know as little as possible
///      about how off-chain quota is priced or sold, so that side stays replaceable without
///      ever redeploying the registry (see `MnemonadUploadGateway`'s header for why that
///      matters — Pyth's MON/USD feed has already migrated contracts once).
interface IMnemonadUploadGateway {
    /// @notice Settles prepaid quota for `payer` covering `size` bytes of `contentHash`.
    /// @return true if escrow was released, meaning the EXTERNAL fee is already paid.
    function consumeUpload(address payer, bytes32 contentHash, uint64 size) external returns (bool);
}
