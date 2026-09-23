import { DEFAULT_DESKTOP_BRIDGE_URL } from "./constants";
import { InferAdapterError, InferErrorCode } from "./errors";
import { isRecoveryArchive, type RecoveryArchive } from "./requestArchive";
import type { InferExternalSession, InferWalletOptions } from "./types";

const STORAGE_PREFIX = "inferenco:infer-pending-desktop-request:";

export type RecoverableMethod =
  "signMessage" | "signTransaction" | "signAndSubmitTransaction";

export interface PendingDesktopBridgeRequest {
  version: 2;
  transport: "desktop-bridge";
  requestId: string;
  sessionId: string;
  address: string;
  network: string;
  chainId: number;
  origin: string;
  /** Endpoint identity only. Authentication is resolved from the live session. */
  bridgeOrigin: string;
  method: RecoverableMethod;
  expectedTransactionBcsHex?: string;
  archive?: RecoveryArchive;
}

export function desktopBridgeOrigin(
  session: InferExternalSession,
  options: InferWalletOptions = {}
): string {
  return new URL(options.bridgeBaseUrl ?? session.bridgeUrl ?? DEFAULT_DESKTOP_BRIDGE_URL).origin;
}

/** A receipt contains no bridge URL token, session token, or signing key. */
export function storePendingDesktopBridgeRequest(request: PendingDesktopBridgeRequest): void {
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + request.requestId, JSON.stringify(request));
  } catch (cause) {
    throw new InferAdapterError(
      InferErrorCode.InternalError,
      "Unable to save the Infer Desk request for recovery; approval remains unresolved",
      cause
    );
  }
}

export function readPendingDesktopBridgeRequests(
  session: InferExternalSession,
  options: InferWalletOptions = {}
): PendingDesktopBridgeRequest[] {
  const requests: PendingDesktopBridgeRequest[] = [];
  const expectedOrigin = desktopBridgeOrigin(session, options);
  try {
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i);
      if (!key?.startsWith(STORAGE_PREFIX)) continue;
      let item: Record<string, unknown> | null;
      try {
        item = JSON.parse(window.sessionStorage.getItem(key) ?? "null") as
          Record<string, unknown> | null;
      } catch {
        continue;
      }
      if (!item || (item.version !== 1 && item.version !== 2) ||
          item.transport !== "desktop-bridge" ||
          typeof item.requestId !== "string" || key !== STORAGE_PREFIX + item.requestId ||
          item.sessionId !== session.sessionId || item.address !== session.address ||
          item.network !== session.network || item.chainId !== session.chainId ||
          item.origin !== window.location.origin ||
          typeof item.method !== "string" ||
          !["signMessage", "signTransaction", "signAndSubmitTransaction"].includes(item.method) ||
          (item.expectedTransactionBcsHex !== undefined &&
            typeof item.expectedTransactionBcsHex !== "string") ||
          (item.archive !== undefined && !isRecoveryArchive(item.archive))) continue;

      if (item.version === 1) {
        if (typeof item.bridgeBaseUrl !== "string" ||
            item.bridgeBaseUrl !== (session.bridgeUrl ?? options.bridgeBaseUrl ?? DEFAULT_DESKTOP_BRIDGE_URL)) continue;
        let legacyOrigin: string;
        try {
          legacyOrigin = new URL(item.bridgeBaseUrl).origin;
        } catch {
          continue;
        }
        if (legacyOrigin !== expectedOrigin) continue;
        const upgraded: PendingDesktopBridgeRequest = {
          version: 2, transport: "desktop-bridge", requestId: item.requestId,
          sessionId: item.sessionId, address: item.address, network: item.network,
          chainId: item.chainId, origin: item.origin, bridgeOrigin: expectedOrigin,
          method: item.method as RecoverableMethod,
          ...(item.expectedTransactionBcsHex !== undefined
            ? { expectedTransactionBcsHex: item.expectedTransactionBcsHex } : {})
        };
        // Rewrite immediately so the legacy token is not retained in sessionStorage.
        window.sessionStorage.setItem(key, JSON.stringify(upgraded));
        requests.push(upgraded);
        continue;
      }
      if (item.bridgeOrigin !== expectedOrigin ||
          typeof item.bridgeBaseUrl === "string") continue;
      requests.push(item as unknown as PendingDesktopBridgeRequest);
    }
  } catch (cause) {
    throw new InferAdapterError(InferErrorCode.InternalError,
      "Unable to inspect saved Infer Desk requests; outcomes remain unresolved", cause);
  }
  return requests;
}

export function archivePendingDesktopBridgeRequest(
  requestId: string,
  session: InferExternalSession,
  archive: RecoveryArchive,
  options: InferWalletOptions = {}
): void {
  const pending = readPendingDesktopBridgeRequests(session, options).find(
    (item) => item.requestId === requestId && !item.archive
  );
  if (!pending) {
    throw new InferAdapterError(InferErrorCode.Unauthorized,
      "Active Infer Desk request does not belong to this session");
  }
  storePendingDesktopBridgeRequest({ ...pending, archive });
}

export function clearPendingDesktopBridgeRequest(requestId: string): void {
  window.sessionStorage.removeItem(STORAGE_PREFIX + requestId);
}
