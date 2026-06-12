/**
 * Facilitator routes as an importable handler so the Render deploy can mux
 * the facilitator and the demo API onto one service/port (serve-all.ts at the
 * repo root). Returns false when the request isn't ours.
 */
import http from "node:http";
import { NETWORKS } from "./config.js";
import { settle, supported, verify } from "./facilitator.js";

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
  return false;
}
