import {
  AccountAuthenticator,
  Deserializer,
  RawTransaction,
  SimpleTransaction
} from "@cedra-labs/ts-sdk";
import type {
  CedraSignAndSubmitTransactionInput,
  CedraSignAndSubmitTransactionOutput,
  CedraSignMessageInput,
  CedraSignMessageOutput,
  CedraSignTransactionInputV1_1,
  CedraSignTransactionOutputV1_1
} from "@cedra-labs/wallet-standard";
import type { NovaTransactionPayload } from "./types";
import {
  CALLBACK_REQUEST_ID_PARAM,
  CALLBACK_STATUS_PARAM,
  DEFAULT_DEEPLINK_SCHEME,
  DEFAULT_MOBILE_RELAY_BASE_URL,
  DEFAULT_MOBILE_POLL_INTERVAL_MS,
  DEFAULT_MOBILE_REQUEST_TIMEOUT_MS,
  DEFAULT_MOBILE_WEBSOCKET_URL
} from "./constants";
import { clearCallbackMarker, fetchJsonWithTimeout, readCallbackMarker, storeCallbackSession, storeExternalSession } from "./bridge";
import { decryptJson, createKeyPair, deriveSharedSecret, encryptJson } from "./mobileCrypto";
import { watchRelaySocket } from "./mobileSocket";
import { NovaAdapterError, NovaErrorCode } from "./errors";
import type {
  NovaCallbackMarker,
  NovaExternalSession,
  NovaMobilePairingCreateResponse,
  NovaMobilePairingStatus,
  NovaMobileRequestCreateResponse,
  NovaMobileRequestStatus,
  NovaWalletOptions
} from "./types";

function assertBrowser(): void {
  if (typeof window === "undefined") {
    throw new NovaAdapterError(NovaErrorCode.Unsupported, "Nova Connect mobile relay requires a browser");
  }
}

function getRelayBaseUrl(options: NovaWalletOptions): string {
  return options.relayBaseUrl ?? DEFAULT_MOBILE_RELAY_BASE_URL;
}

function getWebsocketUrl(options: NovaWalletOptions, fallback?: string): string | undefined {
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
  return url.toString();
}

function appName(): string {
  return typeof document !== "undefined" && document.title ? document.title : "Nova Connect";
}

function mobilePollInterval(options: NovaWalletOptions): number {
  return options.mobilePollIntervalMs ?? DEFAULT_MOBILE_POLL_INTERVAL_MS;
}

function mobileRequestTimeout(options: NovaWalletOptions): number {
  return options.mobileRequestTimeoutMs ?? DEFAULT_MOBILE_REQUEST_TIMEOUT_MS;
}

function buildRelayUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function launch(url: string): void {
  window.location.href = url;
}

function isFinalStatus(status: string | undefined): boolean {
  return status === "approved" || status === "rejected" || status === "expired" || status === "cancelled" || status === "revoked";
}

function throwForStatus(status: string, errorMessage?: string): never {
  if (status === "rejected") {
    throw new NovaAdapterError(NovaErrorCode.UserRejected, errorMessage ?? "User rejected the request");
  }
  if (status === "expired" || status === "cancelled" || status === "revoked") {
    throw new NovaAdapterError(NovaErrorCode.ConnectionTimeout, errorMessage ?? "Nova Connect request expired");
  }
  throw new NovaAdapterError(NovaErrorCode.InternalError, errorMessage ?? "Nova Connect request failed");
}

async function waitForPairingOutcome(
  pairingId: string,
  dappPairingToken: string,
  options: NovaWalletOptions,
  websocketUrl?: string
): Promise<NovaMobilePairingStatus> {
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
        const status = await fetchJsonWithTimeout<NovaMobilePairingStatus>(
          `${buildRelayUrl(relayBaseUrl, `/v1/pairings/${pairingId}`)}?dappPairingToken=${encodeURIComponent(dappPairingToken)}`,
          mobileRequestTimeout(options)
        );
        if (isFinalStatus(status.status)) {
          clearCallbackMarker();
          return status;
        }
        socketSignal = false;
      }

      await new Promise((resolve) => window.setTimeout(resolve, mobilePollInterval(options)));
    }
  } finally {
    socket?.close();
  }

  throw new NovaAdapterError(NovaErrorCode.ConnectionTimeout, "Timed out waiting for Nova Wallet approval");
}

async function waitForRequestOutcome(
  requestId: string,
  session: NovaExternalSession,
  options: NovaWalletOptions,
  websocketUrl?: string
): Promise<NovaMobileRequestStatus> {
  const relayBaseUrl = getRelayBaseUrl(options);
  const deadline = Date.now() + mobileRequestTimeout(options);
  let socketSignal = false;

  const socket =
    websocketUrl && session.dappSessionToken
      ? watchRelaySocket({
          websocketUrl,
          role: "dapp",
          token: session.dappSessionToken,
          target: { kind: "session", id: session.sessionId },
          options,
          onEvent(event) {
            if (
              (event.type === "request.approved" || event.type === "request.rejected") &&
              event.requestId === requestId
            ) {
              socketSignal = true;
            }
            if (event.type === "session.revoked" || event.type === "session.expired") {
              socketSignal = true;
            }
          }
        })
      : null;

  try {
    while (Date.now() < deadline) {
      storeCallbackSession();
      const marker = readCallbackMarker();
      if (socketSignal || marker?.requestId === requestId || !websocketUrl) {
        const status = await fetchJsonWithTimeout<NovaMobileRequestStatus>(
          buildRelayUrl(relayBaseUrl, `/v1/requests/${requestId}`),
          mobileRequestTimeout(options),
          {
            headers: {
              "x-nova-session-token": session.dappSessionToken ?? ""
            }
          }
        );
        if (isFinalStatus(status.status)) {
          clearCallbackMarker();
          return status;
        }
        socketSignal = false;
      }

      await new Promise((resolve) => window.setTimeout(resolve, mobilePollInterval(options)));
    }
  } finally {
    socket?.close();
  }

  throw new NovaAdapterError(NovaErrorCode.ConnectionTimeout, "Timed out waiting for Nova Wallet approval");
}

