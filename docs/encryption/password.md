# Password-based encryption

The key-encryption key(see [encryption.md](encryption.md)) is derived from a plaintext password via PBKDF2-HMAC-SHA256, salted per stream. The salt is generated automatically at `create()` and — along with the iteration count actually used - gets published in the stream's own `streamMeta.kek` block (`{method: 'password', salt, iterations}`), so a later reader only ever needs the password itself; nothing else to remember or pass around separately. The
default iteration count is `MnemonadCrypto.DEFAULT_PBKDF2_ITERATIONS` (600,000 — OWASP's 2023 floor for PBKDF2-HMAC-SHA256), overridable per-stream via `passwordIterations`; whatever value is actually used is what gets persisted, since raising the default later must never change what an already-created stream needs to unwrap correctly. 

A password is rejected outright if empty (`crypto: password must not be empty`) rather than silently treated as "no password."

This is the wallet-independent recovery option: the password is the whole credential, independent of any wallet, so it can be shared with a collaborator or written down without handing over signing keys. 

*That convenience is also the whole risk surface — whoever knows the password can decrypt the stream, and there is no password reset.*

*@todo:* Implement additional method that combines wallet [signature.md](signature.md) + password.

A fresh instance unlocks with `unlockWithPassword(password)`, which reads the salt and iteration count straight off `streamMeta.kek` so the caller doesn't have to track them:

```javascript
const ev = new Mnemonad({ publicClient, contractAddress, id }); // no password yet
await ev.unlockWithPassword(userTypedPassword);
await ev.at(0); // plaintext, from here on
```

A wrong password throws rather than silently unwrapping garbage.