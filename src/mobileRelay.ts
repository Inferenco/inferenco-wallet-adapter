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
import {
  storePendingMobileRelayRequest,
  readPendingMobileRelayRequests,
  type PendingMobileRelayRequest
} from "./mobileRequests";
import {
  isValidTransactionHash,
  InferAdapterError,
  InferErrorCode
} from "./errors";
import { deserializeSignTransactionResult } from "./conversion";
import type {
  InferExternalSignTransactionInput,
  InferExternalSession,
  InferMobilePairingCreateResponse,
  InferMobilePairingStatus,
  InferMobileRequestCreateResponse,
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

function launch(url: string): void {
  window.location.href = url;
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
  let socketSignal = false;

  const socket = websocketUrl
    ? watchRelaySocket({
        websocketUrl,
        role: "dapp",
        token: dappPairingToken,
        target: { kind: "pairing", id: pairingId },
        options,
        onEvent(event) {
          if (event.type === "pairing.approved" || event.type === "pairing.rejected") {
            socketSignal = true;
          }
        }
      })
    : null;

  try {
    while (Date.now() < deadline) {
      storeCallbackSession();
      const marker = readCallbackMarker();
      if (socketSignal || marker?.requestId === pairingId || !websocketUrl) {
        const status = await fetchJsonWithTimeout<InferMobilePairingStatus>(
          `${buildRelayUrl(relayBaseUrl, `/v1/pairings/${pairingId}`)}?dappPairingToken=${encodeURIComponent(dappPairingToken)}`,
          mobileRequestTimeout(options)
        );
        if (isFinalStatus(status.status)) {
          if (readCallbackMarker()?.requestId === pairingId) clearCallbackMarker();
          return status;
        }
        socketSignal = false;
      }

      await new Promise((resolve) => window.setTimeout(resolve, mobilePollInterval(options)));
    }
  } finally {
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

export async function resumeMobileRelaySessionFromCallback(
  options: InferWalletOptions = {}
): Promise<InferExternalSession | null> {
  assertBrowser();
  const marker = readCallbackMarker();
  const pendingPairing = readPendingMobilePairing();

  if (!marker || !pendingPairing || marker.requestId !== pendingPairing.pairingId) {
    return null;
  }

  const pairing = await fetchJsonWithTimeout<InferMobilePairingStatus>(
    `${buildRelayUrl(pendingPairing.relayBaseUrl, `/v1/pairings/${pendingPairing.pairingId}`)}?dappPairingToken=${encodeURIComponent(pendingPairing.dappPairingToken)}`,
    mobileRequestTimeout(options)
  );

  if (pairing.status === "approved") {
    try {
      const session = sessionFromApprovedPairing(pairing, pendingPairing.relayBaseUrl, pendingPairing.privateKey);
      storeExternalSession(session);
      clearPendingMobilePairing();
      clearCallbackMarker();
      return session;
    } catch (error) {
      clearPendingMobilePairing();
      clearCallbackMarker();
      throw error;
    }
  }

  if (isFinalStatus(pairing.status)) {
    clearPendingMobilePairing();
    clearCallbackMarker();
    return null;
  }

  return null;
}

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
  options: InferWalletOptions = {}
): Promise<{ pending: PendingMobileRelayRequest; status: InferMobileRequestStatus }> {
  if (!session.dappSessionToken || !session.sharedSecret) {
    throw new InferAdapterError(InferErrorCode.Unauthorized, "Missing relay session for recovery");
  }
  const pending = readPendingMobileRelayRequests(session).find((item) => item.requestId === requestId);
  const relayBaseUrl = session.relayBaseUrl ?? getRelayBaseUrl(options);
  if (!pending || pending.relayBaseUrl !== relayBaseUrl) {
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
  launch(response.walletDeeplinkUrl);
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

async function startRequest(
  method: "signMessage" | "signTransaction" | "signAndSubmitTransaction",
  payload: unknown,
  session: InferExternalSession,
  options: InferWalletOptions
): Promise<{ status: InferMobileRequestStatus; pending: PendingMobileRelayRequest }> {
  if (!session.dappSessionToken || !session.sharedSecret) {
    throw new InferAdapterError(InferErrorCode.Unauthorized, "Missing Infer Connect mobile relay session state");
  }

  const relayBaseUrl = session.relayBaseUrl ?? getRelayBaseUrl(options);
  const response = await fetchJsonWithTimeout<InferMobileRequestCreateResponse>(
    buildRelayUrl(relayBaseUrl, "/v1/requests"),
    mobileRequestTimeout(options),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        sessionId: session.sessionId,
        dappSessionToken: session.dappSessionToken,
        method,
        callbackUrl: callbackUrlWithoutMarkers(),
        encryptedRequest: encryptJson(payload, session.sharedSecret),
        requestMetadata: {
          origin: window.location.origin,
          appName: appName()
        }
      })
    }
  );

  if (typeof response.requestId !== "string" || !response.requestId ||
      typeof response.expiresAt !== "string" || !Number.isFinite(Date.parse(response.expiresAt))) {
    throw new InferAdapterError(InferErrorCode.InternalError, "Invalid relay request receipt");
  }
  const pending: PendingMobileRelayRequest = {
    version: 1,
    requestId: response.requestId,
    sessionId: session.sessionId,
    address: session.address,
    network: session.network,
    chainId: session.chainId,
    relayBaseUrl,
    origin: window.location.origin,
    method,
    expiresAt: response.expiresAt,
    ...(method === "signTransaction" && payload && typeof payload === "object" &&
        "rawTransactionBcsHex" in payload && typeof payload.rawTransactionBcsHex === "string"
      ? { expectedTransactionBcsHex: payload.rawTransactionBcsHex } : {})
  };
  storePendingMobileRelayRequest(pending);
  await options.onMobileRequestCreated?.(Object.freeze({ ...pending }));
  await options.onRequestCreated?.(Object.freeze({ ...pending }));
  if (Date.parse(response.expiresAt) > Date.now()) launch(response.walletDeeplinkUrl);
  const status = await waitForRequestOutcome(response.requestId, method, session, options, response.expiresAt);
  return { status, pending };
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

export async function signMessageViaMobileRelay(
  input: CedraSignMessageInput,
  session: InferExternalSession,
  options: InferWalletOptions = {}
): Promise<CedraSignMessageOutput> {
  const { status, pending } = await startRequest("signMessage", input, session, options);
  return decodeMobileRelayResult(status, pending, session) as CedraSignMessageOutput;
}

export async function signTransactionViaMobileRelay(
  input: CedraSignTransactionInputV1_1 | InferExternalSignTransactionInput,
  session: InferExternalSession,
  options: InferWalletOptions = {}
): Promise<CedraSignTransactionOutputV1_1 & { authenticatorHex: string; rawTransactionBcsHex: string }> {
  const { status, pending } = await startRequest("signTransaction", input, session, options);
  return decodeMobileRelayResult(status, pending, session) as
    CedraSignTransactionOutputV1_1 & { authenticatorHex: string; rawTransactionBcsHex: string };
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
  const { status, pending } = await startRequest("signAndSubmitTransaction", input, session, options);
  return decodeMobileRelayResult(status, pending, session) as CedraSignAndSubmitTransactionOutput;
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
