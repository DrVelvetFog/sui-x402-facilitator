/**
 * Decisive Enoki sponsorship test: will our Enoki project sponsor a generic
 * transfer on testnet? Builds a tiny gas->self transfer (onlyTransactionKind),
 * asks Enoki to sponsor it via the real sponsor() code path, and prints PASS
 * (Enoki returned sponsored bytes + a digest) or the exact refusal message so
 * we know precisely what to flip in the Enoki portal.
 *
 *   tsx scripts/enoki-test.ts      (ENOKI_KEY loaded from facilitator/.env)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { getFaucetHost, requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { toBase64 } from "@mysten/sui/utils";

const dir = path.dirname(fileURLToPath(import.meta.url));
process.loadEnvFile(path.join(dir, "..", ".env"));

// Import after env load so enoki.ts picks up ENOKI_KEY at module eval.
const { sponsor, sponsorshipEnabled } = await import("../src/enoki.js");

if (!sponsorshipEnabled()) {
  console.error("✗ ENOKI_KEY not loaded from .env — check facilitator/.env");
  process.exit(1);
}

// Reuse the e2e payer just for its address (the sender of the sponsored tx).
const secret = fs.readFileSync(path.join(dir, "..", ".secrets", "e2e-payer.key"), "utf8").trim();
const sender = Ed25519Keypair.fromSecretKey(secret).toSuiAddress();

const client = new SuiJsonRpcClient({ url: "https://fullnode.testnet.sui.io:443", network: "testnet" });

// A sponsored tx references SENDER-owned objects; the sponsor supplies the gas
// coin separately (so we can't reference tx.gas in a kind-only build). Split
// from a coin the payer actually owns — faucet first if the payer is dry.
let coins = await client.getCoins({ owner: sender, coinType: "0x2::sui::SUI" });
if (coins.data.length === 0) {
  console.log("payer has no SUI — fauceting…");
  try {
    await requestSuiFromFaucetV2({ host: getFaucetHost("testnet"), recipient: sender });
    await new Promise((r) => setTimeout(r, 4000));
    coins = await client.getCoins({ owner: sender, coinType: "0x2::sui::SUI" });
  } catch (e: any) {
    console.error(`faucet refused: ${e?.message ?? e}`);
  }
}
if (coins.data.length === 0) {
  console.error(`✗ payer ${sender} owns no SUI coin to transfer — fund it then rerun`);
  process.exit(1);
}

const tx = new Transaction();
const [coin] = tx.splitCoins(tx.object(coins.data[0].coinObjectId), [1]); // 1 MIST from an owned coin
tx.transferObjects([coin], sender);
const kindBytes = await tx.build({ client, onlyTransactionKind: true });

console.log(`Testing Enoki sponsorship — sender ${sender}, network=testnet ...`);
try {
  const { bytes, digest } = await sponsor("testnet", toBase64(kindBytes), sender);
  console.log("✓ PASS — Enoki sponsored the transfer.");
  console.log(`  digest: ${digest}`);
  console.log(`  sponsored bytes: ${bytes.length} chars (b64)`);
} catch (e: any) {
  console.error(`✗ Enoki refused: ${e?.message ?? e}`);
  process.exit(2);
}
