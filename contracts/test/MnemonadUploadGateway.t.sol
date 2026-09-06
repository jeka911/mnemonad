// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.28;

import {EvTest} from "./lib/EvTest.sol";
import {Mnemonad} from "../src/Mnemonad.sol";
import {MnemonadUploadGateway} from "../src/MnemonadUploadGateway.sol";
import {IPyth} from "../src/IPyth.sol";

/// @notice Stand-in for Pyth's on-chain contract, so price shape (expo, confidence,
///         staleness) can be driven directly instead of depending on a live feed.
contract MockPyth {
    int64 public price;
    uint64 public conf;
    int32 public expo;
    uint256 public publishTime;
    uint256 public updateFee;
    uint256 public updateCalls;
    bool public forceStale;

    function set(int64 p, uint64 c, int32 e, uint256 t) external {
        price = p;
        conf = c;
        expo = e;
        publishTime = t;
    }

    function setUpdateFee(uint256 f) external {
        updateFee = f;
    }

    function setForceStale(bool s) external {
        forceStale = s;
    }

    function getPriceNoOlderThan(bytes32, uint256 age) external view returns (IPyth.Price memory) {
        if (forceStale || block.timestamp > publishTime + age) revert("StalePrice");
        return IPyth.Price({price: price, conf: conf, expo: expo, publishTime: publishTime});
    }

    function getUpdateFee(bytes[] calldata) external view returns (uint256) {
        return updateFee;
    }

    /// @dev Mirrors the real thing in the way that matters here: a successful update makes
    ///      the feed readable again, so a read straight afterwards succeeds.
    function updatePriceFeeds(bytes[] calldata) external payable {
        updateCalls++;
        publishTime = block.timestamp;
        forceStale = false;
    }
}

/// @notice A gateway that always reverts, to prove `pushExternal` degrades to the normal fee
///         instead of becoming unusable.
contract RevertingGateway {
    function consumeUpload(address, bytes32, uint64) external pure returns (bool) {
        revert("nope");
    }
}

