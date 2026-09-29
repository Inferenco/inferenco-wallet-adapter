import type {
  CedraSignAndSubmitTransactionInput,
  CedraSignAndSubmitTransactionOutput,
  CedraSignMessageInput,
  CedraSignMessageOutput,
  CedraSignTransactionInputV1_1,
  CedraSignTransactionOutputV1_1
} from "@cedra-labs/wallet-standard";
import type { InferTransactionPayload } from "./types";
import {
  CALLBACK_REQUEST_ID_PARAM,
  CALLBACK_STATUS_PARAM,
  LEGACY_CALLBACK_REQUEST_ID_PARAM,
  LEGACY_CALLBACK_STATUS_PARAM,
  DEFAULT_MOBILE_RELAY_BASE_URL,
  DEFAULT_MOBILE_POLL_INTERVAL_MS,
  DEFAULT_MOBILE_REQUEST_TIMEOUT_MS,
  DEFAULT_MOBILE_WEBSOCKET_URL
} from "./constants";
import {
  BridgeHttpError,
  clearCallbackMarker,
  clearPendingMobilePairing,
  fetchJsonWithTimeout,
  readCallbackMarker,
  readPendingMobilePairing,
  storeCallbackSession,
  storeExternalSession,
  storePendingMobilePairing
} from "./bridge";
import {
  decryptJson,
  createKeyPair,
  deriveSharedSecret,
  deriveSharedSecretLegacy,
  encryptJson
} from "./mobileCrypto";
import { watchRelaySocket } from "./mobileSocket";
import { rememberOwnedMobilePairing } from "./mobileReturnCoordinator";
import {
  storePendingMobileRelayRequest,
  readPendingMobileRelayRequests,
  type PendingMobileRelayRequest
} from "./mobileRequests";
import {
  isValidTransactionHash,
  InferAdapterError,
  InferRequestError,
  unresolvedRequestError,
  InferErrorCode
} from "./errors";
import { deserializeSignTransactionResult } from "./conversion";
import { prepareDurableInvocation, saveDurableMobileInvocationEnvelope, saveDurableRequest, saveDurableFinal, serializeStoredFinal, updateDurableInvocation, type DurableInvocation } from "./durableRecovery";
import type {
  InferExternalSignTransactionInput,
  InferExternalSession,
  InferMobilePairingCreateResponse,
  InferMobilePairingStatus,
  InferMobileRequestCreateResponse,
  InferMobileInvocationReceipt,
  InferMobileInvocationRelaunchReceipt,
  InferMobileRequestStatus,
  InferWalletOptions
} from "./types";

function assertBrowser(): void {
  if (typeof window === "undefined") {
    throw new InferAdapterError(InferErrorCode.Unsupported, "Infer Connect mobile relay requires a browser");
  }
}

function getRelayBaseUrl(options: InferWalletOptions): string {
  return options.relayBaseUrl ?? DEFAULT_MOBILE_RELAY_BASE_URL;
}

function getWebsocketUrl(options: InferWalletOptions, fallback?: string): string | undefined {
  if (options.websocketBaseUrl) return options.websocketBaseUrl;
  if (fallback) return fallback;
  const relayBaseUrl = options.relayBaseUrl ?? DEFAULT_MOBILE_RELAY_BASE_URL;
  if (!relayBaseUrl) return DEFAULT_MOBILE_WEBSOCKET_URL;
  const url = new URL(relayBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v1/ws";
  return url.toString();
}

function callbackUrlWithoutMarkers(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete(CALLBACK_REQUEST_ID_PARAM);
  url.searchParams.delete(CALLBACK_STATUS_PARAM);
  url.searchParams.delete(LEGACY_CALLBACK_REQUEST_ID_PARAM);
  url.searchParams.delete(LEGACY_CALLBACK_STATUS_PARAM);
  return url.toString();
}

function appName(): string {
  return typeof document !== "undefined" && document.title ? document.title : "Infer Connect";
}

function mobilePollInterval(options: InferWalletOptions): number {
  return options.mobilePollIntervalMs ?? DEFAULT_MOBILE_POLL_INTERVAL_MS;
}

function mobileRequestTimeout(options: InferWalletOptions): number {
  return options.mobileRequestTimeoutMs ?? DEFAULT_MOBILE_REQUEST_TIMEOUT_MS;
}

function buildRelayUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

export function mobileWalletLaunchUrl(url: string, options: InferWalletOptions): string {
  const target = new URL(url);
  if (options.mobileReturnMode === "resume-browser-v1") {
    target.searchParams.set("returnMode", "resume-browser-v1");
  }
  return target.toString();
}

function launch(url: string, options: InferWalletOptions): void {
  window.location.href = mobileWalletLaunchUrl(url, options);
}

function isFinalStatus(status: string | undefined): boolean {
  return status === "approved" || status === "rejected" || status === "failed" || status === "expired" || status === "cancelled" || status === "revoked";
}

function throwForStatus(status: string, errorMessage?: string | null): never {
  if (status === "rejected") {
    throw new InferAdapterError(InferErrorCode.UserRejected, errorMessage ?? "User rejected the request");
  }
  if (status === "expired" || status === "cancelled" || status === "revoked") {
    throw new InferAdapterError(InferErrorCode.ConnectionTimeout, errorMessage ?? "Infer Connect request expired");
  }
  throw new InferAdapterError(InferErrorCode.InternalError, errorMessage ?? "Infer Connect request failed");
}

async function waitForPairingOutcome(
  pairingId: string,
  dappPairingToken: string,
  options: InferWalletOptions,
  websocketUrl?: string
): Promise<InferMobilePairingStatus> {
  const relayBaseUrl = getRelayBaseUrl(options);
  const deadline = Date.now() + mobileRequestTimeout(options);
  let wakePoll: (() => void) | undefined;
  let wakeRequested = false;
  const wake = () => {
    wakeRequested = true;
    wakePoll?.();
  };
  let socket: ReturnType<typeof watchRelaySocket> | null = null;
  if (websocketUrl) {
    try {
      socket = watchRelaySocket({
        websocketUrl,
        role: "dapp",
        token: dappPairingToken,
        target: { kind: "pairing", id: pairingId },
        options,
        onEvent(event) {
          if (event.type === "pairing.approved" || event.type === "pairing.rejected") wake();
        }
      });
    } catch {
      // Authenticated HTTP polling remains authoritative.
    }
  }
  window.addEventListener("focus", wake);
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("pageshow", wake);

  try {
    // Always poll the exact pairing. Websocket and callback signals only wake.
    do {
      wakeRequested = false;
      storeCallbackSession();
      try {
        const status = await fetchJsonWithTimeout<InferMobilePairingStatus>(
          buildRelayUrl(relayBaseUrl, "/v1/pairings/" + pairingId) +
            "?dappPairingToken=" + encodeURIComponent(dappPairingToken),
          Math.min(10_000, Math.max(1, deadline - Date.now()))
        );
        if (status.pairingId !== pairingId) {
          throw new InferAdapterError(InferErrorCode.InternalError,
            "Infer Connect returned a different pairing");
        }
        if (isFinalStatus(status.status)) {
          if (readCallbackMarker()?.requestId === pairingId) clearCallbackMarker();
          return status;
        }
        if (status.status !== "pending" && status.status !== "claimed") {
          throw new InferAdapterError(InferErrorCode.InternalError,
            "Infer Connect returned an invalid pairing status");
        }
      } catch (error) {
        const retryable = error instanceof TypeError ||
          (error instanceof DOMException && error.name === "AbortError") ||
          (error instanceof BridgeHttpError && (error.status === 429 || error.status >= 500));
        if (!retryable) throw error;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      // Focus may arrive while the HTTP request is in flight, before the
      // timer exists. Keep that wake so it cannot be lost.
      if (wakeRequested) {
        wakeRequested = false;
        continue;
      }
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          wakePoll = undefined;
          resolve();
        };
        const timer = window.setTimeout(finish, Math.min(mobilePollInterval(options), remaining));
        wakePoll = finish;
      });
    } while (Date.now() < deadline);
    // A suspended tab can cross the deadline. Read the same pairing once more.
    try {
      const final = await fetchJsonWithTimeout<InferMobilePairingStatus>(
        buildRelayUrl(relayBaseUrl, "/v1/pairings/" + pairingId) +
          "?dappPairingToken=" + encodeURIComponent(dappPairingToken),
        10_000
      );
      if (final.pairingId === pairingId && isFinalStatus(final.status)) return final;
    } catch {
      // The saved pairing remains available for a future retry.
    }
  } finally {
    wakePoll?.();
    window.removeEventListener("focus", wake);
    document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("pageshow", wake);
    socket?.close();
  }

  throw new InferAdapterError(InferErrorCode.ConnectionTimeout, "Timed out waiting for Infer Wallet approval");
}

