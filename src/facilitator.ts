/**
 * Sui `exact` scheme verify/settle core (scheme_exact_sui.md).
 *
 * Non-custodial by construction: the payload carries the payer's complete
 * signed transaction; we can only simulate it (verify) or broadcast it
 * verbatim (settle). There is no key material in this service and no way to
 * redirect funds — the payer signed the exact bytes we relay.
 *
 * verify = one dry-run RPC + local signature check + balance-change assertion.
 * settle = re-verify (the verify→settle gap: coins may have been consumed or
 * object versions gone stale since the resource server called /verify) →
 * broadcast → re-assert effects + balance changes from execution truth.
 * Idempotency: settles are deduped on the exact transaction bytes (same bytes
 * ⇒ same digest), with the in-flight promise cached so concurrent settles of
 * the same payment collapse into one broadcast.
 */
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { verifyTransactionSignature } from "@mysten/sui/verify";
import { fromBase64, normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { NETWORKS, networkById, type NetworkConfig } from "./config.js";
import { FailoverRpc } from "./rpc.js";
import { ERR, type PaymentRequirements, type SettleResponse, type VerifySettleRequest, type VerifyResponse } from "./x402.js";

const clients = new Map<string, FailoverRpc>();
function rpc(net: NetworkConfig): FailoverRpc {
  let c = clients.get(net.id);
  if (!c) { c = new FailoverRpc(net.rpcUrls, net.id.split(":")[1]); clients.set(net.id, c); }
  return c;
}

class Invalid extends Error {
  constructor(public reason: string, public payer?: string, detail?: string) {
    super(detail ?? reason);
  }
}

/** Sum of balance changes credited to `payTo` in `asset` (atomic units). */
function receivedBy(balanceChanges: any[], payTo: string, asset: string): bigint | null {
  const to = normalizeSuiAddress(payTo);
  const coin = normalizeStructTag(asset);
  let found = false;
  let sum = 0n;
  for (const bc of balanceChanges ?? []) {
    const owner = bc?.owner?.AddressOwner;
    if (typeof owner !== "string" || normalizeSuiAddress(owner) !== to) continue;
    if (normalizeStructTag(bc.coinType) !== coin) continue;
    found = true;
    sum += BigInt(bc.amount);
  }
  return found ? sum : null;
}

/** Reconstruct a settle outcome from an already-executed transaction. */
function executedResult(r: any, req: PaymentRequirements, networkId: string): SettleResponse {
  const payer = r.transaction?.data?.sender;
  if (r.effects?.status?.status !== "success") {
    return { success: false, errorReason: ERR.invalidTxState, ...(payer ? { payer } : {}), transaction: r.digest, network: networkId };
  }
  const received = receivedBy(r.balanceChanges ?? [], req.payTo, req.asset);
  if (received === null || received < BigInt(req.amount)) {
    return { success: false, errorReason: ERR.suiValue, ...(payer ? { payer } : {}), transaction: r.digest, network: networkId };
  }
  return { success: true, payer, transaction: r.digest, network: networkId, amount: received.toString() };
}

function checkStructure(body: VerifySettleRequest): { req: PaymentRequirements; net: NetworkConfig; txBytes: Uint8Array; signature: string } {
  const { x402Version, paymentPayload, paymentRequirements: req } = body ?? ({} as VerifySettleRequest);
  if (x402Version !== 2 || paymentPayload?.x402Version !== 2) throw new Invalid(ERR.invalidVersion);
  if (!req || typeof req !== "object") throw new Invalid(ERR.invalidRequirements);
  if (req.scheme !== "exact") throw new Invalid(ERR.unsupportedScheme);
  const net = networkById(req.network);
  if (!net) throw new Invalid(ERR.invalidNetwork);
  let amount: bigint;
  try { amount = BigInt(req.amount); } catch { throw new Invalid(ERR.invalidRequirements); }
  if (amount <= 0n || typeof req.payTo !== "string" || typeof req.asset !== "string") {
    throw new Invalid(ERR.invalidRequirements);
  }
  // The payload's `accepted` must be the requirements we're asked to enforce —
  // a mismatch means the client agreed to different terms than the server sent us.
  const acc = paymentPayload.accepted;
  if (!acc || acc.scheme !== req.scheme || acc.network !== req.network ||
      acc.amount !== req.amount || normalizeStructTag(acc.asset) !== normalizeStructTag(req.asset) ||
      normalizeSuiAddress(acc.payTo) !== normalizeSuiAddress(req.payTo)) {
    throw new Invalid(ERR.invalidRequirements);
  }
  const { transaction, signature } = paymentPayload.payload ?? ({} as any);
  if (typeof transaction !== "string" || typeof signature !== "string" ||
      transaction.length === 0 || transaction.length > 120_000) {
    throw new Invalid(ERR.invalidPayload);
  }
  let txBytes: Uint8Array;
  try { txBytes = fromBase64(transaction); } catch { throw new Invalid(ERR.invalidPayload); }
  return { req, net, txBytes, signature };
}

/**
 * Full verification per the scheme spec: structure → signature over the tx
 * bytes → dry-run (catches expired/already-executed/consumed-coin txs: stale
 * object versions fail the simulation) → payTo receives ≥ amount of asset.
 * Returns the payer and the simulated received amount.
 */
async function verifyCore(body: VerifySettleRequest, opts: { skipExecutedCheck?: boolean } = {}): Promise<{ payer: string; received: bigint; net: NetworkConfig; txBytes: Uint8Array; signature: string; req: PaymentRequirements }> {
  const { req, net, txBytes, signature } = checkStructure(body);
  const client = rpc(net);

  // Scheme spec step 3 ("not already executed"): dry-run alone can't catch
  // this — the fullnode simulates against LATEST object versions, so a spent
  // payment still simulates cleanly. The tx digest is deterministic from the
  // bytes; if the chain already knows it, this payment is used up.
  if (!opts.skipExecutedCheck) {
    const digest = TransactionDataBuilder.getDigestFromBytes(txBytes);
    // null = never committed (gRPC NOT_FOUND); a transport error THROWS and
    // fails verify closed — we must not pass a payment we couldn't check.
    const known = await client.getTransactionBlock({ digest });
    if (known) throw new Invalid(ERR.invalidTxState, undefined, `already executed: ${digest}`);
  }

  // One RPC does the heavy lifting: sender, execution status, balance changes.
  let dry: any;
  try {
    dry = await client.dryRunTransactionBlock({ transactionBlock: txBytes });
  } catch (e: any) {
    throw new Invalid(ERR.invalidTxState, undefined, `dry run failed: ${e?.message ?? e}`);
  }
  const payer: string = dry.input?.sender;
  if (dry.effects?.status?.status !== "success") {
    throw new Invalid(ERR.invalidTxState, payer, `simulation: ${dry.effects?.status?.error ?? dry.executionErrorSource ?? "failed"}`);
  }

  // The signature must be the payer's, over exactly these bytes. (Execution
  // would also reject a bad signature, but verify must fail closed pre-settle.)
  try {
    const pk = await verifyTransactionSignature(txBytes, signature, { address: payer });
    if (normalizeSuiAddress(pk.toSuiAddress()) !== normalizeSuiAddress(payer)) throw new Error("signer != sender");
  } catch (e: any) {
    throw new Invalid(ERR.suiSignature, payer, `signature: ${e?.message ?? e}`);
  }

  const received = receivedBy(dry.balanceChanges, req.payTo, req.asset);
  if (received === null) throw new Invalid(ERR.suiRecipient, payer);
  if (received < BigInt(req.amount)) throw new Invalid(ERR.insufficientFunds, payer);
  return { payer, received, net, txBytes, signature, req };
}

export async function verify(body: VerifySettleRequest): Promise<VerifyResponse> {
  try {
    const { payer } = await verifyCore(body);
    return { isValid: true, payer };
  } catch (e: any) {
    if (e instanceof Invalid) {
      if (e.message !== e.reason) console.log(`verify rejected (${e.reason}): ${e.message}`);
      return { isValid: false, invalidReason: e.reason, ...(e.payer ? { payer: e.payer } : {}) };
    }
    console.error("verify error:", e);
    return { isValid: false, invalidReason: ERR.unexpectedVerify };
  }
}

// Idempotency: same transaction bytes ⇒ same Sui digest ⇒ same settlement.
// The promise goes in the cache before the broadcast so a concurrent settle
// of the same payment awaits the first one instead of double-broadcasting
// (the second broadcast would fail on consumed coins anyway — Sui's digest
// uniqueness is the real replay protection; this cache just makes retries
// return the original result instead of an error).
const SETTLE_CACHE_MAX = 10_000;
const settled = new Map<string, Promise<SettleResponse>>();

export async function settle(body: VerifySettleRequest): Promise<SettleResponse> {
  const network = body?.paymentRequirements?.network ?? "";
  const rawTx = body?.paymentPayload?.payload?.transaction;
  if (typeof rawTx !== "string" || rawTx.length === 0) {
    return { success: false, errorReason: ERR.invalidPayload, transaction: "", network };
  }
  // Idempotency key = the 32-byte tx digest, not the full base64 (≤120 KB):
  // same bytes ⇒ same digest, and the small key bounds cache memory.
  let key: string;
  try { key = TransactionDataBuilder.getDigestFromBytes(fromBase64(rawTx)); }
  catch { return { success: false, errorReason: ERR.invalidPayload, transaction: "", network }; }
  const hit = settled.get(key);
  if (hit) return hit;

  const run = (async (): Promise<SettleResponse> => {
    try {
      const { req, net, txBytes } = checkStructure(body);
      const client = rpc(net);

      // Durable idempotency: a settle retry after a restart (cache gone) finds
      // the payment already on-chain and gets the original outcome back
      // instead of an error — reconstructed from execution truth.
      const digest = TransactionDataBuilder.getDigestFromBytes(txBytes);
      // null = not yet on-chain (gRPC NOT_FOUND); a transport error THROWS to
      // the outer catch (fail closed) rather than reading as "no prior" and
      // risking a double broadcast.
      const prior = await client.getTransactionBlock({ digest });
      if (prior) {
        console.log(`settle: ${digest} already on-chain — returning prior result`);
        return executedResult(prior, req, net.id);
      }

      // Re-verify immediately before broadcast — the verify→settle gap.
      const { payer, signature } = await verifyCore(body, { skipExecutedCheck: true });
      const r = await client.executeTransactionBlock({
        transactionBlock: txBytes,
        signature,
      });
      await client.waitForTransaction({ digest: r.digest, timeout: req.maxTimeoutSeconds > 0 ? req.maxTimeoutSeconds * 1000 : 60_000 });
      if (r.effects?.status?.status !== "success") {
        console.log(`settle failed on-chain ${r.digest}: ${r.effects?.status?.error}`);
        return { success: false, errorReason: ERR.invalidTxState, payer, transaction: r.digest, network: net.id };
      }
      // Execution truth beats simulation: re-assert what payTo actually got.
      const received = receivedBy(r.balanceChanges ?? [], req.payTo, req.asset);
      if (received === null || received < BigInt(req.amount)) {
        console.error(`settle ${r.digest}: executed but payTo received ${received ?? "nothing"} < ${req.amount}`);
        return { success: false, errorReason: ERR.suiValue, payer, transaction: r.digest, network: net.id };
      }
      console.log(`settled ${r.digest}: ${payer.slice(0, 10)}… paid ${received} ${req.asset.split("::").pop()} on ${net.id}`);
      return { success: true, payer, transaction: r.digest, network: net.id, amount: received.toString() };
    } catch (e: any) {
      if (e instanceof Invalid) {
        if (e.message !== e.reason) console.log(`settle rejected (${e.reason}): ${e.message}`);
        return { success: false, errorReason: e.reason, ...(e.payer ? { payer: e.payer } : {}), transaction: "", network };
      }
      console.error("settle error:", e);
      return { success: false, errorReason: ERR.unexpectedSettle, transaction: "", network };
    }
  })();

  settled.set(key, run);
  if (settled.size > SETTLE_CACHE_MAX) {
    const oldest = settled.keys().next().value;
    if (oldest !== undefined) settled.delete(oldest);
  }
  const result = await run;
  // A rejection that never broadcast isn't a settlement — let the client fix
  // the payment and retry with the same bytes (e.g. after topping up gas).
  if (!result.success && result.transaction === "") settled.delete(key);
  return result;
}

export function supported() {
  return {
    kinds: NETWORKS.map((n) => ({
      x402Version: 2,
      scheme: "exact",
      network: n.id,
      extra: { usdc: n.usdc, decimals: 6 },
    })),
    extensions: [],
    // No signers: the facilitator never co-signs (no gas-station sponsorship
    // yet) and holds no keys.
    signers: { "sui:*": [] },
  };
}
