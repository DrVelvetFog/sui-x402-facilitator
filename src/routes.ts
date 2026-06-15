/**
 * Facilitator routes as an importable handler so the Render deploy can mux
 * the facilitator and the demo API onto one service/port (serve-all.ts at the
 * repo root). Returns false when the request isn't ours.
 */
import http from "node:http";
import { NETWORKS } from "./config.js";
import { settle, supported, verify } from "./facilitator.js";
import { sponsor, executeSponsored, sponsorshipEnabled } from "./enoki.js";

const MAX_BODY = 256 * 1024; // signed Sui tx payloads are ~2–6 KB; be generous
const RATE_LIMIT = Number(process.env.RATE_LIMIT ?? 120); // requests per IP per minute
const buckets = new Map<string, { min: number; n: number }>();

function rateLimited(ip: string): boolean {
  const min = Math.floor(Date.now() / 60_000);
  const b = buckets.get(ip);
  if (!b || b.min !== min) { buckets.set(ip, { min, n: 1 }); return false; }
  if (buckets.size > 50_000) buckets.clear();
  return ++b.n > RATE_LIMIT;
}

// Per-sender daily cap on sponsorship — the gas station pays real gas, so an
// open endpoint is a free-gas faucet without this. Mirrors the Acre control.
const SPONSOR_DAILY_CAP = Number(process.env.SPONSOR_DAILY_CAP ?? 60);
const sponsorCount = new Map<string, { day: number; n: number }>();
function sponsorAllowed(addr: string): boolean {
  const day = Math.floor(Date.now() / 86_400_000);
  const e = sponsorCount.get(addr);
  if (!e || e.day !== day) { sponsorCount.set(addr, { day, n: 1 }); return true; }
  if (sponsorCount.size > 50_000) sponsorCount.clear();
  if (e.n >= SPONSOR_DAILY_CAP) return false;
  e.n++; return true;
}

export function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, payment-signature, por-proof",
    "access-control-allow-methods": "POST, GET, OPTIONS",
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) throw new Error("body too large");
  }
  return JSON.parse(raw);
}

export function facilitatorInfo() {
  return {
    service: "sui-x402-facilitator",
    networks: NETWORKS.map((n) => n.id),
    custody: "none — relays the payer's own signed transaction",
    fees: "none",
    terms: "https://github.com/DrVelvetFog/sui-x402-facilitator/blob/main/TERMS.md",
  };
}

/** Handle /supported, /verify, /settle. False = not a facilitator route. */
export async function facilitatorRoutes(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const isVerify = url.pathname === "/verify";
  const isSettle = url.pathname === "/settle";

  if (req.method === "GET" && url.pathname === "/supported") {
    json(res, 200, supported());
    return true;
  }
  if (req.method === "POST" && (isVerify || isSettle)) {
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "?";
    if (rateLimited(ip)) { json(res, 429, { error: "rate limited" }); return true; }
    let body: any;
    try { body = await readBody(req); } catch {
      json(res, 400, isVerify
        ? { isValid: false, invalidReason: "invalid_payload" }
        : { success: false, errorReason: "invalid_payload", transaction: "", network: "" });
      return true;
    }
    json(res, 200, isVerify ? await verify(body) : await settle(body));
    return true;
  }
  // Optional gas station (scheme_exact_sui.md): fill gas on a client's partial
  // payment tx via Enoki so agents don't need SUI. Sponsor key pays gas only.
  if (req.method === "POST" && url.pathname === "/gas-station") {
    if (!sponsorshipEnabled()) { json(res, 503, { error: "sponsorship not configured" }); return true; }
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "?";
    if (rateLimited(ip)) { json(res, 429, { error: "rate limited" }); return true; }
    let body: any;
    try { body = await readBody(req); } catch { json(res, 400, { error: "invalid_payload" }); return true; }
    const { sender, transactionKindBytes, network, recipients } = body ?? {};
    if (typeof sender !== "string" || typeof transactionKindBytes !== "string" || typeof network !== "string") {
      json(res, 400, { error: "sender, transactionKindBytes, network required" }); return true;
    }
    const net = NETWORKS.find((n) => n.id === network);
    if (!net) { json(res, 400, { error: "unsupported network" }); return true; }
    if (!sponsorAllowed(sender)) { json(res, 429, { error: "daily sponsorship limit reached" }); return true; }
    // Allow-list the payer plus any declared payees so Enoki permits the payment
    // recipient. The caller scopes its own payees; gas spend is capped above.
    const allowed = [sender, ...(Array.isArray(recipients) ? recipients.filter((r: unknown) => typeof r === "string") : [])];
    try {
      json(res, 200, await sponsor(net.id.split(":")[1], transactionKindBytes, sender, allowed));
    } catch (e: any) {
      json(res, 502, { error: String(e?.message ?? e) });
    }
    return true;
  }
  // Execute half of the gas station: the client signs the sponsored bytes from
  // /gas-station, then posts {digest, signature} here. Enoki adds the sponsor
  // signature it already holds for `digest` and broadcasts. Key pays gas only.
  if (req.method === "POST" && url.pathname === "/gas-station/execute") {
    if (!sponsorshipEnabled()) { json(res, 503, { error: "sponsorship not configured" }); return true; }
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "?";
    if (rateLimited(ip)) { json(res, 429, { error: "rate limited" }); return true; }
    let body: any;
    try { body = await readBody(req); } catch { json(res, 400, { error: "invalid_payload" }); return true; }
    const { digest, signature } = body ?? {};
    if (typeof digest !== "string" || typeof signature !== "string") {
      json(res, 400, { error: "digest, signature required" }); return true;
    }
    try {
      json(res, 200, { digest: await executeSponsored(digest, signature) });
    } catch (e: any) {
      json(res, 502, { error: String(e?.message ?? e) });
    }
    return true;
  }
  return false;
}
