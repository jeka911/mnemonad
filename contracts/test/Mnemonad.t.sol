// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.28;

import {EvTest} from "./lib/EvTest.sol";
import {Mnemonad} from "../src/Mnemonad.sol";
import {DataChunk} from "../src/DataChunk.sol";

contract MnemonadTest is EvTest {
    Mnemonad internal ev;

    address internal owner = address(0xA11CE);
    address internal writer = address(0xB0B);
    address internal stranger = address(0xCAFE);
    address internal feeTo = address(0xFEE);

    /// @dev The local EDR node enforces EIP-170's 24,576-byte code limit and offers no
    ///      `allowUnlimitedContractSize` for Solidity tests, so chunks here must stay well
    ///      under it. Monad allows 128 KB; that path is only verifiable on testnet.
    uint256 internal constant TEST_MAX_CHUNK = 20_000;

    uint64 internal constant ANY = type(uint64).max;

    function setUp() public {
        ev = new Mnemonad(TEST_MAX_CHUNK, feeTo);
        vm.deal(owner, 100 ether);
        vm.deal(writer, 100 ether);
        vm.deal(stranger, 100 ether);
    }

    // -----------------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------------

    function _bytes(uint256 len, uint8 seed) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i = 0; i < len; ++i) {
            out[i] = bytes1(uint8((i * 31 + seed) % 251) + 1); // never zero
        }
    }

    function _createEmpty(address as_, bytes32 salt) internal returns (uint256 id) {
        vm.prank(as_);
        id = ev.create(salt, "", "", new bytes[](0));
    }

    // `length`/`binaryLength`/`firstAvailableIndex`/`streamMeta`/`encKeyWrapped` no longer
    // exist as separate getters — folded into `getStreamInfo` to reclaim bytecode size (see
    // its own comment in Mnemonad.sol). These wrappers keep every assertion below reading the
    // same as before rather than tuple-destructuring at each call site; each still reverts
    // exactly like its removed counterpart did, since `getStreamInfo` runs the same
    // `_requireExists` check.
    function _length(Mnemonad ev_, uint256 id) internal view returns (uint64 len) {
        (len,,,,) = ev_.getStreamInfo(id);
    }

    function _binaryLength(Mnemonad ev_, uint256 id) internal view returns (uint64 binLen) {
        (, binLen,,,) = ev_.getStreamInfo(id);
    }

    function _firstAvailableIndex(Mnemonad ev_, uint256 id) internal view returns (uint64 firstIdx) {
        (,, firstIdx,,) = ev_.getStreamInfo(id);
    }

    function _streamMeta(Mnemonad ev_, uint256 id) internal view returns (bytes memory meta) {
        (,,, meta,) = ev_.getStreamInfo(id);
    }

    function _encKeyWrapped(Mnemonad ev_, uint256 id) internal view returns (bytes memory encKey) {
        (,,,, encKey) = ev_.getStreamInfo(id);
    }

    // -----------------------------------------------------------------------------
    // Deployment / version
    // -----------------------------------------------------------------------------

    function test_deployment() public view {
        assertEq(ev.CONTRACT_VERSION(), 2);
        assertEq(ev.maxChunkBytes(), TEST_MAX_CHUNK);
        assertEq(ev.externalFeeBytes(), TEST_MAX_CHUNK / 4);
        assertEq(ev.feePerByte(), 0, "fee must ship dormant");
        assertEq(ev.feeRecipient(), feeTo);
        assertEq(ev.uploadGateway(), address(0), "gateway hook must ship disabled");
    }

    function test_constructorRejectsChunkCeilingAboveMax() public {
        uint256 tooBig = ev.MAX_CHUNK_BYTES_CEILING() + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                Mnemonad.BadChunkCeiling.selector, tooBig, ev.MAX_CHUNK_BYTES_CEILING()
            )
        );
        new Mnemonad(tooBig, feeTo);
    }

    // -----------------------------------------------------------------------------
    // Deterministic ids
    // -----------------------------------------------------------------------------

    function test_streamIdIsDeterministicAndPredictable() public {
        bytes32 salt = keccak256("salt-1");
        uint256 predicted = ev.streamIdFor(owner, salt);

        uint256 id = _createEmpty(owner, salt);

        // The whole point: the id was knowable before the transaction, which is what lets
        // an encrypted stream be created + keyed + populated in a single transaction.
        assertEq(id, predicted);
        assertEq(ev.ownerOf(id), owner);
    }

    function test_sameSaltDifferentCreatorsGiveDifferentIds() public {
        bytes32 salt = keccak256("shared");
        uint256 a = _createEmpty(owner, salt);
        uint256 b = _createEmpty(stranger, salt);
        assertTrue(a != b);
    }

    function test_cannotCreateSameIdTwice() public {
        bytes32 salt = keccak256("dup");
        uint256 id = _createEmpty(owner, salt);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Mnemonad.StreamExists.selector, id));
        ev.create(salt, "", "", new bytes[](0));
    }

    function test_burnedIdCannotBeRecreated() public {
        bytes32 salt = keccak256("recycle");
        uint256 id = _createEmpty(owner, salt);

        bytes[] memory one = new bytes[](1);
        one[0] = _bytes(100, 7);
        vm.prank(owner);
        ev.pushMany(id, 0, one);

        vm.prank(owner);
        ev.burn(id);

        // Ids are deterministic, so re-creating a burned id must be refused: the old item
        // records are still in storage and would otherwise be silently resurrected.
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Mnemonad.StreamExists.selector, id));
        ev.create(salt, "", "", new bytes[](0));
    }

    // -----------------------------------------------------------------------------
    // Tier routing: SLOT vs CODE
    // -----------------------------------------------------------------------------

    function test_smallItemUsesSlotTier() public {
        uint256 id = _createEmpty(owner, "s");
        bytes memory data = _bytes(31, 1);

        vm.prank(owner);
        ev.push(id, 0, data, "");

        assertEq(uint8(ev.itemStore(id, 0)), uint8(Mnemonad.Store.SLOT));
        assertEq(ev.at(id, 0), data);
        assertEq(_length(ev, id), 1);
        assertEq(_binaryLength(ev, id), 31);
    }

    function test_thirtyTwoBytesCrossesIntoCodeTier() public {
        uint256 id = _createEmpty(owner, "c");
        bytes memory data = _bytes(32, 2);

        vm.prank(owner);
        ev.push(id, 0, data, "");

        // 32 bytes is exactly where a Solidity `bytes` stops fitting one slot and CODE
        // becomes the cheaper tier.
        assertEq(uint8(ev.itemStore(id, 0)), uint8(Mnemonad.Store.CODE));
        assertEq(ev.at(id, 0), data);
    }

    function test_pushAndReadVariousSizes() public {
        uint256 id = _createEmpty(owner, "v");
        uint256[6] memory sizes = [uint256(1), 31, 32, 1_000, 8_192, TEST_MAX_CHUNK];

        for (uint256 i = 0; i < sizes.length; ++i) {
            bytes memory data = _bytes(sizes[i], uint8(i + 1));
            vm.prank(owner);
            ev.push(id, uint64(i), data, "");
            assertEq(ev.at(id, i), data, "roundtrip failed");
            assertEq(ev.itemSize(id, i), uint32(sizes[i]));
        }

        assertEq(_length(ev, id), sizes.length);
    }

    function test_pushAboveChunkLimitReverts() public {
        uint256 id = _createEmpty(owner, "big");
        bytes memory data = _bytes(TEST_MAX_CHUNK + 1, 3);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                Mnemonad.ChunkTooLarge.selector, TEST_MAX_CHUNK + 1, TEST_MAX_CHUNK
            )
        );
        ev.push(id, 0, data, "");
    }

    function test_pushEmptyReverts() public {
        uint256 id = _createEmpty(owner, "e");
        vm.prank(owner);
        vm.expectRevert(Mnemonad.EmptyPayload.selector);
        ev.push(id, 0, "", "");
    }

    // -----------------------------------------------------------------------------
    // Packing
    // -----------------------------------------------------------------------------

    function test_pushManyPacksIntoASingleChunk() public {
        uint256 id = _createEmpty(owner, "pack");

        bytes[] memory items = new bytes[](5);
        for (uint256 i = 0; i < 5; ++i) {
            items[i] = _bytes(200 + i * 37, uint8(i + 1));
        }

        vm.prank(owner);
        ev.pushMany(id, 0, items);

        assertEq(_length(ev, id), 5);

        // Every item must read back exactly, sliced out of the shared chunk by offset/size.
        (, address[] memory chunks0,,,) = ev.getItemRefs(id, 0);
        for (uint256 i = 0; i < 5; ++i) {
            assertEq(ev.at(id, i), items[i], "packed item mismatch");
            (, address[] memory chunks,,,) = ev.getItemRefs(id, i);
            assertEq(chunks.length, 1);
            // The saving comes precisely from all items sharing one deployed chunk.
            assertEq(chunks[0], chunks0[0], "items should share one chunk");
        }
    }

    function test_pushManyOffsetsAreDistinct() public {
        uint256 id = _createEmpty(owner, "off");
        bytes[] memory items = new bytes[](3);
        items[0] = _bytes(100, 1);
        items[1] = _bytes(50, 2);
        items[2] = _bytes(70, 3);

        vm.prank(owner);
        ev.pushMany(id, 0, items);

        (,, uint32 off0, uint32 sz0,) = ev.getItemRefs(id, 0);
        (,, uint32 off1, uint32 sz1,) = ev.getItemRefs(id, 1);
        (,, uint32 off2, uint32 sz2,) = ev.getItemRefs(id, 2);

        assertEq(off0, 0);
        assertEq(sz0, 100);
        assertEq(off1, 100);
        assertEq(sz1, 50);
        assertEq(off2, 150);
        assertEq(sz2, 70);
        assertEq(_binaryLength(ev, id), 220);
    }

    function test_pushManyFallsBackToPerItemChunksWhenBatchTooLarge() public {
        uint256 id = _createEmpty(owner, "fallback");
        bytes[] memory items = new bytes[](2);
        items[0] = _bytes(TEST_MAX_CHUNK - 100, 1);
        items[1] = _bytes(500, 2);

        vm.prank(owner);
        ev.pushMany(id, 0, items);

        (, address[] memory c0,,,) = ev.getItemRefs(id, 0);
        (, address[] memory c1,,,) = ev.getItemRefs(id, 1);
        assertTrue(c0[0] != c1[0], "batch over the chunk limit must split");
        assertEq(ev.at(id, 0), items[0]);
        assertEq(ev.at(id, 1), items[1]);
    }

    function test_createWithInitialItems() public {
        bytes[] memory items = new bytes[](3);
        items[0] = _bytes(40, 1);
        items[1] = _bytes(41, 2);
        items[2] = _bytes(42, 3);

        vm.prank(owner);
        uint256 id = ev.create("init", hex"DEAD", hex"BEEF", items);

        assertEq(_length(ev, id), 3);
        assertEq(ev.at(id, 2), items[2]);
        assertEq(_streamMeta(ev, id), hex"DEAD");
        assertEq(_encKeyWrapped(ev, id), hex"BEEF");
        assertTrue(ev.isEncrypted(id));
    }

    // -----------------------------------------------------------------------------
    // Optimistic concurrency (ensure_length analogue)
    // -----------------------------------------------------------------------------

    function test_expectedLengthGuardBlocksStalePush() public {
        uint256 id = _createEmpty(owner, "g");
        bytes memory data = _bytes(64, 1);

        vm.prank(owner);
        ev.push(id, 0, data, "");

        // A retry that still believes length==0 must abort rather than duplicate the item.
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Mnemonad.LengthMismatch.selector, 0, 1));
        ev.push(id, 0, data, "");

        assertEq(_length(ev, id), 1);
    }

    function test_expectedLengthSentinelSkipsCheck() public {
        uint256 id = _createEmpty(owner, "g2");
        bytes memory data = _bytes(64, 1);

        vm.prank(owner);
        ev.push(id, ANY, data, "");
        vm.prank(owner);
        ev.push(id, ANY, data, "");

        assertEq(_length(ev, id), 2);
    }

    // -----------------------------------------------------------------------------
    // Staged append
    // -----------------------------------------------------------------------------

    function test_stagedAppendAssemblesMultiChunkItem() public {
        uint256 id = _createEmpty(owner, "staged");

        uint32 partSize = 5_000;
        uint32 total = partSize * 3;
        bytes memory p0 = _bytes(partSize, 1);
        bytes memory p1 = _bytes(partSize, 2);
        bytes memory p2 = _bytes(partSize, 3);

        vm.startPrank(owner);
        uint256 sid = ev.beginItem(id, total, hex"AA");

        // Invisible until commit: readers never see a partial item.
        assertEq(_length(ev, id), 0);

        ev.appendChunk(sid, 0, p0);
        ev.appendChunk(sid, partSize, p1);
        ev.appendChunk(sid, partSize * 2, p2);
        assertEq(_length(ev, id), 0);

        uint256 index = ev.commitItem(sid);
        vm.stopPrank();

        assertEq(index, 0);
        assertEq(_length(ev, id), 1);
        assertEq(ev.itemSize(id, 0), total);
        assertEq(ev.at(id, 0), bytes.concat(p0, p1, p2));
        assertEq(ev.itemMeta(id, 0), hex"AA");
        assertEq(_binaryLength(ev, id), total);

        (, address[] memory chunks,,,) = ev.getItemRefs(id, 0);
        assertEq(chunks.length, 3);
    }

    function test_stagedAppendRejectsWrongOffset() public {
        uint256 id = _createEmpty(owner, "staged2");
        bytes memory part = _bytes(1_000, 1);

        vm.startPrank(owner);
        uint256 sid = ev.beginItem(id, 2_000, "");
        ev.appendChunk(sid, 0, part);

        // Offset must equal bytes already received — this is what makes a timeout-retry
        // idempotent instead of silently appending the same chunk twice.
        vm.expectRevert(
            abi.encodeWithSelector(Mnemonad.StagingSizeMismatch.selector, 1_000, 0)
        );
        ev.appendChunk(sid, 0, part);
        vm.stopPrank();
    }

    function test_stagedAppendRejectsOverflowPastDeclaredSize() public {
        uint256 id = _createEmpty(owner, "staged3");
        vm.startPrank(owner);
        uint256 sid = ev.beginItem(id, 1_000, "");
        vm.expectRevert(
            abi.encodeWithSelector(Mnemonad.StagingSizeMismatch.selector, 1_000, 1_500)
        );
        ev.appendChunk(sid, 0, _bytes(1_500, 1));
        vm.stopPrank();
    }

    function test_commitBeforeCompleteReverts() public {
        uint256 id = _createEmpty(owner, "staged4");
        vm.startPrank(owner);
        uint256 sid = ev.beginItem(id, 2_000, "");
        ev.appendChunk(sid, 0, _bytes(1_000, 1));
        vm.expectRevert(
            abi.encodeWithSelector(Mnemonad.StagingSizeMismatch.selector, 2_000, 1_000)
        );
        ev.commitItem(sid);
        vm.stopPrank();
    }

    function test_abortItemDiscardsStaging() public {
        uint256 id = _createEmpty(owner, "staged5");
        vm.startPrank(owner);
        uint256 sid = ev.beginItem(id, 1_000, "");
        ev.appendChunk(sid, 0, _bytes(1_000, 1));
        ev.abortItem(sid);

        vm.expectRevert(abi.encodeWithSelector(Mnemonad.BadStaging.selector, sid));
        ev.commitItem(sid);
        vm.stopPrank();
        assertEq(_length(ev, id), 0);
    }

    function test_stagingIsCallerScoped() public {
        uint256 id = _createEmpty(owner, "staged6");
        vm.prank(owner);
        uint256 sid = ev.beginItem(id, 1_000, "");

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Mnemonad.BadStaging.selector, sid));
        ev.appendChunk(sid, 0, _bytes(1_000, 1));
    }

    // -----------------------------------------------------------------------------
    // External (IPFS) items
    // -----------------------------------------------------------------------------

    function test_pushExternalStoresPointerOnly() public {
        uint256 id = _createEmpty(owner, "ext");
        bytes memory cid = hex"01551220AABBCCDD";
        Mnemonad.Pointer memory p = Mnemonad.Pointer({
            hash: keccak256("payload"),
            size: 1_000_000_000, // 1 GB off-chain
            codec: 0,
            locator: cid
        });

        vm.prank(owner);
        ev.pushExternal(id, 0, p, hex"BB");

        assertEq(uint8(ev.itemStore(id, 0)), uint8(Mnemonad.Store.EXTERNAL));
        assertEq(_binaryLength(ev, id), 1_000_000_000);

        Mnemonad.Pointer memory got = ev.pointerAt(id, 0);
        assertEq(got.locator, cid);
        assertEq(got.size, 1_000_000_000);
        assertEq(got.hash, keccak256("payload"));

        // No on-chain payload exists, so `at()` must refuse rather than return junk.
        vm.expectRevert(
            abi.encodeWithSelector(
                Mnemonad.WrongStore.selector,
                Mnemonad.Store.CODE,
                Mnemonad.Store.EXTERNAL
            )
        );
        ev.at(id, 0);
    }

    function test_pointerAtRejectsOnchainItem() public {
        uint256 id = _createEmpty(owner, "ext2");
        vm.prank(owner);
        ev.push(id, 0, _bytes(100, 1), "");

        vm.expectRevert(
            abi.encodeWithSelector(
                Mnemonad.WrongStore.selector,
                Mnemonad.Store.EXTERNAL,
                Mnemonad.Store.CODE
            )
        );
        ev.pointerAt(id, 0);
    }

    // -----------------------------------------------------------------------------
    // Authorization
    // -----------------------------------------------------------------------------

    function test_strangerCannotPush() public {
        uint256 id = _createEmpty(owner, "auth");
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Mnemonad.NotAuthorized.selector, id, stranger)
        );
        ev.push(id, 0, _bytes(100, 1), "");
    }

    function test_approvedWriterCanPush() public {
        uint256 id = _createEmpty(owner, "auth2");
        vm.prank(owner);
        ev.setWriterApproval(id, writer, true);

        vm.prank(writer);
        ev.push(id, 0, _bytes(100, 1), "");
        assertEq(_length(ev, id), 1);

        vm.prank(owner);
        ev.setWriterApproval(id, writer, false);
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(Mnemonad.NotAuthorized.selector, id, writer));
        ev.push(id, 1, _bytes(100, 2), "");
    }

    function test_erc721ApprovalDoesNotGrantWriteAccess() public {
        uint256 id = _createEmpty(owner, "auth3");

        vm.prank(owner);
        ev.approve(stranger, id);
        vm.prank(owner);
        ev.setApprovalForAll(stranger, true);

        // The point of a separate writer mapping: approving a marketplace to SELL a stream
        // must not also let it APPEND to it.
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Mnemonad.NotAuthorized.selector, id, stranger)
        );
        ev.push(id, 0, _bytes(100, 1), "");
    }

    function test_onlyOwnerCanApproveWriters() public {
        uint256 id = _createEmpty(owner, "auth4");
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Mnemonad.NotAuthorized.selector, id, stranger)
        );
        ev.setWriterApproval(id, stranger, true);
    }

    // -----------------------------------------------------------------------------
    // Concat
    // -----------------------------------------------------------------------------

    function test_concatRelinksItemsAndBurnsSource() public {
        uint256 dst = _createEmpty(owner, "dst");
        uint256 src = _createEmpty(owner, "src");

        bytes memory d0 = _bytes(100, 1);
        bytes memory s0 = _bytes(200, 2);
        bytes memory s1 = _bytes(20, 3); // SLOT tier, to cover the mixed-tier path

        vm.startPrank(owner);
        ev.push(dst, 0, d0, "");
        ev.push(src, 0, s0, hex"11");
        ev.push(src, 1, s1, "");
        ev.concat(dst, src, 1);
        vm.stopPrank();

        assertEq(_length(ev, dst), 3);
        assertEq(ev.at(dst, 0), d0);
        assertEq(ev.at(dst, 1), s0);
        assertEq(ev.at(dst, 2), s1);
        assertEq(ev.itemMeta(dst, 1), hex"11", "item meta must survive relinking");
        assertEq(_binaryLength(ev, dst), 320);

        // Source is consumed.
        vm.expectRevert(abi.encodeWithSelector(Mnemonad.NoSuchStream.selector, src));
        _length(ev, src);
    }

    function test_concatSharesChunksRatherThanCopyingBytes() public {
        uint256 dst = _createEmpty(owner, "dst2");
        uint256 src = _createEmpty(owner, "src2");
        bytes memory payload = _bytes(4_000, 9);

        vm.startPrank(owner);
        ev.push(src, 0, payload, "");
        (, address[] memory before,,,) = ev.getItemRefs(src, 0);
        ev.concat(dst, src, 0);
        vm.stopPrank();

        (, address[] memory afterChunks,,,) = ev.getItemRefs(dst, 0);
        // Same chunk address on both sides: the payload was never re-deployed or copied.
        assertEq(afterChunks[0], before[0]);
        assertEq(ev.at(dst, 0), payload);
    }

    function test_concatRejectsSelf() public {
        uint256 id = _createEmpty(owner, "self");
        vm.prank(owner);
        vm.expectRevert(Mnemonad.CannotConcatSelf.selector);
        ev.concat(id, id, 0);
    }

    function test_concatRejectsEncrypted() public {
        vm.prank(owner);
        uint256 dst = ev.create("edst", "", "", new bytes[](0));
        vm.prank(owner);
        uint256 src = ev.create("esrc", "", hex"BEEF", new bytes[](0));

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Mnemonad.CannotConcatEncrypted.selector, src));
        ev.concat(dst, src, 0);
    }

    function test_concatRejectsTruncatedSource() public {
        uint256 dst = _createEmpty(owner, "tdst");
        uint256 src = _createEmpty(owner, "tsrc");

        vm.startPrank(owner);
        ev.push(src, 0, _bytes(100, 1), "");
        ev.push(src, 1, _bytes(100, 2), "");
        ev.truncateFrom(src, 1);

        vm.expectRevert(abi.encodeWithSelector(Mnemonad.CannotConcatTruncated.selector, src));
        ev.concat(dst, src, 0);
        vm.stopPrank();
    }

    function test_concatRequiresOwningTheSource() public {
        uint256 dst = _createEmpty(stranger, "xdst");
        uint256 src = _createEmpty(owner, "xsrc");

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Mnemonad.NotAuthorized.selector, src, stranger)
        );
        ev.concat(dst, src, 0);
    }

    // -----------------------------------------------------------------------------
    // Truncate / burn
    // -----------------------------------------------------------------------------

    function test_truncateMakesEarlyIndexesUnreadable() public {
        uint256 id = _createEmpty(owner, "tr");
        vm.startPrank(owner);
        for (uint256 i = 0; i < 4; ++i) {
            ev.push(id, uint64(i), _bytes(100 + i, uint8(i + 1)), "");
        }
        ev.truncateFrom(id, 2);
        vm.stopPrank();

        assertEq(_firstAvailableIndex(ev, id), 2);
        // length never decreases — indices stay stable.
        assertEq(_length(ev, id), 4);

        vm.expectRevert(abi.encodeWithSelector(Mnemonad.IndexTruncated.selector, id, 0));
        ev.at(id, 0);
        vm.expectRevert(abi.encodeWithSelector(Mnemonad.IndexTruncated.selector, id, 1));
        ev.at(id, 1);

        assertEq(ev.at(id, 2), _bytes(102, 3));
        assertEq(ev.at(id, 3), _bytes(103, 4));
    }

    function test_truncateIsMonotonic() public {
        uint256 id = _createEmpty(owner, "tr2");
        vm.startPrank(owner);
        for (uint256 i = 0; i < 3; ++i) {
            ev.push(id, uint64(i), _bytes(50, uint8(i + 1)), "");
        }
        ev.truncateFrom(id, 2);
        ev.truncateFrom(id, 1); // no-op, must not rewind
        vm.stopPrank();
        assertEq(_firstAvailableIndex(ev, id), 2);
    }

    function test_truncateBeyondLengthReverts() public {
        uint256 id = _createEmpty(owner, "tr3");
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Mnemonad.IndexOutOfBounds.selector, id, 1));
        ev.truncateFrom(id, 1);
    }

    function test_pushAfterTruncateStillWorks() public {
        uint256 id = _createEmpty(owner, "tr4");
        vm.startPrank(owner);
        ev.push(id, 0, _bytes(100, 1), "");
        ev.truncateFrom(id, 1);
        ev.push(id, 1, _bytes(100, 2), "");
        vm.stopPrank();

        assertEq(_length(ev, id), 2);
        assertEq(ev.at(id, 1), _bytes(100, 2));
    }

    function test_burnDestroysStream() public {
        uint256 id = _createEmpty(owner, "b");
        vm.prank(owner);
        ev.push(id, 0, _bytes(100, 1), "");
        vm.prank(owner);
        ev.burn(id);

        vm.expectRevert(abi.encodeWithSelector(Mnemonad.NoSuchStream.selector, id));
        _length(ev, id);
    }

    // -----------------------------------------------------------------------------
    // Encryption key / transfer block
    // -----------------------------------------------------------------------------

    function test_setAndRewrapEncKey() public {
        uint256 id = _createEmpty(owner, "k");
        assertFalse(ev.isEncrypted(id));

        vm.prank(owner);
        ev.setEncKeyWrapped(id, hex"AABB");
        assertTrue(ev.isEncrypted(id));
        assertEq(_encKeyWrapped(ev, id), hex"AABB");

        // Owner-may-rewrap rather than write-once: the prerequisite for ever handing an
        // encrypted stream to a new owner.
        vm.prank(owner);
        ev.setEncKeyWrapped(id, hex"CCDD");
        assertEq(_encKeyWrapped(ev, id), hex"CCDD");
    }

    function test_unencryptedStreamTransfersFreely() public {
        uint256 id = _createEmpty(owner, "t1");
        vm.prank(owner);
        ev.transferFrom(owner, stranger, id);
        assertEq(ev.ownerOf(id), stranger);
    }

    function test_encryptedStreamCannotBeTransferred() public {
        uint256 id = _createEmpty(owner, "t2");
        vm.prank(owner);
        ev.setEncKeyWrapped(id, hex"AABB");

        // A self-wrapped key is bound to the owner's signature, so the recipient could
        // never decrypt. Blocking is the honest behaviour until rewrap-on-transfer exists.
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(Mnemonad.EncryptedStreamNotTransferable.selector, id)
        );
        ev.transferFrom(owner, stranger, id);
    }

    function test_encryptedStreamCanStillBeBurned() public {
        uint256 id = _createEmpty(owner, "t3");
        vm.prank(owner);
        ev.setEncKeyWrapped(id, hex"AABB");
        vm.prank(owner);
        ev.burn(id);

        vm.expectRevert(abi.encodeWithSelector(Mnemonad.NoSuchStream.selector, id));
        _length(ev, id);
    }

    function test_clearingKeyReenablesTransfer() public {
        uint256 id = _createEmpty(owner, "t4");
        vm.startPrank(owner);
        ev.setEncKeyWrapped(id, hex"AABB");
        ev.setEncKeyWrapped(id, "");
        ev.transferFrom(owner, stranger, id);
        vm.stopPrank();
        assertEq(ev.ownerOf(id), stranger);
    }

    // -----------------------------------------------------------------------------
    // Fees
    // -----------------------------------------------------------------------------

    function test_feeDormantByDefault() public {
        uint256 id = _createEmpty(owner, "f0");
        vm.prank(owner);
        ev.push(id, 0, _bytes(1_000, 1), ""); // no value attached
        assertEq(ev.feesAccrued(), 0);
    }

    function test_perByteFeeChargedAndAccrued() public {
        ev.setFeePerByte(1_000); // wei per byte
        uint256 id = _createEmpty(owner, "f1");

        uint256 size = 1_000;
        uint256 expected = size * 1_000;
        assertEq(ev.quotePushFee(size, Mnemonad.Store.CODE), expected);

        vm.prank(owner);
        ev.push{value: expected}(id, 0, _bytes(size, 1), "");
        assertEq(ev.feesAccrued(), expected);
    }

    function test_insufficientFeeReverts() public {
        ev.setFeePerByte(1_000);
        uint256 id = _createEmpty(owner, "f2");
        uint256 size = 1_000;

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(Mnemonad.InsufficientFee.selector, size * 1_000, 1)
        );
        ev.push{value: 1}(id, 0, _bytes(size, 1), "");
    }

    function test_excessFeeRefunded() public {
        ev.setFeePerByte(1_000);
        uint256 id = _createEmpty(owner, "f3");
        uint256 size = 100;
        uint256 required = size * 1_000;

        uint256 balanceBefore = owner.balance;
        vm.prank(owner);
        ev.push{value: required + 5 ether}(id, 0, _bytes(size, 1), "");

        // Overpayment is returned rather than rejected, so a fee change landing between an
        // SDK's quote and its broadcast doesn't fail the transaction.
        assertEq(owner.balance, balanceBefore - required);
        assertEq(ev.feesAccrued(), required);
    }

    function test_externalItemPaysFlatFeeRegardlessOfSize() public {
        ev.setFeePerByte(1_000);
        uint256 id = _createEmpty(owner, "f4");

        uint256 flat = ev.externalFeeBytes() * 1_000;
        assertEq(ev.quotePushFee(1_000_000_000, Mnemonad.Store.EXTERNAL), flat);
        assertEq(ev.quotePushFee(1, Mnemonad.Store.EXTERNAL), flat);

        Mnemonad.Pointer memory p = Mnemonad.Pointer({
            hash: keccak256("x"),
            size: 1_000_000_000,
            codec: 0,
            locator: hex"AABB"
        });

        vm.prank(owner);
        ev.pushExternal{value: flat}(id, 0, p, "");
        assertEq(ev.feesAccrued(), flat);
    }

    function test_externalFlatFeeIsQuarterOfMaxOnchainUpload() public view {
        // The decided relationship, asserted so it can't drift silently.
        assertEq(ev.externalFeeBytes() * 4, ev.maxChunkBytes());
    }

    function test_feeCannotExceedHardMax() public {
        uint256 max = ev.MAX_FEE_PER_BYTE();
        ev.setFeePerByte(max); // allowed

        vm.expectRevert(
            abi.encodeWithSelector(Mnemonad.FeeAboveMax.selector, max + 1, max)
        );
        ev.setFeePerByte(max + 1);
    }

    function test_onlyOwnerSetsFee() public {
        vm.prank(stranger);
        vm.expectRevert();
        ev.setFeePerByte(1);
    }

    function test_withdrawFeesPullsToRecipient() public {
        ev.setFeePerByte(1_000);
        uint256 id = _createEmpty(owner, "f5");
        uint256 required = 100 * 1_000;

        vm.prank(owner);
        ev.push{value: required}(id, 0, _bytes(100, 1), "");

        uint256 before = feeTo.balance;
        ev.withdrawFees();
        assertEq(feeTo.balance, before + required);
        assertEq(ev.feesAccrued(), 0);
    }

    // -----------------------------------------------------------------------------
    // Bounds and existence
    // -----------------------------------------------------------------------------

    function test_readingMissingStreamReverts() public {
        uint256 ghost = ev.streamIdFor(owner, "nope");
        vm.expectRevert(abi.encodeWithSelector(Mnemonad.NoSuchStream.selector, ghost));
        _length(ev, ghost);
    }

    function test_indexOutOfBoundsReverts() public {
        uint256 id = _createEmpty(owner, "oob");
        vm.expectRevert(abi.encodeWithSelector(Mnemonad.IndexOutOfBounds.selector, id, 0));
        ev.at(id, 0);
    }

    function test_getItemRefsReportsLayout() public {
        uint256 id = _createEmpty(owner, "refs");
        vm.prank(owner);
        ev.push(id, 0, _bytes(500, 1), hex"7788");

        (
            Mnemonad.Store store,
            address[] memory chunks,
            uint32 offset,
            uint32 size,
            bytes memory meta
        ) = ev.getItemRefs(id, 0);

        assertEq(uint8(store), uint8(Mnemonad.Store.CODE));
        assertEq(chunks.length, 1);
        assertTrue(chunks[0] != address(0));
        assertEq(offset, 0);
        assertEq(size, 500);
        assertEq(meta, hex"7788");

        // A successor registry can adopt this chunk by address — no bytes copied. That is
        // the migration path an immutable contract depends on.
        assertEq(DataChunk.read(chunks[0]), _bytes(500, 1));
    }
}
