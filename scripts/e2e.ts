/**
 * End-to-end test against a RUNNING facilitator (npm run serve first):
 *
 *   payer keypair signs a payment tx -> /verify -> /settle -> seller balance up
 *
 * plus the failure paths that matter: tampered signature, recipient mismatch,
 * underpayment, and double-settle idempotency (same digest back, no error).
 *
 * Keypairs persist in .secrets/ (gitignored) so reruns reuse the funded payer.
 * Faucets SUI automatically when the payer is dry. ASSET=USDC needs Circle
 * testnet USDC in the payer wallet first (https://faucet.circle.com).
 *
 *   FACILITATOR_URL  default http://localhost:4402
 *   ASSET            SUI (default) | USDC
 *   AMOUNT           atomic units; default 1000000 (0.001 SUI) / 10000 ($0.01)
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
const NETWORK = "sui:testnet";
const RPC = "https://fullnode.testnet.sui.io:443";
const USDC = "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";
const SUI = "0x2::sui::SUI";
const ASSET = (process.env.ASSET ?? "SUI") === "USDC" ? USDC : SUI;
const AMOUNT = BigInt(process.env.AMOUNT ?? (ASSET === USDC ? 10_000 : 1_000_000));

const secretsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".secrets");

function keypair(name: string): Ed25519Keypair {
  const file = path.join(secretsDir, `${name}.key`);
  if (fs.existsSync(file)) return Ed25519Keypair.fromSecretKey(fs.readFileSync(file, "utf8").trim());
  fs.mkdirSync(secretsDir, { recursive: true });
  const kp = new Ed25519Keypair();
  fs.writeFileSync(file, kp.getSecretKey(), { mode: 0o600 });
  console.log(`new ${name} keypair -> ${kp.toSuiAddress()}`);
  return kp;
}

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
}

async function post(route: string, body: unknown): Promise<any> {
  const r = await fetch(`${FACILITATOR}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

/** Build + sign a payment of `amount` `asset` from payer to `to`. */
async function buildPayment(client: SuiJsonRpcClient, payer: Ed25519Keypair, to: string, amount: bigint, asset: string) {
  const tx = new Transaction();
  tx.setSender(payer.toSuiAddress());
  if (asset === SUI) {
    const [coin] = tx.splitCoins(tx.gas, [amount]);
    tx.transferObjects([coin], to);
  } else {
    const coins = await client.getCoins({ owner: payer.toSuiAddress(), coinType: asset });
    const total = coins.data.reduce((s, c) => s + BigInt(c.balance), 0n);
    if (total < amount) throw new Error(`payer has ${total} of ${asset}, needs ${amount} — fund via https://faucet.circle.com`);
    const [first, ...rest] = coins.data;
    if (rest.length && BigInt(first.balance) < amount) {
      tx.mergeCoins(tx.object(first.coinObjectId), rest.map((c) => tx.object(c.coinObjectId)));
    }
    const [coin] = tx.splitCoins(tx.object(first.coinObjectId), [amount]);
    tx.transferObjects([coin], to);
  }
  const bytes = await tx.build({ client });
  const { signature } = await payer.signTransaction(bytes);
  return { transaction: toBase64(bytes), signature };
}

function requestBody(payload: { transaction: string; signature: string }, payTo: string, amount = AMOUNT, asset = ASSET) {
  const paymentRequirements = {
    scheme: "exact", network: NETWORK, amount: amount.toString(),
    asset, payTo, maxTimeoutSeconds: 60, extra: {},
  };
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      resource: { url: "https://example.com/e2e", description: "facilitator e2e", mimeType: "application/json" },
      accepted: paymentRequirements,
      payload,
    },
    paymentRequirements,
  };
}

