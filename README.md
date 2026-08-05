# sui-x402-facilitator

**A non-custodial [x402](https://docs.x402.org) facilitator that settles on Sui, live on mainnet + testnet.**

Live service: **https://sui-facilitator.onrender.com** · on-chain proof: [PROOF.md](PROOF.md)

Implements the x402 v2 facilitator API (`/supported`, `/verify`, `/settle`) for
the [`exact` scheme on Sui](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_sui.md).

**Non-custodial by construction.** The payment payload carries the payer's
complete signed transaction. This service can only simulate it (verify) or
broadcast it verbatim (settle) — it holds no keys, never touches funds, and has
no way to redirect a payment: the payer signed the exact bytes being relayed.
Zero fees.

## Live demo — agents pay, verified humans read free

The hosted service also exposes a demo resource:

```sh
curl -i https://sui-facilitator.onrender.com/signal/whales
```

returns `402 Payment Required` with a base64 `PAYMENT-REQUIRED` header
($0.01 testnet USDC per call). Retry with a `PAYMENT-SIGNATURE` header carrying
a signed Sui payment and you get the data plus a `PAYMENT-RESPONSE` settlement
digest — an agent buying an API call on Sui rails.

The same endpoint waives payment for wallets holding a
[Proof of Real](https://por-proof-of-real.netlify.app) personhood credential
(`POR-PROOF` header: a personal-message signature + on-chain credential check —
see [`por-sdk`](https://www.npmjs.com/package/por-sdk)). *Humans verify once
and read free; agents pay per call.*

## Endpoints

```
GET  /supported   capability discovery -> { kinds, extensions, signers }
POST /verify      { x402Version, paymentPayload, paymentRequirements } -> { isValid, invalidReason?, payer }
POST /settle      same body -> { success, errorReason?, payer, transaction, network, amount? }
GET  /health
```

Semantic failures return HTTP 200 with `isValid: false` / `success: false` and
a spec §9 reason code; 400 is reserved for unparseable bodies.

### Optional gas station (sponsored payments)

When `ENOKI_KEY` is set, two extra routes let a payer with **no SUI for gas**
still pay, via an [Enoki](https://docs.enoki.mystenlabs.com) sponsor:

```
POST /gas-station          { sender, transactionKindBytes, network, recipients? } -> { bytes, digest }
POST /gas-station/execute  { digest, signature } -> { digest }
```

The payer builds the payment as a transaction *kind* (no gas), `/gas-station`
fills the gas and returns the full bytes, the payer signs them, and
`/gas-station/execute` adds the sponsor signature and broadcasts. **The sponsor
key pays gas only** — the payment coin lives in the payer-signed bytes, the
sponsor signs the *same* bytes, so it still cannot redirect funds. `recipients`
are allow-listed so the sponsored tx can only pay the payees the caller
declares. Both routes are absent (404) unless `ENOKI_KEY` is configured.

## Networks & assets

| network | status | USDC (Circle, 6 decimals) |
|---|---|---|
| `sui:testnet` | live | `0xa1ec…7e29::usdc::USDC` |
| `sui:mainnet` | live — first payment settled 2026-06-12 ([PROOF.md](PROOF.md)) | `0xdba3…00e7::usdc::USDC` |

The facilitator is asset-agnostic: it enforces whatever coin type the
`PaymentRequirements.asset` names (USDC, SUI, anything `0x2::coin::Coin<T>`).

**Note on `sui:testnet`:** the spec defines `sui:mainnet` but no testnet id;
`sui:testnet` (CAIP-2 style) is our proposal pending a canonical answer from
the x402 foundation.

## How verification works

1. Structure: v2 envelope, `exact` scheme, supported network, payload's
   `accepted` terms match the `paymentRequirements` being enforced.
2. **Replay**: the tx digest is computed locally from the payload bytes and
   looked up on-chain — an already-executed payment is rejected
   (`invalid_transaction_state`). Dry-run alone cannot catch this: Sui
   fullnodes simulate against *latest* object versions, so a spent payment
   still simulates cleanly.
3. Dry-run via `dryRunTransactionBlock` — catches everything execution would
   reject (bad gas, stale/consumed coins, expired tx).
4. Signature: `verifyTransactionSignature` over the exact tx bytes, and the
   recovered signer must equal the tx sender (= reported `payer`).
5. Balance assertion: simulated `balanceChanges` must credit `payTo` with
   ≥ `amount` of `asset`. (The scheme spec says "equal"; we accept overpayment
   and report the actual settled amount in the `amount` field, never underpayment.)

Settlement re-runs all of the above immediately before broadcast (the
verify→settle gap: coins can be consumed between the two calls), then
re-asserts the balance change from **execution** results, not the simulation.

### Idempotency

Same transaction bytes ⇒ same Sui digest ⇒ same settlement. Concurrent settles
of one payment collapse into a single broadcast (in-flight promise cache), and
a settle retry after a process restart finds the digest on-chain and returns
the original outcome reconstructed from execution truth. Sui's digest
uniqueness + consumed coin objects make double-settlement fail closed at the
chain level regardless.

### Error codes

Spec §9 codes, plus Sui analogues of the `invalid_exact_evm_payload_*` family
(the Sui scheme spec defines no codes of its own):
`invalid_exact_sui_payload_signature`, `invalid_exact_sui_payload_recipient_mismatch`,
`invalid_exact_sui_payload_value_mismatch`.

## Run your own

```sh
npm install
npm run serve          # PORT=4402 by default
npm run e2e            # needs a running server; testnet, fresh keypairs in .secrets/
ASSET=USDC npm run e2e # payer needs Circle testnet USDC: https://faucet.circle.com
```

The e2e covers the happy path (verify → settle → recipient balance up),
tampered signature, recipient mismatch, underpayment, double-settle
idempotency, and spent-payment re-verification — 12 checks, all against real
testnet broadcasts. `npm run stress` adds concurrency races: 12 simultaneous
settles of one payment credit the recipient exactly once (single broadcast).

With `ENOKI_KEY` set (in `.env`), the gas station has its own tests:
`tsx scripts/enoki-test.ts` (one-call sponsorship probe) and
`tsx scripts/sponsored-e2e.ts` (full build → sponsor → sign → execute loop,
proving the payer pays zero gas).

## Reliability

`SUI_TESTNET_RPC` / `SUI_MAINNET_RPC` accept a **comma-separated failover
list** (first = primary). Calls retry across endpoints on transport failures
(network error, timeout, 5xx, 429) but not on deterministic JSON-RPC errors —
an honest node returns the same protocol answer everywhere. Defaults are
official fullnodes only: verification trusts the RPC's answers, so only add
endpoints you trust.

## Config

| env | default | |
|---|---|---|
| `PORT` | `4402` | |
| `ENABLE_MAINNET` | unset | `1` adds `sui:mainnet` |
| `SUI_TESTNET_RPC` | `https://fullnode.testnet.sui.io:443` | comma-separated failover list |
| `SUI_MAINNET_RPC` | `https://fullnode.mainnet.sui.io:443` | comma-separated failover list |
| `RPC_TIMEOUT_MS` | `20000` | per-call timeout before failover |
| `RATE_LIMIT` | `120` | requests per IP per minute |
| `ENOKI_KEY` | unset | Enoki key; enables the gas-station routes (gas-only sponsor) |
| `SPONSOR_DAILY_CAP` | `60` | max sponsored txs per sender per day |

## Custody & terms

Non-custodial, zero fees: the service holds no keys and relays the payer's own
signed transaction — it cannot redirect funds. See [TERMS.md](TERMS.md).

## License

Apache-2.0 © UIG Studios LLC. Pairs with
[Proof of Real](https://por-proof-of-real.netlify.app) for
"humans verify free / agents pay" differential access.
