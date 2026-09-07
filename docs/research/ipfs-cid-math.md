# IPFS CID math — can we compute it off-chain?

Question this answers: can a client know the IPFS CID of a payload **before** uploading
it, so an upload flow could commit to a pointer without waiting on the pinning
service's response? Motivated by the [paid-upload flow](../../README.md#paid-off-chain-uploads)
currently taking three separate wallet prompts to offload one item and push it — see
[Reducing the prompt count](#reducing-the-prompt-count) below for why a predictable
CID is the piece that would let two of those three collapse into one.

**Status: proven for small payloads, unverified above ~256 KB.**

## The proof

Pulled the pointer for a real item pushed during local-signer testing (124 KB
payload, offloaded through the presign-server flow to Pinata):

```
pointer.hash:    0xaa20bd7f491bc145fefe5108e37b672d3a0e5cbe44bb9c9560688a3dbb39ff78  (sha256, computed off-chain by offloadCommitment())
pointer.locator: bafkreifkec6x6si3yfc757srbdrxwzznhihfzpsexoojkydiri63wop7pa        (CID, read back from Pinata's response)
```

Decoded the CID by hand — strip the multibase prefix (`b` = base32), base32-decode,
and read the multiformat header:

```
01 55 12 20 aa20bd7f491bc145fefe5108e37b672d3a0e5cbe44bb9c9560688a3dbb39ff78
│  │  │  │  └─ digest (32 bytes)
│  │  │  └──── digest length = 32
│  │  └─────── hash function = 0x12 (sha2-256)
│  └────────── codec = 0x55 (raw)
└───────────── CID version = 1
```

**The digest is byte-for-byte identical to `pointer.hash`.** For this payload,
Pinata's CID is nothing but `sha256(bytes)` wrapped in a fixed 4-byte header and
base32-encoded. That sha256 is already computed off-chain today — it's
`offloadCommitment()`'s output, the same value `payForUpload` escrows against. No
network call, no guessing, for this size class.

### Reproducing the decode

```js
const cid = 'bafkreifkec6x6si3yfc757srbdrxwzznhihfzpsexoojkydiri63wop7pa';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'; // RFC4648 base32, lowercase, no padding

function base32Decode(str) {
	let bits = '';
	for (const c of str.toLowerCase()) {
		bits += ALPHABET.indexOf(c).toString(2).padStart(5, '0');
	}
	const bytes = [];
	for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
	return Buffer.from(bytes);
}

const raw = base32Decode(cid.slice(1)); // drop the 'b' multibase prefix
// raw = [version, codec, hashFnCode, digestLen, ...digest]
```

## The formula (raw-block case)

```js
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import * as raw from 'multiformats/codecs/raw';

const digest = await sha256.digest(data);   // same bytes offloadCommitment() already hashes
const cid = CID.createV1(raw.code, digest); // codec 0x55
cid.toString();                             // "bafkrei..." — matched Pinata's response exactly
```

`multiformats` isn't a dependency anywhere in this repo yet (checked `js/` and
`explorer/` — not present). It's pure JS, no network access needed, works in the
browser or Node either way.

## The catch — this only holds below some size

The formula above only works because Pinata stored this payload as **one raw IPFS
block**. IPFS's standard chunker splits anything above **256 KiB** (the default
`ipfs add` chunk size) into a UnixFS DAG — multiple blocks wrapped in a `dag-pb` node
— producing a completely different CID (`bafybei...` prefix, not `bafkrei...`),
computed from a Merkle tree over the chunks rather than a plain hash of the bytes.
Reproducing *that* off-chain means replicating Pinata's exact chunk size, raw-leaves
setting, and DAG layout — doable with `ipfs-unixfs-importer` + `@ipld/dag-pb` (still
zero network calls), but real complexity, and nothing here has tested it.

**Only the raw-block case (124 KB, one sample) is verified.** Not confirmed:

- Where Pinata's own behavior actually switches from raw-block to DAG-wrapped —
  might not be exactly IPFS's 256 KiB default, since Pinata's v3 Files API may not
  route through the standard `ipfs add` chunker at all.
- Whether that threshold is stable across Pinata API versions, or something they
  could change without notice.

This matters concretely for Mnemonad: the EXTERNAL tier only activates above
`maxChunkBytes` (~120 KB on Monad), so realistic offloaded payloads sit right around
this exact 120–256 KB boundary — the size range where the answer is least certain.

