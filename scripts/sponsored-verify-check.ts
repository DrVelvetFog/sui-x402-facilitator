/**
 * Finding D (#3): a sponsored payment (gas owner != sender) must fail /verify,
 * because settle only ever broadcasts the payer's signature. Also checks an
 * ordinary self-paid testnet payment still verifies.
 *
 *   PAYER_COIN=<a SUI coin id owned by the e2e payer> npx tsx scripts/sponsored-verify-check.ts
 *
 * Needs .secrets/e2e-payer.key and .secrets/e2e-seller.key (the seller pays
 * the gas in the sponsored case). Nothing is broadcast.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { verify } from "../src/facilitator.js";

const SUI = "0x2::sui::SUI";
const NETWORK = "sui:testnet";
const AMOUNT = "1000000";
const secrets = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".secrets");
const payer = Ed25519Keypair.fromSecretKey(fs.readFileSync(path.join(secrets, "e2e-payer.key"), "utf8").trim());
const payTo = new Ed25519Keypair().toSuiAddress();

function body(txBytes: Uint8Array, signature: string) {
  const req = { scheme: "exact", network: NETWORK, amount: AMOUNT, asset: SUI, payTo, maxTimeoutSeconds: 60 };
  return { x402Version: 2, paymentRequirements: req,
    paymentPayload: { x402Version: 2, accepted: req, payload: { transaction: toBase64(txBytes), signature } } } as any;
}

// 1. Sponsored: a real testnet payment whose gas is owned by a second funded
// wallet (the e2e seller), so it simulates cleanly on chain. Before the fix this
// verified as valid; settle could never broadcast it.
const client = new SuiGrpcClient({ baseUrl: "https://fullnode.testnet.sui.io:443", network: "testnet" });
const sponsorKp = Ed25519Keypair.fromSecretKey(fs.readFileSync(path.join(secrets, "e2e-seller.key"), "utf8").trim());
const s = new Transaction();
s.setSender(payer.toSuiAddress());
s.setGasOwner(sponsorKp.toSuiAddress());
const [payment] = s.splitCoins(s.object(process.env.PAYER_COIN ?? ""), [BigInt(AMOUNT)]);
s.transferObjects([payment], payTo);
const sBytes = await s.build({ client });
const sSig = (await payer.signTransaction(sBytes)).signature;
const r1 = await verify(body(sBytes, sSig));
console.log("sponsored:", JSON.stringify(r1));

// 2. Self-paid: real testnet payment from the funded e2e payer (not broadcast).
const t = new Transaction();
t.setSender(payer.toSuiAddress());
t.transferObjects([t.splitCoins(t.gas, [BigInt(AMOUNT)])], payTo);
const tBytes = await t.build({ client });
const tSig = (await payer.signTransaction(tBytes)).signature;
const r2 = await verify(body(tBytes, tSig));
console.log("self-paid:", JSON.stringify(r2));

const ok = r1.isValid === false && r1.invalidReason === "invalid_payload" && r2.isValid === true;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