function sessionFromApprovedPairing(
  pairing: InferMobilePairingStatus,
  relayBaseUrl: string,
  privateKey: string
): InferExternalSession {
  if (
    pairing.status !== "approved" ||
    !pairing.encryptedResult ||
    !pairing.dappSessionToken ||
    !pairing.walletPublicKey ||
    !pairing.sessionId
  ) {
    throwForStatus(pairing.status, pairing.errorMessage);
  }

  // v0.3.0 (rebrand): dual-derive the AEAD key. The canonical rebrand
  // info string is `"infer-connect-relay"`. nova-service (the mobile
  // relay backend) is still on the legacy `"nova-connect-relay"` info
  // until its separate rebrand completes, so we try the canonical key
  // first and fall back to the legacy key on decrypt failure. This
  // lets dapps connect to either backend during the transition window.
  let sharedSecret: string;
  let result: {
    address: string;
    publicKey: string;
    network: string;
    chainId: number;
    walletName?: string;
  };
  try {
    sharedSecret = deriveSharedSecret(privateKey, pairing.walletPublicKey);
    result = decryptJson(pairing.encryptedResult, sharedSecret);
  } catch (canonicalError) {
    try {
      sharedSecret = deriveSharedSecretLegacy(privateKey, pairing.walletPublicKey);
      result = decryptJson(pairing.encryptedResult, sharedSecret);
    } catch (legacyError) {
      // Both fail — surface the canonical rebrand error (most likely
      // the actual cause: token expired, wrong public key, etc).
      throw canonicalError;
    }
  }

  return {
    transport: "mobile-relay",
    address: result.address,
    publicKey: result.publicKey,
    network: result.network,
    chainId: result.chainId,
    sessionId: pairing.sessionId,
    relayBaseUrl,
    dappSessionToken: pairing.dappSessionToken,
    sharedSecret,
    walletPublicKey: pairing.walletPublicKey,
    walletName: result.walletName ?? pairing.walletName
  };
}

/** Resume an existing pairing after callback, task return, focus, or reload.
 * This never creates a second pairing or opens the wallet. */
export async function resumeMobileRelaySession(
  options: InferWalletOptions = {}
): Promise<InferExternalSession | null> {
  assertBrowser();
  const pendingPairing = readPendingMobilePairing();
  if (!pendingPairing) return null;
  const marker = readCallbackMarker();

  const pairing = await waitForPairingOutcome(
    pendingPairing.pairingId, pendingPairing.dappPairingToken,
    { ...options, relayBaseUrl: pendingPairing.relayBaseUrl },
    getWebsocketUrl({ ...options, relayBaseUrl: pendingPairing.relayBaseUrl })
  );
  if (pairing.status === "approved") {
    const session = sessionFromApprovedPairing(
      pairing, pendingPairing.relayBaseUrl, pendingPairing.privateKey
    );
    storeExternalSession(session);
    clearPendingMobilePairing();
    if (marker?.requestId === pendingPairing.pairingId) clearCallbackMarker();
    return session;
  }
  if (isFinalStatus(pairing.status)) {
    clearPendingMobilePairing();
    if (marker?.requestId === pendingPairing.pairingId) clearCallbackMarker();
    throwForStatus(pairing.status, pairing.errorMessage);
  }
  return null;
}

/** Backwards-compatible name for clients using the older callback API. */
export const resumeMobileRelaySessionFromCallback = resumeMobileRelaySession;