## Reducing the prompt count

Context for why this was worth investigating: today, offloading one item to IPFS and
adding it to a vector takes three separate wallet prompts, strictly serialized:

```
1. offloadCommitment(data)        → local, sha256(data)                    no prompt
2. payForUpload(hash, maxSize)    → escrow on-chain                        TX #1
3. signTypedData(hash, size)      → prove "I'm the payer" to the server    SIGN #2
4. POST bytes → Pinata            → returns the real CID                  (HTTP, no prompt)
5. pushExternal(Pointer{...CID})  → commit pointer, settle escrow          TX #3
```

Step 5 is what forces the wait: it needs the *actual* CID as calldata, and today
that only exists after step 4 finishes. Everything downstream of `payForUpload` is
serialized behind the upload round-trip.

If the CID is known upfront (per [the proof above](#the-proof), for payloads in the
verified size class), steps 2 and 5 no longer have anything to wait on — the pointer
for `pushExternal` is fully known the moment `offloadCommitment` runs, before any
network call to Pinata happens at all. That unlocks two different levels of
simplification, and they are not the same thing.

### Level 1 — fire both transactions immediately, no contract change

`payForUpload` and `pushExternal` still have to be two separate calls (different
contracts), but neither has to *wait* for the upload anymore. Submit them back to
back, and let the actual Pinata upload happen against the now-known CID. The
presign server's authorization can also change: instead of a *signature* proving
"I'm the payer," it can check on-chain whether a commitment already exists for this
exact `(hash, CID)` pair — public once the second transaction lands. **That drops
the signature step: 3 prompts → 2.**

### Level 2 — merge pay and commit into one call

Requires an actual new contract method — something like `payAndPushExternal`,
escrowing and consuming in one atomic transaction — instead of two separate ones.
**That's 3 prompts → 1.**

### What doesn't go away

Two things worth being honest about before either level looks like a clean win:

- **Removing the signature isn't free.** It isn't just proving identity for its own
  sake — it stops someone who sees your `payForUpload` transaction in the mempool
  (the contentHash is public) from immediately burning your upload-URL issuance
  quota before you get to it (`MAX_ISSUES_PER_REQUEST` in `presign-server/`).
  Dropping the signature needs *some* replacement griefing protection, not just a
  deletion — e.g. rate-limiting issuance per `(hash, requester IP)` instead of per
  signed identity, or a short exclusivity window after the commit tx before anyone
  else's request is even entertained.
- **This is riskier specifically because Mnemonad is append-only.** Today, if the
  upload fails, nothing gets committed — retry, or the escrow becomes refundable
  after expiry. Once `pushExternal` fires *before* the upload is confirmed, a
  failed background upload leaves a **permanent** item in the vector pointing at a
  CID that was never actually pinned — and there's no fixing that item afterward,
  only `truncateFrom`, which destroys everything pushed after it too. That's a
  materially worse failure mode than what exists now, and it's the reason neither
  level is implemented or proposed here as-is.

### Recommendation

Level 1 is the one worth actually pursuing, and it can keep today's safety property
if implemented carefully: predictable CID mainly buys "commit immediately once the
upload confirms" rather than "commit before uploading at all" — i.e. still wait for
Pinata to answer before calling `pushExternal`, just don't need the intermediate
signature to get there, since the client already knows the pointer it's going to
commit and can request the upload URL by presenting that on-chain-provable escrow
directly. The net win is one fewer wallet prompt with no change to the correctness
guarantee.

Level 2 is a genuine architecture change — a new contract, no on-chain migration
path (see the root README's status on why redeploys can't carry existing vectors
forward), and it inherits the append-only risk above unless paired with a
reliable-upload guarantee or an "unconfirmed until verified" read-side convention.
Worth a separate design pass if it gets prioritized; this document only establishes
whether the CID math underneath either level actually holds.

## Next steps

1. Test a payload deliberately over 256 KB through the real presign-server flow to
   find where Pinata's behavior actually switches from raw to DAG-wrapped.
2. If the cutoff is stable and well above `maxChunkBytes`, the raw-block fast path
   alone might cover most real Mnemonad offloads — worth sizing that against actual
   usage before building the DAG case at all.
3. If Level 1 gets picked up: design the presign server's replacement
   griefing-protection (issuance is currently gated by a signature proving payer
   identity — needs an equivalent that doesn't depend on one) before removing the
   signature step.
