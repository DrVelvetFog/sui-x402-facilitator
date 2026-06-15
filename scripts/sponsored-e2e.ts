/**
 * Full sponsored end-to-end against a RUNNING facilitator (with ENOKI_KEY set):
 *
 *   build payment kind -> POST /gas-station (Enoki fills gas)
 *   -> payer signs sponsored bytes -> POST /gas-station/execute (Enoki broadcasts)
 *   -> assert the tx executed on testnet and the seller received the transfer.
 *
 * The payer never holds SUI for gas — the Enoki sponsor key pays it. Proves the
 * agent-pays / no-gas path the gas station exists for.
 *
 *   FACILITATOR_URL  default http://localhost:4402
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { getFaucetHost, requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { fromBase64, toBase64 } from "@mysten/sui/utils";

const FACILITATOR = process.env.FACILITATOR_URL ?? "http://localhost:4402";
const RPC = "https://fullnode.testnet.sui.io:443";
const dir = path.dirname(fileURLToPath(import.meta.url));

function keypair(name: string): Ed25519Keypair {
  const file = path.join(dir, "..", ".secrets", `${name}.key`);
  return Ed25519Keypair.fromSecretKey(fs.readFileSync(file, "utf8").trim());
}
async function post(route: string, body: unknown): Promise<any> {
  const r = await fetch(`${FACILITATOR}${route}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

const payer = keypair("e2e-payer");
const seller = keypair("e2e-seller");
const sender = payer.toSuiAddress();
const sellerAddr = seller.toSuiAddress();
const client = new SuiJsonRpcClient({ url: RPC, network: "testnet" });
const AMOUNT = 1n; // 1 MIST, just enough to prove a real transfer

// The payer needs at least one owned SUI coin object to transfer from (gas is
// sponsor-paid). Faucet best-effort if dry.
let coins = await client.getCoins({ owner: sender, coinType: "0x2::sui::SUI" });
if (coins.data.length === 0) {
  console.log("payer dry — fauceting…");
  try {
    await requestSuiFromFaucetV2({ host: getFaucetHost("testnet"), recipient: sender });
    await new Promise((r) => setTimeout(r, 4000));
    coins = await client.getCoins({ owner: sender, coinType: "0x2::sui::SUI" });
  } catch (e: any) { console.log(`faucet refused: ${e?.message ?? e}`); }
}
if (coins.data.length === 0) { console.error(`✗ payer ${sender} has no SUI coin to transfer`); process.exit(1); }

// 1) Build the payment as transaction-kind bytes (no gas, no sender baked in).
const tx = new Transaction();
const [coin] = tx.splitCoins(tx.object(coins.data[0].coinObjectId), [AMOUNT]);
tx.transferObjects([coin], sellerAddr);
const kindBytes = toBase64(await tx.build({ client, onlyTransactionKind: true }));

const before = BigInt((await client.getBalance({ owner: sellerAddr })).totalBalance);

// 2) Ask the facilitator to sponsor it.
const sp = await post("/gas-station", { sender, transactionKindBytes: kindBytes, network: "sui:testnet", recipients: [sellerAddr] });
if (sp.status !== 200 || !sp.json.bytes || !sp.json.digest) {
  console.error(`✗ /gas-station failed (${sp.status}):`, sp.json); process.exit(2);
}
console.log(`  ✓ /gas-station sponsored — digest ${sp.json.digest}`);

// 3) Payer signs the sponsored bytes (Enoki holds the sponsor signature).
const { signature } = await payer.signTransaction(fromBase64(sp.json.bytes));

// 4) Hand the signature back to execute.
const ex = await post("/gas-station/execute", { digest: sp.json.digest, signature });
if (ex.status !== 200 || !ex.json.digest) {
  console.error(`✗ /gas-station/execute failed (${ex.status}):`, ex.json); process.exit(3);
}
console.log(`  ✓ /gas-station/execute broadcast — digest ${ex.json.digest}`);

// 5) Confirm on-chain: tx succeeded and the seller balance went up.
await client.waitForTransaction({ digest: ex.json.digest });
const txb = await client.getTransactionBlock({ digest: ex.json.digest, options: { showEffects: true } });
const status = txb.effects?.status?.status;
const after = BigInt((await client.getBalance({ owner: sellerAddr })).totalBalance);

console.log(`  tx status: ${status} | seller balance ${before} -> ${after} (Δ ${after - before})`);
if (status === "success" && after - before === AMOUNT) {
  console.log("✓ PASS — full sponsored payment settled on testnet, payer paid zero gas.");
} else {
  console.error("✗ FAIL — tx did not settle as expected."); process.exit(4);
}
