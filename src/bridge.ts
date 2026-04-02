import {
  AccountAuthenticator,
  Deserializer,
  Network,
  RawTransaction,
  SimpleTransaction
} from "@cedra-labs/ts-sdk";
import type {
  AccountInfo,
  CedraSignAndSubmitTransactionInput,
  CedraSignAndSubmitTransactionOutput,
  CedraSignMessageInput,
  CedraSignMessageOutput,
  CedraSignTransactionInputV1_1,
  CedraSignTransactionOutputV1_1
} from "@cedra-labs/wallet-standard";
import type {
  NovaBridgeConnectPoll,
  NovaCallbackMarker,
  NovaBridgeMessagePoll,
  NovaBridgeSignTransactionPoll,
  NovaBridgeStartResponse,
  NovaBridgeTransactionPoll,
  NovaExternalSession,
  NovaWalletOptions
} from "./types";
import {
  CALLBACK_ADDRESS_PARAM,
  CALLBACK_BRIDGE_URL_PARAM,
  CALLBACK_CHAIN_ID_PARAM,
  CALLBACK_NETWORK_PARAM,
  CALLBACK_REQUEST_ID_PARAM,
  CALLBACK_PROTOCOL_PUBLIC_KEY_PARAM,
  CALLBACK_PUBLIC_KEY_PARAM,
  CALLBACK_SESSION_ID_PARAM,
  CALLBACK_STATUS_PARAM,
  CALLBACK_WALLET_NAME_PARAM,
  DEFAULT_BRIDGE_CONNECT_TIMEOUT_MS,
  DEFAULT_BRIDGE_POLL_INTERVAL_MS,
  DEFAULT_BRIDGE_POLL_TIMEOUT_MS,
  DEFAULT_DESKTOP_BRIDGE_URL,
  DEFAULT_DESKTOP_LOGIN_URL,
  DEFAULT_DEEPLINK_BASE_URL,
  NOVA_CALLBACK_MARKER_STORAGE_KEY,
  NOVA_EXTERNAL_SESSION_STORAGE_KEY,
  NOVA_PROTOCOL_KEY_STORAGE_KEY
} from "./constants";
import { normalizeProviderAccount } from "./conversion";

export class BridgeHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "BridgeHttpError";
  }
}

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

export function isMobileBrowser(): boolean {
  if (!isBrowser()) return false;
  const userAgent = navigator.userAgent.toLowerCase();
  const coarsePointer = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  return /android|iphone|ipad|ipod|mobile/.test(userAgent) || coarsePointer;
}

export function bridgeBaseUrl(options: NovaWalletOptions = {}): string {
  return options.bridgeBaseUrl ?? DEFAULT_DESKTOP_BRIDGE_URL;
}

function bridgeConnectTimeoutMs(options: NovaWalletOptions = {}): number {
  return options.bridgeConnectTimeoutMs ?? DEFAULT_BRIDGE_CONNECT_TIMEOUT_MS;
}

function bridgePollIntervalMs(options: NovaWalletOptions = {}): number {
  return options.bridgePollIntervalMs ?? DEFAULT_BRIDGE_POLL_INTERVAL_MS;
}

function bridgePollTimeoutMs(options: NovaWalletOptions = {}): number {
  return options.bridgePollTimeoutMs ?? DEFAULT_BRIDGE_POLL_TIMEOUT_MS;
}

export function currentUrlWithoutCallbackKey(): string {
  if (!isBrowser()) return "";
  const url = new URL(window.location.href);
  for (const key of [
    CALLBACK_ADDRESS_PARAM,
    CALLBACK_PUBLIC_KEY_PARAM,
    CALLBACK_NETWORK_PARAM,
    CALLBACK_CHAIN_ID_PARAM,
    CALLBACK_SESSION_ID_PARAM,
    CALLBACK_BRIDGE_URL_PARAM,
    CALLBACK_PROTOCOL_PUBLIC_KEY_PARAM,
    CALLBACK_WALLET_NAME_PARAM,
    CALLBACK_REQUEST_ID_PARAM,
    CALLBACK_STATUS_PARAM
  ]) {
    url.searchParams.delete(key);
  }
  return url.toString();
}

