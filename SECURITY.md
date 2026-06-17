# sui-x402 Facilitator — Security

The facilitator verifies and broadcasts x402 `exact`-scheme payments on Sui. It
is **non-custodial by construction** and holds no payment keys; this document is
the trust model, the hardening in place, and the assumptions an integrator must
honor.

## Core property: non-custodial

The payment payload carries the **payer's complete signed transaction**. The
facilitator can only (a) simulate it (`verify`) or (b) broadcast the exact bytes
(`settle`). It never holds key material for payments and cannot redirect funds —
the payer signed the precise bytes we relay, and value is asserted from the
transaction's **net balance change to `payTo`** (execution truth), not from
parsing transaction structure. This eliminates the worst risk class (a
facilitator that can steal funds).

## verify vs. settle — the integrator contract

- **`/verify` is advisory.** It is a single dry-run + signature + balance-change
  check. A resource server may use it to pre-screen a payment, but **must not
  release the paid resource on `/verify` alone.**
- **`/settle` is authoritative.** It broadcasts the transaction, waits for
  finality, and re-asserts `payTo`'s actual received amount from on-chain
  execution effects. The returned `transaction` digest is real and independently
  verifiable on any explorer. **Gate resource delivery on a successful
  `/settle`.**
- Replay/double-spend: a payment's digest is deterministic from its bytes; an
  already-executed payment is rejected at verify and deduped at settle (in-flight
  cache + durable on-chain re-read), and Sui's own digest/coin-version uniqueness
  is the ultimate guard.

## RPC trust (M2 — documented assumption)

Verification trusts the configured RPC's answers (dry-run, balance changes,
digest lookups), so a **malicious endpoint could falsely validate a payment**.
Mitigations:
- RPC defaults are **official Mysten fullnodes only**; operators should add only
  endpoints they trust (documented in `config.ts`).
- `settle` is robust against a single bad endpoint: it broadcasts for real and
  the digest is independently checkable, so a fooled `/verify` cannot by itself
  cause loss when the integrator gates on `/settle` (above).

A cross-RPC quorum on `verify` was **considered and deliberately not adopted**:
honest fullnodes can lag each other by an object version, so requiring agreement
on a pre-broadcast dry-run would reject legitimate payments (false negatives)
more often than it would catch a malicious endpoint. Operator trust in the RPC
list + the settle-is-authoritative contract is the chosen posture.

## Gas station (L3 — capped, gas-only)

The optional `/gas-station` sponsors a payer's transaction via Enoki so agents
need no SUI. The Enoki sponsor key **pays gas only** — it co-signs as gas owner
and cannot redirect funds; the payment content is the payer's. It sponsors
arbitrary transaction *kinds* (not only payments), so it is effectively a capped
free-gas faucet, bounded by:
- per-sender daily cap (`SPONSOR_DAILY_CAP`, default 60),
- a **global daily circuit breaker** (`SPONSOR_GLOBAL_DAILY_CAP`, default 1000).

**Mainnet operating requirement:** size `SPONSOR_GLOBAL_DAILY_CAP × max-gas-per-tx
≤ the sponsor wallet's funded SUI`, and monitor the wallet balance. Sponsorship
is disabled entirely unless `ENOKI_KEY` is set (env only, never in the repo), so
ordinary verify/settle stay key-free.

## Abuse hardening

- Per-IP rate limit on all endpoints, keyed on the **trusted last
  `x-forwarded-for` hop** (the platform-appended one) so a client can't bypass it
  by spoofing the header.
- Request body cap (256 KB) and a per-payload transaction-bytes cap (120 KB).
- Bounded caches (rate-limit buckets, sponsor counters, and the settle
  idempotency cache keyed on the 32-byte digest) evict oldest rather than
  clearing wholesale.

## Reporting

Solo project. Open an issue on the repo or contact the maintainer. Testnet by
default; mainnet behind `ENABLE_MAINNET=1`. Unaudited.
