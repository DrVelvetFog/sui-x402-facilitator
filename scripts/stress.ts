/**
 * Adversarial / race tests against a RUNNING facilitator (npm run serve first).
 * The idempotency guarantees only matter under real concurrency, which the
 * sequential e2e doesn't exercise. Here we fire many simultaneous requests at
 * the SAME payment and assert the chain saw exactly one broadcast.
 *
 *   1. N concurrent /settle of one fresh payment -> all succeed, one digest,
 *      seller credited exactly once (not N times).
 *   2. N concurrent /settle of the now-spent payment -> all return that same
 *      digest from chain reconstruction, no second broadcast, balance flat.
 *   3. N concurrent /verify racing /settle -> no crash, consistent answers.
 *
 * Reuses the e2e payer/seller keypairs in .secrets (faucets gas if the payer
 * is low). Testnet, SUI asset.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { getFaucetHost, requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { toBase64 } from "@mysten/sui/utils";

const FACILITATOR = process.env.FACILITATOR_URL ?? "http://localhost:4402";
const RPC = "https://fullnode.testnet.sui.io:443";
const SUI = "0x2::sui::SUI";
const AMOUNT = BigInt(process.env.AMOUNT ?? 1_000_000); // 0.001 SUI
const N = Number(process.env.CONCURRENCY ?? 12);

const secretsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".secrets");
const kp = (name: string) => Ed25519Keypair.fromSecretKey(fs.readFileSync(path.join(secretsDir, `${name}.key`), "utf8").trim());

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`); ok ? pass++ : fail++; };
const post = (route: string, body: unknown) =>
  fetch(`${FACILITATOR}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);

async function buildPayment(client: SuiJsonRpcClient, payer: Ed25519Keypair, to: string) {
  const tx = new Transaction();
  tx.setSender(payer.toSuiAddress());
  const [coin] = tx.splitCoins(tx.gas, [AMOUNT]);
  tx.transferObjects([coin], to);
  const bytes = await tx.build({ client });
  const { signature } = await payer.signTransaction(bytes);
  const requirements = { scheme: "exact", network: "sui:testnet", amount: AMOUNT.toString(), asset: SUI, payTo: to, maxTimeoutSeconds: 60, extra: {} };
  return {
    x402Version: 2,
    paymentPayload: { x402Version: 2, accepted: requirements, payload: { signature, transaction: toBase64(bytes) } },
    paymentRequirements: requirements,
  };
}

async function main() {
  const client = new SuiJsonRpcClient({ url: RPC, network: "testnet" });
  const payer = kp("e2e-payer");
  const seller = kp("e2e-seller");
  const sellerAddr = seller.toSuiAddress();
  console.log(`payer ${payer.toSuiAddress()}\nseller ${sellerAddr}\nconcurrency ${N}, amount ${AMOUNT}\n`);

  // ensure gas — each of the N concurrent settles is its own broadcast, so the
  // payer needs gas for N transactions plus the test payments
  const bal = BigInt((await client.getBalance({ owner: payer.toSuiAddress() })).totalBalance);
  if (bal < 60_000_000n) {
    console.log("fauceting payer gas…");
    try {
      await requestSuiFromFaucetV2({ host: getFaucetHost("testnet"), recipient: payer.toSuiAddress() });
      await new Promise((r) => setTimeout(r, 3000));
    } catch (e: any) {
      throw new Error(`payer low on gas (${bal} MIST) and faucet refused (${e?.message ?? e}) — fund ${payer.toSuiAddress()} and retry`);
    }
  }

  // ---- Test 1: N concurrent settles of one fresh payment ----
  console.log(`— ${N} concurrent /settle of one fresh payment`);
  const body = await buildPayment(client, payer, sellerAddr);
  const before = BigInt((await client.getBalance({ owner: sellerAddr, coinType: SUI })).totalBalance);
  const results = await Promise.all(Array.from({ length: N }, () => post("/settle", body)));
  const successes = results.filter((r) => r.success === true);
  const digests = new Set(results.map((r) => r.transaction).filter(Boolean));
  check("all N settles succeeded", successes.length === N, `${successes.length}/${N}`);
  check("exactly one distinct digest", digests.size === 1, [...digests].join(", "));
  const digest = [...digests][0];
  if (digest) await client.waitForTransaction({ digest });
  const after = BigInt((await client.getBalance({ owner: sellerAddr, coinType: SUI })).totalBalance);
  check("seller credited exactly ONCE (single broadcast)", after - before === AMOUNT, `${before} -> ${after} (Δ ${after - before}, expected ${AMOUNT})`);

  // ---- Test 2: N concurrent settles of the now-spent payment ----
  console.log(`— ${N} concurrent /settle of the spent payment (chain reconstruction)`);
  const before2 = BigInt((await client.getBalance({ owner: sellerAddr, coinType: SUI })).totalBalance);
  const replay = await Promise.all(Array.from({ length: N }, () => post("/settle", body)));
  const replayDigests = new Set(replay.map((r) => r.transaction).filter(Boolean));
  check("all return the original digest", replay.every((r) => r.success === true && r.transaction === digest), `${replayDigests.size} distinct`);
  const after2 = BigInt((await client.getBalance({ owner: sellerAddr, coinType: SUI })).totalBalance);
  check("no second broadcast (balance flat)", after2 === before2, `Δ ${after2 - before2}`);

  // ---- Test 3: concurrent verify racing settle on a fresh payment ----
  console.log(`— concurrent /verify × /settle on a fresh payment`);
  const body3 = await buildPayment(client, payer, sellerAddr);
  const mixed = await Promise.all([
    ...Array.from({ length: N }, () => post("/verify", body3)),
    ...Array.from({ length: N }, () => post("/settle", body3)),
  ]);
  const settleR = mixed.slice(N).filter((r) => r.success === true);
  const settleDigests = new Set(mixed.slice(N).map((r) => r.transaction).filter(Boolean));
  const verifyOk = mixed.slice(0, N).every((r) => typeof r.isValid === "boolean"); // valid or already-spent, never a crash
  check("no malformed responses under verify×settle race", verifyOk && mixed.slice(N).every((r) => typeof r.success === "boolean"));
  check("settles still collapse to one digest", settleDigests.size === 1 && settleR.length === N, `${settleDigests.size} digest(s), ${settleR.length}/${N} ok`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