export function buildDesktopOrMobileConnectUrl(
  options: NovaWalletOptions = {},
  callbackUrl = currentUrlWithoutCallbackKey()
): string {
  if (isMobileBrowser()) {
    const base = options.deeplinkBaseUrl ?? DEFAULT_DEEPLINK_BASE_URL;
    return `${base}${encodeURIComponent(callbackUrl)}`;
  }

  const params = new URLSearchParams({
    redirect: callbackUrl,
    app: typeof document !== "undefined" ? document.title || "Nova Desk" : "Nova Desk"
  });
  return `${DEFAULT_DESKTOP_LOGIN_URL}?${params.toString()}`;
}

export function launchDesktopOrMobileConnect(
  options: NovaWalletOptions = {},
  callbackUrl = currentUrlWithoutCallbackKey()
): string {
  const url = buildDesktopOrMobileConnectUrl(options, callbackUrl);
  if (!isBrowser()) return url;

  window.location.href = url;
  return url;
}

function parseExternalSession(
  candidate: Partial<NovaExternalSession> | null | undefined
): NovaExternalSession | null {
  if (
    !candidate ||
    typeof candidate.address !== "string" ||
    typeof candidate.publicKey !== "string" ||
    typeof candidate.network !== "string" ||
    typeof candidate.chainId !== "number" ||
    typeof candidate.sessionId !== "string"
  ) {
    return null;
  }

  return {
    transport: candidate.transport === "mobile-relay" ? "mobile-relay" : "desktop-bridge",
    address: candidate.address,
    publicKey: candidate.publicKey,
    network: candidate.network,
    chainId: candidate.chainId,
    sessionId: candidate.sessionId,
    bridgeUrl: typeof candidate.bridgeUrl === "string" ? candidate.bridgeUrl : undefined,
    relayBaseUrl: typeof candidate.relayBaseUrl === "string" ? candidate.relayBaseUrl : undefined,
    protocolPublicKey:
      typeof candidate.protocolPublicKey === "string" ? candidate.protocolPublicKey : undefined,
    dappSessionToken:
      typeof candidate.dappSessionToken === "string" ? candidate.dappSessionToken : undefined,
    sharedSecret: typeof candidate.sharedSecret === "string" ? candidate.sharedSecret : undefined,
    walletPublicKey:
      typeof candidate.walletPublicKey === "string" ? candidate.walletPublicKey : undefined,
    walletName: typeof candidate.walletName === "string" ? candidate.walletName : undefined
  };
}

export function readExternalSession(): NovaExternalSession | null {
  if (!isBrowser()) return null;
  const raw = window.localStorage.getItem(NOVA_EXTERNAL_SESSION_STORAGE_KEY);
  if (!raw) return null;

  try {
    return parseExternalSession(JSON.parse(raw) as Partial<NovaExternalSession>);
  } catch {
    return null;
  }
}

export function hasStoredExternalSession(): boolean {
  return !!readExternalSession();
}

export function storeExternalSession(session: NovaExternalSession): void {
  if (!isBrowser()) return;
  window.localStorage.setItem(NOVA_EXTERNAL_SESSION_STORAGE_KEY, JSON.stringify(session));
  if (session.protocolPublicKey) {
    window.localStorage.setItem(NOVA_PROTOCOL_KEY_STORAGE_KEY, session.protocolPublicKey);
  }
}

export function clearExternalSession(): void {
  if (!isBrowser()) return;
  window.localStorage.removeItem(NOVA_EXTERNAL_SESSION_STORAGE_KEY);
  window.localStorage.removeItem(NOVA_PROTOCOL_KEY_STORAGE_KEY);
}

function sessionEndpointUrl(
  session: Pick<NovaExternalSession, "sessionId" | "bridgeUrl">,
  options: NovaWalletOptions = {}
): string {
  return new URL(
    `/session/${encodeURIComponent(session.sessionId)}`,
    sessionBridgeBaseUrl(session, options)
  ).toString();
}

function connectionEndpointUrl(
  session: Pick<NovaExternalSession, "address" | "network" | "bridgeUrl">,
  options: NovaWalletOptions = {}
): string {
  const url = new URL("/connection", sessionBridgeBaseUrl(session, options));
  url.searchParams.set("origin", window.location.origin);
  url.searchParams.set("address", session.address);
  url.searchParams.set("network", session.network);
  return url.toString();
}

