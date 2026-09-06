import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Mnemonad from '../Mnemonad.js';
import MnemonadPinataProvider from '../offloading/MnemonadPinataProvider.js';
import { startNode, makeClients, deployRegistry, makeBytes } from './fixture.js';

// Opt-in only: needs a real Pinata account, spends real (free-tier) quota, and needs
// real network access — unlike every other file here, which runs fully offline against a
// local Hardhat node and an in-memory IPFS mock. Skipped, not failed, without a token, so
// `npm test` stays deterministic by default. See js/.env (gitignored) — PINATA_JWT_TOKEN.
try {
	process.loadEnvFile();
} catch {
	// no js/.env — fine, this file just skips below.
}
const PINATA_JWT = process.env.PINATA_JWT_TOKEN;

let node;
let clients;
let contractAddress;
/** CIDs this run actually pinned, so afterAll can unpin every one — see cleanup below. */
const pinnedCids = [];

describe.skipIf(!PINATA_JWT)('real IPFS (Pinata)', () => {
	beforeAll(async () => {
		node = await startNode();
		clients = makeClients();
		contractAddress = await deployRegistry(clients);
	}, 120_000);

	afterAll(async () => {
		// Best-effort: a failed unpin (wrong scope on the key, transient API error) should
		// not fail the suite — it already asserted what it needed to. Left-behind pins are
		// a quota nuisance, not a correctness problem. Not attached to any Mnemonad — unpin()
		// only needs the JWT, so a standalone provider is enough here.
		const cleanup = new MnemonadPinataProvider({ pinningJwt: PINATA_JWT });
		await Promise.all(
			pinnedCids.map((cid) =>
				cleanup
					.unpin(cid)
					.catch((e) => console.warn(`real_ipfs test cleanup: failed to unpin ${cid} (${e.message})`))
			)
		);
		await node?.stop();
	});

	function realIpfsParams(extra = {}) {
		return {
			publicClient: clients.publicClient,
			walletClient: clients.walletClient,
			contractAddress,
			offloadingProvider: new MnemonadPinataProvider({ pinningJwt: PINATA_JWT }),
			...extra,
		};
	}

	/** Records a pin for cleanup, then returns the same locator for the test to use. */
	async function trackPin(ev, index = 0) {
		const { locator } = await ev.pointerAt(index);
		pinnedCids.push(locator);
		return locator;
	}

	it(
		'round-trips a real upload through Pinata, hash-verified',
		async () => {
			const ev = await Mnemonad.create(realIpfsParams());
			const data = makeBytes(5_000, 1);

			await ev.pushExternal(data);
			await trackPin(ev);
			const readBack = await ev.at(0);

			expect(new Uint8Array(readBack)).toEqual(data);
		},
		30_000
	);

	it(
		'serves a real ranged fetch (206), not a disguised whole-payload read',
		async () => {
			const ev = await Mnemonad.create(realIpfsParams({ allowUnverifiedRanges: true }));
			const data = makeBytes(20_000, 2);
			await ev.pushExternal(data);
			await trackPin(ev);

			const slice = await ev.readRange(0, 5_000, 1_000);
			expect(new Uint8Array(slice)).toEqual(data.subarray(5_000, 6_000));
		},
		30_000
	);

	it(
		'repin() finds the same CID Pinata already assigned',
		async () => {
			const ev = await Mnemonad.create(realIpfsParams());
			const data = makeBytes(3_000, 3);
			await ev.pushExternal(data);

			const before = await ev.pointerAt(0);
			pinnedCids.push(before.locator);
			const cidAfter = await ev.offloadingProvider.repin(0);

			// Confirms Pinata's chunking matches the assumption repin() makes — a custom
			// chunker would make this throw "produced a different CID" instead.
			expect(cidAfter).toBe(before.locator);
		},
		30_000
	);

	it(
		'verifyAvailability reports the real pinned item as available',
		async () => {
			const ev = await Mnemonad.create(realIpfsParams());
			await ev.pushExternal(makeBytes(1_000, 4));
			await trackPin(ev);

			const [report] = await ev.offloadingProvider.verifyAvailability();
			expect(report.available).toBe(true);
			expect(report.error).toBeNull();
		},
		30_000
	);

	it(
		'catches a hash mismatch on real fetched bytes, not just mocked ones',
		async () => {
			const ev = await Mnemonad.create(realIpfsParams());
			await ev.pushExternal(makeBytes(1_000, 5));

			const real = await ev.pointerAt(0);
			pinnedCids.push(real.locator);
			const tampered = { ...real, hash: `0x${'ab'.repeat(32)}` };

			// Real HTTP fetch against the real pin, deliberately checked against a hash that
			// doesn't match it — the network round trip is real, only the expectation is
			// wrong, which is exactly what a compromised or misconfigured gateway would
			// look like from the SDK's side.
			await expect(ev.offloadingProvider.readPointerBytes(tampered)).rejects.toThrow(/hash mismatch/);
		},
		30_000
	);

	it(
		'ev.offloadingProvider is the exact MnemonadPinataProvider instance passed in',
		async () => {
			const provider = new MnemonadPinataProvider({ pinningJwt: PINATA_JWT });
			const ev = await Mnemonad.create({
				publicClient: clients.publicClient,
				walletClient: clients.walletClient,
				contractAddress,
				offloadingProvider: provider,
			});

			expect(ev.offloadingProvider).toBe(provider);
			expect(MnemonadPinataProvider.codec).toBe(0); // Codec.IPFS — pinned content is still IPFS
		},
		30_000
	);

	it(
		'uploads via a pre-signed temporary JWT (pinningJwtProvider), not a static one',
		async () => {
			// pinningJwtProvider is called fresh for this one upload — no static pinningJwt
			// anywhere on this provider, so the real admin JWT never signs the actual
			// pinFileToIPFS request; only the narrow, single-use one mintUploadJwt returns
			// does.
			const provider = new MnemonadPinataProvider({
				pinningJwtProvider: () => MnemonadPinataProvider.mintUploadJwt(PINATA_JWT),
			});
			const ev = await Mnemonad.create({
				publicClient: clients.publicClient,
				walletClient: clients.walletClient,
				contractAddress,
				offloadingProvider: provider,
			});
			const data = makeBytes(2_000, 6);

			await ev.pushExternal(data);
			await trackPin(ev);
			const readBack = await ev.at(0);

			expect(new Uint8Array(readBack)).toEqual(data);
		},
		30_000
	);

	it(
		'a minted temp JWT is single-use — a second upload with the same one fails',
		async () => {
			const tempJwt = await MnemonadPinataProvider.mintUploadJwt(PINATA_JWT, { maxUses: 1 });
			const provider = new MnemonadPinataProvider({ pinningJwt: tempJwt });

			// First upload spends the key.
			const pointer = await provider.putBytes(makeBytes(500, 7));
			pinnedCids.push(pointer.locator);

			// Second attempt with the SAME (now-spent) key must fail — proves maxUses: 1 is
			// actually enforced by Pinata, not just requested.
			await expect(provider.putBytes(makeBytes(500, 8))).rejects.toThrow();
		},
		30_000
	);
});
