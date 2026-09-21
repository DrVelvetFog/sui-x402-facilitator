/**
 * Regression check for the settle-cache binding (security report #3, finding A).
 *
 * Signs ONE testnet payment to seller A and settles it for A. Then presents the
 * exact same signed bytes to /settle again with seller B as payTo, at the same
 * price. A correct facilitator must refuse B: the chain credited A, not B.
 * A digest-only cache would replay A's success to B.
 *
 * Testnet only; costs one ~1,000,000 MIST SUI payment plus gas.
 *   FACILITATOR_URL=http://localhost:4402 npx tsx scripts/cross-merchant-replay.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";

const FACILITATOR = process.env.FACILITATOR_URL ?? "http://localhost:4402";
const NETWORK = "sui:testnet";
const SUI = "0x2::sui::SUI";
const AMOUNT = 1_000_000n;
const secretsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".secrets");

function keypair(name: string): Ed25519Keypair {
  const file = path.join(secretsDir, `${name}.key`);
  if (fs.existsSync(file)) return Ed25519Keypair.fromSecretKey(fs.readFileSync(file, "utf8").trim());
  fs.mkdirSync(secretsDir, { recursive: true });
  const kp = new Ed25519Keypair();
  fs.writeFileSync(file, kp.getSecretKey(), { mode: 0o600 });
  return kp;
}

function body(payload: { transaction: string; signature: string }, payTo: string) {
  const req = { scheme: "exact", network: NETWORK, amount: AMOUNT.toString(), asset: SUI, payTo, maxTimeoutSeconds: 60, extra: {} };
  return {
    x402Version: 2,
    paymentPayload: { x402Version: 2, resource: { url: "https://example.com/replay", description: "replay check", mimeType: "application/json" }, accepted: req, payload },
    paymentRequirements: req,
  };
}

async function settle(b: unknown): Promise<any> {
  const r = await fetch(`${FACILITATOR}/settle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return r.json();
}

async function main() {
  const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" });
  const payer = keypair("e2e-payer");
  const sellerA = keypair("e2e-seller").toSuiAddress();
  const sellerB = keypair("e2e-seller-b").toSuiAddress();

  const tx = new Transaction();
  tx.setSender(payer.toSuiAddress());
  const [coin] = tx.splitCoins(tx.gas, [AMOUNT]);
  tx.transferObjects([coin], sellerA);
  const bytes = await tx.build({ client });
  const { signature } = await payer.signTransaction(bytes);
  const payload = { transaction: toBase64(bytes), signature };

  const a = await settle(body(payload, sellerA));
  console.log(`seller A settle: success=${a.success} tx=${a.transaction} ${a.errorReason ?? ""}`);
  const b = await settle(body(payload, sellerB));
  console.log(`seller B settle (same bytes): success=${b.success} ${b.errorReason ?? ""}`);

  const again = await settle(body(payload, sellerA));
  console.log(`seller A retry:  success=${again.success} tx=${again.transaction}`);

  const ok = a.success === true && b.success !== true && again.success === true && again.transaction === a.transaction;
  console.log(ok ? "PASS — seller B refused, seller A's retry still idempotent" : "FAIL — see results above");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
