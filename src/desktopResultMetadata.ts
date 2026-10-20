import { INTEGRATION_CONTRACT_VERSION, MESSAGE_PROFILE } from "./integrationContract";
import type { InferIntegrationCapabilities } from "./types";

export const DESKTOP_RESULT_METADATA_KEYS = [
  "integrationContractVersion", "capabilities"
] as const;

const BOOLEAN_CAPABILITIES: readonly (keyof InferIntegrationCapabilities)[] = [
  "transactionRestrictions", "completeResults", "durableInvocationLookup",
  "durableExternalSubmissionRecovery", "durableInvocationSubmission"
];

/**
 * Versioned metadata describes the producer, never the result's authority.
 * Unknown capability keys fail closed until this contract is explicitly updated.
 * Legacy responses may omit both fields; capabilities alone are not versioned.
 */
export function hasValidDesktopResultMetadata(value: object): boolean {
  const fields = value as Record<string, unknown>;
  const hasVersion = Object.prototype.hasOwnProperty.call(fields, "integrationContractVersion");
  const hasCapabilities = Object.prototype.hasOwnProperty.call(fields, "capabilities");
  if (!hasVersion) return !hasCapabilities;
  if (fields.integrationContractVersion !== INTEGRATION_CONTRACT_VERSION) return false;
  if (!hasCapabilities) return true;
  const capabilities = fields.capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return false;
  return Object.entries(capabilities).every(([key, capability]) =>
    key === "messageProfile"
      ? capability === MESSAGE_PROFILE
      : BOOLEAN_CAPABILITIES.includes(key as keyof InferIntegrationCapabilities) &&
        typeof capability === "boolean"
  );
}