async function readRequestStatus(
  requestId: string,
  method: PendingMobileRelayRequest["method"],
  session: InferExternalSession,
  options: InferWalletOptions,
  timeoutMs: number
): Promise<InferMobileRequestStatus> {
  const relayBaseUrl = session.relayBaseUrl ?? getRelayBaseUrl(options);
  const status = await fetchJsonWithTimeout<InferMobileRequestStatus>(
    buildRelayUrl(relayBaseUrl, "/v1/requests/" + encodeURIComponent(requestId)),
    Math.max(1, timeoutMs),
    { headers: { "x-infer-session-token": session.dappSessionToken! } }
  );
  if (!status || status.requestId !== requestId ||
      status.sessionId !== session.sessionId || status.method !== method ||
      (status.accountAddress != null &&
        status.accountAddress.toLowerCase() !== session.address.toLowerCase()) ||
      (status.origin != null && status.origin !== window.location.origin) ||
      (status.network != null && status.network !== session.network) ||
      (status.chainId != null && status.chainId !== session.chainId)) {
    throw new InferAdapterError(InferErrorCode.InternalError,
      "Infer Connect returned a result for a different request or session");
  }
  if (isFinalStatus(status.status) && readCallbackMarker()?.requestId === requestId) {
    clearCallbackMarker();
  }
  return status;
}

/** One authoritative read of the original request. Pending is not a rejection. */
export async function readMobileRelayRequestOnce(
  requestId: string,
  session: InferExternalSession,
  options: InferWalletOptions = {},
  durablePending?: PendingMobileRelayRequest
): Promise<{ pending: PendingMobileRelayRequest; status: InferMobileRequestStatus }> {
  if (!session.dappSessionToken || !session.sharedSecret) {
    throw new InferAdapterError(InferErrorCode.Unauthorized, "Missing relay session for recovery");
  }
  const pending = durablePending ?? readPendingMobileRelayRequests(session).find((item) => item.requestId === requestId);
  const relayBaseUrl = session.relayBaseUrl ?? getRelayBaseUrl(options);
  if (!pending || pending.requestId !== requestId ||
      pending.sessionId !== session.sessionId || pending.address !== session.address ||
      pending.network !== session.network || pending.chainId !== session.chainId ||
      pending.origin !== window.location.origin || pending.relayBaseUrl !== relayBaseUrl) {
    throw new InferAdapterError(InferErrorCode.Unauthorized, "Request does not belong to this relay session");
  }
  const status = await readRequestStatus(requestId, pending.method, session, options, 10_000);
  return { pending, status };
}

async function waitForRequestOutcome(
  requestId: string,
  method: "signMessage" | "signTransaction" | "signAndSubmitTransaction",
  session: InferExternalSession,
  options: InferWalletOptions,
  expiresAt: string
): Promise<InferMobileRequestStatus> {
  const relayBaseUrl = session.relayBaseUrl ?? getRelayBaseUrl(options);
  const clientDeadline = Date.now() + mobileRequestTimeout(options);
  const deadline = Math.min(clientDeadline, Date.parse(expiresAt));
  let wakePoll: (() => void) | undefined;
  const wake = () => wakePoll?.();
  let socket: ReturnType<typeof watchRelaySocket> | null = null;
  try {
    socket = watchRelaySocket({
      websocketUrl: getWebsocketUrl({ ...options, relayBaseUrl })!,
      role: "dapp",
      token: session.dappSessionToken!,
      target: { kind: "session", id: session.sessionId },
      options,
      onEvent(event) {
        if (event.requestId === requestId ||
            event.type === "session.revoked" || event.type === "session.expired") wake();
      }
    });
  } catch {
    // HTTP remains authoritative when WebSockets are blocked or unavailable.
  }
  window.addEventListener("focus", wake);
  document.addEventListener("visibilitychange", wake);

  try {
    // Always reconcile once, including when resuming an already-expired request.
    do {
      storeCallbackSession();
      try {
        const status = await readRequestStatus(
          requestId, method, session, options,
          Math.min(10_000, Math.max(1, clientDeadline - Date.now()))
        );
        if (isFinalStatus(status.status)) return status;
        if (status.status !== "pending") {
          throw new InferAdapterError(InferErrorCode.InternalError, "Unknown relay request status");
        }
      } catch (error) {
        // Retry reads only. Never repeat request creation after an ambiguous failure.
        const retryable = error instanceof TypeError ||
          (error instanceof DOMException && error.name === "AbortError") ||
          (error instanceof BridgeHttpError && (error.status === 429 || error.status >= 500));
        if (!retryable) throw error;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => {
        const finish = () => {
          window.clearTimeout(timer);
          wakePoll = undefined;
          resolve();
        };
        const timer = window.setTimeout(finish, Math.min(mobilePollInterval(options), remaining));
        wakePoll = finish;
      });
    } while (Date.now() < deadline);
    // A suspended tab may resume after expiry. Read this ID once more with a
    // bounded request before leaving its receipt unresolved.
    try {
      const finalStatus = await readRequestStatus(requestId, method, session, options, 10_000);
      if (isFinalStatus(finalStatus.status)) return finalStatus;
    } catch {
      // The original request remains unresolved and recoverable.
    }
  } finally {
    wakePoll?.();
    window.removeEventListener("focus", wake);
    document.removeEventListener("visibilitychange", wake);
    socket?.close();
  }
  throw new InferAdapterError(InferErrorCode.ConnectionTimeout,
    "Relay outcome is unknown; recover the existing request before trying again");
}

function matchingMobileInvocation(
  invocation: DurableInvocation,
  session: InferExternalSession,
  options: InferWalletOptions
): boolean {
  const envelope = invocation.mobileRequest?.envelope;
  return invocation.origin === window.location.origin &&
    invocation.transport === "mobile-relay" &&
    invocation.sessionId === session.sessionId &&
    invocation.address === session.address &&
    invocation.network === session.network &&
    invocation.chainId === session.chainId &&
    invocation.mobileRequest?.relayBaseUrl ===
      (session.relayBaseUrl ?? getRelayBaseUrl(options)) &&
    envelope?.clientInvocationId === invocation.id &&
    envelope.sessionId === session.sessionId &&
    envelope.method === invocation.method &&
    envelope.requestMetadata.origin === window.location.origin &&
    !!session.dappSessionToken && !!session.sharedSecret;
}

