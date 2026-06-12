# Terms & Disclaimer — sui-x402-facilitator

_Last updated: 2026-06-12. Operator: UIG Studios LLC ("we"). This document
states what the service is and is not. It is not legal advice._

## What this service is

The sui-x402-facilitator is a **non-custodial, pass-through relay** for
[x402](https://docs.x402.org) payments on the Sui network, implementing the
`exact` scheme. Its role is functionally similar to a public RPC node:

- A payer constructs and **signs their own Sui transaction**. The signed
  transaction and signature are the payment payload.
- `POST /verify` **simulates** that transaction (read-only) and checks it pays
  the agreed recipient the agreed amount.
- `POST /settle` **broadcasts that same signed transaction, unchanged**, to the
  Sui network and reports the result.

## No custody, ever

We never take custody of, hold, control, or have access to any funds.

- The service holds **no private keys** and **no wallet**.
- It **cannot move, redirect, freeze, or seize** funds. It can only relay the
  bytes the payer already signed, which move the payer's funds to the recipient
  the payer chose.
- It **adds no signature** to payments (no sponsorship/gas-station mode is
  enabled). The payer pays their own gas.
- It charges **zero fees** and takes no cut of any payment.

Because settlement is the payer's own signed transaction, neither we nor any
attacker who compromised the service could direct funds anywhere other than the
recipient named in the payer-signed transaction.

## No warranty

The service is provided **"as is" and "as available," without warranties of
any kind**, express or implied, including merchantability, fitness for a
particular purpose, and non-infringement. We do not guarantee uptime,
correctness, finality, or that a payment will verify or settle. Blockchain
transactions are irreversible; you are responsible for the transactions you
sign.

## Limitation of liability

To the maximum extent permitted by law, UIG Studios LLC is not liable for any
loss or damages arising from use of the service, including lost funds, failed
or delayed settlement, RPC or network errors, or downtime.

## Your responsibilities

- You are responsible for what you sign and submit, and for complying with the
  laws and regulations that apply to you, including sanctions and tax law.
- Do not use the service for unlawful purposes.
- The service performs **no KYC/AML/sanctions screening**. It is a neutral
  relay. If you require screened settlement, use a facilitator that offers it.

## Scope & changes

Currently serves Sui testnet and mainnet for the `exact` scheme. We may change,
suspend, or discontinue the service at any time. Continued use after changes to
these terms constitutes acceptance.

Contact: UIG Studios LLC.
