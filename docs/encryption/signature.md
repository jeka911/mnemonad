# Signature-based encryption

The key-encryption key is derived from the owner's own wallet signature rather than a password. `personal_sign` signs a domain-separated message binding the chain id, contract address and stream id — `mnemonad:kek:v1\nchainId:<N>\ncontract:<address>\nstream:<id>` — so the same wallet produces a *different* KEK for every stream, and a key wrapped on one deployment can never be replayed against another. The signature itself is then run through HKDF-SHA256 to produce the 32-byte AES key that wraps the actual per-stream data key. There is nothing to publish beyond the method marker: unlike the password method, no salt or  iteration count exists to hand a later reader, since the signature itself already varies per stream by construction.

This is the strictly owner-bound option, with the trade-off that implies: nothing to
remember (no password to type, write down, or leak) and nothing to protect beyond the wallet
itself, but only that exact wallet can ever derive the right key. Lose access to the account
and the stream's contents are gone permanently — there is no recovery path.

`unlockWithSignature(signer)` asks for the one signature this stream's KEK derives from and
adopts the resulting key on the instance:

```javascript
const ev = new Mnemonad({ publicClient, contractAddress, id });
await ev.unlockWithSignature(walletClient);
await ev.at(0); // plaintext, from here on
```

A signature from the wrong wallet fails to unwrap the key exactly like a wrong password does
— `err.code === 'KEK_MISMATCH'`, never a silent garbage key. Creating a signature-encrypted
stream asks the wallet **twice**: once for the key signature, then for the `create`
transaction itself; rejecting the second leaves nothing on chain, and a retry re-derives the
identical key since the derivation is deterministic.

From the CLI this is `--encrypt --encrypt-with wallet` (no `--password`) plus a signing key via `--key`/`--phrase`/
`MNEMONAD_KEY` env var; the explorer dApp's create dialog offers it as "sign with wallet" alongside
the password option, and the unlock prompt for an already-created stream just asks to sign.

*@todo:* Implement additional method that combines wallet signature + [password.md](password.md).