function validateInvocationReceipt(
  receipt: InferMobileInvocationReceipt
): void {
  if (!receipt || typeof receipt.requestId !== "string" || !receipt.requestId ||
      typeof receipt.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(receipt.expiresAt)) ||
      !["pending", "approved", "rejected", "failed", "expired", "cancelled", "revoked"]
        .includes(receipt.status)) {
    throw new InferAdapterError(InferErrorCode.InternalError,
      "Relay returned an invalid invocation receipt");
  }
}

/** Authenticated lookup of a prepared invocation whose creation response was
 * lost. Saves the original request identity before any consumer is notified.
 * Never POSTs another signing request and never launches the wallet. */
export async function reconcileMobileRelayInvocationReceipt(
  invocation: DurableInvocation,
  session: InferExternalSession,
  options: InferWalletOptions = {}
): Promise<{ pending: PendingMobileRelayRequest; receipt: InferMobileInvocationReceipt }> {
  assertBrowser();
  if (!matchingMobileInvocation(invocation, session, options)) {
    throw new InferAdapterError(InferErrorCode.Unauthorized,
      "Invocation does not belong to this relay session");
  }
  const relayBaseUrl = invocation.mobileRequest!.relayBaseUrl;
  const url = new URL(buildRelayUrl(relayBaseUrl,
    "/v1/requests/by-invocation/" + encodeURIComponent(invocation.id)));
  url.searchParams.set("sessionId", session.sessionId);
  const receipt = await fetchJsonWithTimeout<InferMobileInvocationReceipt>(
    url.toString(), mobileRequestTimeout(options),
    { headers: { "x-infer-session-token": session.dappSessionToken! } }
  );
  validateInvocationReceipt(receipt);
  if (invocation.requestId && invocation.requestId !== receipt.requestId) {
    throw new InferAdapterError(InferErrorCode.InternalError,
      "Invocation lookup changed its original request ID");
  }
  const pending: PendingMobileRelayRequest = {
    version: 1,
    requestId: receipt.requestId,
    invocationId: invocation.id,
    sessionId: invocation.sessionId,
    address: invocation.address,
    network: invocation.network,
    chainId: invocation.chainId,
    relayBaseUrl,
    origin: invocation.origin,
    method: invocation.method,
    expiresAt: receipt.expiresAt,
    ...(invocation.mobileRequest!.expectedTransactionBcsHex
      ? { expectedTransactionBcsHex: invocation.mobileRequest!.expectedTransactionBcsHex }
      : {})
  };
  storePendingMobileRelayRequest(pending);
  await saveDurableRequest(pending, invocation.id);
  await updateDurableInvocation(invocation.id, "created", receipt.requestId);
  await options.onMobileRequestCreated?.(Object.freeze({ ...pending }));
  await options.onRequestCreated?.(Object.freeze({ ...pending }));
  return { pending, receipt };
}

/** Explicit user action to reopen the wallet for the SAME pending request.
 * The relay issues an additive launch token; the original request survives. */
export async function relaunchMobileRelayInvocation(
  invocation: DurableInvocation,
  session: InferExternalSession,
  options: InferWalletOptions = {}
): Promise<InferMobileInvocationRelaunchReceipt> {
  assertBrowser();
  if (!matchingMobileInvocation(invocation, session, options) || !invocation.requestId) {
    throw new InferAdapterError(InferErrorCode.Unauthorized,
      "The existing relay request must be reconciled before relaunch");
  }
  const url = buildRelayUrl(invocation.mobileRequest!.relayBaseUrl,
    "/v1/requests/by-invocation/" + encodeURIComponent(invocation.id) + "/relaunch");
  const receipt = await fetchJsonWithTimeout<InferMobileInvocationRelaunchReceipt>(
    url, mobileRequestTimeout(options), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-infer-session-token": session.dappSessionToken!
      },
      body: JSON.stringify({ sessionId: session.sessionId })
    }
  );
  validateInvocationReceipt(receipt);
  if (receipt.requestId !== invocation.requestId ||
      receipt.status !== "pending" ||
      typeof receipt.walletDeeplinkUrl !== "string" ||
      !receipt.walletDeeplinkUrl ||
      Date.parse(receipt.expiresAt) <= Date.now()) {
    throw new InferAdapterError(InferErrorCode.InternalError,
      "Relay relaunch did not match the pending original request");
  }
  launch(receipt.walletDeeplinkUrl, options);
  return receipt;
}

/** Read the original request after reload; never creates a request or opens the wallet. */
export async function resumeMobileRelayRequest(
  requestId: string,
  session: InferExternalSession,
  options: InferWalletOptions = {}
): Promise<InferMobileRequestStatus> {
  if (!session.dappSessionToken || !session.sharedSecret) {
    throw new InferAdapterError(InferErrorCode.Unauthorized, "Missing relay session for recovery");
  }
  const pending = readPendingMobileRelayRequests(session).find((item) => item.requestId === requestId);
  const relayBaseUrl = session.relayBaseUrl ?? getRelayBaseUrl(options);
  if (!pending || pending.relayBaseUrl !== relayBaseUrl) {
    throw new InferAdapterError(InferErrorCode.Unauthorized, "Request does not belong to this relay session");
  }
  // Return the authenticated status/ciphertext for the dapp's existing durable journal.
  // The caller acknowledges with clearPendingMobileRelayRequest after recording it.
  return waitForRequestOutcome(requestId, pending.method, session, options, pending.expiresAt);
}

export async function connectViaMobileRelay(options: InferWalletOptions = {}): Promise<InferExternalSession> {
  assertBrowser();
  const relayBaseUrl = getRelayBaseUrl(options);
  const keyPair = createKeyPair();
  const response = await fetchJsonWithTimeout<InferMobilePairingCreateResponse>(
    buildRelayUrl(relayBaseUrl, "/v1/pairings"),
    mobileRequestTimeout(options),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        origin: window.location.origin,
        appName: appName(),
        callbackUrl: callbackUrlWithoutMarkers(),
        dappPublicKey: keyPair.publicKey
      })
    }
  );

  storePendingMobilePairing({
    pairingId: response.pairingId,
    dappPairingToken: response.dappPairingToken,
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    relayBaseUrl,
    expiresAt: response.expiresAt
  });
  rememberOwnedMobilePairing(response.pairingId);
  launch(response.walletDeeplinkUrl, options);
  const pairing = await waitForPairingOutcome(
    response.pairingId,
    response.dappPairingToken,
    options,
    getWebsocketUrl(options, response.websocketUrl)
  );

  try {
    const session = sessionFromApprovedPairing(pairing, relayBaseUrl, keyPair.privateKey);
    storeExternalSession(session);
    clearPendingMobilePairing();
    return session;
  } catch (error) {
    if (isFinalStatus(pairing.status)) {
      clearPendingMobilePairing();
    }
    throw error;
  }
}