export async function connectViaMobileRelay(options: NovaWalletOptions = {}): Promise<NovaExternalSession> {
  assertBrowser();
  const relayBaseUrl = getRelayBaseUrl(options);
  const keyPair = createKeyPair();
  const response = await fetchJsonWithTimeout<NovaMobilePairingCreateResponse>(
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

  launch(response.walletDeeplinkUrl);
  const pairing = await waitForPairingOutcome(
    response.pairingId,
    response.dappPairingToken,
    options,
    getWebsocketUrl(options, response.websocketUrl)
  );

  if (pairing.status !== "approved" || !pairing.encryptedResult || !pairing.dappSessionToken || !pairing.walletPublicKey || !pairing.sessionId) {
    throwForStatus(pairing.status, pairing.errorMessage);
  }

  const sharedSecret = deriveSharedSecret(keyPair.privateKey, pairing.walletPublicKey);
  const result = decryptJson<{
    address: string;
    publicKey: string;
    network: string;
    chainId: number;
    walletName?: string;
  }>(pairing.encryptedResult, sharedSecret);

  const session: NovaExternalSession = {
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
  storeExternalSession(session);
  return session;
}

async function startRequest(
  method: "signMessage" | "signTransaction" | "signAndSubmitTransaction",
  payload: unknown,
  session: NovaExternalSession,
  options: NovaWalletOptions
): Promise<NovaMobileRequestStatus> {
  if (!session.dappSessionToken || !session.sharedSecret) {
    throw new NovaAdapterError(NovaErrorCode.Unauthorized, "Missing Nova Connect mobile relay session state");
  }

  const relayBaseUrl = session.relayBaseUrl ?? getRelayBaseUrl(options);
  const response = await fetchJsonWithTimeout<NovaMobileRequestCreateResponse>(
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

  launch(response.walletDeeplinkUrl);
  return waitForRequestOutcome(
    response.requestId,
    session,
    options,
    getWebsocketUrl(options)
  );
}

export async function signMessageViaMobileRelay(
  input: CedraSignMessageInput,
  session: NovaExternalSession,
  options: NovaWalletOptions = {}
): Promise<CedraSignMessageOutput> {
  const status = await startRequest("signMessage", input, session, options);
  if (status.status !== "approved" || !status.encryptedResult || !session.sharedSecret) {
    throwForStatus(status.status, status.errorMessage);
  }
  return decryptJson<CedraSignMessageOutput>(status.encryptedResult, session.sharedSecret);
}

export async function signTransactionViaMobileRelay(
  input: CedraSignTransactionInputV1_1,
  session: NovaExternalSession,
  options: NovaWalletOptions = {}
): Promise<CedraSignTransactionOutputV1_1> {
  const status = await startRequest("signTransaction", input, session, options);
  if (status.status !== "approved" || !status.encryptedResult || !session.sharedSecret) {
    throwForStatus(status.status, status.errorMessage);
  }
  const result = decryptJson<{
    authenticatorHex: string;
    rawTransactionBcsHex: string;
  }>(status.encryptedResult, session.sharedSecret);
  return {
    authenticator: AccountAuthenticator.deserialize(Deserializer.fromHex(result.authenticatorHex)),
    rawTransaction: new SimpleTransaction(
      RawTransaction.deserialize(Deserializer.fromHex(result.rawTransactionBcsHex))
    )
  };
}

export async function signAndSubmitViaMobileRelay(
  input: CedraSignAndSubmitTransactionInput | AnyMobileTransactionLike,
  session: NovaExternalSession,
  options: NovaWalletOptions = {}
): Promise<CedraSignAndSubmitTransactionOutput> {
  const status = await startRequest("signAndSubmitTransaction", input, session, options);
  if (status.status !== "approved" || !status.encryptedResult || !session.sharedSecret) {
    throwForStatus(status.status, status.errorMessage);
  }
  return decryptJson<CedraSignAndSubmitTransactionOutput>(status.encryptedResult, session.sharedSecret);
}

type AnyMobileTransactionLike = NovaTransactionPayload | CedraSignAndSubmitTransactionInput;

export async function revokeMobileRelaySession(
  session: NovaExternalSession,
  options: NovaWalletOptions = {}
): Promise<void> {
  const relayBaseUrl = session.relayBaseUrl ?? getRelayBaseUrl(options);
  if (!session.dappSessionToken) return;
  await fetchJsonWithTimeout(
    buildRelayUrl(relayBaseUrl, `/v1/sessions/${session.sessionId}`),
    mobileRequestTimeout(options),
    {
      method: "DELETE",
      headers: {
        "x-nova-session-token": session.dappSessionToken
      }
    }
  );
}
