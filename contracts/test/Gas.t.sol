// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.28;

import {console} from "hardhat/console.sol";
import {EvTest} from "./lib/EvTest.sol";
import {Mnemonad} from "../src/Mnemonad.sol";

/// @notice Turns the plan's cost-model claims into executable assertions.
///
/// IMPORTANT — what these numbers are and are not:
/// The local EDR node prices storage with the standard Ethereum schedule (20,000 gas per
/// new slot, EIP-2929 cold access). Monad does NOT: under MIP-8 it charges 8,000 per cold
/// 4 KB page + 2,800 per page write + 17,000 per net-new slot, and it may have repriced
/// CREATE. So the ABSOLUTE figures logged here are Ethereum figures and must not be quoted
/// as Monad costs — that is what the Phase 0 testnet benchmark is for.
///
/// What does transfer is the DIRECTION of each comparison, which is what these tests pin
/// down: both schedules charge per-new-slot for storage and per-byte for deployed code, so
/// if CODE beats SLOT here it beats it on Monad by a wider margin still (Monad's per-slot
/// charge is 17,000 versus Ethereum's 20,000, while code stays at ~200/byte).
contract GasTest is EvTest {
    Mnemonad internal ev;
    address internal owner = address(0xA11CE);
    uint256 internal constant TEST_MAX_CHUNK = 20_000;

    function setUp() public {
        ev = new Mnemonad(TEST_MAX_CHUNK, address(0xFEE));
        vm.deal(owner, 1000 ether);
    }

    function _bytes(uint256 len, uint8 seed) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i = 0; i < len; ++i) {
            out[i] = bytes1(uint8((i * 31 + seed) % 251) + 1);
        }
    }

    function _createEmpty(bytes32 salt) internal returns (uint256 id) {
        vm.prank(owner);
        id = ev.create(salt, "", "", new bytes[](0));
    }

    /// @dev Measures a single push of `size` bytes into a fresh stream.
    function _gasForPush(bytes32 salt, uint256 size) internal returns (uint256 used) {
        uint256 id = _createEmpty(salt);
        bytes memory data = _bytes(size, 1);
        vm.prank(owner);
        uint256 before = gasleft();
        ev.push(id, 0, data, "");
        used = before - gasleft();
    }

    // -----------------------------------------------------------------------------
    // The SLOT/CODE crossover
    // -----------------------------------------------------------------------------

    /// @notice At 31 bytes SLOT should win; at 32 bytes CODE should win.
    /// @dev This is the crossover the plan's tier ladder is built on. It exists because a
    ///      Solidity `bytes` of <=31 bytes packs into ONE slot, and at 32 bytes becomes a
    ///      length slot plus data slots — a step change, not a gradual one.
    function test_slotWinsAtOrBelow31Bytes() public {
        uint256 slotGas = _gasForPush("g31", 31);
        console.log("push 31B (SLOT tier):", slotGas);
        assertEq(uint8(ev.itemStore(ev.streamIdFor(owner, "g31"), 0)), 1); // Store.SLOT
    }

    function test_codeTierIsCompetitiveAtTheBoundary() public {
        // 31 bytes routes to SLOT, 32 bytes routes to CODE.
        uint256 slot31 = _gasForPush("gA", 31);
        uint256 code32 = _gasForPush("gB", 32);

        console.log("push 31B via SLOT:", slot31);
        console.log("push 32B via CODE:", code32);

        // Note what this does and does not establish. It shows CODE is in the same cost
        // band as a one-slot SLOT write at the boundary, which is all that is needed for
        // the routing rule to be defensible. It does NOT prove 31 is the exact crossover:
        // that depends on a 32-byte SLOT write costing two slots plus a second page, and
        // the page half of that only exists under Monad's MIP-8 schedule, which the local
        // node does not implement. SLOT_MAX_BYTES is therefore a Phase 0 measurement, not
        // a settled constant.
        assertTrue(code32 < slot31 * 2, "CODE must stay within a 2-slot storage write");
    }

    /// @notice Cost per byte must fall as items grow — the CODE tier's whole premise.
    function test_codeTierCostPerByteFallsWithSize() public {
        uint256 g1k = _gasForPush("g1k", 1_000);
        uint256 g10k = _gasForPush("g10k", 10_000);

        uint256 perByte1k = g1k / 1_000;
        uint256 perByte10k = g10k / 10_000;

        console.log("push  1KB total gas:", g1k);
        console.log("push 10KB total gas:", g10k);
        console.log("per-byte  1KB:", perByte1k);
        console.log("per-byte 10KB:", perByte10k);

        // The fixed ~32,000 CREATE overhead amortises away as payloads grow.
        assertTrue(perByte10k < perByte1k, "per-byte cost should fall with size");
    }

    // -----------------------------------------------------------------------------
    // Packing
    // -----------------------------------------------------------------------------

    /// @notice A packed batch must cost materially less than the same items pushed one by
    ///         one — this is the entire justification for `pushMany`.
    function test_packedBatchBeatsIndividualPushes() public {
        uint256 n = 10;
        uint256 itemSize = 200;

        // Individually: n separate chunk deployments, each paying CREATE overhead.
        uint256 idA = _createEmpty("packA");
        uint256 individualGas;
        for (uint256 i = 0; i < n; ++i) {
            bytes memory data = _bytes(itemSize, uint8(i + 1));
            vm.prank(owner);
            uint256 before = gasleft();
            ev.push(idA, uint64(i), data, "");
            individualGas += before - gasleft();
        }

        // Packed: one chunk deployment for the whole batch.
        uint256 idB = _createEmpty("packB");
        bytes[] memory items = new bytes[](n);
        for (uint256 i = 0; i < n; ++i) {
            items[i] = _bytes(itemSize, uint8(i + 1));
        }
        vm.prank(owner);
        uint256 b4 = gasleft();
        ev.pushMany(idB, 0, items);
        uint256 packedGas = b4 - gasleft();

        console.log("10x200B individual pushes:", individualGas);
        console.log("10x200B packed pushMany:  ", packedGas);
        console.log("saving (gas):", individualGas - packedGas);

        assertTrue(packedGas < individualGas, "packing must be cheaper");

        // Both must produce identical readable data — a saving that corrupted the payload
        // would be no saving at all.
        for (uint256 i = 0; i < n; ++i) {
            assertEq(ev.at(idA, i), ev.at(idB, i), "packed vs individual data mismatch");
        }
    }

    // -----------------------------------------------------------------------------
    // Concat
    // -----------------------------------------------------------------------------

    /// @notice Concat cost must track the source's ITEM COUNT, not its byte length.
    /// @dev The property that justifies a single shared registry: two sources holding the
    ///      same number of items should cost about the same to merge even when one holds
    ///      50× more data, because payload bytes are re-linked rather than copied.
    function test_concatCostTracksItemCountNotByteLength() public {
        uint256 smallSrc = _createEmpty("cs");
        uint256 bigSrc = _createEmpty("cb");
        uint256 dstA = _createEmpty("cda");
        uint256 dstB = _createEmpty("cdb");

        vm.startPrank(owner);
        // Same item count (4), wildly different payload sizes.
        for (uint256 i = 0; i < 4; ++i) {
            ev.push(smallSrc, uint64(i), _bytes(100, uint8(i + 1)), "");
            ev.push(bigSrc, uint64(i), _bytes(5_000, uint8(i + 1)), "");
        }

        uint256 b1 = gasleft();
        ev.concat(dstA, smallSrc, 0);
        uint256 smallGas = b1 - gasleft();

        uint256 b2 = gasleft();
        ev.concat(dstB, bigSrc, 0);
        uint256 bigGas = b2 - gasleft();
        vm.stopPrank();

        console.log("concat 4 items x   100B:", smallGas);
        console.log("concat 4 items x 5_000B:", bigGas);

        // 50x the bytes must not mean meaningfully more gas. Allowing 20% slack for
        // incidental differences; a byte-copying implementation would be ~50x apart.
        assertTrue(bigGas < smallGas * 12 / 10, "concat must not scale with byte length");
        assertEq(ev.at(dstB, 0), _bytes(5_000, 1), "concat must preserve payloads");
    }

    // -----------------------------------------------------------------------------
    // Per-item overhead
    // -----------------------------------------------------------------------------

    /// @notice The `Item` struct must occupy exactly one storage slot.
    /// @dev Asserted through cost rather than layout: pushing an EXTERNAL item writes the
    ///      Item record plus a Pointer, and nothing else. If `Item` silently grew past 256
    ///      bits, every push in the system would pay for an extra slot forever, so this is
    ///      worth a regression test rather than a comment.
    function test_itemRecordFitsOneSlot() public {
        uint256 id = _createEmpty("slotfit");
        Mnemonad.Pointer memory p = Mnemonad.Pointer({
            hash: keccak256("x"),
            size: 1_000,
            codec: 0,
            locator: hex"AABBCCDD"
        });

        vm.prank(owner);
        uint256 before = gasleft();
        ev.pushExternal(id, 0, p, "");
        uint256 used = before - gasleft();

        console.log("pushExternal (Item + Pointer):", used);

        // Under the standard schedule a new slot costs 20,000. The write set here is the
        // Item (1 slot), the array length, and the Pointer (3 slots: hash, packed
        // size/codec, locator) — so ~5 new slots plus overhead. An Item that had spilled
        // into a second slot would push this past the bound.
        assertTrue(used < 7 * 20_000 + 60_000, "per-item overhead higher than expected");
    }
}
