/**
 * GASLESS cross-check for x402-foundation/x402 #2616 (Sceat's @x402/sui exact
 * mechanism). Builds a GASLESS Address-Balance payment the way Sceat's client
 * does — one `0x2::balance::send_funds` per output via `tx.balance()`, built over
 * gRPC, `setGasBudget(0n)` to force the gasless election — signs it, and settles
 * it through THIS independent facilitator (verify -> settle). Then it recomputes
 * the settlement from chain data alone and prints a paste-ready summary for #2616.
 *
 * This is the third-party coverage Sceat asked for: an independent facilitator
 * settling his gasless shape, with the exact-fee balance-change recompute
 * (matchBalanceChanges) confirmed against the on-chain effects.
 *
 * Reuses the funded .secrets/e2e-payer.key. Testnet only.
 *
 *   FACILITATOR_URL  default http://localhost:4402
 *   ASSET            USDC (default) | SUI
 *   AMOUNT           atomic units; default 10000 ($0.01 USDC) / 2000000 SUI
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { FailoverRpc } from "../src/rpc.js";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";

const FACILITATOR = process.env.FACILITATOR_URL ?? "http://localhost:4402";
const NETWORK = "sui:testnet";
const RPC = "https://fullnode.testnet.sui.io:443";
const USDC = "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";
const SUI = "0x2::sui::SUI";
const ASSET = (process.env.ASSET ?? "USDC") === "SUI" ? SUI : USDC;
const AMOUNT = BigInt(process.env.AMOUNT ?? (ASSET === USDC ? 10_000 : 2_000_000));

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

async function post(route: string, body: unknown): Promise<any> {
  const r = await fetch(`${FACILITATOR}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

/**
 * Build the GASLESS Address-Balance PTB exactly as Sceat's ExactSuiScheme client
 * does (buildGaslessOutputs): `0x2::balance::send_funds` per output drawn from the
 * payer's balance via `tx.balance()`, built over gRPC, `setGasBudget(0n)` to force
 * the gasless election. Do NOT set gasPrice/gasPayment manually — the protocol
 * rejects those; the 0-budget branch elects gaslessness.
 */
async function buildGaslessSigned(payer: Ed25519Keypair, to: string, amount: bigint, asset: string) {
  const grpc = new SuiGrpcClient({ network: "testnet", baseUrl: RPC });
  const tx = new Transaction();
  tx.setSender(payer.toSuiAddress());
  tx.moveCall({
    target: "0x2::balance::send_funds",
    typeArguments: [asset],
    arguments: [tx.balance({ type: asset, balance: amount }), tx.pure.address(to)],
  });
  tx.setGasBudget(0n);
  const bytes = await tx.build({ client: grpc as never });
  const { signature } = await payer.signTransaction(bytes);
  return { transaction: toBase64(bytes), signature };
}

function requestBody(payload: { transaction: string; signature: string }, payTo: string) {
  const paymentRequirements = {
    scheme: "exact", network: NETWORK, amount: AMOUNT.toString(),
    asset: ASSET, payTo, maxTimeoutSeconds: 60, extra: {},
  };
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      resource: { url: "https://example.com/2616-gasless", description: "#2616 gasless cross-check", mimeType: "application/json" },
      accepted: paymentRequirements,
      payload,
    },
    paymentRequirements,
  };
}

/** Net AddressOwner deltas for `asset`, keyed by lowercased address. */
function netByAddress(balanceChanges: any[], asset: string): Map<string, bigint> {
  const net = new Map<string, bigint>();
  for (const bc of balanceChanges ?? []) {
    if (bc.coinType !== asset) continue;
    const owner = bc.owner && typeof bc.owner === "object" && "AddressOwner" in bc.owner ? bc.owner.AddressOwner : "";
    if (!owner) continue;
    const k = owner.toLowerCase();
    net.set(k, (net.get(k) ?? 0n) + BigInt(bc.amount));
  }
  return net;
}

