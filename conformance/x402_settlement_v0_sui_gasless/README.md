# exact-on-Sui settlement-receipt-binding conformance vector (#2666, gasless)

An independent-recompute conformance vector for the x402 settlement-receipt-binding
extension ([#2666](https://github.com/x402-foundation/x402/pull/2666)), anchored to a
**real gasless Sui testnet settlement** produced during the [#2616](https://github.com/x402-foundation/x402/pull/2616)
cross-check of Sceat's `@x402/sui` exact mechanism.

## What it proves

Run the pinned checker (`cryptography` + `rfc8785`, no Vaara import):

```sh
python _check_independent.py   # exit 0 = every verdict matched expected.json
```

For each rail (`generic`, `sui`) and lifecycle step (step0 in-progress, step1 terminal)
a third party reproduces, with only the settlement and receipt in hand:

- **action_ref_recomputes** — `sha256(JCS(agentId, actionType, scope, timestampMs, seq, terminal))` equals `settlement.actionRef` (the join key).
- **settlement_binding_resolves** — `sha256(JCS(settlement))` equals the receipt's `decisionDerived.evidenceRef.digest`.
- **receipt_signature_ok** — ES256 over the canonical decision blocks verifies against `keys/es256_public.pem`.
- **lifecycle_distinguishes_terminal** — step0/step1 carry distinct action_refs and opposite `terminal` flags; a mid-task receipt cannot be presented where the final one is required.

## The real anchor (sui rail)

| field | value |
|---|---|
| txDigest | [`FVejSg9ddPYXwWtxjk58TjkZg6aawJFyynZEsTmsxRQ6`](https://testnet.suivision.xyz/txblock/FVejSg9ddPYXwWtxjk58TjkZg6aawJFyynZEsTmsxRQ6) |
| asset | Circle USDC testnet (`0xa1ec7fc0…::usdc::USDC`) |
| amount | 10000 (`$0.01`, 6 decimals) |
| payTo | `0xf0dab0db…898d86` |
| assertedFrom | `net-balance-change-to-payTo` |
| timestampMs | 1782987830704 (on-chain) |

The settlement was built as a gasless Address-Balance payment (`0x2::balance::send_funds`
via `tx.balance()`, `setGasBudget(0n)`), settled through an independent non-custodial Sui
facilitator (x402 PR #2619), and recomputed from chain data alone: payTo credited exactly
+10000, payer debited exactly −10000, no undeclared recipient, gasless (`gasData.price = 0`,
`payment = []`, gas fully rebated), payer SUI delta 0. The sui rail models the mechanism's two
phases — **step0** = verify (digest recomputed from the signed bytes, pre-broadcast), **step1**
= settle (net-balance-change asserted from executed effects).

## Honest labeling

- The checker `_check_independent.py` is **byte-identical** to the pinned Vaara v1.1.1
  checker (git-blob `0669786…`) — unmodified, not asserted.
- The txDigest, amounts, and timestamp are **real** (independently verifiable on testnet).
- The ES256 issuer key is a **fresh throwaway demo key** generated for this fixture. Per
  #2666's non-goals, the vector proves the receipt **shape + binding**, NOT a live
  attestation-instance binding. Do not treat the signature as a production attestation.
