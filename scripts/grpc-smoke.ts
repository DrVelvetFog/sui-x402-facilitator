/**
 * gRPC migration smoke — exercises the migrated FailoverRpc against REAL Sui
 * testnet gRPC, funds-free (uses the testnet SUI faucet). Validates the
 * load-bearing bits of the JSON-RPC -> gRPC migration:
 *   1. getTransactionBlock adapter over a FRESH real tx (sender + effects.status
 *      + balanceChanges shape facilitator.ts consumes)
 *   2. dryRunTransactionBlock adapter over a freshly built, valid tx (verify path)
 *   3. NOT_FOUND -> null (the replay-guard safety path: a well-formed but
 *      never-committed digest is null, not a throw)
 *
 *   npx tsx scripts/grpc-smoke.ts
 */
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { getFaucetHost, requestSuiFromFaucetV2, FaucetRateLimitError } from "@mysten/sui/faucet";
import { FailoverRpc } from "../src/rpc.js";

const RPC = process.env.SUI_TESTNET_RPC ?? "https://fullnode.testnet.sui.io:443";
// base58 of 32 zero-bytes: a well-formed digest that was never committed.
const NEVER = "11111111111111111111111111111111";

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const rpc = new FailoverRpc([RPC], "testnet");
const raw = new SuiGrpcClient({ network: "testnet", baseUrl: RPC } as any);

// --- fund a throwaway address; the faucet tx is our fresh, real testnet tx ---
const kp = new Ed25519Keypair();
const addr = kp.toSuiAddress();
let fundingDigest: string | null = null;
try {
  const res = await requestSuiFromFaucetV2({ host: getFaucetHost("testnet"), recipient: addr });
  fundingDigest = res.status === "Success" ? res.coins_sent?.[0]?.transferTxDigest ?? null : null;
  ok("faucet funded throwaway address", !!fundingDigest, fundingDigest ?? String(res.status));
} catch (e: any) {
  ok("faucet funded throwaway address", false, e instanceof FaucetRateLimitError ? "RATE LIMITED (skipping fund-dependent checks)" : `${e?.message ?? e}`);
}

// 1. getTransactionBlock adapter over the FRESH funding tx (poll until it lands)
if (fundingDigest) {
  let tx: any = null;
  for (let i = 0; i < 15 && !tx; i++) { tx = await rpc.getTransactionBlock({ digest: fundingDigest }); if (!tx) await sleep(2000); }
  ok("getTransactionBlock returns the fresh tx (not null)", !!tx, fundingDigest);
  if (tx) {
    ok("  .digest matches", tx.digest === fundingDigest);
    ok("  .transaction.data.sender present", typeof tx.transaction?.data?.sender === "string", tx.transaction?.data?.sender);
    ok("  .effects.status.status === 'success'", tx.effects?.status?.status === "success");
    const bcs: any[] = tx.balanceChanges ?? [];
    ok("  balanceChanges carry {owner.AddressOwner, coinType, amount}",
      bcs.length > 0 && bcs.every((b) => typeof b?.owner?.AddressOwner === "string" && "coinType" in b && "amount" in b),
      `${bcs.length} changes`);
    const toAddr = bcs.filter((b) => b.owner.AddressOwner === addr);
    ok("  a credit to the recipient parses as BigInt", toAddr.length > 0 && toAddr.every((b) => { try { BigInt(b.amount); return true; } catch { return false; } }),
      toAddr.map((b) => b.amount).join(","));
  }

  // 2. dryRunTransactionBlock adapter over a freshly BUILT, valid tx (verify path)
  await sleep(1500);
  try {
    const t = new Transaction();
    t.setSender(addr);
    const [c] = t.splitCoins(t.gas, [1000]);
    t.transferObjects([c], addr);
    const bytes = await t.build({ client: raw as any });
    const dry: any = await rpc.dryRunTransactionBlock({ transactionBlock: bytes });
    ok("dryRunTransactionBlock: input.sender === payer", dry.input?.sender === addr, dry.input?.sender);
    ok("dryRunTransactionBlock: effects.status.status === 'success'", dry.effects?.status?.status === "success", dry.effects?.status?.error ?? "");
    ok("dryRunTransactionBlock: balanceChanges shaped", Array.isArray(dry.balanceChanges) && dry.balanceChanges.every((b: any) => typeof b?.owner?.AddressOwner === "string"));
  } catch (e: any) {
    ok("dryRunTransactionBlock over a fresh built tx", false, `${e?.message ?? e}`);
  }
}

// 1b. Faucet-independent adapter check: the Clock object (0x6) is mutated every
// checkpoint, so its previousTransaction is always a fresh, in-window tx. Proves
// the getTransactionBlock adapter parses real gRPC results (digest/status/
// balanceChanges shape) even when the faucet is rate-limited.
try {
  const clock: any = await raw.getObject({ objectId: "0x6", include: { previousTransaction: true } as any });
  const prev: string | null = clock?.object?.previousTransaction ?? clock?.previousTransaction ?? null;
  ok("Clock 0x6 yields a fresh previousTransaction digest", typeof prev === "string", prev ?? "");
  if (prev) {
    const ctx: any = await rpc.getTransactionBlock({ digest: prev });
    ok("  getTransactionBlock parses the fresh tx (not null)", !!ctx, prev);
    if (ctx) {
      ok("    .digest matches", ctx.digest === prev);
      ok("    .effects.status.status === 'success'", ctx.effects?.status?.status === "success");
      ok("    .balanceChanges is an array", Array.isArray(ctx.balanceChanges));
      ok("    .transaction.data.sender field present (string|null)", "sender" in (ctx.transaction?.data ?? {}));
    }
  }
} catch (e: any) {
  ok("Clock-based adapter check", false, `${e?.message ?? e}`);
}

// 3. NOT_FOUND -> null (well-formed digest, never committed) — must NOT throw
try {
  const miss = await rpc.getTransactionBlock({ digest: NEVER });
  ok("NOT_FOUND maps to null (never-committed digest, no throw)", miss === null);
} catch (e: any) {
  ok("NOT_FOUND maps to null (never-committed digest, no throw)", false, `threw ${e?.code ?? ""}: ${e?.message ?? e}`);
}

console.log(failures === 0 ? "\nALL GREEN — gRPC transport + adapters + NOT_FOUND semantics verified on live testnet" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
