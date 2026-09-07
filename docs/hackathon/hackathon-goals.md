# Hackathon goals — Trust & Identity (AI track)

> Copied from [hackathon.monad.xyz/tracks/trust-identity-ai](https://hackathon.monad.xyz/tracks/trust-identity-ai).

## About

### What this track is for

AI has shifted the default assumptions the internet runs on — about identity, provenance,
and what's real. At the same time, the personal context that makes AI genuinely useful
tends to accumulate in platforms people don't own. This track is for builders working on
the trust and data ownership layer: the primitives that need to exist at the protocol level
for the rest of it to work. Monad provides specific building blocks — a native P256
precompile for WebAuthn verification, ERC-8004 as a first-class trustless agent registry,
and BTX encrypted mempools — that make this space more tractable than it's been elsewhere.

**Core question:** What does the trust and data ownership layer look like for an AI-native
internet — built in a way that is privacy-preserving, composable, and impossible for any
single platform to capture?

**Belongs here if:** the primary output is a protocol, primitive, or infrastructure layer
that other applications build on — not a standalone consumer product.

## Judging criteria

### What judges look for

| Criterion | Weight | What it's asking |
|---|---|---|
| Technical Execution | 20% | Is the trust/identity/data primitive implemented correctly and securely — correct use of WebAuthn/P256, sound key derivation, no leaked secrets? |
| Design & Craft | 20% | Is the primitive usable by the developers who'd build on it — clear docs, clean interface or API — even without an end-user-facing UI? Design here means developer experience, not just visuals. |
| Originality & Track Insight | 15% | Does this solve trust, provenance, or data ownership in a way that's privacy-preserving and not capturable by a single platform, or does it just centralize the problem differently? |
| Founder & Market Readiness | 25% | Does the team know which specific applications or developers would adopt this primitive, and why they'd choose it over rolling their own? |
| Traction & Path Forward | 20% | Any evidence of developer interest (even one other team integrating it during the hackathon), and a specific plan to get more integrations post-event. |
