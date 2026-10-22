import { canonicalAddress, encodeWireValue, requestCommitment } from "./integrationContract";

export type NativeNotSubmittedProof = {
  contractVersion: 1; invocationId: string; requestCommitment: string;
  scope: { origin: string; accountAddress: string; network: string; chainId: number };
  method: "signAndSubmitTransaction"; status: "unknown";
  submissionDisposition: "not-submitted"; failureCode: "EXECUTION_FAILED_BEFORE_BROADCAST";
};
type Binding = { id: string; transport: string; origin: string; address: string; network: string; chainId: number;
  method: string; requestCommitment?: string; requestPayload?: unknown; requestId?: string };
/** Only an authenticated native read may supply this exact invocation-bound assertion. */
export function validateNativeNotSubmitted(value: unknown, row: Binding): NativeNotSubmittedProof {
  const v = encodeWireValue(value) as Record<string, unknown>;
  const scope = { origin: row.origin, accountAddress: canonicalAddress(row.address), network: row.network, chainId: row.chainId };
  if (!v || typeof v !== "object" || Array.isArray(v) || row.transport !== "injected" ||
      row.method !== "signAndSubmitTransaction" || !row.requestCommitment ||
      requestCommitment(row.method, scope, row.requestPayload) !== row.requestCommitment ||
      v.contractVersion !== 1 || v.invocationId !== row.id || v.requestCommitment !== row.requestCommitment ||
      v.method !== row.method || v.status !== "unknown" || v.submissionDisposition !== "not-submitted" ||
      v.failureCode !== "EXECUTION_FAILED_BEFORE_BROADCAST" ||
      Object.keys(v).some(k => !["contractVersion", "invocationId", "requestCommitment", "scope", "method", "status", "submissionDisposition", "failureCode", "requestId"].includes(k)) ||
      (v.requestId !== undefined && v.requestId !== (row.requestId ?? row.id)) ||
      !v.scope || typeof v.scope !== "object" || Array.isArray(v.scope) || Object.keys(v.scope).length !== 4 ||
      Object.entries(scope).some(([key, val]) => (v.scope as Record<string, unknown>)[key] !== val))
    throw new Error("Invalid native non-submission proof");
  return { contractVersion: 1, invocationId: row.id, requestCommitment: row.requestCommitment,
    scope, method: "signAndSubmitTransaction", status: "unknown", submissionDisposition: "not-submitted",
    failureCode: "EXECUTION_FAILED_BEFORE_BROADCAST" };
}
