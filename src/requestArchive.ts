export interface RecoveryArchive {
  archivedAt: string;
  reconciliationReference: string;
}

export function makeRecoveryArchive(reference: string): RecoveryArchive {
  const trimmed = reference.trim();
  if (!trimmed || trimmed.length > 256 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error("A short, non-secret reconciliation reference is required to archive a request");
  }
  return { archivedAt: new Date().toISOString(), reconciliationReference: trimmed };
}

export function isRecoveryArchive(value: unknown): value is RecoveryArchive {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<RecoveryArchive>;
  return typeof item.archivedAt === "string" &&
    Number.isFinite(Date.parse(item.archivedAt)) &&
    typeof item.reconciliationReference === "string" &&
    item.reconciliationReference.length > 0 &&
    item.reconciliationReference.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(item.reconciliationReference);
}