function sessionBridgeBaseUrl(
  session: Pick<NovaExternalSession, "bridgeUrl">,
  options: NovaWalletOptions = {}
): string {
  const configuredUrl = session.bridgeUrl ?? bridgeBaseUrl(options);

  try {
    const url = new URL(configuredUrl);
    if (url.pathname.startsWith("/session/")) {
      url.pathname = "/";
      url.search = "";
      url.hash = "";
    }
    return url.toString();
  } catch {
    return bridgeBaseUrl(options);
  }
}

export function sessionToAccountInfo(session: NovaExternalSession): AccountInfo {
  return normalizeProviderAccount({
    address: session.address,
    publicKey: session.publicKey,
    network: {
      name: session.network as Network,
      chainId: session.chainId
    }
  });
}

function sessionFromBridgePoll(payload: NovaBridgeConnectPoll): NovaExternalSession {
  const address = payload.address;
  const publicKey = payload.publicKey ?? payload.public_key;
  const network = payload.network;
  const chainId = payload.chainId ?? payload.chain_id;
  const sessionId = payload.sessionId ?? payload.session_id;
  const bridgeUrl = payload.bridgeUrl ?? payload.bridge_url;
  const walletName = payload.walletName ?? payload.wallet_name;

  if (
    typeof address !== "string" ||
    typeof publicKey !== "string" ||
    typeof network !== "string" ||
    typeof chainId !== "number" ||
    typeof sessionId !== "string"
  ) {
    throw new Error("Nova Desk bridge returned an incomplete session payload");
  }

  return {
    transport: "desktop-bridge",
    address,
    publicKey,
    network,
    chainId,
    sessionId,
    bridgeUrl,
    walletName
  };
}

