/**
 * x402 v2 wire types — transcribed from the spec
 * (x402-foundation/x402: specs/x402-specification-v2.md +
 * specs/schemes/exact/scheme_exact_sui.md, fetched 2026-06-12).
 */

export interface PaymentRequirements {
  scheme: string;            // "exact"
  network: string;           // CAIP-2 style, e.g. "sui:testnet"
  amount: string;            // atomic units of `asset`
  asset: string;             // Sui coin type, e.g. "0x…::usdc::USDC"
  payTo: string;             // recipient Sui address
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

/** Sui `exact` scheme payload: the payer's complete signed transaction. */
export interface SuiExactPayload {
  signature: string;         // base64 Sui serialized signature
  transaction: string;       // base64 Sui transaction bytes
}

export interface PaymentPayload {
  x402Version: number;
  resource?: { url: string; description?: string; mimeType?: string };
  accepted: PaymentRequirements;
  payload: SuiExactPayload;
  extensions?: Record<string, unknown>;
}

export interface VerifySettleRequest {
  x402Version: number;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction: string;       // settlement digest; "" on failure
  network: string;
  amount?: string;           // actual atomic units received by payTo
}

/**
 * Spec §9 standard error codes, plus Sui-scheme analogues of the
 * `invalid_exact_evm_payload_*` family (same naming convention; the Sui
 * scheme spec defines no codes of its own — documented in the README).
 */
export const ERR = {
  insufficientFunds: "insufficient_funds",
  invalidNetwork: "invalid_network",
  invalidPayload: "invalid_payload",
  invalidRequirements: "invalid_payment_requirements",
  unsupportedScheme: "unsupported_scheme",
  invalidVersion: "invalid_x402_version",
  invalidTxState: "invalid_transaction_state",
  unexpectedVerify: "unexpected_verify_error",
  unexpectedSettle: "unexpected_settle_error",
  suiSignature: "invalid_exact_sui_payload_signature",
  suiRecipient: "invalid_exact_sui_payload_recipient_mismatch",
  suiValue: "invalid_exact_sui_payload_value_mismatch",
} as const;
