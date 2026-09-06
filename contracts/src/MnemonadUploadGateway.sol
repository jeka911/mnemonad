// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPyth} from "./IPyth.sol";

/// @title MnemonadUploadGateway
/// @notice Sells off-chain pinning quota for MON, priced in USD via Pyth's MON/USD feed.
///
/// The problem it solves: an EXTERNAL item's bytes never touch the chain, so somebody has to
/// pay a pinning service to hold them. Handing a Pinata credential to a browser means every
/// visitor can upload unlimited data on your account. Instead:
///
///   1. The client commits on-chain to `(contentHash, maxSize)` and escrows MON here.
///   2. A server reads that escrow, then mints a Pinata *presigned upload URL* bounded to
///      `maxFileSize: maxSize` — so the paid ceiling is enforced by Pinata, not by trust.
///   3. The client uploads, then calls `Mnemonad.pushExternal` with a Pointer carrying the
///      same `contentHash`. That call settles the escrow here and waives the registry's
///      EXTERNAL fee, so committing the pointer costs nothing extra.
///
/// Escrow, not immediate revenue, is the load-bearing choice. It makes step 2's server
/// non-custodial and optional: if it never issues a URL, the payer reclaims their MON after
/// `requestTtl` via {refund}. A dead server delays uploads; it cannot strand funds.
///
/// Deliberately a separate deployable rather than logic inside `Mnemonad`:
///   - `Mnemonad` sits at 22,960 bytes against EIP-170's 24,576. Pyth math plus escrow does
///     not fit, and pushing the registry over the limit would make it undeployable on the
///     local test node (which offers no `allowUnlimitedContractSize`), costing the whole
///     Solidity test suite.
///   - Pyth is a moving dependency: MON/USD already migrated off the beta contract, which
///     stopped serving the feed. `pyth` and `priceFeedId` are settable here. Hard-wiring
///     them into an immutable data registry is the one mistake that cannot be walked back.
///   - A bug in this contract cannot corrupt vector state or touch the registry's own fees.
contract MnemonadUploadGateway is Ownable2Step, ReentrancyGuardTransient {
    // ---------------------------------------------------------------------------------
    // Constants and immutables
    // ---------------------------------------------------------------------------------

    /// @dev Pricing unit. Bytes are too small to price in whole wei without rounding to
    ///      zero, so the cached rate is per-MiB and per-request cost divides down from it.
    uint256 private constant MIB = 1024 * 1024;

    /// @notice Hard ceiling on the admin-settable rate band, so no owner can set a band that
    ///         permits an absurd price. A constant, mirroring `Mnemonad.MAX_FEE_PER_BYTE`.
    uint256 public constant MAX_WEI_PER_MIB = 1e21; // 1000 MON per MiB

    /// @notice The only address allowed to settle escrow. Immutable: this is the trust
    ///         relationship the whole design rests on, and it should not be re-pointable.
    address public immutable mnemonad;

    // ---------------------------------------------------------------------------------
    // Oracle configuration
    // ---------------------------------------------------------------------------------

    IPyth public pyth;
    bytes32 public priceFeedId;

    /// @notice Max age Pyth itself will accept for a price when refreshing the rate.
    ///
    /// @dev DELIBERATELY LOOSE FOR TESTNET — tighten before mainnet via {setLimits}.
    ///      Nobody keeps MON/USD warm on Monad testnet: a live read of
    ///      `0x2880aB…C17B43` returned a price ~27 days old. At a production value
    ///      (~60s) quoting can only ever succeed by paying to push fresh Hermes
    ///      data, which needs a Pyth API key since their 2026-08-26 Core upgrade. Two
    ///      months accepts the stale testnet feed so the gateway is exercisable without
    ///      that dependency. A price this old is worthless for pricing real money, so
    ///      mainnet must set seconds, not months.
    uint256 public maxPriceAge = 60 days;

    /// @notice Reject a price whose confidence interval exceeds this share of the price.
    ///         A wide band means Pyth's publishers disagree — not a number to price against.
    uint256 public maxConfBps = 200; // 2%

    // ---------------------------------------------------------------------------------
    // Pricing configuration
    // ---------------------------------------------------------------------------------

    /// @notice Headline lever: USD cents charged per MiB of off-chain payload.
    uint256 public usdCentsPerMiB;

    /// @notice Floor per request. Small uploads cost request overhead, not bytes.
    uint256 public minChargeWei;

    /// @notice Accepted band for a freshly computed rate. A rate outside it is refused
    ///         rather than clamped: silently clamping a broken oracle would mis-sell quota,
    ///         whereas refusing freezes the cache and (once stale) halts sales, which is the
    ///         safe direction to fail — {refund} still works while halted.
    uint256 public minWeiPerMiB;
    uint256 public maxWeiPerMiB;

    // ---------------------------------------------------------------------------------
    // Escrow
    // ---------------------------------------------------------------------------------

    /// @notice How long a paid request stays claimable before {refund} unlocks.
    uint256 public requestTtl = 1 hours;

    /// @notice New sales can be halted without touching outstanding escrow.
    bool public paused;

    /// @dev Packed into one slot: 96 + 64 + 64 = 224 bits. `payer` and `contentHash` are
    ///      not stored because they are the key — a caller who reproduces the key has
    ///      thereby proven both, which is what lets {refund} pay out safely.
    struct Request {
        uint96 amount; // MON escrowed
        uint64 maxSize; // paid ceiling, in bytes
        uint64 expiry;
    }

    mapping(bytes32 requestId => Request) public requests;

    /// @notice Total MON owed back to payers. Withdrawals may never dip into this.
    uint256 public escrowed;

    /// @notice Settled, withdrawable revenue.
    uint256 public revenue;

    // ---------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------

    event UploadPaid(
        bytes32 indexed requestId,
        address indexed payer,
        bytes32 indexed contentHash,
        uint64 maxSize,
        uint256 amount,
        uint64 expiry
    );
    event UploadConsumed(bytes32 indexed requestId, address indexed payer, bytes32 indexed contentHash, uint64 size);
    event UploadRefunded(bytes32 indexed requestId, address indexed payer, uint256 amount);
    event RevenueWithdrawn(address indexed to, uint256 amount);
    event OracleSet(address pyth, bytes32 priceFeedId);
    event PricingSet(uint256 usdCentsPerMiB, uint256 minChargeWei, uint256 minWeiPerMiB, uint256 maxWeiPerMiB);
    event LimitsSet(uint256 maxPriceAge, uint256 maxConfBps, uint256 requestTtl);
    event PausedSet(bool paused);

    // ---------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------

    error ZeroAddress();
    error NotMnemonad();
    error SalesPaused();
    error PricingUnset();
    error BadBand(uint256 minWeiPerMiB, uint256 maxWeiPerMiB);
    error RateOutOfBand(uint256 weiPerMiB, uint256 min, uint256 max);
    error BadPrice(int64 price);
    error BadExponent(int32 expo);
    error ConfidenceTooWide(uint64 conf, int64 price);
    error EmptySize();
    error RequestExists(bytes32 requestId);
    error UnknownRequest(bytes32 requestId);
    error NotExpired(uint64 expiry);
    error InsufficientPayment(uint256 required, uint256 provided);
    error AmountTooLarge();
    error BandAboveMax(uint256 maxWeiPerMiB, uint256 ceiling);
    error TransferFailed();

    // ---------------------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------------------

    /// @param mnemonad_ The registry allowed to settle escrow. Deploy order is registry
    ///        first, then this, then `Mnemonad.setUploadGateway(address(this))`.
    ///
    /// @dev Pricing is required at construction rather than set afterwards. An unpriced
    ///      gateway is not a safely-dormant one — it is a deployed contract whose every
    ///      `quote` reverts, which reads as broken rather than as off. There is no useful
    ///      default for `usdCentsPerMiB` (what would you charge unasked?) or for
    ///      `maxWeiPerMiB` (the circuit-breaker ceiling depends on the price regime), so
    ///      they are demanded up front and validated once, here.
    ///
    ///      Activation is `Mnemonad.setUploadGateway`, not a flag in here: the registry
    ///      ignores this contract entirely until wired, which is the single switch worth
    ///      having. `paused` exists for stopping sales later, not for staging a rollout.
    constructor(
        address mnemonad_,
        address pyth_,
        bytes32 priceFeedId_,
        address owner_,
        uint256 usdCentsPerMiB_,
        uint256 minChargeWei_,
        uint256 minWeiPerMiB_,
        uint256 maxWeiPerMiB_
    ) Ownable(owner_) {
        if (mnemonad_ == address(0) || pyth_ == address(0)) revert ZeroAddress();
        mnemonad = mnemonad_;
        pyth = IPyth(pyth_);
        priceFeedId = priceFeedId_;
        emit OracleSet(pyth_, priceFeedId_);
        _setPricing(usdCentsPerMiB_, minChargeWei_, minWeiPerMiB_, maxWeiPerMiB_);
    }

    // ---------------------------------------------------------------------------------
    // Rate
    // ---------------------------------------------------------------------------------

    /// @notice Current MON-per-MiB rate, derived from Pyth on every call.
    ///
    /// @dev Read live rather than cached. `getPriceNoOlderThan` is a `view` and therefore
    ///      free — the thing that costs money is `updatePriceFeeds`, which is a *write* and
    ///      was never on this path. Caching the result would have bought one avoided view
    ///      call while costing two storage slots, a second staleness bound to reason about,
    ///      and a mandatory keeper transaction per cache window. That is the wrong trade at
    ///      any plausible volume.
    ///
    ///      Reverts rather than returning a sentinel when the oracle cannot be trusted, so a
    ///      bad price can never be silently sold against: `quote` and every payment path
    ///      inherit those checks by construction.
    function weiPerMiB() public view returns (uint256) {
        IPyth.Price memory p = pyth.getPriceNoOlderThan(priceFeedId, maxPriceAge);
        if (p.price <= 0) revert BadPrice(p.price);
        // A confidence band wider than `maxConfBps` of the price means the publishers do not
        // agree closely enough to sell against.
        if (uint256(p.conf) * 10_000 > uint256(uint64(p.price)) * maxConfBps) {
            revert ConfidenceTooWide(p.conf, p.price);
        }

        uint256 rate = Math.mulDiv(usdCentsPerMiB * 1e18, 1e18, _usdPerMon1e18(p.price, p.expo) * 100);
        if (rate < minWeiPerMiB || rate > maxWeiPerMiB) revert RateOutOfBand(rate, minWeiPerMiB, maxWeiPerMiB);
        return rate;
    }

    /// @notice Pushes signed Hermes price data into Pyth, making subsequent reads fresher.
    ///
    /// Permissionless, and no longer a prerequisite for anything — quoting works off
    /// whatever price is already on-chain. This exists for when `maxPriceAge` is tight
    /// enough that the on-chain price genuinely needs advancing first, which on mainnet it
    /// should be. See {payForUploadWithUpdate} to do it and buy in one transaction.
    ///
    /// @dev Any `msg.value` beyond Pyth's update fee is returned, so a caller can overpay
    ///      rather than racing the fee.
    function pushPriceUpdate(bytes[] calldata updateData) external payable nonReentrant {
        uint256 spent = _pushPythUpdate(updateData);
        _refundExcess(msg.value - spent);
    }

    function _pushPythUpdate(bytes[] calldata updateData) private returns (uint256 spent) {
        if (updateData.length == 0) return 0;
        spent = pyth.getUpdateFee(updateData);
        if (msg.value < spent) revert InsufficientPayment(spent, msg.value);
        pyth.updatePriceFeeds{value: spent}(updateData);
    }

    /// @dev USD per MON, scaled to 1e18. Pyth reports `price * 10**expo`; `expo` is data, not
    ///      a constant, so it is normalised here rather than assumed to be -8.
    function _usdPerMon1e18(int64 price, int32 expo) private pure returns (uint256) {
        if (expo < -18 || expo > 18) revert BadExponent(expo);
        uint256 p = uint256(uint64(price)); // safe: caller checked price > 0
        if (expo >= 0) return p * (10 ** uint256(uint32(expo))) * 1e18;
        return p * (10 ** (18 - uint256(uint32(-expo))));
    }

    // ---------------------------------------------------------------------------------
    // Quoting and payment
    // ---------------------------------------------------------------------------------

    /// @notice MON required to buy quota for a payload of up to `size` bytes.
    /// @dev Rounds up: paying for a fraction of a byte is not a thing. Inherits every
    ///      oracle guard from {weiPerMiB}, so this reverts on an untrustworthy price rather
    ///      than quoting one.
    function quote(uint64 size) public view returns (uint256) {
        if (size == 0) revert EmptySize();
        uint256 cost = Math.ceilDiv(uint256(size) * weiPerMiB(), MIB);
        return cost < minChargeWei ? minChargeWei : cost;
    }

    /// @notice Deterministic request id. Computable off-chain, so a server can look a request
    ///         up without watching events.
    /// @dev Keyed by content rather than by a nonce: the payer already knows the sha256 of
    ///      what they are about to upload (the SDK computes it to build a Pointer), and
    ///      binding payment to exact content is what makes over-upload detectable.
    function requestIdFor(address payer, bytes32 contentHash) public pure returns (bytes32) {
        return keccak256(abi.encode(payer, contentHash));
    }

    /// @notice Escrows payment for uploading `contentHash`, up to `maxSize` bytes.
    /// @dev `maxSize` is a ceiling, not an exact size: it is handed to Pinata as
    ///      `maxFileSize`, and settlement accepts any pointer at or under it. Overpayment is
    ///      escrowed in full and refundable, never silently kept.
    function payForUpload(bytes32 contentHash, uint64 maxSize) external payable nonReentrant returns (bytes32 requestId) {
        if (paused) revert SalesPaused();
        uint256 required = quote(maxSize);
        if (msg.value < required) revert InsufficientPayment(required, msg.value);
        return _escrow(contentHash, maxSize, msg.value);
    }

    /// @notice {pushPriceUpdate} and {payForUpload} in one transaction.
    /// @dev Exists so an on-chain price too old for `maxPriceAge` costs the user one wallet
    ///      prompt instead of two. Pyth's update fee is taken off `msg.value` first; the
    ///      remainder buys quota. The update lands before the quote is computed, so the
    ///      price paid is the one just pushed.
    function payForUploadWithUpdate(bytes[] calldata updateData, bytes32 contentHash, uint64 maxSize)
        external
        payable
        nonReentrant
        returns (bytes32 requestId)
    {
        if (paused) revert SalesPaused();
        uint256 spent = _pushPythUpdate(updateData);

        uint256 forUpload = msg.value - spent;
        uint256 required = quote(maxSize);
        if (forUpload < required) revert InsufficientPayment(required, forUpload);
        return _escrow(contentHash, maxSize, forUpload);
    }

    function _escrow(bytes32 contentHash, uint64 maxSize, uint256 amount) private returns (bytes32 requestId) {
        if (amount > type(uint96).max) revert AmountTooLarge();

        requestId = requestIdFor(msg.sender, contentHash);
        Request storage existing = requests[requestId];
        // One open request per (payer, content). Topping up or overwriting would make the
        // escrowed amount ambiguous; a caller who wants different terms refunds first.
        if (existing.amount != 0) revert RequestExists(requestId);

        uint64 expiry = uint64(block.timestamp + requestTtl);
        requests[requestId] = Request({amount: uint96(amount), maxSize: maxSize, expiry: expiry});
        escrowed += amount;

        emit UploadPaid(requestId, msg.sender, contentHash, maxSize, amount, expiry);
    }

    // ---------------------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------------------

    /// @notice Releases escrow for `(payer, contentHash)` if it covers `size` bytes.
    /// @dev Called by `Mnemonad.pushExternal`, which passes its own `msg.sender` as `payer`
    ///      and the committed Pointer's hash and size. Returns false — rather than
    ///      reverting — when there is nothing to settle, so an ordinary unpaid EXTERNAL push
    ///      still goes through and simply pays the registry's normal fee.
    function consumeUpload(address payer, bytes32 contentHash, uint64 size) external returns (bool) {
        if (msg.sender != mnemonad) revert NotMnemonad();

        bytes32 requestId = requestIdFor(payer, contentHash);
        Request memory req = requests[requestId];
        if (req.amount == 0) return false;
        if (size > req.maxSize) return false;
        if (block.timestamp > req.expiry) return false;

        delete requests[requestId];
        escrowed -= req.amount;
        revenue += req.amount;

        emit UploadConsumed(requestId, payer, contentHash, size);
        return true;
    }

    /// @notice Reclaims an expired, unconsumed payment.
    /// @dev Permissionless but not misdirectable: funds go to `payer`, and only a caller who
    ///      can reproduce `requestIdFor(payer, contentHash)` can name a live request. This is
    ///      the escape hatch that keeps a dead URL server from stranding anyone's MON.
    function refund(address payer, bytes32 contentHash) external nonReentrant {
        bytes32 requestId = requestIdFor(payer, contentHash);
        Request memory req = requests[requestId];
        if (req.amount == 0) revert UnknownRequest(requestId);
        if (block.timestamp <= req.expiry) revert NotExpired(req.expiry);

        delete requests[requestId];
        escrowed -= req.amount;

        emit UploadRefunded(requestId, payer, req.amount);
        _send(payer, req.amount);
    }

    // ---------------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------------

    /// @dev Pull, not push, and capped at `revenue`: outstanding escrow is never withdrawable
    ///      no matter what the balance says.
    function withdrawRevenue(address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = revenue;
        revenue = 0;
        emit RevenueWithdrawn(to, amount);
        _send(to, amount);
    }

    function setOracle(address pyth_, bytes32 priceFeedId_) external onlyOwner {
        if (pyth_ == address(0)) revert ZeroAddress();
        pyth = IPyth(pyth_);
        priceFeedId = priceFeedId_;
        emit OracleSet(pyth_, priceFeedId_);
    }

    function setPricing(uint256 usdCentsPerMiB_, uint256 minChargeWei_, uint256 minWeiPerMiB_, uint256 maxWeiPerMiB_)
        external
        onlyOwner
    {
        _setPricing(usdCentsPerMiB_, minChargeWei_, minWeiPerMiB_, maxWeiPerMiB_);
    }

    /// @dev One validation site for the constructor and the setter, so pricing can never be
    ///      left in a shape that makes {weiPerMiB} unsatisfiable. Use {setPaused} to stop
    ///      selling — never a zero price, which would only make quoting revert.
    function _setPricing(uint256 usdCentsPerMiB_, uint256 minChargeWei_, uint256 minWeiPerMiB_, uint256 maxWeiPerMiB_)
        private
    {
        if (usdCentsPerMiB_ == 0 || maxWeiPerMiB_ == 0) revert PricingUnset();
        if (maxWeiPerMiB_ > MAX_WEI_PER_MIB) revert BandAboveMax(maxWeiPerMiB_, MAX_WEI_PER_MIB);
        // An inverted band accepts no rate at all, which would halt sales in a way that
        // looks like an oracle fault rather than a configuration mistake.
        if (minWeiPerMiB_ > maxWeiPerMiB_) revert BadBand(minWeiPerMiB_, maxWeiPerMiB_);

        usdCentsPerMiB = usdCentsPerMiB_;
        minChargeWei = minChargeWei_;
        minWeiPerMiB = minWeiPerMiB_;
        maxWeiPerMiB = maxWeiPerMiB_;
        emit PricingSet(usdCentsPerMiB_, minChargeWei_, minWeiPerMiB_, maxWeiPerMiB_);
    }

    function setLimits(uint256 maxPriceAge_, uint256 maxConfBps_, uint256 requestTtl_) external onlyOwner {
        maxPriceAge = maxPriceAge_;
        maxConfBps = maxConfBps_;
        requestTtl = requestTtl_;
        emit LimitsSet(maxPriceAge_, maxConfBps_, requestTtl_);
    }

    /// @notice Halts new sales. Deliberately does not touch settlement or {refund}: pausing
    ///         must never trap money that is already in escrow.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    // ---------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------

    function _refundExcess(uint256 amount) private {
        if (amount != 0) _send(msg.sender, amount);
    }

    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