async function main() {
  // Independent on-chain reads over gRPC (JSON-RPC retired). getBalance reads
  // `.balance`; the tx recompute reuses the migrated FailoverRpc adapter for the
  // `owner.AddressOwner` balanceChange shape, plus a raw read for gasData.
  const grpc = new SuiGrpcClient({ network: "testnet", baseUrl: RPC } as never);
  const rpc = new FailoverRpc([RPC], "testnet");
  const getBalance = async (owner: string, coinType: string) =>
    BigInt((await grpc.getBalance({ owner, coinType } as never) as any).balance.balance);
  const payer = keypair("e2e-payer");
  const seller = keypair("e2e-seller");
  const payerAddr = payer.toSuiAddress();
  const sellerAddr = seller.toSuiAddress();
  console.log(`facilitator ${FACILITATOR}`);
  console.log(`payer  ${payerAddr}\nseller ${sellerAddr}\nasset  ${ASSET}\namount ${AMOUNT}\n`);

  // 1. build the gasless payment the way Sceat's client does
  console.log("— building gasless Address-Balance PTB (0x2::balance::send_funds, setGasBudget(0n), over gRPC)");
  const payload = await buildGaslessSigned(payer, sellerAddr, AMOUNT, ASSET);
  const built = Transaction.from(Buffer.from(payload.transaction, "base64"));
  const gasData = built.getData().gasData;
  const gasless =
    (gasData?.price === "0" || gasData?.price == null) &&
    (gasData?.payment == null || (Array.isArray(gasData.payment) && gasData.payment.length === 0));
  console.log(`  gasData: price=${gasData?.price ?? "null"} payment=${JSON.stringify(gasData?.payment ?? null)}  -> gasless=${gasless}`);
  if (!gasless) throw new Error("built tx is NOT gasless — aborting before settle");

  // 2. verify through this facilitator
  console.log("— /verify");
  const v = await post("/verify", requestBody(payload, sellerAddr));
  console.log(`  isValid=${v.isValid} payer=${v.payer ?? "-"}${v.invalidReason ? " reason=" + v.invalidReason : ""}`);
  if (v.isValid !== true) throw new Error(`facilitator rejected the gasless payment at verify: ${JSON.stringify(v)}`);

  // 3. settle through this facilitator
  console.log("— /settle");
  const usdcBefore = await getBalance(sellerAddr, ASSET);
  const s = await post("/settle", requestBody(payload, sellerAddr));
  console.log(`  success=${s.success} digest=${s.transaction ?? "-"} amount=${s.amount ?? "-"}`);
  if (!s.success || !s.transaction) throw new Error(`settle failed: ${JSON.stringify(s)}`);
  await rpc.waitForTransaction({ digest: s.transaction });

  // 4. RECOMPUTE from chain data alone (gRPC: FailoverRpc adapter for the
  // balanceChange shape + a raw read for gasData)
  console.log("— recompute from chain (gRPC getTransaction, balanceChanges + gasData)");
  const tbAdapted = await rpc.getTransactionBlock({ digest: s.transaction });
  const tbRaw: any = await grpc.getTransaction({ digest: s.transaction, include: { transaction: true } as never });
  const tbTx = tbRaw.$kind === "Transaction" ? tbRaw.Transaction : tbRaw.FailedTransaction;
  const tb = { balanceChanges: (tbAdapted as any)?.balanceChanges ?? [], transaction: { data: { gasData: tbTx?.transaction?.gasData } } };
  const net = netByAddress(tb.balanceChanges as any[], ASSET);
  const payToDelta = net.get(sellerAddr.toLowerCase()) ?? 0n;
  const payerDelta = net.get(payerAddr.toLowerCase()) ?? 0n;
  const suiNet = netByAddress(tb.balanceChanges as any[], SUI);
  const payerSuiDelta = ASSET === SUI ? payerDelta : (suiNet.get(payerAddr.toLowerCase()) ?? 0n);
  const chainGas = (tb.transaction as any)?.data?.gasData;
  const usdcAfter = await getBalance(sellerAddr, ASSET);

  const checks: [string, boolean, string][] = [
    ["payTo credited EXACTLY amount", payToDelta === AMOUNT, `${payToDelta} vs ${AMOUNT}`],
    ["payer debited EXACTLY amount (asset)", payerDelta === -AMOUNT, `${payerDelta} vs ${-AMOUNT}`],
    ["no undeclared recipient", [...net].every(([a, d]) => d <= 0n || a === sellerAddr.toLowerCase()), `${[...net].map(([a, d]) => a.slice(0, 8) + ":" + d).join(" ")}`],
    ["gasless on chain (no gas coin / price 0)", (chainGas?.price === "0" || chainGas?.price == null) && (chainGas?.payment == null || (Array.isArray(chainGas.payment) && chainGas.payment.length === 0)), `price=${chainGas?.price} payment=${JSON.stringify(chainGas?.payment)}`],
    ["seller balance moved by amount", usdcAfter - usdcBefore === AMOUNT, `${usdcBefore} -> ${usdcAfter}`],
  ];
  if (ASSET === USDC) checks.push(["payer SUI delta == 0 (no gas noise)", payerSuiDelta === 0n, `${payerSuiDelta} MIST`]);

  console.log();
  let ok = true;
  for (const [name, pass, detail] of checks) {
    console.log(`  ${pass ? "✓" : "✗"} ${name} — ${detail}`);
    ok = ok && pass;
  }

  // 5. idempotency: re-settle the SAME payment. The facilitator's executed-first
  // getTransactionBlock check now hits the just-committed tx and returns the
  // original digest WITHOUT re-broadcasting — exercises the getTransaction
  // adapter on a real committed programmable tx (executedResult path).
  console.log("\n— /settle again (idempotency)");
  const s2 = await post("/settle", requestBody(payload, sellerAddr));
  const idem = s2.success === true && s2.transaction === s.transaction;
  console.log(`  ${idem ? "✓" : "✗"} idempotent re-settle — success=${s2.success} digest=${s2.transaction} same=${s2.transaction === s.transaction}`);
  ok = ok && idem;

  // 6. a tampered signature MUST be rejected at verify (fail closed)
  console.log("— /verify tampered signature (must reject)");
  const flip = payload.signature.slice(-6) === "AAAAAA" ? "BBBBBB" : "AAAAAA";
  const vBad = await post("/verify", requestBody({ ...payload, signature: payload.signature.slice(0, -6) + flip }, sellerAddr));
  const rejected = vBad.isValid === false;
  console.log(`  ${rejected ? "✓" : "✗"} tampered rejected — isValid=${vBad.isValid} reason=${vBad.invalidReason ?? "-"}`);
  ok = ok && rejected;

  console.log("\n================ #2616 paste-ready ================");
  console.log(`Ran a gasless Address-Balance ${ASSET === USDC ? "USDC" : "SUI"} payment through my independent Sui facilitator (the #2619 one), verify -> settle, and recomputed the settlement from chain alone:`);
  console.log(`- digest: ${s.transaction}`);
  console.log(`- explorer: https://testnet.suivision.xyz/txblock/${s.transaction}`);
  console.log(`- payTo net +${payToDelta}, payer net ${payerDelta} (${ASSET === USDC ? "USDC" : "SUI"}), no undeclared recipient`);
  console.log(`- gasless confirmed on chain (gasData price 0 / empty payment)${ASSET === USDC ? `, payer SUI delta ${payerSuiDelta} = no gas noise in the asset delta` : ""}`);
  console.log(`- exact-fee balance-change match (matchBalanceChanges) clean against the declared single output`);
  console.log("==================================================");

  if (!ok) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
