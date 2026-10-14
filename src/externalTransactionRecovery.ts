import { canonicalAddress, encodeWireValue, requestCommitment } from "./integrationContract";

export const EXTERNAL_TRANSACTION_RECOVERY_SCHEMA = "infer-connect-transaction-recovery-v1";
export type ExternalTransactionRecovery = Readonly<{
  recoverySchema: typeof EXTERNAL_TRANSACTION_RECOVERY_SCHEMA;
  requestId: string;
  invocationId: string | null;
  requestCommitment: string;
  scope: { origin: string; accountAddress: string; network: string; chainId: number };
  method: "signAndSubmitTransaction";
  status: "unknown" | "approved" | "not-submitted";
  transactionHash?: string;
  submissionAcceptance?: "unknown" | "accepted";
  chainStatus?: "unknown" | "pending" | "confirmed" | "aborted";
  chainVersion?: string;
  failureCode?: "EXECUTION_FAILED_BEFORE_BROADCAST";
}>;
export type ExternalRecoveryBinding = {
  requestId: string; invocationId?: string; requestCommitment?: string;
  origin: string; address: string; network: string; chainId: number; method: string;
  pending: { requestPayload?: unknown };
};
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function invalid(): never { throw new Error("Invalid external transaction recovery evidence"); }
/** Decrypted evidence is usable only for the exact durable original request. */
export function validateExternalTransactionRecovery(value: unknown, binding: ExternalRecoveryBinding): ExternalTransactionRecovery {
  const input = encodeWireValue(value);
  if (!record(input) || binding.method !== "signAndSubmitTransaction" ||
      !binding.requestCommitment || !/^[0-9a-f]{64}$/.test(binding.requestCommitment)) invalid();
  const permitted = ["recoverySchema", "requestId", "invocationId", "requestCommitment", "scope", "method", "status", "transactionHash", "submissionAcceptance", "chainStatus", "chainVersion", "failureCode"];
  if (Object.keys(input).some((key) => !permitted.includes(key)) || input.recoverySchema !== EXTERNAL_TRANSACTION_RECOVERY_SCHEMA ||
      input.requestId !== binding.requestId || input.invocationId !== (binding.invocationId ?? null) ||
      input.requestCommitment !== binding.requestCommitment || input.method !== binding.method) invalid();
  const scope = input.scope;
  if (!record(scope) || Object.keys(scope).length !== 4 || scope.origin !== binding.origin ||
      scope.accountAddress !== canonicalAddress(binding.address) || scope.network !== binding.network || scope.chainId !== binding.chainId ||
      requestCommitment(binding.method, { origin: binding.origin, accountAddress: canonicalAddress(binding.address), network: binding.network, chainId: binding.chainId },
        binding.pending.requestPayload) !== binding.requestCommitment) invalid();
  if (!["unknown", "approved", "not-submitted"].includes(String(input.status))) invalid();
  const hash = input.transactionHash;
  if (hash !== undefined && (typeof hash !== "string" || !/^0x[0-9a-f]{64}$/.test(hash))) invalid();
  if (input.submissionAcceptance !== undefined && !["unknown", "accepted"].includes(String(input.submissionAcceptance))) invalid();
  if (input.chainStatus !== undefined && !["unknown", "pending", "confirmed", "aborted"].includes(String(input.chainStatus))) invalid();
  if (input.chainVersion !== undefined && (typeof input.chainVersion !== "string" || !/^(0|[1-9]\d{0,19})$/.test(input.chainVersion) || BigInt(input.chainVersion) > (1n << 64n) - 1n)) invalid();
  if (input.status === "not-submitted") {
    if (input.failureCode !== "EXECUTION_FAILED_BEFORE_BROADCAST" || hash !== undefined ||
        input.submissionAcceptance !== undefined || input.chainStatus !== undefined || input.chainVersion !== undefined) invalid();
  } else {
    if (input.failureCode !== undefined) invalid();
    if (input.status === "approved" && (!hash || input.submissionAcceptance !== "accepted")) invalid();
    if (hash && input.submissionAcceptance === undefined) invalid();
    if (!hash && (input.submissionAcceptance !== undefined || input.chainStatus !== undefined || input.chainVersion !== undefined)) invalid();
    const committed = input.chainStatus === "confirmed" || input.chainStatus === "aborted";
    if (committed && input.submissionAcceptance !== "accepted") invalid();
    if (committed !== (input.chainVersion !== undefined)) invalid();
  }
  return input as unknown as ExternalTransactionRecovery;
}
/** Older snapshots cannot erase a known identity, acceptance or committed receipt. */
export function mergeExternalTransactionRecovery(previous: ExternalTransactionRecovery | undefined, next: ExternalTransactionRecovery): ExternalTransactionRecovery {
  if (!previous) return next;
  if (previous.status === "not-submitted") {
    if (next.status !== "not-submitted") invalid();
    return previous;
  }
  if (next.status === "not-submitted") {
    if (previous.transactionHash || previous.submissionAcceptance === "accepted") invalid();
    return next;
  }
  if (previous.transactionHash && next.transactionHash && previous.transactionHash !== next.transactionHash) invalid();
  if (previous.transactionHash && !next.transactionHash) return previous;
  const committed = previous.chainStatus === "confirmed" || previous.chainStatus === "aborted";
  if (committed && (next.chainStatus === "confirmed" || next.chainStatus === "aborted") &&
      (previous.chainStatus !== next.chainStatus || previous.chainVersion !== next.chainVersion)) invalid();
  return { ...next,
    ...(previous.submissionAcceptance === "accepted" ? { submissionAcceptance: "accepted" as const } : {}),
    ...(committed ? { chainStatus: previous.chainStatus, chainVersion: previous.chainVersion } : {}),
    ...(previous.chainStatus === "pending" && next.chainStatus === "unknown" ? { chainStatus: "pending" as const } : {})
  };
}
