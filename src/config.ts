/**
 * Network registry. `sui:mainnet` is the only Sui id in the x402 spec; the
 * testnet id is our proposal (`sui:testnet`, CAIP-2 style) — flagged in the
 * README and to be raised in the foundation directory PR.
 *
 * USDC coin types are Circle's official deployments
 * (https://developers.circle.com/stablecoins/usdc-contract-addresses),
 * 6 decimals — verified against on-chain coin metadata 2026-06-12.
 */
export interface NetworkConfig {
  /** CAIP-2 style id, e.g. "sui:testnet" */
  id: string;
  rpcUrl: string;
  /** Canonical USDC coin type, advertised in /supported as a courtesy. */
  usdc: string;
}

const TESTNET: NetworkConfig = {
  id: "sui:testnet",
  rpcUrl: process.env.SUI_TESTNET_RPC ?? "https://fullnode.testnet.sui.io:443",
  usdc: "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
};

const MAINNET: NetworkConfig = {
  id: "sui:mainnet",
  rpcUrl: process.env.SUI_MAINNET_RPC ?? "https://fullnode.mainnet.sui.io:443",
  usdc: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
};

/** Mainnet stays off until the deliberate hardening pass (FACILITATOR_PLAN.md). */
export const NETWORKS: NetworkConfig[] =
  process.env.ENABLE_MAINNET === "1" ? [TESTNET, MAINNET] : [TESTNET];

export const PORT = Number(process.env.PORT ?? 4402);

export function networkById(id: string): NetworkConfig | undefined {
  return NETWORKS.find((n) => n.id === id);
}