function mobileCreationFailureReason(cause: unknown): string {
  if (cause instanceof BridgeHttpError) return "relay_http_" + cause.status;
  if (cause instanceof DOMException && cause.name === "AbortError") return "creation_timeout";
  if (cause instanceof TypeError) return "creation_network_error";
  return "creation_response_unavailable";
}

async function startRequest(
  method: "signMessage" | "signTransaction" | "signAndSubmitTransaction",
  payload: unknown,
  session: InferExternalSession,
  options: InferWalletOptions
): Promise<{ status: InferMobileRequestStatus; pending: PendingMobileRelayRequest; durableId: string }> {
  if (!session.dappSessionToken || !session.sharedSecret) {
    throw new InferAdapterError(InferErrorCode.Unauthorized, "Missing Infer Connect mobile relay session state");
  }

  const relayBaseUrl = session.relayBaseUrl ?? getRelayBaseUrl(options);
  let invocation: DurableInvocation;
  try {
    invocation = await prepareDurableInvocation(session, method);
  } catch (cause) {
    throw new InferRequestError(InferErrorCode.RequestNotInvoked,
      "Wallet request was not sent because its invocation could not be saved",
      null, null, cause);
  }
  const expectedTransactionBcsHex = method === "signTransaction" &&
    payload && typeof payload === "object" &&
    "rawTransactionBcsHex" in payload &&
    typeof payload.rawTransactionBcsHex === "string"
      ? payload.rawTransactionBcsHex : undefined;
  let envelope;
  try {
    envelope = {
      clientInvocationId: invocation.id,
      sessionId: session.sessionId,
      method,
      callbackUrl: callbackUrlWithoutMarkers(),
      encryptedRequest: encryptJson(payload, session.sharedSecret),
      requestMetadata: { origin: window.location.origin, appName: appName() }
    };
    await saveDurableMobileInvocationEnvelope(
      invocation.id, relayBaseUrl, envelope, expectedTransactionBcsHex
    );
    await options.onInvocationPrepared?.(Object.freeze({
      invocationId: invocation.id, transport: invocation.transport,
      sessionId: invocation.sessionId, address: invocation.address,
      network: invocation.network, chainId: invocation.chainId,
      method: invocation.method, state: invocation.state
    }));
  } catch (cause) {
    await updateDurableInvocation(invocation.id, "not-invoked").catch(() => undefined);
    throw new InferRequestError(InferErrorCode.RequestNotInvoked,
      "Wallet request was not sent because invocation persistence failed",
      invocation.id, null, cause);
  }
  let response: InferMobileRequestCreateResponse;
  try {
    response = await fetchJsonWithTimeout<InferMobileRequestCreateResponse>(
      buildRelayUrl(relayBaseUrl, "/v1/requests"),
      mobileRequestTimeout(options),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...envelope,
          dappSessionToken: session.dappSessionToken
        })
      }
    );
  } catch (cause) {
    await updateDurableInvocation(invocation.id, "unknown", undefined, mobileCreationFailureReason(cause)).catch(() => undefined);
    throw unresolvedRequestError(
      "Relay request creation may have succeeded; reconcile before retrying",
      invocation.id, null, cause);
  }

  if (typeof response.requestId !== "string" || !response.requestId ||
      typeof response.expiresAt !== "string" || !Number.isFinite(Date.parse(response.expiresAt))) {
    await updateDurableInvocation(invocation.id, "unknown", undefined, "invalid_creation_receipt").catch(() => undefined);
    throw new InferRequestError(InferErrorCode.RequestOutcomeUnknown,
      "Relay request creation returned an invalid receipt", invocation.id, null);
  }
  const pending: PendingMobileRelayRequest = {
    version: 1,
    requestId: response.requestId,
    invocationId: invocation.id,
    sessionId: session.sessionId,
    address: session.address,
    network: session.network,
    chainId: session.chainId,
    relayBaseUrl,
    origin: window.location.origin,
    method,
    expiresAt: response.expiresAt,
    ...(expectedTransactionBcsHex ? { expectedTransactionBcsHex } : {})
  };
  let durableId: string;
  try {
    storePendingMobileRelayRequest(pending);
    durableId = (await saveDurableRequest(pending, invocation.id)).id;
    await updateDurableInvocation(invocation.id, "created", response.requestId);
    await options.onMobileRequestCreated?.(Object.freeze({ ...pending }));
    await options.onRequestCreated?.(Object.freeze({ ...pending }));
  } catch (cause) {
    await updateDurableInvocation(invocation.id, "unknown", response.requestId).catch(() => undefined);
    throw unresolvedRequestError(
      "Relay request exists but its receipt could not be fully recorded",
      invocation.id, response.requestId, cause);
  }
  if (response.walletDeeplinkUrl && Date.parse(response.expiresAt) > Date.now()) {
    launch(response.walletDeeplinkUrl, options);
  }
  let status: InferMobileRequestStatus;
  try {
    status = await waitForRequestOutcome(response.requestId, method, session, options, response.expiresAt);
  } catch (cause) {
    throw unresolvedRequestError(
      "Relay request outcome is unresolved; read the original request before retrying",
      invocation.id, response.requestId, cause);
  }
  return { status, pending, durableId };
}