contract MnemonadUploadGatewayTest is EvTest {
    Mnemonad internal ev;
    MnemonadUploadGateway internal gw;
    MockPyth internal pyth;

    address internal owner = address(0xA11CE);
    address internal payer = address(0xB0B);
    address internal stranger = address(0xCAFE);
    address internal feeTo = address(0xFEE);
    address internal revenueTo = address(0xBEEF);

    uint256 internal constant TEST_MAX_CHUNK = 20_000;
    bytes32 internal constant FEED = bytes32(uint256(0xFEED));
    uint256 internal constant MIB = 1024 * 1024;

    /// MON/USD = $0.025 at Pyth's usual exponent.
    int64 internal constant PRICE = 2_500_000;
    int32 internal constant EXPO = -8;

    /// $0.05 per MiB. At $0.025/MON that is exactly 2 MON per MiB — the arithmetic is
    /// hand-checkable, which is the point of picking these numbers.
    uint256 internal constant CENTS_PER_MIB = 5;
    uint256 internal constant EXPECTED_WEI_PER_MIB = 2e18;
    uint256 internal constant BAND_MAX = 100e18;

    function setUp() public {
        vm.warp(1_000_000);

        ev = new Mnemonad(TEST_MAX_CHUNK, feeTo);
        pyth = new MockPyth();
        pyth.set(PRICE, 1000, EXPO, block.timestamp);

        // Deploy order is registry → gateway → wire, because the gateway's `mnemonad` is
        // immutable and the registry's pointer to it is not. Pricing is part of
        // construction, so there is no post-deploy setup step at all.
        gw = new MnemonadUploadGateway(address(ev), address(pyth), FEED, owner, CENTS_PER_MIB, 0, 0, BAND_MAX);
        ev.setUploadGateway(address(gw));

        vm.deal(payer, 100 ether);
        vm.deal(stranger, 100 ether);
    }

    // -----------------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------------

    function _pointer(bytes32 hash, uint64 size) internal pure returns (Mnemonad.Pointer memory) {
        return Mnemonad.Pointer({hash: hash, size: size, codec: 0, locator: hex"01551220AABB"});
    }

    function _vector(address as_, bytes32 salt) internal returns (uint256 id) {
        vm.prank(as_);
        id = ev.create(salt, "", "", new bytes[](0));
    }

    function _data() internal pure returns (bytes[] memory d) {
        d = new bytes[](1);
        d[0] = hex"AABB";
    }

    // -----------------------------------------------------------------------------
    // Deployment
    // -----------------------------------------------------------------------------

    function test_deploymentWiring() public view {
        assertEq(gw.mnemonad(), address(ev));
        assertEq(address(gw.pyth()), address(pyth));
        assertEq(gw.priceFeedId(), FEED);
        assertEq(gw.owner(), owner);
        assertEq(ev.uploadGateway(), address(gw));
        assertFalse(gw.paused(), "activation is setUploadGateway, not an internal flag");
    }

    /// @dev The whole point of taking pricing in the constructor: a deployed gateway is
    ///      immediately usable, with no transaction in between. Previously `quote` reverted
    ///      until an owner priced it and a keeper seeded a cached rate.
    function test_sellableImmediatelyAfterDeployWithNoSetupTx() public view {
        assertEq(gw.weiPerMiB(), EXPECTED_WEI_PER_MIB);
        assertEq(gw.quote(uint64(MIB)), EXPECTED_WEI_PER_MIB);
    }

    function test_constructorRequiresPricing() public {
        vm.expectRevert(MnemonadUploadGateway.PricingUnset.selector);
        new MnemonadUploadGateway(address(ev), address(pyth), FEED, owner, 0, 0, 0, BAND_MAX);

        // A zero ceiling would make every computed rate out-of-band, i.e. unsellable.
        vm.expectRevert(MnemonadUploadGateway.PricingUnset.selector);
        new MnemonadUploadGateway(address(ev), address(pyth), FEED, owner, CENTS_PER_MIB, 0, 0, 0);
    }

    function test_constructorRejectsInvertedBand() public {
        vm.expectRevert(abi.encodeWithSelector(MnemonadUploadGateway.BadBand.selector, BAND_MAX, 1e18));
        new MnemonadUploadGateway(address(ev), address(pyth), FEED, owner, CENTS_PER_MIB, 0, BAND_MAX, 1e18);
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(MnemonadUploadGateway.ZeroAddress.selector);
        new MnemonadUploadGateway(address(0), address(pyth), FEED, owner, CENTS_PER_MIB, 0, 0, BAND_MAX);

        vm.expectRevert(MnemonadUploadGateway.ZeroAddress.selector);
        new MnemonadUploadGateway(address(ev), address(0), FEED, owner, CENTS_PER_MIB, 0, 0, BAND_MAX);
    }

    /// @dev Pins the deliberately-loose testnet staleness default. This test is *meant* to
    ///      fail when it is tightened for mainnet — that should be a conscious act with a
    ///      matching test edit, not something that drifts in unnoticed.
    function test_stalenessDefaultIsTestnetLoose() public view {
        assertEq(gw.maxPriceAge(), 60 days, "testnet MON/USD is ~27d stale; 60d accepts it");
    }

    // -----------------------------------------------------------------------------
    // Rate — read live from Pyth, never cached
    // -----------------------------------------------------------------------------

    function test_rateComputedFromPrice() public view {
        // $0.05/MiB ÷ $0.025/MON = 2 MON/MiB. Asserted as a literal so a change in the
        // scaling maths can't pass silently.
        assertEq(gw.weiPerMiB(), EXPECTED_WEI_PER_MIB);
    }

    function test_rateTracksPriceWithoutAnyTransaction() public {
        // The cache-free consequence worth having a test for: the price halving is reflected
        // on the very next read, with nobody having to refresh anything.
        pyth.set(PRICE / 2, 1000, EXPO, block.timestamp);
        assertEq(gw.weiPerMiB(), EXPECTED_WEI_PER_MIB * 2, "MON worth half as much costs twice as many");
    }

    function test_rateHandlesNonStandardExponent() public {
        // Same real price ($0.025), reported at a different exponent. Exponent is data, not
        // a constant, so the result must be identical.
        pyth.set(25_000, 10, -6, block.timestamp);
        assertEq(gw.weiPerMiB(), EXPECTED_WEI_PER_MIB, "expo must be normalised, not assumed");
    }

    function test_rateRejectsNonPositivePrice() public {
        pyth.set(0, 0, EXPO, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(MnemonadUploadGateway.BadPrice.selector, int64(0)));
        gw.weiPerMiB();
    }

    function test_rateRejectsWideConfidence() public {
        // 3% band against a 2% ceiling.
        pyth.set(PRICE, uint64(uint256(int256(PRICE)) * 3 / 100), EXPO, block.timestamp);
        vm.expectRevert();
        gw.weiPerMiB();
    }

    function test_rateRejectsExtremeExponent() public {
        pyth.set(PRICE, 10, 30, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(MnemonadUploadGateway.BadExponent.selector, int32(30)));
        gw.weiPerMiB();
    }

    function test_rateOutsideBandIsRefusedNotClamped() public {
        // Tighten the ceiling below the true rate: the rate must be refused, so a broken
        // oracle halts sales instead of mispricing them.
        vm.prank(owner);
        gw.setPricing(CENTS_PER_MIB, 0, 0, 1e18);
        vm.expectRevert();
        gw.weiPerMiB();
    }

    function test_ratePropagatesPythStaleness() public {
        pyth.setForceStale(true);
        vm.expectRevert();
        gw.weiPerMiB();
    }

    function test_acceptsAMonthOldPrice() public {
        // The actual testnet condition: a price published long ago and never refreshed.
        pyth.set(PRICE, 1000, EXPO, block.timestamp);
        vm.warp(block.timestamp + 27 days);
        assertEq(gw.quote(uint64(MIB)), EXPECTED_WEI_PER_MIB, "must quote off a stale-but-accepted feed");
    }

    function test_stillRejectsBeyondMaxPriceAge() public {
        pyth.set(PRICE, 1000, EXPO, block.timestamp);
        vm.warp(block.timestamp + 61 days);
        vm.expectRevert(); // Pyth's own StalePrice — the bound is loose, not absent
        gw.quote(uint64(MIB));
    }

    // -----------------------------------------------------------------------------
    // Pushing price data
    // -----------------------------------------------------------------------------

    function test_pushPriceUpdatePaysFeeAndRefundsRest() public {
        pyth.setUpdateFee(7 wei);

        uint256 before = payer.balance;
        vm.prank(payer);
        gw.pushPriceUpdate{value: 100 wei}(_data());

        assertEq(pyth.updateCalls(), 1, "update data must reach Pyth");
        assertEq(before - payer.balance, 7 wei, "only the fee is spent");
        assertEq(address(pyth).balance, 7 wei);
    }

    function test_pushPriceUpdateIsNotAPrerequisite() public view {
        // Nothing has ever been pushed in this test, and quoting still works — that is the
        // difference from the cached design.
        assertEq(pyth.updateCalls(), 0);
        assertTrue(gw.quote(uint64(MIB)) > 0);
    }

    function test_pushPriceUpdateRejectsUnderpaidFee() public {
        pyth.setUpdateFee(50 wei);
        vm.prank(payer);
        vm.expectRevert();
        gw.pushPriceUpdate{value: 10 wei}(_data());
    }

    // -----------------------------------------------------------------------------
    // Quoting
    // -----------------------------------------------------------------------------

    function test_quoteScalesWithSize() public view {
        assertEq(gw.quote(uint64(MIB)), EXPECTED_WEI_PER_MIB);
        assertEq(gw.quote(uint64(MIB / 2)), EXPECTED_WEI_PER_MIB / 2);
    }

    function test_quoteRoundsUp() public view {
        // One byte is a vanishing fraction of a MiB; it must still cost something.
        assertTrue(gw.quote(1) > 0, "sub-byte rounding must never reach zero");
    }

    function test_quoteAppliesMinimumCharge() public {
        vm.prank(owner);
        gw.setPricing(CENTS_PER_MIB, 1 ether, 0, BAND_MAX);
        assertEq(gw.quote(1), 1 ether, "small uploads pay request overhead, not bytes");
    }

    function test_quoteRejectsZeroSize() public {
        vm.expectRevert(MnemonadUploadGateway.EmptySize.selector);
        gw.quote(0);
    }

    // -----------------------------------------------------------------------------
    // Payment / escrow
    // -----------------------------------------------------------------------------

    function test_payEscrowsFunds() public {
        uint256 cost = gw.quote(uint64(MIB));

        vm.prank(payer);
        bytes32 rid = gw.payForUpload{value: cost}(keccak256("blob"), uint64(MIB));

        assertEq(rid, gw.requestIdFor(payer, keccak256("blob")));
        assertEq(gw.escrowed(), cost);
        assertEq(gw.revenue(), 0, "unsettled payment is not revenue");

        (uint96 amount, uint64 maxSize,) = gw.requests(rid);
        assertEq(uint256(amount), cost);
        assertEq(uint256(maxSize), MIB);
    }

    function test_payRejectsUnderpayment() public {
        uint256 cost = gw.quote(uint64(MIB));
        vm.prank(payer);
        vm.expectRevert();
        gw.payForUpload{value: cost - 1}(keccak256("blob"), uint64(MIB));
    }

    function test_payEscrowsOverpaymentRatherThanKeepingIt() public {
        uint256 cost = gw.quote(uint64(MIB));

        vm.prank(payer);
        bytes32 rid = gw.payForUpload{value: cost + 5 ether}(keccak256("blob"), uint64(MIB));

        (uint96 amount,,) = gw.requests(rid);
        assertEq(uint256(amount), cost + 5 ether, "overpayment must stay refundable");
        assertEq(gw.escrowed(), cost + 5 ether);
    }

    function test_payRejectsDuplicateOpenRequest() public {
        uint256 cost = gw.quote(uint64(MIB));

        vm.startPrank(payer);
        gw.payForUpload{value: cost}(keccak256("blob"), uint64(MIB));
        vm.expectRevert();
        gw.payForUpload{value: cost}(keccak256("blob"), uint64(MIB));
        vm.stopPrank();
    }

    function test_payBlockedWhilePaused() public {
        uint256 cost = gw.quote(uint64(MIB));

        vm.prank(owner);
        gw.setPaused(true);

        vm.prank(payer);
        vm.expectRevert(MnemonadUploadGateway.SalesPaused.selector);
        gw.payForUpload{value: cost}(keccak256("blob"), uint64(MIB));
    }

    function test_payWithUpdateRevivesAnUnreadableFeedAndBuys() public {
        pyth.setUpdateFee(3 wei);
        pyth.setForceStale(true);

        // Too stale to quote at all right now...
        vm.expectRevert();
        gw.quote(uint64(MIB));

        // ...so pay and push in the same transaction. The update lands first, which is what
        // makes the quote inside this call succeed.
        vm.prank(payer);
        bytes32 rid = gw.payForUploadWithUpdate{value: 3 wei + 2e18}(_data(), keccak256("blob"), uint64(MIB));

        (uint96 amount,,) = gw.requests(rid);
        assertEq(uint256(amount), 2e18, "Pyth's fee must come off the top, not out of escrow");
        assertEq(gw.escrowed(), 2e18);
        assertEq(pyth.updateCalls(), 1);
    }

    // -----------------------------------------------------------------------------
    // Settlement
    // -----------------------------------------------------------------------------

    function test_consumeOnlyCallableByRegistry() public {
        vm.prank(stranger);
        vm.expectRevert(MnemonadUploadGateway.NotMnemonad.selector);
        gw.consumeUpload(payer, keccak256("blob"), 1);
    }

    function test_consumeMovesEscrowToRevenue() public {
        uint256 cost = gw.quote(uint64(MIB));
        vm.prank(payer);
        gw.payForUpload{value: cost}(keccak256("blob"), uint64(MIB));

        vm.prank(address(ev));
        assertTrue(gw.consumeUpload(payer, keccak256("blob"), uint64(MIB)));

        assertEq(gw.escrowed(), 0);
        assertEq(gw.revenue(), cost);
        // Consumed exactly once: a replayed settlement must find nothing.
        vm.prank(address(ev));
        assertFalse(gw.consumeUpload(payer, keccak256("blob"), uint64(MIB)));
    }

    function test_consumeAcceptsSmallerThanPaidFor() public {
        uint256 cost = gw.quote(uint64(MIB));
        vm.prank(payer);
        gw.payForUpload{value: cost}(keccak256("blob"), uint64(MIB));

        // The paid size is a ceiling — an upload that came in under it still settles, rather
        // than stranding the payment over a few bytes.
        vm.prank(address(ev));
        assertTrue(gw.consumeUpload(payer, keccak256("blob"), uint64(MIB) - 10));
    }

    function test_consumeRejectsOversize() public {
        uint256 cost = gw.quote(uint64(MIB));
        vm.prank(payer);
        gw.payForUpload{value: cost}(keccak256("blob"), uint64(MIB));

        vm.prank(address(ev));
        assertFalse(gw.consumeUpload(payer, keccak256("blob"), uint64(MIB) + 1), "cannot settle more than paid for");
        assertEq(gw.escrowed(), cost, "a refused settlement must leave escrow untouched");
    }

    function test_consumeReturnsFalseForUnknownOrWrongPayer() public {
        uint256 cost = gw.quote(uint64(MIB));
        vm.prank(payer);
        gw.payForUpload{value: cost}(keccak256("blob"), uint64(MIB));

        vm.startPrank(address(ev));
        assertFalse(gw.consumeUpload(payer, keccak256("other"), 1), "hash must match");
        assertFalse(gw.consumeUpload(stranger, keccak256("blob"), 1), "payer must match");
        vm.stopPrank();
    }

    function test_consumeReturnsFalseAfterExpiry() public {
        uint256 cost = gw.quote(uint64(MIB));
        vm.prank(payer);
        gw.payForUpload{value: cost}(keccak256("blob"), uint64(MIB));

        vm.warp(block.timestamp + gw.requestTtl() + 1);
        vm.prank(address(ev));
        assertFalse(gw.consumeUpload(payer, keccak256("blob"), uint64(MIB)));
    }

    // -----------------------------------------------------------------------------
    // Refunds
    // -----------------------------------------------------------------------------

    function test_refundAfterExpiryReturnsFunds() public {
        uint256 cost = gw.quote(uint64(MIB));
        vm.prank(payer);
        gw.payForUpload{value: cost}(keccak256("blob"), uint64(MIB));

        vm.warp(block.timestamp + gw.requestTtl() + 1);

        uint256 before = payer.balance;
        // Permissionless: a stranger can trigger it, but the money can only go to the payer.
        vm.prank(stranger);
        gw.refund(payer, keccak256("blob"));

        assertEq(payer.balance - before, cost);
        assertEq(gw.escrowed(), 0);
        assertEq(gw.revenue(), 0, "a refund is not revenue");
    }

    function test_refundBlockedBeforeExpiry() public {
        uint256 cost = gw.quote(uint64(MIB));
        vm.prank(payer);
        gw.payForUpload{value: cost}(keccak256("blob"), uint64(MIB));

        vm.expectRevert();
        gw.refund(payer, keccak256("blob"));
    }

    function test_refundWorksWhilePaused() public {
        // Pausing sales must never trap money already in escrow.
        uint256 cost = gw.quote(uint64(MIB));
        vm.prank(payer);
        gw.payForUpload{value: cost}(keccak256("blob"), uint64(MIB));

        vm.prank(owner);
        gw.setPaused(true);
        vm.warp(block.timestamp + gw.requestTtl() + 1);

        gw.refund(payer, keccak256("blob"));
        assertEq(gw.escrowed(), 0);
    }

    /// @dev Refunds must not depend on the oracle. If Pyth goes bad, sales halt — but money
    ///      already escrowed has to remain reclaimable, or an oracle fault becomes a freeze.
    function test_refundWorksEvenWhenOracleIsBroken() public {
        uint256 cost = gw.quote(uint64(MIB));
        vm.prank(payer);
        gw.payForUpload{value: cost}(keccak256("blob"), uint64(MIB));

        pyth.setForceStale(true);
        vm.expectRevert();
        gw.quote(uint64(MIB)); // sales are indeed halted

        vm.warp(block.timestamp + gw.requestTtl() + 1);
        uint256 before = payer.balance;
        gw.refund(payer, keccak256("blob"));
        assertEq(payer.balance - before, cost, "escrow must survive an oracle fault");
    }

    function test_refundRejectsUnknownRequest() public {
        vm.expectRevert();
        gw.refund(payer, keccak256("nothing"));
    }

    // -----------------------------------------------------------------------------
    // Revenue withdrawal — the escrow-safety invariant
    // -----------------------------------------------------------------------------

    function test_withdrawCannotTouchEscrow() public {
        uint256 cost = gw.quote(uint64(MIB));

        // One paid-but-unsettled request, one settled.
        vm.prank(payer);
        gw.payForUpload{value: cost}(keccak256("settled"), uint64(MIB));
        vm.prank(address(ev));
        gw.consumeUpload(payer, keccak256("settled"), uint64(MIB));

        vm.prank(payer);
        gw.payForUpload{value: cost}(keccak256("open"), uint64(MIB));

        assertEq(address(gw).balance, cost * 2);
        assertEq(gw.revenue(), cost);
        assertEq(gw.escrowed(), cost);

        vm.prank(owner);
        gw.withdrawRevenue(revenueTo);

        // Only the settled half leaves. The open request is still fully funded.
        assertEq(revenueTo.balance, cost);
        assertEq(gw.revenue(), 0);
        assertEq(gw.escrowed(), cost);
        assertEq(address(gw).balance, cost, "escrow must survive a full revenue withdrawal");

        // And it is still refundable afterwards.
        vm.warp(block.timestamp + gw.requestTtl() + 1);
        uint256 before = payer.balance;
        gw.refund(payer, keccak256("open"));
        assertEq(payer.balance - before, cost);
    }

    function test_onlyOwnerAdmin() public {
        vm.startPrank(stranger);
        vm.expectRevert();
        gw.setPricing(CENTS_PER_MIB, 0, 0, BAND_MAX);
        vm.expectRevert();
        gw.setOracle(address(pyth), FEED);
        vm.expectRevert();
        gw.setLimits(60, 200, 1 hours);
        vm.expectRevert();
        gw.setPaused(true);
        vm.expectRevert();
        gw.withdrawRevenue(stranger);
        vm.stopPrank();
    }

    function test_pricingBandCannotExceedHardMax() public {
        uint256 ceiling = gw.MAX_WEI_PER_MIB();
        vm.startPrank(owner);
        gw.setPricing(CENTS_PER_MIB, 0, 0, ceiling); // allowed
        vm.expectRevert();
        gw.setPricing(CENTS_PER_MIB, 0, 0, ceiling + 1);
        vm.stopPrank();
    }

    function test_setPricingRejectsZeroingThePrice() public {
        // Turning the gateway off is `setPaused`, not a zero price — which would only make
        // quoting revert and look like a fault.
        vm.prank(owner);
        vm.expectRevert(MnemonadUploadGateway.PricingUnset.selector);
        gw.setPricing(0, 0, 0, BAND_MAX);
    }

    // -----------------------------------------------------------------------------
    // Registry integration
    // -----------------------------------------------------------------------------

    function test_prepaidExternalPushWaivesFee() public {
        ev.setFeePerByte(1e6); // registry fee on, so a waiver is observable
        uint256 flat = ev.quotePushFee(0, Mnemonad.Store.EXTERNAL);
        assertTrue(flat > 0);

        uint256 id = _vector(payer, "prepaid");
        bytes32 hash = keccak256("payload");
        uint256 cost = gw.quote(1_000_000);

        vm.prank(payer);
        gw.payForUpload{value: cost}(hash, 1_000_000);

        // No `value` at all: the escrow covers it.
        vm.prank(payer);
        ev.pushExternal(id, 0, _pointer(hash, 1_000_000), "");

        assertEq(ev.feesAccrued(), 0, "prepaid push must not also charge the registry fee");
        assertEq(gw.revenue(), cost, "escrow must have settled");
        assertEq(gw.escrowed(), 0);
        assertEq(uint8(ev.itemStore(id, 0)), uint8(Mnemonad.Store.EXTERNAL));
    }

    function test_unpaidExternalPushStillChargesNormally() public {
        ev.setFeePerByte(1e6);
        uint256 flat = ev.quotePushFee(0, Mnemonad.Store.EXTERNAL);

        uint256 id = _vector(payer, "unpaid");
        vm.prank(payer);
        ev.pushExternal{value: flat}(id, 0, _pointer(keccak256("nothing-prepaid"), 100), "");

        assertEq(ev.feesAccrued(), flat, "no escrow means the ordinary fee applies");
    }

    function test_prepaidPushCannotBeReplayedForASecondItem() public {
        ev.setFeePerByte(1e6);
        uint256 flat = ev.quotePushFee(0, Mnemonad.Store.EXTERNAL);

        uint256 id = _vector(payer, "replay");
        bytes32 hash = keccak256("payload");
        uint256 cost = gw.quote(1_000);

        vm.prank(payer);
        gw.payForUpload{value: cost}(hash, 1_000);

        vm.prank(payer);
        ev.pushExternal(id, 0, _pointer(hash, 1_000), "");
        assertEq(ev.feesAccrued(), 0);

        // Same content, same payer, second push: the escrow is spent, so this one pays.
        vm.prank(payer);
        ev.pushExternal{value: flat}(id, 1, _pointer(hash, 1_000), "");
        assertEq(ev.feesAccrued(), flat, "one payment buys one commit");
    }

    function test_revertingGatewayDoesNotBrickExternalPush() public {
        ev.setFeePerByte(1e6);
        uint256 flat = ev.quotePushFee(0, Mnemonad.Store.EXTERNAL);

        ev.setUploadGateway(address(new RevertingGateway()));

        uint256 id = _vector(payer, "broken");
        vm.prank(payer);
        ev.pushExternal{value: flat}(id, 0, _pointer(keccak256("x"), 100), "");

        assertEq(ev.feesAccrued(), flat, "a broken gateway must degrade to the normal fee");
        assertEq(uint8(ev.itemStore(id, 0)), uint8(Mnemonad.Store.EXTERNAL));
    }

    function test_clearingGatewayRestoresPlainBehaviour() public {
        ev.setFeePerByte(1e6);
        uint256 flat = ev.quotePushFee(0, Mnemonad.Store.EXTERNAL);

        ev.setUploadGateway(address(0));
        assertEq(ev.uploadGateway(), address(0));

        uint256 id = _vector(payer, "nogw");
        vm.prank(payer);
        ev.pushExternal{value: flat}(id, 0, _pointer(keccak256("x"), 100), "");
        assertEq(ev.feesAccrued(), flat);
    }

    function test_onlyRegistryOwnerCanSetGateway() public {
        vm.prank(stranger);
        vm.expectRevert();
        ev.setUploadGateway(address(gw));
    }
}
