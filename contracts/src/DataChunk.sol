// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.28;

/// @title DataChunk
/// @notice Stores arbitrary bytes as the runtime code of a freshly deployed, non-callable
///         contract — the "SSTORE2" pattern.
///
/// Why this exists on Monad specifically: writing bytes to contract storage costs ~537
/// gas/byte under MIP-8 (17,000 gas per net-new slot dominates), while deploying them as
/// code costs ~216 gas/byte, and reading them back via `EXTCODECOPY` is roughly 44× cheaper
/// than the equivalent `SLOAD` run. Monad also raises the max contract size to 128 KB (from
/// Ethereum's 24 KB) — but the code-size cap and the *gas* cap are two separate limits, and
/// the gas one binds first: at ~221 gas/byte measured live (this comment's own ~216 estimate
/// plus calldata and bookkeeping), a chunk anywhere near 128 KB computes to ~28-30M gas —
/// against Monad's 30M-gas *per-transaction* cap, with only single-digit-percent headroom.
/// That is not a safe number to build a ceiling around: it leaves no room for a wallet's own
/// gas-estimation padding, which is exactly what turned a real ~97 KB chunk (well inside the
/// registry's old 120 KB ceiling) into an "Exceeds transaction gas limit" failure rather than
/// a successful, if expensive, deploy. See `Mnemonad.MAX_CHUNK_BYTES_CEILING` for the ceiling
/// this pushed the registry to: 64 KiB, computing to roughly half the 30M cap with real
/// margin to spare.
///
/// The trade-off, which the caller must accept: a chunk is immutable and can never be
/// deleted (`SELFDESTRUCT` no longer frees code post-Cancun), so there are no storage
/// refunds and no way to erase the bytes.
library DataChunk {
    /// @dev The deployed runtime code is `0x00 || payload`. The leading STOP makes the
    ///      chunk non-callable, so it can never be mistaken for or used as a real contract.
    uint256 internal constant DATA_OFFSET = 1;

    error DeployFailed();
    error NotAChunk(address ptr);
    error OutOfRange(uint256 start, uint256 len, uint256 size);

    /// @notice Deploys `payload` as a data contract and returns its address.
    function write(bytes memory payload) internal returns (address ptr) {
        // 11-byte initcode that returns everything after itself as the runtime code:
        //
        //   60 0B   PUSH1 11    | 11                          -- offset of the payload
        //   59      MSIZE       | 0 11
        //   81      DUP2        | 11 0 11
        //   38      CODESIZE    | cs 11 0 11
        //   03      SUB         | (cs-11) 0 11
        //   80      DUP1        | (cs-11) (cs-11) 0 11
        //   92      SWAP3       | 11 (cs-11) 0 (cs-11)
        //   59      MSIZE       | 0 11 (cs-11) 0 (cs-11)
        //   39      CODECOPY    | 0 (cs-11)
        //   F3      RETURN      |
        //
        // Deriving the length from CODESIZE keeps the initcode fixed-width regardless of
        // payload size, which matters here because payloads run to ~120 KB.
        bytes memory initcode = abi.encodePacked(
            hex"60_0B_59_81_38_03_80_92_59_39_F3",
            hex"00",
            payload
        );

        assembly ("memory-safe") {
            ptr := create(0, add(initcode, 0x20), mload(initcode))
        }

        // Reverts on the EVM code-size limit (24 KB locally, 128 KB on Monad) as well as
        // on out-of-gas during deployment.
        if (ptr == address(0)) revert DeployFailed();
    }

    /// @notice Payload length of a chunk, excluding the STOP byte.
    function sizeOf(address ptr) internal view returns (uint256) {
        uint256 codeSize = ptr.code.length;
        if (codeSize < DATA_OFFSET) revert NotAChunk(ptr);
        return codeSize - DATA_OFFSET;
    }

    /// @notice Reads a chunk's full payload.
    function read(address ptr) internal view returns (bytes memory) {
        return readRange(ptr, 0, sizeOf(ptr));
    }

    /// @notice Copies a chunk's whole payload directly into `dest` at `destOffset`.
    /// @dev Exists so a multi-chunk item can be reassembled into ONE preallocated buffer.
    ///      Reassembling with repeated `bytes.concat` instead is quadratic in memory — a
    ///      1 MB item spread over 50 chunks would allocate ~25 MB cumulatively, and Monad
    ///      caps memory at 8 MB per transaction, so the naive version breaks on exactly the
    ///      large payloads this contract exists to store.
    /// @return written Number of bytes copied.
    function copyInto(address ptr, bytes memory dest, uint256 destOffset)
        internal
        view
        returns (uint256 written)
    {
        written = sizeOf(ptr);
        copyRangeInto(ptr, 0, written, dest, destOffset);
    }

    /// @notice Copies `len` payload bytes from `start` directly into `dest` at `destOffset`.
    /// @dev The ranged form of `copyInto`, used to serve a partial read that begins or ends
    ///      part-way through a chunk.
    function copyRangeInto(
        address ptr,
        uint256 start,
        uint256 len,
        bytes memory dest,
        uint256 destOffset
    ) internal view {
        uint256 size = sizeOf(ptr);
        if (start + len > size) revert OutOfRange(start, len, size);
        if (destOffset + len > dest.length) {
            revert OutOfRange(destOffset, len, dest.length);
        }
        uint256 codeStart = start + DATA_OFFSET;
        assembly ("memory-safe") {
            extcodecopy(ptr, add(add(dest, 0x20), destOffset), codeStart, len)
        }
    }

    /// @notice Reads `len` payload bytes starting at `start`.
    function readRange(address ptr, uint256 start, uint256 len)
        internal
        view
        returns (bytes memory out)
    {
        uint256 size = sizeOf(ptr);
        if (start + len > size) revert OutOfRange(start, len, size);

        uint256 codeStart = start + DATA_OFFSET;
        assembly ("memory-safe") {
            out := mload(0x40)
            // Allocate: 32B length + word-aligned data + one word of slack, so zeroing the
            // trailing partial word below can never run past the allocation.
            let aligned := and(add(len, 0x1f), not(0x1f))
            mstore(0x40, add(out, add(0x40, aligned)))
            mstore(out, len)
            extcodecopy(ptr, add(out, 0x20), codeStart, len)
            // extcodecopy leaves the bytes past `len` in the final word untouched, so clear
            // them rather than handing back whatever was in memory.
            mstore(add(add(out, 0x20), len), 0)
        }
    }
}