export function storeCallbackSession(): void {
  if (!isBrowser()) return;
  const url = new URL(window.location.href);
  const address = url.searchParams.get(CALLBACK_ADDRESS_PARAM);
  const publicKey = url.searchParams.get(CALLBACK_PUBLIC_KEY_PARAM);
  const network = url.searchParams.get(CALLBACK_NETWORK_PARAM);
  const chainId = url.searchParams.get(CALLBACK_CHAIN_ID_PARAM);
  const sessionId = url.searchParams.get(CALLBACK_SESSION_ID_PARAM);
  const bridgeUrl = url.searchParams.get(CALLBACK_BRIDGE_URL_PARAM);
  const protocolPublicKey = url.searchParams.get(CALLBACK_PROTOCOL_PUBLIC_KEY_PARAM);
  const walletName = url.searchParams.get(CALLBACK_WALLET_NAME_PARAM);
  const requestId = url.searchParams.get(CALLBACK_REQUEST_ID_PARAM);
  const status = url.searchParams.get(CALLBACK_STATUS_PARAM);

  if (address && publicKey && network && chainId && sessionId) {
    const parsedChainId = Number.parseInt(chainId, 10);
    if (!Number.isNaN(parsedChainId)) {
      storeExternalSession({
        transport: "desktop-bridge",
        address,
        publicKey,
        network,
        chainId: parsedChainId,
        sessionId,
        bridgeUrl: bridgeUrl ?? undefined,
        protocolPublicKey: protocolPublicKey ?? undefined,
        walletName: walletName ?? undefined
      });
    }
  } else if (publicKey) {
    window.localStorage.setItem(NOVA_PROTOCOL_KEY_STORAGE_KEY, publicKey);
  }

  if (requestId && status) {
    window.sessionStorage.setItem(
      NOVA_CALLBACK_MARKER_STORAGE_KEY,
      JSON.stringify({ requestId, status } satisfies NovaCallbackMarker)
    );
  }

  for (const key of [
    CALLBACK_ADDRESS_PARAM,
    CALLBACK_PUBLIC_KEY_PARAM,
    CALLBACK_NETWORK_PARAM,
    CALLBACK_CHAIN_ID_PARAM,
    CALLBACK_SESSION_ID_PARAM,
    CALLBACK_BRIDGE_URL_PARAM,
    CALLBACK_PROTOCOL_PUBLIC_KEY_PARAM,
    CALLBACK_WALLET_NAME_PARAM,
    CALLBACK_REQUEST_ID_PARAM,
    CALLBACK_STATUS_PARAM
  ]) {
    url.searchParams.delete(key);
  }

  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

export function readCallbackMarker(): NovaCallbackMarker | null {
  if (!isBrowser()) return null;
  const raw = window.sessionStorage.getItem(NOVA_CALLBACK_MARKER_STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<NovaCallbackMarker>;
    if (typeof parsed.requestId === "string" && typeof parsed.status === "string") {
      return {
        requestId: parsed.requestId,
        status: parsed.status
      };
    }
  } catch {
    return null;
  }

  return null;
}

export function clearCallbackMarker(): void {
  if (!isBrowser()) return;
  window.sessionStorage.removeItem(NOVA_CALLBACK_MARKER_STORAGE_KEY);
}

export async function waitForExternalSession(
  options: NovaWalletOptions = {}
): Promise<NovaExternalSession | null> {
  if (!isBrowser()) return null;

  const deadline = Date.now() + bridgePollTimeoutMs(options);

  while (Date.now() < deadline) {
    storeCallbackSession();
    const session = readExternalSession();
    if (session) {
      return session;
    }

    await new Promise((resolve) =>
      window.setTimeout(resolve, bridgePollIntervalMs(options))
    );
  }

  return null;
}

export async function validateExternalSession(
  session: NovaExternalSession,
  options: NovaWalletOptions = {}
): Promise<NovaExternalSession | null> {
  if (!isBrowser()) return null;
  if (session.transport === "mobile-relay") {
    return session;
  }

  try {
    const sessionUrl = sessionEndpointUrl(session, options);
    const payload = await fetchJsonWithTimeout<Partial<NovaExternalSession>>(
      sessionUrl,
      bridgeConnectTimeoutMs(options)
    );
    const validatedSession = parseExternalSession(payload) ?? session;
    const refreshedSession: NovaExternalSession = {
      ...session,
      ...validatedSession,
      bridgeUrl: validatedSession.bridgeUrl ?? session.bridgeUrl,
      protocolPublicKey: validatedSession.protocolPublicKey ?? session.protocolPublicKey,
      walletName: validatedSession.walletName ?? session.walletName
    };

    storeExternalSession(refreshedSession);

    return refreshedSession;
  } catch (error) {
    if (error instanceof BridgeHttpError && (error.status === 403 || error.status === 404)) {
      clearExternalSession();
    }

    return null;
  }
}

export async function revokeExternalSession(
  session: NovaExternalSession,
  options: NovaWalletOptions = {}
): Promise<void> {
  if (!isBrowser()) return;
  if (session.transport === "mobile-relay") {
    const relayBaseUrl = session.relayBaseUrl ?? options.relayBaseUrl;
    if (!relayBaseUrl || !session.dappSessionToken) return;
    await fetchJsonWithTimeout(
      new URL(`/v1/sessions/${encodeURIComponent(session.sessionId)}`, relayBaseUrl).toString(),
      bridgeConnectTimeoutMs(options),
      {
        method: "DELETE",
        headers: {
          "x-nova-session-token": session.dappSessionToken
        }
      }
    );
    return;
  }

  try {
    await fetchJsonWithTimeout(
      connectionEndpointUrl(session, options),
      bridgeConnectTimeoutMs(options),
      { method: "DELETE" }
    );
  } catch (error) {
    if (error instanceof BridgeHttpError && (error.status === 400 || error.status === 404)) {
      try {
        await fetchJsonWithTimeout(
          sessionEndpointUrl(session, options),
          bridgeConnectTimeoutMs(options),
          { method: "DELETE" }
        );
        return;
      } catch (fallbackError) {
        if (
          fallbackError instanceof BridgeHttpError &&
          (fallbackError.status === 403 || fallbackError.status === 404)
        ) {
          return;
        }

        throw fallbackError;
      }
    }

    if (error instanceof BridgeHttpError && error.status === 403) {
      return;
    }

    throw error;
  }
}

export async function readValidatedExternalSession(
  options: NovaWalletOptions = {}
): Promise<NovaExternalSession | null> {
  const session = readExternalSession();
  if (!session) {
    return null;
  }

  return validateExternalSession(session, options);
}

export async function fetchJsonWithTimeout<T>(
  url: string,
  timeoutMs: number,
  init?: RequestInit
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        ...(init?.headers ?? {})
      },
      mode: "cors",
      signal: controller.signal,
      ...init
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new BridgeHttpError(response.status, body || `Nova Desk bridge request failed with status ${response.status}`);
    }

    return (await response.json()) as T;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function pollBridge<T extends { status?: string; error?: string }>(
  url: string,
  options: NovaWalletOptions
): Promise<T> {
  const deadline = Date.now() + bridgePollTimeoutMs(options);

  while (Date.now() < deadline) {
    const payload = await fetchJsonWithTimeout<T>(url, bridgeConnectTimeoutMs(options));
    if (payload.status && payload.status !== "pending") {
      return payload;
    }
    await new Promise((resolve) => window.setTimeout(resolve, bridgePollIntervalMs(options)));
  }

  throw new Error("Timed out waiting for Nova Desk approval");
}