async function main() {
  const client = new SuiJsonRpcClient({ url: RPC, network: "testnet" });
  const payer = keypair("e2e-payer");
  const seller = keypair("e2e-seller");
  const payerAddr = payer.toSuiAddress();
  const sellerAddr = seller.toSuiAddress();
  console.log(`payer  ${payerAddr}\nseller ${sellerAddr}\nasset  ${ASSET}  amount ${AMOUNT}\n`);

  // gas (and SUI-asset funds) for the payer — faucet is best-effort: a few
  // hundredths of a SUI is plenty of gas, only a truly dry wallet is fatal
  const balance = BigInt((await client.getBalance({ owner: payerAddr })).totalBalance);
  if (balance < 50_000_000n) {
    console.log("fauceting payer…");
    try {
      await requestSuiFromFaucetV2({ host: getFaucetHost("testnet"), recipient: payerAddr });
      await new Promise((r) => setTimeout(r, 3000));
    } catch (e: any) {
      if (balance < 10_000_000n) throw new Error(`payer is dry (${balance} MIST) and the faucet refused: ${e?.message ?? e}`);
      console.log(`faucet refused (${e?.message ?? e}) — continuing on ${balance} MIST`);
    }
  }

  console.log("— /supported");
  const sup = await (await fetch(`${FACILITATOR}/supported`)).json() as any;
  check("advertises sui:testnet exact", sup.kinds?.some((k: any) => k.network === NETWORK && k.scheme === "exact" && k.x402Version === 2));

  console.log("— /verify happy path");
  const payload = await buildPayment(client, payer, sellerAddr, AMOUNT, ASSET);
  const v = await post("/verify", requestBody(payload, sellerAddr));
  check("isValid", v.isValid === true, JSON.stringify(v));
  check("payer reported", v.payer === payerAddr);

  console.log("— /verify rejections");
  const tampered = { ...payload, signature: payload.signature.replace(/.$/, (c) => (c === "A" ? "B" : "A")) };
  const vt = await post("/verify", requestBody(tampered, sellerAddr));
  check("tampered signature rejected", vt.isValid === false && String(vt.invalidReason).includes("signature"), vt.invalidReason);

  const stranger = new Ed25519Keypair().toSuiAddress();
  const vr = await post("/verify", requestBody(payload, stranger));
  check("recipient mismatch rejected", vr.isValid === false && String(vr.invalidReason).includes("recipient"), vr.invalidReason);

  const vu = await post("/verify", requestBody(payload, sellerAddr, AMOUNT * 2n));
  check("underpayment rejected", vu.isValid === false, vu.invalidReason);

  console.log("— /settle");
  const settleBody = requestBody(payload, sellerAddr);
  fs.writeFileSync(path.join(secretsDir, "last-settle-body.json"), JSON.stringify(settleBody, null, 2));
  const before = BigInt((await client.getBalance({ owner: sellerAddr, coinType: ASSET })).totalBalance);
  const s = await post("/settle", settleBody);
  check("success", s.success === true, JSON.stringify(s));
  check("digest returned", typeof s.transaction === "string" && s.transaction.length > 0, s.transaction);
  check("amount settled", s.amount === AMOUNT.toString(), s.amount);

  await client.waitForTransaction({ digest: s.transaction });
  const after = BigInt((await client.getBalance({ owner: sellerAddr, coinType: ASSET })).totalBalance);
  check("seller balance up by amount", after - before === AMOUNT, `${before} -> ${after}`);

  console.log("— /settle idempotency");
  const s2 = await post("/settle", requestBody(payload, sellerAddr));
  check("second settle returns same digest", s2.success === true && s2.transaction === s.transaction, s2.transaction);

  console.log("— /verify after settlement (coins consumed)");
  const vAfter = await post("/verify", requestBody(payload, sellerAddr));
  check("spent payment no longer verifies", vAfter.isValid === false, vAfter.invalidReason);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
  console.log(`settlement digest: ${s.transaction}`);
  console.log(`explorer: https://testnet.suivision.xyz/txblock/${s.transaction}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
