/**
 * RPC failover. Wraps an ordered list of Sui fullnodes: each call tries the
 * primary, and on a *transport* failure (network error, timeout, 5xx, 429)
 * falls through to the next endpoint. Deterministic JSON-RPC errors (a real
 * protocol-level rejection — object not found, bad params, tx validation
 * failure) are NOT retried: every honest node returns the same answer, so
 * failing over would only hide the real reason.
 *
 * Only the four methods the facilitator uses are exposed. A per-call timeout
 * turns a hung endpoint into a fast failover instead of a stuck settle.
 */
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import type {
  DryRunTransactionBlockParams, DryRunTransactionBlockResponse,
  ExecuteTransactionBlockParams, GetTransactionBlockParams, SuiTransactionBlockResponse,
} from "@mysten/sui/jsonRpc";

const CALL_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS ?? 20_000);

/** A deterministic JSON-RPC error answers the same on every node — don't failover. */
function isDeterministic(err: any): boolean {
  if (typeof err?.code === "number") return true;          // JsonRpcError (protocol-level)
  if (typeof err?.status === "number") return err.status < 500 && err.status !== 429; // 4xx (not rate-limit)
  return false;                                            // network / timeout / abort -> failover
}

function withTimeout(signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(CALL_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, t]) : t;
}

export class FailoverRpc {
  private clients: SuiJsonRpcClient[];
  constructor(urls: string[], network: string) {
    if (urls.length === 0) throw new Error("no RPC urls configured");
    this.clients = urls.map((url) => new SuiJsonRpcClient({ url, network }));
  }

  /** Run `op` against each endpoint until one answers or a deterministic error stops us. */
  private async run<T>(op: (c: SuiJsonRpcClient) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < this.clients.length; i++) {
      try {
        return await op(this.clients[i]);
      } catch (err) {
        lastErr = err;
        if (isDeterministic(err) || i === this.clients.length - 1) throw err;
        console.warn(`rpc endpoint ${i} failed (${(err as any)?.message ?? err}); trying next`);
      }
    }
    throw lastErr;
  }

  getTransactionBlock(input: GetTransactionBlockParams): Promise<SuiTransactionBlockResponse> {
    return this.run((c) => c.getTransactionBlock({ ...input, signal: withTimeout(input.signal) }));
  }
  dryRunTransactionBlock(input: DryRunTransactionBlockParams): Promise<DryRunTransactionBlockResponse> {
    return this.run((c) => c.dryRunTransactionBlock({ ...input, signal: withTimeout(input.signal) }));
  }
  executeTransactionBlock(input: ExecuteTransactionBlockParams): Promise<SuiTransactionBlockResponse> {
    // Safe to retry across endpoints: broadcast is idempotent by digest (a
    // re-submit of an already-landed tx returns its result or fails closed on
    // consumed coins), and settle re-reads the chain to reconstruct the result.
    return this.run((c) => c.executeTransactionBlock({ ...input, signal: withTimeout(input.signal) }));
  }
  /** waitForTransaction has its own timeout semantics — don't impose the per-call one. */
  waitForTransaction(input: { digest: string; timeout?: number; signal?: AbortSignal }): Promise<SuiTransactionBlockResponse> {
    return this.run((c) => c.waitForTransaction(input));
  }
}