export function decodeMobileRelayResult(
  status: InferMobileRequestStatus,
  pending: PendingMobileRelayRequest,
  session: InferExternalSession
): CedraSignMessageOutput | (CedraSignTransactionOutputV1_1 & {
  authenticatorHex: string; rawTransactionBcsHex: string
}) | CedraSignAndSubmitTransactionOutput {
  if (!session.sharedSecret || pending.sessionId !== session.sessionId ||
      pending.address !== session.address || pending.network !== session.network ||
      pending.chainId !== session.chainId || pending.method !== status.method ||
      pending.requestId !== status.requestId) {
    throw new InferAdapterError(InferErrorCode.Unauthorized, "Recovery identity does not match the relay result");
  }
  if (status.status === "approved" &&
      (status.errorCode != null || status.errorMessage != null)) {
    throw new InferAdapterError(InferErrorCode.InternalError,
      "Infer Connect returned mixed approval and error fields");
  }
  if (status.status !== "approved" || !status.encryptedResult) {
    if (isCleanMobileTransactionRejection(status)) {
      throw new InferAdapterError(InferErrorCode.UserRejected, "User rejected the request");
    }
    if (pending.method === "signMessage" && status.status !== "rejected" &&
        status.encryptedResult == null) {
      throwForStatus(status.status, status.errorMessage);
    }
    throw new InferAdapterError(InferErrorCode.InternalError,
      "Infer Connect returned an ambiguous signing result");
  }
  const result = decryptJson<unknown>(status.encryptedResult, session.sharedSecret);
  if (pending.method === "signMessage") {
    if (!isRecord(result) || typeof result.address !== "string" ||
        result.address.toLowerCase() !== session.address.toLowerCase() ||
        typeof result.signature !== "string" ||
        typeof result.fullMessage !== "string" || typeof result.message !== "string" ||
        typeof result.nonce !== "string" || typeof result.prefix !== "string") {
      throw new InferAdapterError(InferErrorCode.InternalError,
        "Infer Connect returned an invalid signed message");
    }
    return result as unknown as CedraSignMessageOutput;
  }
  if (pending.method === "signTransaction") {
    return deserializeSignTransactionResult(result, pending.expectedTransactionBcsHex);
  }
  if (!isRecord(result) || Object.keys(result).length !== 1 ||
      !isValidTransactionHash(result.hash)) {
    throw new InferAdapterError(InferErrorCode.InternalError,
      "Infer Connect returned an approved transaction without a valid hash");
  }
  return { hash: result.hash };
}

async function completeMobileResult(
  status: InferMobileRequestStatus,
  pending: PendingMobileRelayRequest,
  session: InferExternalSession,
  durableId: string
): Promise<CedraSignMessageOutput | CedraSignTransactionOutputV1_1 | CedraSignAndSubmitTransactionOutput> {
  const invocationId = pending.invocationId!;
  let output: CedraSignMessageOutput | CedraSignTransactionOutputV1_1 | CedraSignAndSubmitTransactionOutput;
  try {
    output = decodeMobileRelayResult(status, pending, session);
  } catch (cause) {
    if (cause instanceof InferAdapterError && cause.code === InferErrorCode.UserRejected) {
      try {
        await saveDurableFinal(durableId, { status: "rejected" });
      } catch (storageCause) {
        throw unresolvedRequestError("Wallet rejection could not be saved durably",
          invocationId, pending.requestId, storageCause);
      }
      throw cause;
    }
    throw unresolvedRequestError("Wallet result could not be validated",
      invocationId, pending.requestId, cause);
  }
  try {
    await saveDurableFinal(durableId, serializeStoredFinal(pending.method, output));
  } catch (cause) {
    throw unresolvedRequestError("Verified wallet result could not be saved durably",
      invocationId, pending.requestId, cause);
  }
  return output;
}

export async function signMessageViaMobileRelay(
  input: CedraSignMessageInput,
  session: InferExternalSession,
  options: InferWalletOptions = {}
): Promise<CedraSignMessageOutput> {
  const { status, pending, durableId } = await startRequest("signMessage", input, session, options);
  return completeMobileResult(status, pending, session, durableId) as Promise<CedraSignMessageOutput>;
}

export async function signTransactionViaMobileRelay(
  input: CedraSignTransactionInputV1_1 | InferExternalSignTransactionInput,
  session: InferExternalSession,
  options: InferWalletOptions = {}
): Promise<CedraSignTransactionOutputV1_1 & { authenticatorHex: string; rawTransactionBcsHex: string }> {
  const { status, pending, durableId } = await startRequest("signTransaction", input, session, options);
  return completeMobileResult(status, pending, session, durableId) as Promise<
    CedraSignTransactionOutputV1_1 & { authenticatorHex: string; rawTransactionBcsHex: string }
  >;
}

const MOBILE_REJECTION_ALLOWED_KEYS = new Set([
  "requestId",
  "sessionId",
  "method",
  "status",
  "callbackUrl",
  "encryptedRequest",
  "encryptedResult",
  "requestMetadata",
  "resultMetadata",
  "errorCode",
  "errorMessage",
  "origin",
  "appName",
  "accountAddress",
  "network",
  "chainId",
  "walletName",
  "expiresAt"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isCleanRequestMetadata(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).every((key) => key === "origin" || key === "appName") &&
    isNullableString(value.origin) &&
    isNullableString(value.appName)
  );
}

function isCleanMobileTransactionRejection(status: InferMobileRequestStatus): boolean {
  if (status.status !== "rejected") return false;
  const record = status as unknown as Record<string, unknown>;
  if (!Object.keys(record).every((key) => MOBILE_REJECTION_ALLOWED_KEYS.has(key))) {
    return false;
  }

  return (
    status.encryptedResult == null &&
    status.resultMetadata == null &&
    isCleanRequestMetadata(status.requestMetadata) &&
    isNullableString(status.encryptedRequest) &&
    isNullableString(status.errorCode) &&
    isNullableString(status.errorMessage) &&
    isNullableString(status.origin) &&
    isNullableString(status.appName) &&
    isNullableString(status.accountAddress) &&
    isNullableString(status.network) &&
    (status.chainId === undefined || status.chainId === null || typeof status.chainId === "number") &&
    isNullableString(status.walletName) &&
    typeof status.callbackUrl === "string" &&
    typeof status.expiresAt === "string"
  );
}

export async function signAndSubmitViaMobileRelay(
  input: CedraSignAndSubmitTransactionInput | AnyMobileTransactionLike,
  session: InferExternalSession,
  options: InferWalletOptions = {}
): Promise<CedraSignAndSubmitTransactionOutput> {
  const { status, pending, durableId } = await startRequest("signAndSubmitTransaction", input, session, options);
  return completeMobileResult(status, pending, session, durableId) as Promise<CedraSignAndSubmitTransactionOutput>;
}