export async function tryLocalBridgeConnect(options: NovaWalletOptions = {}): Promise<AccountInfo | null> {
  if (!isBrowser() || isMobileBrowser()) return null;

  const connectUrl = new URL("/connect", bridgeBaseUrl(options));
  connectUrl.searchParams.set("origin", window.location.origin);
  connectUrl.searchParams.set("app", typeof document !== "undefined" ? document.title || "Nova Desk" : "Nova Desk");

  let start: NovaBridgeStartResponse;
  try {
    start = await fetchJsonWithTimeout<NovaBridgeStartResponse>(connectUrl.toString(), bridgeConnectTimeoutMs(options));
  } catch {
    return null;
  }

  if (typeof start.requestId !== "string" || start.requestId.length === 0) {
    return null;
  }

  const pollUrl = new URL(`/request/${start.requestId}`, bridgeBaseUrl(options)).toString();
  const payload = await pollBridge<NovaBridgeConnectPoll>(pollUrl, options);

  if (payload.status === "approved") {
    const session = sessionFromBridgePoll(payload);
    storeExternalSession(session);
    return sessionToAccountInfo(session);
  }

  if (payload.status === "rejected") {
    throw new Error(payload.error ?? "Nova Desk rejected the browser bridge request");
  }

  throw new Error(payload.error ?? "Nova Desk bridge connect failed");
}

function reconnectSigningError(): Error {
  return new Error("Nova Desk is not reachable for signing. Reconnect the wallet and try again.");
}

function reconnectTransactionError(): Error {
  return new Error("Nova Desk is not reachable for transaction approval. Reconnect the wallet and try again.");
}

function normalizeBridgeSignMessageOutput(payload: NovaBridgeMessagePoll): CedraSignMessageOutput {
  const address = payload.address;
  const signature = payload.signature;
  const fullMessage = payload.fullMessage ?? payload.full_message;
  const message = payload.message;

  if (
    typeof address !== "string" ||
    typeof signature !== "string" ||
    typeof fullMessage !== "string" ||
    typeof message !== "string"
  ) {
    throw new Error("Nova Desk bridge returned an incomplete signMessage payload");
  }

  return {
    address,
    fullMessage,
    message,
    nonce: "",
    prefix: "CEDRA",
    signature: signature as unknown as CedraSignMessageOutput["signature"]
  };
}

function normalizeBridgeSignTransactionOutput(
  payload: NovaBridgeSignTransactionPoll
): CedraSignTransactionOutputV1_1 {
  const authenticatorHex = payload.authenticatorHex ?? payload.authenticator_hex;
  const rawTransactionBcsHex = payload.rawTransactionBcsHex ?? payload.raw_transaction_bcs_hex;

  if (typeof authenticatorHex !== "string" || typeof rawTransactionBcsHex !== "string") {
    throw new Error("Nova Desk bridge returned an incomplete signTransaction payload");
  }

  return {
    authenticator: AccountAuthenticator.deserialize(Deserializer.fromHex(authenticatorHex)),
    rawTransaction: new SimpleTransaction(RawTransaction.deserialize(Deserializer.fromHex(rawTransactionBcsHex)))
  };
}

async function startBridgeRequest<T>(
  path: string,
  body: unknown,
  options: NovaWalletOptions,
  reconnectError: Error
): Promise<string> {
  try {
    const start = await fetchJsonWithTimeout<NovaBridgeStartResponse>(
      new URL(path, bridgeBaseUrl(options)).toString(),
      bridgeConnectTimeoutMs(options),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }
    );

    if (typeof start.requestId !== "string" || start.requestId.length === 0) {
      throw new Error("Nova Desk bridge did not return a request id");
    }

    return start.requestId;
  } catch (error) {
    if (error instanceof BridgeHttpError && (error.status === 403 || error.status === 404)) {
      clearExternalSession();
      throw reconnectError;
    }
    if (error instanceof BridgeHttpError && error.status >= 500) {
      throw reconnectError;
    }
    throw error;
  }
}

