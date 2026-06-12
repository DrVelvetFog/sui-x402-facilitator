# Proof: the first x402 payments settled on Sui

Verify any testnet digest at `https://testnet.suivision.xyz/txblock/<digest>`
and any mainnet digest at `https://suivision.xyz/txblock/<digest>`.

## 🟢 MAINNET — the first x402 payment settled on Sui mainnet

Real Circle USDC, real mainnet broadcast, 2026-06-12:

| | |
|---|---|
| settlement digest | [`49z1am7SpkN16XGSGBowBdCAzzPQQK7ffeqekrwandQL`](https://suivision.xyz/txblock/49z1am7SpkN16XGSGBowBdCAzzPQQK7ffeqekrwandQL) |
| network | `sui:mainnet` |
| amount | $0.01 USDC (`0xdba3…00e7::usdc::USDC`) |
| flow | `/verify` → `/settle`, payer-signed transaction relayed verbatim |

## Production — live service (testnet demo)

**The facilitator is live at https://sui-facilitator.onrender.com**
(`GET /supported` advertises `sui:testnet` / `exact`). First payment through
the **production** deployment, 2026-06-12:

| | |
|---|---|
| settlement digest | [`22NXwKmciPXT4aKX3bhqPAkJuqXPQjT5z5CK4ZTovbfi`](https://testnet.suivision.xyz/txblock/22NXwKmciPXT4aKX3bhqPAkJuqXPQjT5z5CK4ZTovbfi) |
| amount | $0.01 USDC, paid by an agent for `GET /signal/whales` |
| human door | same endpoint, `POR-PROOF` header → `200` free, verified live |

## The first run — 2026-06-12

**An autonomous agent bought an API response for $0.01 USDC over x402,
settled on Sui rails** (402 → signed Sui USDC payment → verify → fulfill →
settle → 200 + data):

| | |
|---|---|
| settlement digest | [`4GnrC3xbJfKSwFWpxJXDQVuqwtcudCACBnZtB5wtNFzs`](https://testnet.suivision.xyz/txblock/4GnrC3xbJfKSwFWpxJXDQVuqwtcudCACBnZtB5wtNFzs) |
| amount | 10000 (= $0.01 Circle USDC, 6 decimals) |
| payer (agent) | `0x0de7508579dca6a2e6a40fab7c267f12068511fd9254bec459c9ef2d4a1273dc` |
| flow | `PAYMENT-REQUIRED` → `PAYMENT-SIGNATURE` → `PAYMENT-RESPONSE` (x402 v2 HTTP transport) |

## Facilitator e2e settlements

Full suite (12 checks: happy path, tampered signature, recipient mismatch,
underpayment, double-settle idempotency, spent-payment re-verification):

| date | asset | digest |
|---|---|---|
| 2026-06-12 | USDC (10000 = $0.01) | [`5GCkEANobgKXonD3gV6muxHCbKWXZ13dir7HRN3zdHfy`](https://testnet.suivision.xyz/txblock/5GCkEANobgKXonD3gV6muxHCbKWXZ13dir7HRN3zdHfy) |
| 2026-06-12 | SUI (1000000 MIST) | [`4WZzq5jWQ2pLGQRZ1fxSXijbyJdxmomjidTKRCKh85zL`](https://testnet.suivision.xyz/txblock/4WZzq5jWQ2pLGQRZ1fxSXijbyJdxmomjidTKRCKh85zL) |
| 2026-06-12 | SUI, agent flow | [`9SUDSAuSqZCZcwo1rRVH7pUUU1EuiA51BaLA8jbtTFqQ`](https://testnet.suivision.xyz/txblock/9SUDSAuSqZCZcwo1rRVH7pUUU1EuiA51BaLA8jbtTFqQ) |

Reproduce against the live demo:

```sh
curl -i https://sui-facilitator.onrender.com/signal/whales   # 402 + payment terms
```

or run your own: `npm run serve`, then `ASSET=USDC npm run e2e`.