type AnyMobileTransactionLike = InferTransactionPayload | CedraSignAndSubmitTransactionInput;

export async function revokeMobileRelaySession(
  session: InferExternalSession,
  options: InferWalletOptions = {}
): Promise<void> {
  const relayBaseUrl = session.relayBaseUrl ?? getRelayBaseUrl(options);
  if (!session.dappSessionToken) return;
  await fetchJsonWithTimeout(
    buildRelayUrl(relayBaseUrl, `/v1/sessions/${session.sessionId}`),
    mobileRequestTimeout(options),
    {
      method: "DELETE",
      headers: {
        "x-infer-session-token": session.dappSessionToken
      }
    }
  );
}

/* ===================================================================
 * v0.2.0-rc.22 (Phase 2 / A1): authorized original-request read.
 *
 * After the original wallet session is gone, the dapp may still hold
 * an active `DurableRequest` whose original `sessionId` does not match
 * the current session. The Infer Connect recovery repair plan closes
 * the protocol dependency via:
 *
 *   POST /v1/requests/:requestId/read-grant
 *   GET  /v1/requests/:requestId/read-grant
 *
 * The dapp mints a one-shot read-grant over the OLD request, scoped to
 * (origin, accountAddress, network, chainId, method) — the relay's S1
 * endpoint REQUIRES `method` in the scope and validates it against the
 * original request row (`originalRequest.method !== method` → 403).
 * The wallet (W2) re-wraps the original ciphertext under the NEW
 * session's sharedSecret and POSTs to
 * `/v1/requests/:requestId/read-delivery`. The dapp then polls GET
 * until the grant is fulfilled, decrypts the redelivered ciphertext
 * with the CURRENT sharedSecret, and persists the verified result
 * via `saveDurableFinal` before returning.
 *
 * These helpers MUST NOT POST a second time if the existing request
 * can be read directly. They only fire on the authorized-read path
 * (when `matchingSession()` returns false on the same-scope path).
 *
 * Fallback contract (rc.22): older relays without the new endpoints
 * return 404 → the caller falls back to current rc.21 behavior. The
 * helper discriminates `ok: false, status: 404` distinctly so the
 * caller can short-circuit before any retry/decode logic.
 * =================================================================== */

/** Wire scope for the relay's S1 read-grant endpoints. Matches
 * `infer-service/src/routes/requests.ts` §"read-grant contract":
 * the relay REQUIRES `method` (validated against the original
 * request row) and treats `invocationId` as optional. `newSessionId`
 * is informational only — the relay resolves the authorizing session
 * from the presented `dappSessionToken`, never from the scope. */
export interface ReadGrantScope {
  origin: string;
  /** The address bound to the old session at the time of the original request. */
  accountAddress: string;
  network: string;
  chainId: number;
  /** Exact method of the original request — required by the relay. */
  method: ReadGrantMethod;
  /** Optional stable invocation identity, when the dapp minted one. */
  invocationId?: string;
  /** Informational only; the relay resolves the new session from the token. */
  newSessionId?: string;
}

/** Methods the relay's S1 endpoint accepts in a read-grant scope
 * (mirrors `REQUEST_SCOPE_METHODS` in infer-service). */
export type ReadGrantMethod = "signMessage" | "signTransaction" | "signAndSubmitTransaction";

export interface MintReadGrantArgs {
  relayBaseUrl: string;
  requestId: string;
  dappSessionToken: string;
  scope: ReadGrantScope;
}

export type MintReadGrantResult =
  | { ok: true; grantId: string; expiresAt: string }
  | { ok: false; status: number; error: string; errorMessage?: string };

export interface GetReadGrantArgs {
  relayBaseUrl: string;
  requestId: string;
  dappSessionToken: string;
}

/** Grant status enum — mirrors the relay's `relay_read_grant_status`
 * (`infer-service/src/db/schema.ts`) and the wallet's `SerializedGrant`
 * (`infer-wallet/src/services/inferConnectRelay.ts`). The relay signals
 * not-found / expired / denied grants via HTTP 404/410 (surfaced as
 * structured `{ok: false}` results), so those statuses appear here only
 * when a relay chooses to inline them in a 200 body. */
export type ReadGrantStatus =
  | "pending_fulfillment"
  | "fulfilled"
  | "expired"
  | "denied";

export interface ReadGrantDescriptor {
  grantId: string;
  requestId: string;
  scope: ReadGrantScope;
  status: ReadGrantStatus;
  expiresAt: string;
  fulfilledAt?: string;
  /** Wallet-side W2 re-encryption under the NEW session's sharedSecret.
   * Present only when `status === "fulfilled"`. */
  redeliveredEncryptedResult?: string;
}

function scopeToWire(scope: ReadGrantScope): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    origin: scope.origin,
    accountAddress: scope.accountAddress,
    network: scope.network,
    chainId: scope.chainId,
    method: scope.method
  };
  if (typeof scope.invocationId === "string" && scope.invocationId) {
    wire.invocationId = scope.invocationId;
  }
  if (typeof scope.newSessionId === "string" && scope.newSessionId) {
    wire.newSessionId = scope.newSessionId;
  }
  return wire;
}

function scopeFromWire(value: unknown): ReadGrantScope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.origin !== "string" || !record.origin) return null;
  if (typeof record.accountAddress !== "string" || !record.accountAddress) return null;
  if (typeof record.network !== "string" || !record.network) return null;
  if (typeof record.chainId !== "number" || !Number.isInteger(record.chainId)) return null;
  // The relay's S1 endpoint always echoes the method in the stored
  // scope; a descriptor without it cannot be trusted.
  if (typeof record.method !== "string" || !record.method) return null;
  const out: ReadGrantScope = {
    origin: record.origin,
    accountAddress: record.accountAddress,
    network: record.network,
    chainId: record.chainId,
    method: record.method as ReadGrantMethod
  };
  if (typeof record.invocationId === "string" && record.invocationId) {
    out.invocationId = record.invocationId;
  }
  if (typeof record.newSessionId === "string" && record.newSessionId) {
    out.newSessionId = record.newSessionId;
  }
  return out;
}

function parseReadGrantStatus(value: unknown): ReadGrantStatus | null {
  if (typeof value !== "string") return null;
  if (value === "pending_fulfillment" || value === "fulfilled" ||
      value === "expired" || value === "denied") {
    return value;
  }
  return null;
}

