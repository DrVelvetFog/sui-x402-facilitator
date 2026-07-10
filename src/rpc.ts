/**
 * RPC failover over Sui **gRPC**. Wraps an ordered list of Sui fullnode gRPC
 * endpoints: each call tries the primary, and on a *transport* failure
 * (unavailable, deadline, network error) falls through to the next. A
 * deterministic gRPC status (NOT_FOUND, INVALID_ARGUMENT — a real protocol
 * rejection) is NOT retried: every honest node answers the same, so failing
 * over would only hide the real reason.
 *
 * Transport note: gRPC replaced JSON-RPC because Mysten retired the public
 * JSON-RPC endpoints on fullnode.*.sui.io (testnet week of 2026-07-06, mainnet
 * week of 07-20) — gRPC on the same hosts is unaffected. Each method adapts the
 * gRPC result back into the small JSON-RPC response shape facilitator.ts already
 * consumes (`effects.status`, `balanceChanges[].owner.AddressOwner`,
 * `input.sender` / `transaction.data.sender`), so verify/settle stay
 * transport-agnostic.
 *
 * Only the four methods the facilitator uses are exposed. A per-call timeout
 * turns a hung endpoint into a fast failover instead of a stuck settle.
 */
import { SuiGrpcClient } from "@mysten/sui/grpc";
import type {
  DryRunTransactionBlockResponse, SuiTransactionBlockResponse,
} from "@mysten/sui/jsonRpc";

const CALL_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS ?? 20_000);

/** gRPC statuses every honest node answers identically — a protocol rejection,
 * not a transport hiccup. Don't fail over on these. */
const DETERMINISTIC = new Set([
  "NOT_FOUND", "INVALID_ARGUMENT", "FAILED_PRECONDITION", "OUT_OF_RANGE",
  "ALREADY_EXISTS", "PERMISSION_DENIED", "UNAUTHENTICATED",
]);

function grpcCode(err: any): string | undefined {
  const c = err?.code ?? err?.status;
  return typeof c === "string" ? c.toUpperCase() : undefined;
}
/** A recognized deterministic status stops failover; anything else (no code =
 * network/timeout) falls through to the next endpoint. */
function isDeterministic(err: any): boolean {
  const c = grpcCode(err);
  return c ? DETERMINISTIC.has(c) : false;
}
/** A tx-lookup MISS: the digest was never committed. Distinct from a transport
 * error, which must NOT read as "not executed" (that would let the replay guard
 * pass an already-settled payment). */
function isNotFound(err: any): boolean {
  if (grpcCode(err) === "NOT_FOUND") return true;
  const m = err?.message;
  return typeof m === "string" && /not found/i.test(m);
}

// --- adapters: gRPC TransactionResult -> the JSON-RPC shapes facilitator.ts reads ---
function txOf(r: any): any {
  return r?.$kind === "Transaction" ? r.Transaction : r.FailedTransaction;
}
function statusOf(tx: any): { status: "success" | "failure"; error?: string } {
  const ok = tx?.status?.success === true;
  return { status: ok ? "success" : "failure", error: tx?.status?.success === false ? tx?.status?.error?.message : undefined };
}
/** gRPC BalanceChange is per-address (`{ coinType, address, amount }`) — every
 * entry is an AddressOwner (the API surfaces no object/shared owner kind). */
function balanceChangesOf(tx: any): any[] {
  return (tx?.balanceChanges ?? []).map((b: any) => ({
    coinType: b.coinType, amount: b.amount, owner: { AddressOwner: b.address },
  }));
}

type GrpcClientOptions = ConstructorParameters<typeof SuiGrpcClient>[0];

export class FailoverRpc {
  private clients: SuiGrpcClient[];
  constructor(urls: string[], network: string) {
    if (urls.length === 0) throw new Error("no RPC urls configured");
    this.clients = urls.map((baseUrl) =>
      new SuiGrpcClient({ network, baseUrl, timeout: CALL_TIMEOUT_MS } as GrpcClientOptions));
  }

  /** Run `op` against each endpoint until one answers or a deterministic error stops us. */
  private async run<T>(op: (c: SuiGrpcClient) => Promise<T>): Promise<T> {
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

  /**
   * Replay guard + idempotent-settle reconstruction. Returns the executed tx
   * adapted to the JSON-RPC shape, or `null` if the digest was never committed
   * (gRPC NOT_FOUND). A *transport* failure THROWS — the caller must fail
   * closed, never read an unreachable node as "not executed".
   */
  async getTransactionBlock(input: { digest: string }): Promise<SuiTransactionBlockResponse | null> {
    try {
      const r = await this.run((c) => c.getTransaction({
        digest: input.digest,
        include: { balanceChanges: true, transaction: true },
      }));
      const tx = txOf(r);
      return {
        digest: tx.digest,
        transaction: { data: { sender: tx.transaction?.sender } },
        effects: { status: statusOf(tx) },
        balanceChanges: balanceChangesOf(tx),
      } as unknown as SuiTransactionBlockResponse;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async dryRunTransactionBlock(input: { transactionBlock: Uint8Array }): Promise<DryRunTransactionBlockResponse> {
    const r = await this.run((c) => c.simulateTransaction({
      transaction: input.transactionBlock,
      include: { balanceChanges: true, transaction: true },
    }));
    const tx = txOf(r);
    return {
      input: { sender: tx.transaction?.sender },
      effects: { status: statusOf(tx) },
      balanceChanges: balanceChangesOf(tx),
    } as unknown as DryRunTransactionBlockResponse;
  }

  async executeTransactionBlock(input: { transactionBlock: Uint8Array; signature: string }): Promise<SuiTransactionBlockResponse> {
    // Re-broadcasting an already-executed gasless tx THROWS over gRPC (unlike
    // JSON-RPC). settle() guards this with an executed-first getTransactionBlock
    // check, so execute only runs for a not-yet-committed tx.
    const r = await this.run((c) => c.executeTransaction({
      transaction: input.transactionBlock,
      signatures: [input.signature],
      include: { balanceChanges: true },
    }));
    const tx = txOf(r);
    return {
      digest: tx.digest,
      effects: { status: statusOf(tx) },
      balanceChanges: balanceChangesOf(tx),
    } as unknown as SuiTransactionBlockResponse;
  }

  /** waitForTransaction has its own poll semantics — the gRPC client's native
   * wait shares the base CoreClient poll, so patience matches the old transport. */
  async waitForTransaction(input: { digest: string; timeout?: number }): Promise<SuiTransactionBlockResponse> {
    const r = await this.run((c) => c.waitForTransaction({ digest: input.digest }));
    const tx = txOf(r);
    return { digest: tx.digest, effects: { status: statusOf(tx) } } as unknown as SuiTransactionBlockResponse;
  }
}