async function pollSignedResult<T extends { status?: string; error?: string }>(
  path: string,
  requestId: string,
  options: NovaWalletOptions,
  reconnectError: Error
): Promise<T> {
  try {
    return await pollBridge<T>(new URL(`${path}/${requestId}`, bridgeBaseUrl(options)).toString(), options);
  } catch (error) {
    if (error instanceof BridgeHttpError && (error.status === 403 || error.status === 404)) {
      clearExternalSession();
      throw reconnectError;
    }
    throw error;
  }
}

export async function tryLocalBridgeSignMessage(
  input: CedraSignMessageInput,
  session: NovaExternalSession,
  options: NovaWalletOptions = {}
): Promise<CedraSignMessageOutput> {
  if (!isBrowser() || !session.sessionId) throw reconnectSigningError();

  const requestId = await startBridgeRequest(
    "/sign-message",
    {
      origin: window.location.origin,
      app: typeof document !== "undefined" ? document.title || "Nova Desk" : "Nova Desk",
      sessionId: session.sessionId,
      message: input
    },
    { ...options, bridgeBaseUrl: session.bridgeUrl ?? options.bridgeBaseUrl },
    reconnectSigningError()
  );
  const payload = await pollSignedResult<NovaBridgeMessagePoll>(
    "/message-request",
    requestId,
    { ...options, bridgeBaseUrl: session.bridgeUrl ?? options.bridgeBaseUrl },
    reconnectSigningError()
  );

  if (payload.status === "approved") return normalizeBridgeSignMessageOutput(payload);
  throw new Error(payload.error ?? "Nova Desk rejected the signMessage request");
}

export async function tryLocalBridgeSignTransaction(
  input: CedraSignTransactionInputV1_1,
  session: NovaExternalSession,
  options: NovaWalletOptions = {}
): Promise<CedraSignTransactionOutputV1_1> {
  if (!isBrowser() || !session.sessionId) throw reconnectSigningError();

  const requestId = await startBridgeRequest(
    "/sign-transaction",
    {
      origin: window.location.origin,
      app: typeof document !== "undefined" ? document.title || "Nova Desk" : "Nova Desk",
      sessionId: session.sessionId,
      transaction: input
    },
    { ...options, bridgeBaseUrl: session.bridgeUrl ?? options.bridgeBaseUrl },
    reconnectSigningError()
  );
  const payload = await pollSignedResult<NovaBridgeSignTransactionPoll>(
    "/sign-transaction-request",
    requestId,
    { ...options, bridgeBaseUrl: session.bridgeUrl ?? options.bridgeBaseUrl },
    reconnectSigningError()
  );

  if (payload.status === "approved") return normalizeBridgeSignTransactionOutput(payload);
  throw new Error(payload.error ?? "Nova Desk rejected the signTransaction request");
}

export async function tryLocalBridgeSignAndSubmit(
  input: CedraSignAndSubmitTransactionInput,
  session: NovaExternalSession,
  options: NovaWalletOptions = {}
): Promise<CedraSignAndSubmitTransactionOutput> {
  if (!isBrowser() || !session.sessionId) throw reconnectTransactionError();

  const requestId = await startBridgeRequest(
    "/transaction",
    {
      origin: window.location.origin,
      app: typeof document !== "undefined" ? document.title || "Nova Desk" : "Nova Desk",
      sessionId: session.sessionId,
      transaction: input
    },
    { ...options, bridgeBaseUrl: session.bridgeUrl ?? options.bridgeBaseUrl },
    reconnectTransactionError()
  );
  const payload = await pollSignedResult<NovaBridgeTransactionPoll>(
    "/transaction-request",
    requestId,
    { ...options, bridgeBaseUrl: session.bridgeUrl ?? options.bridgeBaseUrl },
    reconnectTransactionError()
  );

  if (payload.status === "approved" && typeof payload.hash === "string" && payload.hash.length > 0) {
    return { hash: payload.hash };
  }

  throw new Error(payload.error ?? "Nova Desk rejected the transaction request");
}
