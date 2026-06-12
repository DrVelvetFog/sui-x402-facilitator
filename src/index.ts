/**
 * sui-x402-facilitator — the x402 v2 facilitator HTTP surface (spec §7):
 *
 *   GET  /supported  capability discovery
 *   POST /verify     { x402Version, paymentPayload, paymentRequirements } -> VerifyResponse
 *   POST /settle     same body -> SettleResponse
 *   GET  /health
 *
 * Semantic failures return 200 with isValid:false / success:false (the spec's
 * response schemas carry the reason); 400 is reserved for unparseable bodies.
 *
 *   PORT             default 4402
 *   ENABLE_MAINNET   "1" adds sui:mainnet (off until the hardening pass)
 *   SUI_TESTNET_RPC / SUI_MAINNET_RPC   RPC overrides
 *   RATE_LIMIT       requests per IP per minute (default 120)
 */
import http from "node:http";
import { PORT, NETWORKS } from "./config.js";
import { facilitatorInfo, facilitatorRoutes, json } from "./routes.js";

const started = Date.now();

http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return json(res, 204, {});
    if (await facilitatorRoutes(req, res)) return;
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      return json(res, 200, { ok: true, ...facilitatorInfo(), uptimeSeconds: Math.floor((Date.now() - started) / 1000) });
    }
    return json(res, 404, { error: "no such route" });
  } catch (e: any) {
    console.error("request failed:", e);
    return json(res, 500, { error: String(e?.message ?? e) });
  }
}).listen(PORT, () => {
  console.log(`sui-x402-facilitator on :${PORT} — networks: ${NETWORKS.map((n) => n.id).join(", ")}`);
  console.log(`  GET  /supported   POST /verify   POST /settle`);
});