/**
 * Mint a one-shot authorized-read grant for the given original request.
 *
 * The endpoint POSTs the new session's `dappSessionToken` plus the row's
 * scope (origin, accountAddress, network, chainId, method) — the relay
 * REQUIRES `method` and rejects the mint with 400 `invalid_scope` when
 * it is missing.
 *
 * Returns `{ ok: true, grantId, expiresAt }` on success, or
 * `{ ok: false, status, error, errorMessage }` on failure. A 404 from
 * the relay is a distinct, structured "endpoint not available" signal
 * for the rc.22 fallback: the caller short-circuits to the existing
 * rc.21 behavior.
 */
export async function mintReadGrant(args: MintReadGrantArgs): Promise<MintReadGrantResult> {
  if (typeof window === "undefined") {
    return {
      ok: false, status: 0, error: "browser_unavailable",
      errorMessage: "Authorized-read requires a browser"
    };
  }
  const url = buildRelayUrl(args.relayBaseUrl, `/v1/requests/${encodeURIComponent(args.requestId)}/read-grant`);
  let payload: unknown;
  try {
    payload = await fetchJsonWithTimeout<{
      grantId?: unknown; expiresAt?: unknown; error?: unknown; errorMessage?: unknown;
    }>(url, mobileRequestTimeout({}), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-infer-session-token": args.dappSessionToken
      },
      body: JSON.stringify({
        dappSessionToken: args.dappSessionToken,
        scope: scopeToWire(args.scope)
      })
    });
  } catch (error) {
    if (error instanceof BridgeHttpError) {
      // Older relay (pre-Phase 0 S1) returns 404 for the new endpoint.
      // Surface as a structured failure so the recovery.ts caller can
      // fall back to rc.21 behavior without re-running fetchJsonWithTimeout.
      return {
        ok: false, status: error.status,
        error: error.status === 404 ? "endpoint_unavailable" : "mint_failed",
        errorMessage: error.message
      };
    }
    return {
      ok: false, status: 0, error: "mint_failed",
      errorMessage: error instanceof Error ? error.message : "Read-grant mint failed"
    };
  }
  if (!payload || typeof payload !== "object" ||
      typeof (payload as { grantId?: unknown }).grantId !== "string" ||
      typeof (payload as { expiresAt?: unknown }).expiresAt !== "string") {
    return {
      ok: false, status: 200, error: "malformed_response",
      errorMessage: "Relay returned a malformed read-grant response"
    };
  }
  return {
    ok: true,
    grantId: (payload as { grantId: string }).grantId,
    expiresAt: (payload as { expiresAt: string }).expiresAt
  };
}

/**
 * Poll the relay for the current state of a previously-minted read-grant.
 *
 * Returns a fully-validated `ReadGrantDescriptor` on success. The wallet
 * fulfills the grant asynchronously via W2 (`deliverReadGrant`); the
 * dapp polls `getReadGrant` until `status === "fulfilled"` (success) or
 * `"expired"` / `"denied"` (terminal failures — usually signaled by the
 * relay as HTTP 410, which lands in the `{ok: false}` branch), or the
 * caller's deadline elapses.
 *
 * Returns `{ ok: false, status: 404 }` on older relays — same fallback
 * contract as `mintReadGrant`.
 */
export async function getReadGrant(args: GetReadGrantArgs): Promise<
  | { ok: true; grant: ReadGrantDescriptor }
  | { ok: false; status: number; error: string; errorMessage?: string }
> {
  if (typeof window === "undefined") {
    return {
      ok: false, status: 0, error: "browser_unavailable",
      errorMessage: "Authorized-read requires a browser"
    };
  }
  const url = buildRelayUrl(args.relayBaseUrl, `/v1/requests/${encodeURIComponent(args.requestId)}/read-grant`);
  let payload: unknown;
  try {
    payload = await fetchJsonWithTimeout<{
      grantId?: unknown; requestId?: unknown;
      scope?: unknown; status?: unknown;
      expiresAt?: unknown; fulfilledAt?: unknown;
      redeliveredEncryptedResult?: unknown;
      error?: unknown; errorMessage?: unknown;
    }>(url, mobileRequestTimeout({}), {
      method: "GET",
      headers: {
        "x-infer-session-token": args.dappSessionToken
      }
    });
  } catch (error) {
    if (error instanceof BridgeHttpError) {
      return {
        ok: false, status: error.status,
        error: error.status === 404 ? "endpoint_unavailable" : "get_failed",
        errorMessage: error.message
      };
    }
    return {
      ok: false, status: 0, error: "get_failed",
      errorMessage: error instanceof Error ? error.message : "Read-grant poll failed"
    };
  }
  if (!payload || typeof payload !== "object") {
    return {
      ok: false, status: 200, error: "malformed_response",
      errorMessage: "Relay returned a malformed read-grant descriptor"
    };
  }
  const record = payload as {
    grantId?: unknown; requestId?: unknown;
    scope?: unknown; status?: unknown;
    expiresAt?: unknown; fulfilledAt?: unknown;
    redeliveredEncryptedResult?: unknown;
  };
  if (typeof record.grantId !== "string" || !record.grantId ||
      typeof record.requestId !== "string" || record.requestId !== args.requestId ||
      typeof record.expiresAt !== "string") {
    return {
      ok: false, status: 200, error: "malformed_response",
      errorMessage: "Relay returned a malformed read-grant descriptor"
    };
  }
  const status = parseReadGrantStatus(record.status);
  const scope = scopeFromWire(record.scope);
  if (!status || !scope) {
    return {
      ok: false, status: 200, error: "malformed_response",
      errorMessage: "Relay returned a malformed read-grant descriptor"
    };
  }
  const grant: ReadGrantDescriptor = {
    grantId: record.grantId,
    requestId: record.requestId,
    scope,
    status,
    expiresAt: record.expiresAt
  };
  if (typeof record.fulfilledAt === "string") grant.fulfilledAt = record.fulfilledAt;
  if (typeof record.redeliveredEncryptedResult === "string" &&
      record.redeliveredEncryptedResult) {
    grant.redeliveredEncryptedResult = record.redeliveredEncryptedResult;
  }
  return { ok: true, grant };
}
