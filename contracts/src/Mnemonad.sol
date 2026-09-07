// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {DataChunk} from "./DataChunk.sol";
import {IMnemonadUploadGateway} from "./IMnemonadUploadGateway.sol";

/// @title Mnemonad
/// @notice A scalable append-only on-chain `bytes[]`.
///
/// Each vector is an ERC-721 token: a unique, transferable, owned id, which is what lets
/// `ownerOf` stand in for access control. All vectors live in this one registry rather than
/// in a contract each, because that is what keeps `concat` affordable: merging two vectors
/// re-links item records instead of copying payload bytes, which is only possible when both
/// vectors share a storage domain.
///
/// Items are stored in one of three tiers, chosen by cost rather than by size headroom:
///   - SLOT     — <=31 bytes, packed into a single storage slot.
///   - CODE     — bytes deployed as contract code (see DataChunk); the default tier, since
///                it beats storage at every size above 31 bytes.
///   - EXTERNAL — an off-chain pointer (IPFS CID etc.) plus a hash for read-time
///                verification. Payload never touches the chain.
///
/// No update-in-place operation: this vector is append-only, full stop.
///
/// ERC721Enumerable: adds `tokenOfOwnerByIndex`/`totalSupply`/`tokenByIndex` so "list this
/// owner's vectors" is a direct on-chain read instead of an off-chain event-log scan —
/// deterministic ids (see `vectorIdFor`) mean the ordinary path of walking `0..totalSupply`
/// isn't available, so the SDK still needs the per-owner index rather than a bare loop.
/// Costs real gas on every mint and transfer (~90K / ~24K gas respectively, measured — three
/// extra storage slots on mint, none of them contiguous with anything else this contract
/// writes, so Monad's page-amortization doesn't discount them); does not affect `push`,
/// `pushMany`, or `pushExternal`, which never touch this bookkeeping.
contract Mnemonad is ERC721Enumerable, Ownable2Step, ReentrancyGuardTransient {
    // ---------------------------------------------------------------------------------
    // Constants and immutables
    // ---------------------------------------------------------------------------------

    /// @notice Layout/semantics version. The SDK must refuse to operate on a mismatch
    ///         rather than misdecode a struct whose layout moved.
    /// v2 adds the optional `uploadGateway` settlement hook in `pushExternal`. Item and
    /// Pointer layouts are byte-identical to v1, so a v1-era SDK decodes v2 correctly — the
    /// bump records the fee *semantics* change (an EXTERNAL push can now be prepaid), not a
    /// layout move.
    uint32 public constant CONTRACT_VERSION = 2;

    /// @notice Items at or below this size use the SLOT tier. Above it, CODE is cheaper —
    ///         at 32 bytes a Solidity `bytes` stops packing into one slot and cost roughly
    ///         doubles in a single step, which is exactly where CODE overtakes it.
    uint256 public constant SLOT_MAX_BYTES = 31;

    /// @notice Ceiling on `maxChunkBytes`, deliberately well under what the EVM would allow.
    ///
    /// Monad's own code-size cap is 128 KB, and that number alone would let a deployer set
    /// `maxChunkBytes` right up against it — but a CODE-tier chunk that large risks exceeding
    /// Monad's 30M-gas *per-transaction* cap outright on the deploy itself (`DataChunk.write`
    /// costs ~216 gas/byte), which is a hard failure, not merely an expensive one, and one
    /// that no client-side gas estimate can paper over: if the real cost is above the cap,
    /// every wallet's estimate will correctly say so and the transaction will be rejected
    /// regardless of how tightly it's computed. 64 KiB keeps a full-size chunk's deploy cost
    /// comfortably inside that cap with real headroom to spare, on any gas price.
    ///
    /// This is a ceiling on *on-chain* chunk size only, not a target. A payload above it is
    /// still perfectly storable — it just can't go through the single-transaction CODE path,
    /// and has to use the staged multi-transaction append instead or be offloaded off-chain
    /// (EXTERNAL/IPFS) instead. Deciding *when* off-chain storage is worth it below this
    /// ceiling — e.g. offloading a 40 KB item because IPFS is cheaper than CODE at that size,
    /// even though it would fit on-chain — is a cost-optimization call the contract has no
    /// opinion on; it belongs to the SDK (or whatever calls this contract), which can see gas
    /// price and off-chain pinning cost together and this contract cannot.
    uint256 public constant MAX_CHUNK_BYTES_CEILING = 65_536;

    /// @notice Hard cap on the admin-settable fee. A constant, so no admin can raise it.
    uint256 public constant MAX_FEE_PER_BYTE = 1e14; // 0.0001 MON/byte

    /// @notice Largest payload accepted into a single CODE chunk. An immutable rather than a
    ///         constant because the enforcing limit used to be the EVM's own code-size cap
    ///         (~120 KB on Monad, 24 KB under local EIP-170) before `MAX_CHUNK_BYTES_CEILING`
    ///         tightened it — see that constant for why 64 KiB is the real ceiling now, and
    ///         why a deployer choosing anything under that value is still just as valid.
    ///         Larger items are assembled from several chunks via the staged-append path.
    uint256 public immutable maxChunkBytes;

    /// @notice EXTERNAL items pay a flat fee equal to 25% of a maximum on-chain upload.
    ///         Expressed in byte-equivalents so it scales with `feePerByte` automatically,
    ///         leaving the admin a single lever.
    uint256 public immutable externalFeeBytes;

    // ---------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------

    enum Store {
        NONE,
        SLOT,
        CODE,
        EXTERNAL
    }

    /// @dev 8 + 160 + 32 + 32 + 16 = 248 bits, so an item costs exactly one storage slot.
    ///      At 17,000 gas per net-new slot this is not a micro-optimisation: a three-slot
    ///      layout would cost ~34,000 extra gas on every single push.
    struct Item {
        uint8 store;
        address chunk; // CODE: first data contract. Zero otherwise.
        uint32 offset; // Byte offset within a shared (packed) chunk.
        uint32 size; // Payload length.
        uint16 chunkCount; // CODE: dedicated chunks spanned. 1 when packed or single.
    }

    struct Pointer {
        bytes32 hash; // sha256 of the payload; lets readers verify what a gateway returns.
        uint64 size;
        uint8 codec; // 0 = ipfs CID bytes. Reserved so Arweave/HTTPS need no redeploy.
        bytes locator;
    }

    /// @dev 64 + 64 + 32 + 32 = 192 bits: one slot. `length` is deliberately not stored —
    ///      it is `_items[id].length`, so pushes don't pay to maintain a duplicate counter.
    struct Vector {
        uint64 binaryLength;
        uint64 firstAvailableIndex;
        uint32 flags;
        uint32 madeWithVersion;
    }

    struct Staging {
        uint256 vectorId;
        address opener;
        uint32 totalSize;
        uint32 received;
    }

    // ---------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------

    mapping(uint256 id => Vector) internal _vectors;

    /// @dev A dynamic array per vector, not a nested mapping: array elements occupy
    ///      consecutive slots, so under Monad's MIP-8 page model (128 slots per 4 KB page)
    ///      128 consecutive items share a single cold page charge. A nested mapping would
    ///      scatter them across keccak-derived slots and pay cold access for every one.
    mapping(uint256 id => Item[]) internal _items;

    mapping(uint256 id => bytes) internal _vectorMeta;
    mapping(uint256 id => bytes) internal _encKeyWrapped;
    mapping(uint256 id => mapping(uint256 index => bytes)) internal _itemMeta;
    mapping(uint256 id => mapping(uint256 index => bytes)) internal _slotData;
    mapping(uint256 id => mapping(uint256 index => Pointer)) internal _pointers;
    /// @dev Chunks 1..n-1 of a multi-chunk item; chunk 0 lives in `Item.chunk`.
    mapping(uint256 id => mapping(uint256 index => address[])) internal _extraChunks;

    /// @dev Write permission kept separate from ERC-721 transfer approval on purpose.
    ///      Reusing `approve`/`setApprovalForAll` would mean granting a marketplace the
    ///      right to sell a vector also grants it the right to append to it — and
    ///      `setApprovalForAll` would hand that over for every vector the user owns.
    mapping(uint256 id => mapping(address writer => bool)) internal _writerApproval;

    mapping(uint256 stagingId => Staging) internal _staging;
    mapping(uint256 stagingId => address[]) internal _stagingChunks;
    mapping(uint256 stagingId => bytes) internal _stagingMeta;
    uint256 internal _nextStagingId = 1;

    uint256 public feePerByte;
    address public feeRecipient;
    uint256 public feesAccrued;

    /// @notice Optional paid-upload gateway (see `IMnemonadUploadGateway`). Zero disables the
    ///         hook entirely, leaving `pushExternal` behaving exactly as it does without one.
    address public uploadGateway;

    // ---------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------

    event VectorCreated(uint256 indexed id, address indexed owner, uint32 version);
    event ItemCommitted(uint256 indexed id, uint256 indexed index, Store store, uint32 size);
    event Truncated(uint256 indexed id, uint64 firstAvailableIndex);
    event Concatenated(uint256 indexed dstId, uint256 indexed srcId, uint64 itemsMoved);
    event EncKeySet(uint256 indexed id);
    event WriterApproval(uint256 indexed id, address indexed writer, bool approved);
    event FeePerByteSet(uint256 feePerByte);
    event FeeRecipientSet(address feeRecipient);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event ItemStaged(uint256 indexed stagingId, uint256 indexed id, uint32 totalSize);
    event UploadGatewaySet(address uploadGateway);
    event ExternalFeePrepaid(uint256 indexed id, uint256 indexed index, address indexed payer);

    // ---------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------

    error VectorExists(uint256 id);
    error NoSuchVector(uint256 id);
    error NotAuthorized(uint256 id, address caller);
    error LengthMismatch(uint64 expected, uint64 actual);
    error IndexOutOfBounds(uint256 id, uint256 index);
    error IndexTruncated(uint256 id, uint256 index);
    error ChunkTooLarge(uint256 size, uint256 max);
    error EmptyPayload();
    error WrongStore(Store expected, Store actual);
    error InsufficientFee(uint256 required, uint256 provided);
    error RefundFailed();
    error FeeAboveMax(uint256 requested, uint256 max);
    error EncKeyNotSet(uint256 id);
    error EncryptedVectorNotTransferable(uint256 id);
    error CannotConcatSelf();
    error CannotConcatTruncated(uint256 id);
    error CannotConcatEncrypted(uint256 id);
    error BadStaging(uint256 stagingId);
    error StagingSizeMismatch(uint32 expected, uint32 received);
    error BadChunkCeiling(uint256 requested, uint256 max);
    error NoFeeRecipient();
    error RangeOutOfBounds(uint256 start, uint256 len, uint256 size);

    // ---------------------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------------------

    constructor(uint256 maxChunkBytes_, address feeRecipient_)
        ERC721("Mnemonad", "MNEM")
        Ownable(msg.sender)
    {
        if (maxChunkBytes_ == 0 || maxChunkBytes_ > MAX_CHUNK_BYTES_CEILING) {
            revert BadChunkCeiling(maxChunkBytes_, MAX_CHUNK_BYTES_CEILING);
        }
        maxChunkBytes = maxChunkBytes_;
        externalFeeBytes = maxChunkBytes_ / 4;
        feeRecipient = feeRecipient_;
        // feePerByte intentionally starts at 0: the fee mechanism ships dormant.
    }

    // ---------------------------------------------------------------------------------
    // Authorization
    // ---------------------------------------------------------------------------------

    function _requireExists(uint256 id) internal view {
        if (_ownerOf(id) == address(0)) revert NoSuchVector(id);
    }

    function canWrite(uint256 id, address who) public view returns (bool) {
        return _ownerOf(id) == who || _writerApproval[id][who];
    }

    function _requireCanWrite(uint256 id) internal view {
        _requireExists(id);
        if (!canWrite(id, msg.sender)) revert NotAuthorized(id, msg.sender);
    }

    function _requireOwner(uint256 id) internal view {
        _requireExists(id);
        if (_ownerOf(id) != msg.sender) revert NotAuthorized(id, msg.sender);
    }

    /// @notice Grants or revokes append rights, independently of transfer approval.
    function setWriterApproval(uint256 id, address writer, bool approved) external {
        _requireOwner(id);
        _writerApproval[id][writer] = approved;
        emit WriterApproval(id, writer, approved);
    }

    // ---------------------------------------------------------------------------------
    // Creation
    // ---------------------------------------------------------------------------------

    /// @notice The id a given creator/salt pair will produce.
    /// @dev Deterministic and computable off-chain with no RPC round-trip. That is what
    ///      lets an encrypted vector be created in ONE transaction: the SDK derives the id,
    ///      wraps the AES key scoped to it, and creates + keys + pushes together — no
    ///      round trip needed first to learn what id a create call would produce.
    function vectorIdFor(address creator, bytes32 salt) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(creator, salt)));
    }

    /// @notice Creates a vector, optionally keyed for encryption and pre-loaded with items.
    /// @param items Initial items. More than one is packed into a single shared chunk.
    function create(
        bytes32 salt,
        bytes calldata vectorMeta_,
        bytes calldata encKeyWrapped_,
        bytes[] calldata items
    ) external payable nonReentrant returns (uint256 id) {
        id = vectorIdFor(msg.sender, salt);
        // `madeWithVersion` outlives a burn, so this also rejects re-creating a burned id.
        if (_ownerOf(id) != address(0) || _vectors[id].madeWithVersion != 0) {
            revert VectorExists(id);
        }

        _mint(msg.sender, id);
        _vectors[id] = Vector({
            binaryLength: 0,
            firstAvailableIndex: 0,
            flags: 0,
            madeWithVersion: CONTRACT_VERSION
        });

        if (vectorMeta_.length != 0) _vectorMeta[id] = vectorMeta_;
        if (encKeyWrapped_.length != 0) {
            _encKeyWrapped[id] = encKeyWrapped_;
            emit EncKeySet(id);
        }

        emit VectorCreated(id, msg.sender, CONTRACT_VERSION);

        uint256 fee = _appendItems(id, items);
        _settleFee(fee);
    }

    // ---------------------------------------------------------------------------------
    // Writing
    // ---------------------------------------------------------------------------------

    /// @notice Appends one item.
    /// @param expectedLength Current length the caller believes the vector has; pass
    ///        `type(uint64).max` to skip the check. This matters more on Monad than on most
    ///        chains: Monad charges the gas *limit*, so a push duplicated by a timeout-retry
    ///        costs full price rather than a wasted round trip.
    function push(uint256 id, uint64 expectedLength, bytes calldata data, bytes calldata itemMeta_)
        external
        payable
        nonReentrant
        returns (uint256 index)
    {
        _requireCanWrite(id);
        _checkLength(id, expectedLength);
        if (data.length == 0) revert EmptyPayload();

        index = _appendOne(id, data);
        if (itemMeta_.length != 0) _itemMeta[id][index] = itemMeta_;

        _settleFee(_feeForOnchain(data.length));
    }

    /// @notice Appends many items, packing them into a single shared CODE chunk.
    /// @dev This is the only way packing can work: chunks are immutable, so an item cannot
    ///      be folded into an existing chunk after the fact, and staging small items in
    ///      storage first would cost 537 gas/byte before the 200 gas/byte deploy — worse
    ///      than not packing at all. Batching is therefore the caller's lever, and for
    ///      small items it is a large one: each separate chunk carries ~32,000 gas of
    ///      CREATE overhead.
    function pushMany(uint256 id, uint64 expectedLength, bytes[] calldata items)
        external
        payable
        nonReentrant
        returns (uint256 firstIndex)
    {
        _requireCanWrite(id);
        _checkLength(id, expectedLength);
        firstIndex = _items[id].length;

        uint256 fee = _appendItems(id, items);
        _settleFee(fee);
    }

    /// @notice Appends an off-chain item: only the pointer and hash are stored.
    function pushExternal(
        uint256 id,
        uint64 expectedLength,
        Pointer calldata pointer,
        bytes calldata itemMeta_
    ) external payable nonReentrant returns (uint256 index) {
        _requireCanWrite(id);
        _checkLength(id, expectedLength);
        if (pointer.locator.length == 0) revert EmptyPayload();

        index = _items[id].length;
        _items[id].push(
            Item({
                store: uint8(Store.EXTERNAL),
                chunk: address(0),
                offset: 0,
                // `Item.size` is uint32; a larger off-chain payload keeps its true size in
                // `Pointer.size` and reports uint32 max here as a saturating marker.
                size: pointer.size > type(uint32).max ? type(uint32).max : uint32(pointer.size),
                chunkCount: 0
            })
        );
        _pointers[id][index] = pointer;
        if (itemMeta_.length != 0) _itemMeta[id][index] = itemMeta_;

        _vectors[id].binaryLength += pointer.size;
        emit ItemCommitted(id, index, Store.EXTERNAL, uint32(pointer.size));

        // Flat fee: an EXTERNAL item costs the protocol ~36 bytes of state whether the
        // payload is 200 KB or 1 GB, so charging per payload byte would be nonsense.
        uint256 fee = feePerByte * externalFeeBytes;

        // If a gateway is configured and the caller prepaid for exactly this content, that
        // escrow settles here and covers the fee. `pointer.hash` is what binds the two: the
        // payer committed to it before uploading, and it is already in the Pointer being
        // stored, so settlement needs no extra argument, no second transaction, and no
        // separate consumed-ledger on this side.
        address gateway = uploadGateway;
        if (gateway != address(0)) {
            // try/catch, not a bare call: the fee path must survive a gateway that reverts.
            // A broken or hostile gateway then merely fails to discount, instead of bricking
            // every EXTERNAL push in the registry. `nonReentrant` covers the callback risk.
            try IMnemonadUploadGateway(gateway).consumeUpload(msg.sender, pointer.hash, pointer.size) returns (
                bool prepaid
            ) {
                if (prepaid) {
                    fee = 0;
                    emit ExternalFeePrepaid(id, index, msg.sender);
                }
            } catch {
                // Fall through and charge normally.
            }
        }

        _settleFee(fee);
    }

    // ---------------------------------------------------------------------------------
    // Staged append — items larger than one transaction can carry
    // ---------------------------------------------------------------------------------

    /// @notice Opens a staged item. The item stays invisible to `at()` until `commitItem`,
    ///         so readers never observe a partial item.
    function beginItem(uint256 id, uint32 totalSize, bytes calldata itemMeta_)
        external
        returns (uint256 stagingId)
    {
        _requireCanWrite(id);
        if (totalSize == 0) revert EmptyPayload();

        stagingId = _nextStagingId++;
        _staging[stagingId] =
            Staging({vectorId: id, opener: msg.sender, totalSize: totalSize, received: 0});
        if (itemMeta_.length != 0) _stagingMeta[stagingId] = itemMeta_;

        emit ItemStaged(stagingId, id, totalSize);
    }

    /// @notice Appends one chunk of a staged item.
    /// @param offset Byte offset this chunk starts at. Checked against bytes already
    ///        received, which makes a retry after a timeout safely idempotent rather than
    ///        silently duplicating data.
    function appendChunk(uint256 stagingId, uint32 offset, bytes calldata data)
        external
        payable
        nonReentrant
    {
        Staging storage st = _staging[stagingId];
        if (st.vectorId == 0 || st.opener != msg.sender) revert BadStaging(stagingId);
        if (offset != st.received) revert StagingSizeMismatch(st.received, offset);
        if (data.length == 0) revert EmptyPayload();
        if (data.length > maxChunkBytes) revert ChunkTooLarge(data.length, maxChunkBytes);
        if (st.received + data.length > st.totalSize) {
            revert StagingSizeMismatch(st.totalSize, uint32(st.received + data.length));
        }

        _stagingChunks[stagingId].push(DataChunk.write(data));
        st.received += uint32(data.length);

        _settleFee(_feeForOnchain(data.length));
    }

    /// @notice Finalises a staged item, making it visible at the vector's next index.
    function commitItem(uint256 stagingId) external returns (uint256 index) {
        Staging storage st = _staging[stagingId];
        if (st.vectorId == 0 || st.opener != msg.sender) revert BadStaging(stagingId);
        if (st.received != st.totalSize) revert StagingSizeMismatch(st.totalSize, st.received);

        uint256 id = st.vectorId;
        address[] storage chunks = _stagingChunks[stagingId];
        uint256 n = chunks.length;

        index = _items[id].length;
        _items[id].push(
            Item({
                store: uint8(Store.CODE),
                chunk: chunks[0],
                offset: 0,
                size: st.totalSize,
                chunkCount: uint16(n)
            })
        );
        for (uint256 i = 1; i < n; ++i) {
            _extraChunks[id][index].push(chunks[i]);
        }

        bytes memory meta = _stagingMeta[stagingId];
        if (meta.length != 0) _itemMeta[id][index] = meta;

        _vectors[id].binaryLength += st.totalSize;
        emit ItemCommitted(id, index, Store.CODE, st.totalSize);

        delete _staging[stagingId];
        delete _stagingChunks[stagingId];
        delete _stagingMeta[stagingId];
    }

    /// @notice Abandons a staged item. Already-deployed chunks are unreachable but, being
    ///         contract code, cannot be reclaimed — no refund is possible.
    function abortItem(uint256 stagingId) external {
        Staging storage st = _staging[stagingId];
        if (st.vectorId == 0 || st.opener != msg.sender) revert BadStaging(stagingId);
        delete _staging[stagingId];
        delete _stagingChunks[stagingId];
        delete _stagingMeta[stagingId];
    }

    // ---------------------------------------------------------------------------------
    // Reading
    // ---------------------------------------------------------------------------------

    function length(uint256 id) public view returns (uint64) {
        _requireExists(id);
        return uint64(_items[id].length);
    }

    function binaryLength(uint256 id) external view returns (uint64) {
        _requireExists(id);
        return _vectors[id].binaryLength;
    }

    function firstAvailableIndex(uint256 id) external view returns (uint64) {
        _requireExists(id);
        return _vectors[id].firstAvailableIndex;
    }

    function vectorMeta(uint256 id) external view returns (bytes memory) {
        _requireExists(id);
        return _vectorMeta[id];
    }

    function itemMeta(uint256 id, uint256 index) external view returns (bytes memory) {
        _requireItem(id, index);
        return _itemMeta[id][index];
    }

    function encKeyWrapped(uint256 id) external view returns (bytes memory) {
        _requireExists(id);
        return _encKeyWrapped[id];
    }

    function isEncrypted(uint256 id) public view returns (bool) {
        return _encKeyWrapped[id].length != 0;
    }

    function itemStore(uint256 id, uint256 index) external view returns (Store) {
        _requireItem(id, index);
        return Store(_items[id][index].store);
    }

    function itemSize(uint256 id, uint256 index) external view returns (uint32) {
        _requireItem(id, index);
        return _items[id][index].size;
    }

    /// @notice Reads the payload at `index`. EXTERNAL items have no on-chain payload, so
    ///         read their pointer via `pointerAt` instead.
    function at(uint256 id, uint256 index) external view returns (bytes memory) {
        _requireItem(id, index);
        Item storage it = _items[id][index];
        Store s = Store(it.store);

        if (s == Store.SLOT) return _slotData[id][index];
        if (s == Store.EXTERNAL) revert WrongStore(Store.CODE, Store.EXTERNAL);

        uint16 n = it.chunkCount;
        if (n <= 1) {
            // Single chunk: either the item owns it outright or it is packed alongside
            // others, in which case `offset`/`size` carve out this item's slice.
            return DataChunk.readRange(it.chunk, it.offset, it.size);
        }

        // One allocation of exactly `size`, then copy each chunk straight in. Concatenating
        // chunk by chunk would be quadratic in memory and would blow Monad's 8 MB
        // per-transaction cap on precisely the large items this path exists to serve.
        bytes memory out = new bytes(it.size);
        uint256 cursor = DataChunk.copyInto(it.chunk, out, 0);
        address[] storage extra = _extraChunks[id][index];
        for (uint256 i = 0; i < extra.length; ++i) {
            cursor += DataChunk.copyInto(extra[i], out, cursor);
        }
        return out;
    }

    /// @notice Reads `len` payload bytes of item `index`, starting at `start`.
    ///
    /// The paging companion to `at()`, and not an optional nicety. `at()` allocates the
    /// whole item and the ABI return copies it, so it needs roughly 2× the item size in
    /// memory — against Monad's 8 MB per-transaction cap that puts a hard ceiling near
    /// 3–4 MB. Without a ranged read, an item larger than that would be writable but
    /// permanently unreadable. This lets a caller page through any size.
    ///
    /// @dev On an encrypted vector the returned slice is ciphertext and cannot be decrypted
    ///      on its own: AES-GCM needs the complete ciphertext to verify its tag. Callers
    ///      must reassemble every page before decrypting, which is what the SDK does.
    function readRange(uint256 id, uint256 index, uint256 start, uint256 len)
        external
        view
        returns (bytes memory)
    {
        _requireItem(id, index);
        Item storage it = _items[id][index];
        Store s = Store(it.store);

        if (s == Store.EXTERNAL) revert WrongStore(Store.CODE, Store.EXTERNAL);
        if (start + len > it.size) revert RangeOutOfBounds(start, len, it.size);

        if (s == Store.SLOT) {
            bytes memory whole = _slotData[id][index];
            bytes memory slot = new bytes(len);
            for (uint256 i = 0; i < len; ++i) {
                slot[i] = whole[start + i];
            }
            return slot;
        }

        // Single chunk, whether the item owns it or is packed inside it: `offset` locates
        // the item, `start` locates the slice within the item.
        if (it.chunkCount <= 1) {
            return DataChunk.readRange(it.chunk, uint256(it.offset) + start, len);
        }

        // Multi-chunk: walk the chunk list, skipping whole chunks that fall before `start`,
        // then copying the overlapping portion of each until `len` is satisfied.
        bytes memory out = new bytes(len);
        address[] storage extra = _extraChunks[id][index];
        uint256 chunkTotal = 1 + extra.length;
        uint256 cursor = start; // bytes still to skip within the current chunk
        uint256 remaining = len;
        uint256 outPos;

        for (uint256 i = 0; i < chunkTotal && remaining > 0; ++i) {
            address ptr = i == 0 ? it.chunk : extra[i - 1];
            uint256 chunkSize = DataChunk.sizeOf(ptr);

            if (cursor >= chunkSize) {
                cursor -= chunkSize;
                continue;
            }

            uint256 take = chunkSize - cursor;
            if (take > remaining) take = remaining;

            DataChunk.copyRangeInto(ptr, cursor, take, out, outPos);
            outPos += take;
            remaining -= take;
            cursor = 0;
        }

        return out;
    }

    function pointerAt(uint256 id, uint256 index) external view returns (Pointer memory) {
        _requireItem(id, index);
        Item storage it = _items[id][index];
        if (Store(it.store) != Store.EXTERNAL) revert WrongStore(Store.EXTERNAL, Store(it.store));
        return _pointers[id][index];
    }

    /// @notice The physical layout of an item, without reading its payload.
    /// @dev Required for migration: because this contract is immutable, the upgrade path is
    ///      a successor registry that ADOPTS existing CODE chunks by address — no bytes
    ///      copied, nothing redeployed. Without a cheap ref-read API, migrating would mean
    ///      re-uploading every byte.
    function getItemRefs(uint256 id, uint256 index)
        external
        view
        returns (Store store, address[] memory chunks, uint32 offset, uint32 size, bytes memory meta)
    {
        _requireItem(id, index);
        Item storage it = _items[id][index];
        store = Store(it.store);
        offset = it.offset;
        size = it.size;
        meta = _itemMeta[id][index];

        if (store == Store.CODE) {
            address[] storage extra = _extraChunks[id][index];
            chunks = new address[](1 + extra.length);
            chunks[0] = it.chunk;
            for (uint256 i = 0; i < extra.length; ++i) {
                chunks[i + 1] = extra[i];
            }
        } else {
            chunks = new address[](0);
        }
    }

    // ---------------------------------------------------------------------------------
    // Concat / truncate / burn
    // ---------------------------------------------------------------------------------

    /// @notice Appends every item of `srcId` onto `dstId` and burns the source.
    /// @dev Re-links item records rather than copying payloads: cost scales with the source's
    ///      ITEM COUNT, not its byte length. Copying bytes instead would run at 537 gas/byte
    ///      and be unusable at any real size — this is the property that makes a single
    ///      shared registry the right structure.
    function concat(uint256 dstId, uint256 srcId, uint64 expectedLength) external nonReentrant {
        if (dstId == srcId) revert CannotConcatSelf();
        _requireCanWrite(dstId);
        _requireOwner(srcId);
        _checkLength(dstId, expectedLength);

        // Truncated sources would need index remapping; encrypted vectors are keyed
        // independently, so their items cannot be merged under one key.
        if (_vectors[srcId].firstAvailableIndex != 0) revert CannotConcatTruncated(srcId);
        if (isEncrypted(dstId)) revert CannotConcatEncrypted(dstId);
        if (isEncrypted(srcId)) revert CannotConcatEncrypted(srcId);

        Item[] storage src = _items[srcId];
        Item[] storage dst = _items[dstId];
        uint256 n = src.length;
        uint256 base = dst.length;

        for (uint256 i = 0; i < n; ++i) {
            dst.push(src[i]);
            uint256 newIndex = base + i;

            Store s = Store(src[i].store);
            if (s == Store.SLOT) {
                _slotData[dstId][newIndex] = _slotData[srcId][i];
            } else if (s == Store.EXTERNAL) {
                _pointers[dstId][newIndex] = _pointers[srcId][i];
            } else {
                address[] storage extra = _extraChunks[srcId][i];
                for (uint256 j = 0; j < extra.length; ++j) {
                    _extraChunks[dstId][newIndex].push(extra[j]);
                }
            }

            bytes memory m = _itemMeta[srcId][i];
            if (m.length != 0) _itemMeta[dstId][newIndex] = m;
        }

        _vectors[dstId].binaryLength += _vectors[srcId].binaryLength;
        emit Concatenated(dstId, srcId, uint64(n));

        _burnVector(srcId);
    }

    /// @notice Logically drops every item below `uptoIndex`.
    /// @dev Reclaims essentially nothing. EVM SSTORE-to-zero refunds cap at 20% of gas
    ///      *used*, Monad charges the gas *limit*, and CODE chunks cannot be deleted at
    ///      all. Treat this as state hygiene and access revocation, not as a way to get
    ///      money back.
    function truncateFrom(uint256 id, uint64 uptoIndex) external {
        _requireOwner(id);
        uint64 len = uint64(_items[id].length);
        if (uptoIndex > len) revert IndexOutOfBounds(id, uptoIndex);

        Vector storage v = _vectors[id];
        uint64 from = v.firstAvailableIndex;
        if (uptoIndex <= from) return;

        for (uint64 i = from; i < uptoIndex; ++i) {
            if (Store(_items[id][i].store) == Store.SLOT) delete _slotData[id][i];
            delete _items[id][i];
        }
        v.firstAvailableIndex = uptoIndex;
        emit Truncated(id, uptoIndex);
    }

    /// @notice Destroys a vector's record and the ERC-721 token. CODE chunks survive.
    function burn(uint256 id) external {
        _requireOwner(id);
        _burnVector(id);
    }

    function _burnVector(uint256 id) internal {
        Vector storage v = _vectors[id];
        v.binaryLength = 0;
        v.firstAvailableIndex = 0;
        v.flags = 0;
        // `madeWithVersion` is deliberately retained, and `_items[id]` deliberately NOT
        // cleared. Two reasons:
        //   1. Ids are deterministic, so without a permanent "this id was used" marker a
        //      burn followed by a re-create with the same salt would inherit the old item
        //      records — silent data resurrection.
        //   2. `delete` on a storage array clears every element, so clearing a large
        //      vector's items would be an unbounded gas cost and could simply run out.
        // The orphaned item records stay unreachable: every read goes through
        // `_requireExists`, which fails once the token is burned.
        delete _vectorMeta[id];
        delete _encKeyWrapped[id];
        _burn(id);
    }

    // ---------------------------------------------------------------------------------
    // Encryption key
    // ---------------------------------------------------------------------------------

    /// @notice Sets or replaces the wrapped encryption key.
    /// @dev Owner-may-rewrap rather than write-once: strictly more useful and no less safe
    ///      — only the owner can call it, and a bad value harms only them. It is also the
    ///      prerequisite for ever handing an encrypted vector to a new owner, since a
    ///      self-wrapped key is bound to whoever wrapped it.
    function setEncKeyWrapped(uint256 id, bytes calldata wrapped) external {
        _requireOwner(id);
        _encKeyWrapped[id] = wrapped;
        emit EncKeySet(id);
    }

    /// @dev Blocks transfer of encrypted vectors. A self-wrapped key is derived from the
    ///      owner's own signature, so transferring would hand the recipient bytes they can
    ///      never decrypt. Mint and burn stay permitted. The propose/accept rewrap-and-
    ///      transfer flow is the intended way to lift this, and must exist before mainnet.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0) && isEncrypted(tokenId)) {
            revert EncryptedVectorNotTransferable(tokenId);
        }
        return super._update(to, tokenId, auth);
    }

    // ---------------------------------------------------------------------------------
    // Fees
    // ---------------------------------------------------------------------------------

    /// @notice Fee for appending an item of `size` bytes into `store`.
    function quotePushFee(uint256 size, Store store) public view returns (uint256) {
        if (store == Store.EXTERNAL) return feePerByte * externalFeeBytes;
        return feePerByte * size;
    }

    function _feeForOnchain(uint256 size) internal view returns (uint256) {
        return feePerByte * size;
    }

    function setFeePerByte(uint256 newFeePerByte) external onlyOwner {
        if (newFeePerByte > MAX_FEE_PER_BYTE) {
            revert FeeAboveMax(newFeePerByte, MAX_FEE_PER_BYTE);
        }
        feePerByte = newFeePerByte;
        emit FeePerByteSet(newFeePerByte);
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        feeRecipient = newRecipient;
        emit FeeRecipientSet(newRecipient);
    }

    /// @notice Points EXTERNAL pushes at a paid-upload gateway, or clears it with the zero
    ///         address. Settable rather than immutable so the pricing/provider half stays
    ///         replaceable — the registry is immutable, its gateway should not be.
    function setUploadGateway(address newGateway) external onlyOwner {
        uploadGateway = newGateway;
        emit UploadGatewaySet(newGateway);
    }

    /// @dev Pull, not push. Transferring fees on every write would let a reverting or
    ///      gas-hungry recipient brick all pushes.
    function withdrawFees() external {
        address to = feeRecipient;
        if (to == address(0)) revert NoFeeRecipient();
        uint256 amount = feesAccrued;
        feesAccrued = 0;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert RefundFailed();
        emit FeesWithdrawn(to, amount);
    }

    /// @dev Accrues `required` and returns any excess. Excess is refunded rather than
    ///      demanding exact payment, so a fee change landing between an SDK's quote and its
    ///      broadcast doesn't fail the transaction. Called last in every entrypoint, and
    ///      those entrypoints are `nonReentrant`.
    function _settleFee(uint256 required) internal {
        if (msg.value < required) revert InsufficientFee(required, msg.value);
        if (required != 0) feesAccrued += required;

        uint256 refund = msg.value - required;
        if (refund != 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
    }

    // ---------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------

    function _checkLength(uint256 id, uint64 expectedLength) internal view {
        if (expectedLength == type(uint64).max) return;
        uint64 actual = uint64(_items[id].length);
        if (expectedLength != actual) revert LengthMismatch(expectedLength, actual);
    }

    function _requireItem(uint256 id, uint256 index) internal view {
        _requireExists(id);
        if (index >= _items[id].length) revert IndexOutOfBounds(id, index);
        if (index < _vectors[id].firstAvailableIndex) revert IndexTruncated(id, index);
    }

    /// @dev Routes one item to its tier and appends it. Returns nothing; callers handle fees.
    function _appendOne(uint256 id, bytes calldata data) internal returns (uint256 index) {
        index = _items[id].length;

        if (data.length <= SLOT_MAX_BYTES) {
            _items[id].push(
                Item({
                    store: uint8(Store.SLOT),
                    chunk: address(0),
                    offset: 0,
                    size: uint32(data.length),
                    chunkCount: 0
                })
            );
            _slotData[id][index] = data;
            emit ItemCommitted(id, index, Store.SLOT, uint32(data.length));
        } else {
            if (data.length > maxChunkBytes) revert ChunkTooLarge(data.length, maxChunkBytes);
            address ptr = DataChunk.write(data);
            _items[id].push(
                Item({
                    store: uint8(Store.CODE),
                    chunk: ptr,
                    offset: 0,
                    size: uint32(data.length),
                    chunkCount: 1
                })
            );
            emit ItemCommitted(id, index, Store.CODE, uint32(data.length));
        }

        _vectors[id].binaryLength += uint64(data.length);
    }

    /// @dev Appends a batch. A batch of two or more that fits in one chunk is PACKED: the
    ///      payloads are concatenated, deployed once, and each item points at its slice.
    ///      That saves the ~32,000 gas CREATE overhead per item, which dominates cost for
    ///      anything under a few KB.
    function _appendItems(uint256 id, bytes[] calldata items) internal returns (uint256 fee) {
        uint256 n = items.length;
        if (n == 0) return 0;

        uint256 total;
        for (uint256 i = 0; i < n; ++i) {
            if (items[i].length == 0) revert EmptyPayload();
            total += items[i].length;
        }
        fee = _feeForOnchain(total);

        if (n == 1) {
            _appendOne(id, items[0]);
            return fee;
        }

        if (total > maxChunkBytes) {
            // Too big to pack into one chunk; fall back to an individual chunk per item.
            // A caller wanting fewer chunks should split the batch itself.
            for (uint256 i = 0; i < n; ++i) {
                _appendOne(id, items[i]);
            }
            return fee;
        }

        bytes memory packed = new bytes(total);
        uint256 cursor;
        for (uint256 i = 0; i < n; ++i) {
            bytes calldata src = items[i];
            uint256 len = src.length;
            // calldatacopy rather than a per-byte Solidity loop: packing a 24 KB batch
            // byte-by-byte would burn several hundred thousand gas on bounds checks alone.
            assembly ("memory-safe") {
                calldatacopy(add(add(packed, 0x20), cursor), src.offset, len)
            }
            cursor += len;
        }

        address ptr = DataChunk.write(packed);

        uint256 base = _items[id].length;
        uint256 offset;
        for (uint256 i = 0; i < n; ++i) {
            uint32 sz = uint32(items[i].length);
            _items[id].push(
                Item({
                    store: uint8(Store.CODE),
                    chunk: ptr,
                    offset: uint32(offset),
                    size: sz,
                    chunkCount: 1
                })
            );
            emit ItemCommitted(id, base + i, Store.CODE, sz);
            offset += sz;
        }

        _vectors[id].binaryLength += uint64(total);
    }
}
