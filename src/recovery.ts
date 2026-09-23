import type {
  CedraSignAndSubmitTransactionOutput,
  CedraSignMessageOutput,
  CedraSignTransactionOutputV1_1
} from "@cedra-labs/wallet-standard";
import { readExternalSession, readDesktopBridgeRequestOnce } from "./bridge";
import { clearPendingDesktopBridgeRequest, readPendingDesktopBridgeRequests, type RecoverableMethod } from "./desktopRequests";
import { InferAdapterError, InferErrorCode } from "./errors";
import { decodeMobileRelayResult, readMobileRelayRequestOnce } from "./mobileRelay";
import { clearPendingMobileRelayRequest, readPendingMobileRelayRequests } from "./mobileRequests";
import type { InferExternalSession, InferWalletOptions } from "./types";

export interface RecoverableRequest {
  requestId: string;
  method: RecoverableMethod;
  transport: "mobile-relay" | "desktop-bridge";
}

export type RecoveredRequestOutcome =
  | (RecoverableRequest & { status: "pending" })
  | (RecoverableRequest & { status: "approved"; output:
      CedraSignMessageOutput | CedraSignTransactionOutputV1_1 | CedraSignAndSubmitTransactionOutput })
  | (RecoverableRequest & { status: "rejected" })
  | (RecoverableRequest & { status: "unknown"; reason: string });

function receipts(session: InferExternalSession, options: InferWalletOptions): RecoverableRequest[] {
  return [
    ...(session.transport === "mobile-relay"
      ? readPendingMobileRelayRequests(session).map(({ requestId, method }) =>
          ({ requestId, method, transport: "mobile-relay" as const }))
      : readPendingDesktopBridgeRequests(session, options).map(({ requestId, method }) =>
          ({ requestId, method, transport: "desktop-bridge" as const })))
  ];
}

/** List only receipts bound to the current session and browser origin. */
export async function listRecoverableRequests(options: InferWalletOptions = {}): Promise<RecoverableRequest[]> {
  if (typeof window === "undefined") return [];
  const session = readExternalSession();
  return session ? receipts(session, options) : [];
}

const inFlight = new Map<string, Promise<RecoveredRequestOutcome>>();
const verifiedFinal = new Set<string>();

/** Read an existing request exactly once. This function never signs, submits, or cancels. */
export async function readRecoverableRequest(
  requestId: string,
  options: InferWalletOptions = {}
): Promise<RecoveredRequestOutcome> {
  if (typeof window === "undefined") {
    throw new InferAdapterError(InferErrorCode.Unsupported, "Recovery requires a browser");
  }
  const session = readExternalSession();
  if (!session) {
    throw new InferAdapterError(InferErrorCode.Unauthorized, "No current wallet session for recovery");
  }
  const descriptor = receipts(session, options).find((request) => request.requestId === requestId);
  if (!descriptor) {
    throw new InferAdapterError(InferErrorCode.Unauthorized, "Request is not bound to this wallet session");
  }
  const key = session.sessionId + ":" + descriptor.transport + ":" + requestId;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const task = (async (): Promise<RecoveredRequestOutcome> => {
    try {
      if (descriptor.transport === "mobile-relay") {
        const { pending, status } = await readMobileRelayRequestOnce(requestId, session, options);
        if (status.status === "pending") return { ...descriptor, status: "pending" };
        if (status.status !== "approved" && status.status !== "rejected") {
          return { ...descriptor, status: "unknown", reason: "Relay returned " + status.status };
        }
        return { ...descriptor, status: "approved",
          output: decodeMobileRelayResult(status, pending, session) };
      }
      const result = await readDesktopBridgeRequestOnce(requestId, session, options);
      if (result.status === "pending") return { ...descriptor, status: "pending" };
      if (!result.output) return { ...descriptor, status: "unknown", reason: "Missing approved output" };
      return { ...descriptor, status: "approved", output: result.output };
    } catch (error) {
      if (error instanceof InferAdapterError && error.code === InferErrorCode.UserRejected) {
        return { ...descriptor, status: "rejected" };
      }
      return { ...descriptor, status: "unknown", reason:
        error instanceof Error ? error.message : "Result could not be validated" };
    }
  })();
  inFlight.set(key, task);
  try {
    const outcome = await task;
    if (outcome.status === "approved" || outcome.status === "rejected") verifiedFinal.add(key);
    return outcome;
  } finally {
    inFlight.delete(key);
  }
}

/** Call only after the application has durably recorded an approved or rejected outcome. */
export function acknowledgeRecoverableRequest(
  requestId: string,
  options: InferWalletOptions = {}
): void {
  if (typeof window === "undefined") return;
  const session = readExternalSession();
  if (!session) {
    throw new InferAdapterError(InferErrorCode.Unauthorized, "No current wallet session for acknowledgement");
  }
  const descriptor = receipts(session, options).find((request) => request.requestId === requestId);
  if (!descriptor) {
    throw new InferAdapterError(InferErrorCode.Unauthorized, "Request is not bound to this wallet session");
  }
  const key = session.sessionId + ":" + descriptor.transport + ":" + requestId;
  if (!verifiedFinal.has(key)) {
    throw new InferAdapterError(InferErrorCode.InternalError,
      "Read a verified final outcome before acknowledging this request");
  }
  if (descriptor.transport === "mobile-relay") clearPendingMobileRelayRequest(requestId);
  else clearPendingDesktopBridgeRequest(requestId);
  verifiedFinal.delete(key);
}
