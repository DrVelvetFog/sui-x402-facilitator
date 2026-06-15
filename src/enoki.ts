/**
 * Enoki gas-station client — sponsors a payer's partial payment transaction so
 * agents don't need SUI for gas (scheme_exact_sui.md, "Sponsored Transactions").
 *
 * Custody note: the Enoki sponsor key pays GAS ONLY. The payment (the coin
 * transfer to `payTo`) lives in the payer-signed transaction; the sponsor signs
 * the SAME bytes and cannot redirect funds. Sponsorship is disabled unless
 * ENOKI_KEY is set, so the facilitator's verify/settle stay key-free for
 * ordinary (unsponsored) payments — the proven path is unchanged.
 */
const ENOKI_API = "https://api.enoki.mystenlabs.com/v1";
const ENOKI_KEY = process.env.ENOKI_KEY ?? "";

export function sponsorshipEnabled(): boolean {
  return ENOKI_KEY.length > 0;
}

async function enoki(path: string, body: unknown): Promise<any> {
  const r = await fetch(`${ENOKI_API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ENOKI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) throw new Error(data?.errors?.[0]?.message ?? `enoki ${r.status}`);
  return data?.data ?? {};
}

/**
 * Fill gas on a client's partial payment tx. `network` is the bare Sui network
 * ("testnet" | "mainnet"). Returns the full sponsored tx bytes for the client
 * to sign, plus the digest Enoki tracks it under (used at execute time).
 */
export async function sponsor(
  network: string,
  transactionKindBytes: string,
  sender: string,
  allowedAddresses: string[] = [sender],
): Promise<{ bytes: string; digest: string }> {
  const d = await enoki("/transaction-blocks/sponsor", {
    network,
    transactionBlockKindBytes: transactionKindBytes,
    sender,
    // Enoki guardrail: addresses the sponsored tx may touch (e.g. receive a
    // transfer). A payment pays a seller, so the payee must be allow-listed
    // alongside the payer — otherwise Enoki rejects the recipient.
    allowedAddresses,
  });
  return { bytes: d.bytes, digest: d.digest };
}

/** Add the sponsor signature to a sponsored tx and broadcast it. */
export async function executeSponsored(digest: string, signature: string): Promise<string> {
  const d = await enoki(`/transaction-blocks/sponsor/${digest}`, { signature });
  return d.digest ?? digest;
}
