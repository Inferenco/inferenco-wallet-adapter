import {
  AccountAuthenticator,
  Deserializer,
  Network
} from "@cedra-labs/ts-sdk";
import { CallbackOriginMismatch, NovaAdapterError } from "./errors.js";
import { MissingBridgeTokenError } from "./bridge/token.js";
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
  NovaExternalSignTransactionInput,
  NovaWalletCoreLike,
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
  DEFAULT_SESSION_LIVENESS_INTERVAL_MS,
  NOVA_CALLBACK_MARKER_STORAGE_KEY,
  NOVA_SESSION_CLEARED_MESSAGE_TYPE,
  NOVA_EXTERNAL_SESSION_STORAGE_KEY,
  NOVA_PENDING_MOBILE_PAIRING_STORAGE_KEY,
  NOVA_CONNECT_NAME,
  NOVA_PROTOCOL_KEY_STORAGE_KEY,
  PKCE_VERIFIER_STORAGE_KEY
} from "./constants";
import { BRIDGE_TOKEN_PATH_REGEX } from "./bridge/token.js";
import { forceRefreshBridgeToken } from "./bridge/token.js";
import { bridgePathWithToken, bridgeUrlWithToken, getBridgeBaseUrlWithToken } from "./bridge/url.js";
import { deserializeAnyRawTransaction, ensureBcsToHex, normalizeProviderAccount } from "./conversion";

type NovaPendingMobilePairing = {
  pairingId: string;
  dappPairingToken: string;
  privateKey: string;
  publicKey: string;
  relayBaseUrl: string;
  expiresAt: string;
};

const LEGACY_NOVA_DESK_LABEL = "Nova Desk";
const NOVA_SESSION_READY_MESSAGE_TYPE = "inferenco:nova-session-ready";
const NOVA_CALLBACK_OVERLAY_ID = "inferenco-nova-callback-overlay";

type NovaSessionReadyPayload = {
  type: typeof NOVA_SESSION_READY_MESSAGE_TYPE;
  session?: NovaExternalSession;
};

type NovaSessionClearedPayload = {
  type: typeof NOVA_SESSION_CLEARED_MESSAGE_TYPE;
};

let sessionResumeListenersInstalled = false;
let sessionReadyChannel: BroadcastChannel | null | undefined;
let sessionClearedChannel: BroadcastChannel | null | undefined;
const pendingExternalSessionWaiters = new Set<(session: NovaExternalSession) => void>();
/** v0.2.0-rc.8 (Phase 5 UX): wakeup set for any caller awaiting the
 * next external-session *clear* event. Used by NovaClient's storage-event
 * fallback path so internal callers can serialize against the
 * same-tab-disconnect case. */
const pendingExternalDisconnectWaiters = new Set<() => void>();

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

export { bridgePollIntervalMs };

function bridgePollTimeoutMs(options: NovaWalletOptions = {}): number {
  return options.bridgePollTimeoutMs ?? DEFAULT_BRIDGE_POLL_TIMEOUT_MS;
}

export { bridgePollTimeoutMs };

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
  let url = `${DEFAULT_DESKTOP_LOGIN_URL}?${params.toString()}`;

  // A3 (deeplink hardening): if the dapp passed a `codeChallenge` in
  // its options, append it to the deeplink URL. The wallet reads
  // this on launch and stores it for the eventual `/exchange`
  // request. The dapp keeps the `code_verifier` private; the
  // wallet only sees the `code_challenge`.
  const codeChallenge = (options as { codeChallenge?: string }).codeChallenge;
  if (typeof codeChallenge === "string" && codeChallenge.length > 0) {
    const separator = url.includes("?") ? "&" : "?";
    url = `${url}${separator}code_challenge=${encodeURIComponent(codeChallenge)}`;
  }

  return url;
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

  // Tier 1 (deeplink hardening): the wallet name is set by the wallet,
  // not the dapp. An attacker who controls the callback URL can
  // substitute any string here to confuse the dapp's UI. Reject any
  // value other than the canonical `NOVA_CONNECT_NAME`. The legacy
  // alias `LEGACY_NOVA_DESK_LABEL` is also accepted for backward
  // compatibility with older wallet builds that named themselves
  // "Nova Desk" (pre-0.1.1).
  if (
    typeof candidate.walletName === "string" &&
    candidate.walletName !== NOVA_CONNECT_NAME &&
    candidate.walletName !== LEGACY_NOVA_DESK_LABEL
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

/**
 * 0.2.0-rc.5: if the dapp just returned from a Nova Desk
 * deeplink handoff, the URL has either the legacy
 * `?address=...&sessionId=...` bundle or the PKCE
 * `?code=...` query param. Consume it into localStorage so the
 * rest of the resume flow (which reads from localStorage) can
 * pick it up. The dapp dev does not need to call any of this
 * directly — `tryResumeNovaWalletConnection` invokes this on
 * every page load.
 */
export async function consumeExternalCallbackIfPresent(
  options: NovaWalletOptions = {}
): Promise<boolean> {
  if (!isBrowser()) return false;
  // Defensive: if the location isn't a parseable URL (jsdom test
  // setup, server-side render, etc.), skip the callback consumption.
  // The resume flow falls through to the localStorage read.
  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch {
    return false;
  }

  if (url.searchParams.has("code")) {
    const codeVerifier = window.sessionStorage.getItem(PKCE_VERIFIER_STORAGE_KEY);
    if (codeVerifier) {
      // Best-effort: if the PKCE exchange fails (e.g. wallet
      // unreachable, expired code, missing verifier), the localStorage
      // read below is the next fallback. We do not throw — the
      // resume helper is `async` and the dapp's useEffect can
      // surface the failure separately if it wants to.
      try {
        await storeCallbackSessionViaPkce({ codeVerifier, options });
        return true;
      } catch {
        // Swallow; the caller is `tryResumeNovaWalletConnection`,
        // which has its own error surface.
        return false;
      }
    }
  }

  if (url.searchParams.has(CALLBACK_ADDRESS_PARAM)) {
    storeCallbackSession();
    return true;
  }
  return false;
}

export function storeExternalSession(session: NovaExternalSession): void {
  if (!isBrowser()) return;
  window.localStorage.setItem(NOVA_EXTERNAL_SESSION_STORAGE_KEY, JSON.stringify(session));
  if (session.protocolPublicKey) {
    window.localStorage.setItem(NOVA_PROTOCOL_KEY_STORAGE_KEY, session.protocolPublicKey);
  }
  resolvePendingExternalSessionWaiters(session);
}

export function clearExternalSession(): void {
  if (!isBrowser()) return;
  window.localStorage.removeItem(NOVA_EXTERNAL_SESSION_STORAGE_KEY);
  window.localStorage.removeItem(NOVA_PROTOCOL_KEY_STORAGE_KEY);
}

function parsePendingMobilePairing(
  candidate: Partial<NovaPendingMobilePairing> | null | undefined
): NovaPendingMobilePairing | null {
  if (
    !candidate ||
    typeof candidate.pairingId !== "string" ||
    typeof candidate.dappPairingToken !== "string" ||
    typeof candidate.privateKey !== "string" ||
    typeof candidate.publicKey !== "string" ||
    typeof candidate.relayBaseUrl !== "string" ||
    typeof candidate.expiresAt !== "string"
  ) {
    return null;
  }

  const expiresAt = Date.parse(candidate.expiresAt);
  if (Number.isNaN(expiresAt) || expiresAt <= Date.now()) {
    return null;
  }

  return {
    pairingId: candidate.pairingId,
    dappPairingToken: candidate.dappPairingToken,
    privateKey: candidate.privateKey,
    publicKey: candidate.publicKey,
    relayBaseUrl: candidate.relayBaseUrl,
    expiresAt: candidate.expiresAt
  };
}

export function readPendingMobilePairing(): NovaPendingMobilePairing | null {
  if (!isBrowser()) return null;
  const raw = window.localStorage.getItem(NOVA_PENDING_MOBILE_PAIRING_STORAGE_KEY);
  if (!raw) return null;

  try {
    const pairing = parsePendingMobilePairing(JSON.parse(raw) as Partial<NovaPendingMobilePairing>);
    if (!pairing) {
      clearPendingMobilePairing();
    }
    return pairing;
  } catch {
    clearPendingMobilePairing();
    return null;
  }
}

export function storePendingMobilePairing(pairing: NovaPendingMobilePairing): void {
  if (!isBrowser()) return;
  window.localStorage.setItem(NOVA_PENDING_MOBILE_PAIRING_STORAGE_KEY, JSON.stringify(pairing));
}

export function clearPendingMobilePairing(): void {
  if (!isBrowser()) return;
  window.localStorage.removeItem(NOVA_PENDING_MOBILE_PAIRING_STORAGE_KEY);
}

function sessionEndpointUrl(
  session: Pick<NovaExternalSession, "sessionId" | "bridgeUrl">,
  options: NovaWalletOptions = {}
): string {
  return _sessionEndpointUrlInternal(session, options);
}

/**
 * 0.2.0-rc.7: exposed for tests. Production callers go through
 * `sessionEndpointUrl` (which currently just aliases this function).
 * Underscore-prefixed so package consumers understand this is not a
 * stable surface — it may be removed or renamed without a major bump.
 */
export function _sessionEndpointUrlInternal(
  session: Pick<NovaExternalSession, "sessionId" | "bridgeUrl">,
  options: NovaWalletOptions = {}
): string {
  const sessionId = encodeURIComponent(session.sessionId);
  const base = sessionBridgeBaseUrl(session, options);
  // 0.2.0-rc.7: if the configured/embedded bridge URL carries the
  // per-session token as its first path segment (`.../<64-hex>`),
  // resolving `/session/<id>` against it via the URL constructor
  // replaces `<token>` with `session/<id>` (treating the token as
  // a "directory"). The bridge's F-03 token gate would then reject
  // the resulting request with a 404 and `validateExternalSession`
  // would call `clearExternalSession()`, wiping the freshly-consumed
  // session and breaking the dapp's connect promise.
  //
  // Detect the token segment and prefix it manually.
  const tokenSegment = extractBridgeTokenFromBaseUrl(base, options);
  if (tokenSegment) {
    try {
      const u = new URL(base);
      return `${u.protocol}//${u.host}/${tokenSegment}/session/${sessionId}`;
    } catch {
      /* fall through to URL constructor default */
    }
  }
  return new URL(`/session/${sessionId}`, base).toString();
}

function connectionEndpointUrl(
  session: Pick<NovaExternalSession, "address" | "network" | "bridgeUrl">,
  options: NovaWalletOptions = {}
): string {
  return _connectionEndpointUrlInternal(session, options);
}

/**
 * 0.2.0-rc.7: exposed for tests. Production callers go through
 * `connectionEndpointUrl` (which currently just aliases this function).
 * Underscore-prefixed so package consumers understand this is not a
 * stable surface — it may be removed or renamed without a major bump.
 */
export function _connectionEndpointUrlInternal(
  session: Pick<NovaExternalSession, "address" | "network" | "bridgeUrl">,
  options: NovaWalletOptions = {}
): string {
  const base = sessionBridgeBaseUrl(session, options);
  const tokenSegment = extractBridgeTokenFromBaseUrl(base, options);
  const url = new URL(
    tokenSegment ? `/${tokenSegment}/connection` : "/connection",
    base
  );
  url.searchParams.set("origin", window.location.origin);
  url.searchParams.set("address", session.address);
  url.searchParams.set("network", session.network);
  return url.toString();
}

/**
 * 0.2.0-rc.7: extract the per-session URL token from a base bridge
 * URL. Looks for the first path segment after `host:port`. Returns
 * null when the base has no recognisable token (the dapp is using
 * an unprefixed `http://127.0.0.1:21984` or no token in the URL).
 *
 * Used to preserve the `/<token>/` prefix when constructing URLs
 * relative to `session.bridgeUrl` in external browsers.
 */
function extractBridgeTokenFromBaseUrl(
  baseUrl: string,
  options: NovaWalletOptions = {}
): string | null {
  const candidates = [baseUrl, options.bridgeBaseUrl ?? ""];
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      const u = new URL(raw);
      const segment = u.pathname.replace(/^\//, "").split("/")[0] ?? "";
      if (BRIDGE_TOKEN_PATH_REGEX.test(segment)) return segment;
    } catch {
      continue;
    }
  }
  return null;
}

function sessionBridgeBaseUrl(
  session: Pick<NovaExternalSession, "bridgeUrl">,
  options: NovaWalletOptions = {}
): string {
  // Tier 1 (deeplink hardening): the dapp's configured `bridgeBaseUrl`
  // is the source of truth. `session.bridgeUrl` is treated as advisory
  // only — an attacker who controls the callback URL can substitute any
  // string there to point the dapp at a fake bridge server that logs
  // every signed message. We only fall back to `session.bridgeUrl`
  // when the dapp did not configure its own.
  const configuredUrl =
    options.bridgeBaseUrl ?? session.bridgeUrl ?? bridgeBaseUrl(options);

  try {
    const url = new URL(configuredUrl);
    if (url.pathname.startsWith("/session/")) {
      url.pathname = "/";
      url.search = "";
      url.hash = "";
    }
    return url.toString();
  } catch {
    return options.bridgeBaseUrl ?? bridgeBaseUrl(options);
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

function dispatchSessionReadyEvent(session: NovaExternalSession): void {
  window.dispatchEvent(
    new CustomEvent<NovaExternalSession>(NOVA_SESSION_READY_MESSAGE_TYPE, {
      detail: session
    })
  );
}

/** v0.2.0-rc.8 (Phase 5 UX): payload-less same-window dispatch. Dapp code
 * that wants to observe disconnect events without going through
 * `NovaClient` can listen directly with
 * `window.addEventListener(NOVA_SESSION_CLEARED_MESSAGE_TYPE, ...)`.
 * Mirror of `dispatchSessionReadyEvent`. */
function dispatchExternalDisconnect(): void {
  if (!isBrowser()) return;
  window.dispatchEvent(new CustomEvent(NOVA_SESSION_CLEARED_MESSAGE_TYPE));
}

function resolvePendingExternalSessionWaiters(session: NovaExternalSession): void {
  if (!isBrowser()) return;

  dispatchSessionReadyEvent(session);
  for (const resolve of pendingExternalSessionWaiters) {
    resolve(session);
  }
  pendingExternalSessionWaiters.clear();
}

function getSessionReadyChannel(): BroadcastChannel | null {
  if (!isBrowser() || typeof BroadcastChannel === "undefined") {
    return null;
  }
  if (sessionReadyChannel !== undefined) {
    return sessionReadyChannel;
  }

  sessionReadyChannel = new BroadcastChannel(NOVA_SESSION_READY_MESSAGE_TYPE);
  return sessionReadyChannel;
}

/** v0.2.0-rc.8 (Phase 5 UX): lazy-init BroadcastChannel for the
 * disconnect signal. Mirror of `getSessionReadyChannel`. */
function getSessionClearedChannel(): BroadcastChannel | null {
  if (!isBrowser() || typeof BroadcastChannel === "undefined") {
    return null;
  }
  if (sessionClearedChannel !== undefined) {
    return sessionClearedChannel;
  }

  sessionClearedChannel = new BroadcastChannel(NOVA_SESSION_CLEARED_MESSAGE_TYPE);
  return sessionClearedChannel;
}

function parseSessionReadyPayload(payload: unknown): NovaExternalSession | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as Partial<NovaSessionReadyPayload>;
  if (candidate.type !== NOVA_SESSION_READY_MESSAGE_TYPE) {
    return null;
  }

  return parseExternalSession(candidate.session);
}

/** v0.2.0-rc.8 (Phase 5 UX): typecheck for incoming cross-window /
 * BroadcastChannel messages carrying the disconnect signal. */
export function parseDisconnectPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const candidate = payload as Partial<NovaSessionClearedPayload>;
  return candidate.type === NOVA_SESSION_CLEARED_MESSAGE_TYPE;
}

function syncReadySession(session: NovaExternalSession | null): void {
  if (!session) {
    return;
  }
  resolvePendingExternalSessionWaiters(session);
}

export function installExternalSessionResumeListeners(): void {
  if (!isBrowser() || sessionResumeListenersInstalled) {
    return;
  }

  window.addEventListener("storage", (event) => {
    if (event.key !== NOVA_EXTERNAL_SESSION_STORAGE_KEY) {
      return;
    }

    // v0.2.0-rc.8 (Phase 5 UX): peer tabs that clear their
    // external-session localStorage entry fire a storage event
    // here with `newValue === null`. Treat that as a disconnect.
    if (event.newValue === null) {
      broadcastExternalDisconnect();
      return;
    }

    if (typeof event.newValue !== "string") {
      return;
    }

    try {
      const session = parseExternalSession(JSON.parse(event.newValue) as Partial<NovaExternalSession>);
      syncReadySession(session);
    } catch {
      // Ignore malformed storage payloads and let regular validation handle them.
    }
  });

  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) {
      return;
    }

    if (parseDisconnectPayload(event.data)) {
      broadcastExternalDisconnect();
      return;
    }

    syncReadySession(parseSessionReadyPayload(event.data));
  });

  getSessionReadyChannel()?.addEventListener("message", (event) => {
    syncReadySession(parseSessionReadyPayload(event.data));
  });

  // v0.2.0-rc.8 (Phase 5 UX): mirror listener on the cleared channel.
  getSessionClearedChannel()?.addEventListener("message", () => {
    broadcastExternalDisconnect();
  });

  sessionResumeListenersInstalled = true;
}

/** v0.2.0-rc.8 (Phase 5 UX): fire-and-forget helper that wakes every
 * consumer registered for a disconnect event. Idempotent — multiple
 * sources firing in the same tick result in a single logical event for
 * the waiters but multiple CustomEvent / BroadcastChannel /
 * `window.opener.postMessage` emissions, which is fine (no consumer
 * double-resolves because we `.clear()` the waiter set on the first
 * invocation). */
function broadcastExternalDisconnect(): void {
  if (!isBrowser()) {
    return;
  }

  const payload: NovaSessionClearedPayload = {
    type: NOVA_SESSION_CLEARED_MESSAGE_TYPE
  };

  dispatchExternalDisconnect();
  getSessionClearedChannel()?.postMessage(payload);

  if (window.opener && window.opener !== window) {
    try {
      window.opener.postMessage(payload, window.location.origin);
    } catch {
      // Ignore cross-window messaging failures and keep fallback paths active.
    }
  }

  for (const resolve of pendingExternalDisconnectWaiters) {
    resolve();
  }
  pendingExternalDisconnectWaiters.clear();
}

/** v0.2.0-rc.8 (Phase 5 UX): same-tab, in-process subscribe helper. Used
 * by `NovaClient` to wait for a disconnect signal to settle (e.g., to
 * serialize a reconnect attempt behind a wallet-initiated revoke).
 * Resolves immediately if a disconnect was already observed in this
 * tab before the subscribe call returned. */
export function awaitExternalDisconnect(): Promise<void> {
  if (!isBrowser()) {
    return Promise.resolve();
  }

  installExternalSessionResumeListeners();
  return new Promise((resolve) => {
    pendingExternalDisconnectWaiters.add(resolve);
  });
}

/** v0.2.0-rc.8 (Phase 5 UX): explicit dispatcher for dapp-side
 * disconnect events. Public API so a dapp that calls `clearExternalSession`
 * directly (without going through `client.disconnect()`) can still
 * broadcast a disconnect to peer tabs and listeners. `NovaClient`
 * emits this internally; dapp code calling `client.disconnect()` does
 * not need to invoke this directly. */
export function notifyExternalDisconnect(): void {
  broadcastExternalDisconnect();
}

/** v0.2.0-rc.8 (Phase 5 UX): test-only helper that resets the
 * module-level idempotency guard so subsequent test cases can verify
 * the install path runs fresh. NOT part of the public API surface
 * — the underscore prefix flags it for `_setBridgeTokenForTesting`
 * style consumers.
 *
 * Sets the channel sentinels back to `undefined` (not `null`) so the
 * lazy-init guards `if (sessionReadyChannel !== undefined)` rebuild
 * them on the next call. */
export function _resetExternalSessionResumeListenersForTesting(): void {
  sessionResumeListenersInstalled = false;
  sessionReadyChannel = undefined;
  sessionClearedChannel = undefined;
  pendingExternalSessionWaiters.clear();
  pendingExternalDisconnectWaiters.clear();
}

function broadcastReadySession(session: NovaExternalSession): void {
  if (!isBrowser()) {
    return;
  }

  const payload: NovaSessionReadyPayload = {
    type: NOVA_SESSION_READY_MESSAGE_TYPE,
    session
  };

  getSessionReadyChannel()?.postMessage(payload);

  if (window.opener && window.opener !== window) {
    try {
      window.opener.postMessage(payload, window.location.origin);
    } catch {
      // Ignore cross-window messaging failures and keep fallback paths active.
    }
  }
}

function renderCallbackCompletionFallback(): void {
  if (!isBrowser() || !document.body || document.getElementById(NOVA_CALLBACK_OVERLAY_ID)) {
    return;
  }

  const overlay = document.createElement("div");
  overlay.id = NOVA_CALLBACK_OVERLAY_ID;
  overlay.setAttribute(
    "style",
    [
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "padding:24px",
      "background:rgba(7,12,24,0.96)",
      "color:#f5f7ff",
      "font:600 16px/1.5 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "text-align:center"
    ].join(";")
  );
  overlay.textContent = "Nova Connect is complete. Return to the original tab.";
  document.body.appendChild(overlay);
}

function tryCloseCallbackWindow(): void {
  if (!isBrowser() || !window.opener || window.opener === window) {
    return;
  }

  window.setTimeout(() => {
    window.close();
    window.setTimeout(() => {
      renderCallbackCompletionFallback();
    }, 150);
  }, 0);
}

export function storeCallbackSession(): void {
  if (!isBrowser()) return;
  installExternalSessionResumeListeners();
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
  let callbackSession: NovaExternalSession | null = null;

  if (address && publicKey && network && chainId && sessionId) {
    const parsedChainId = Number.parseInt(chainId, 10);
    if (!Number.isNaN(parsedChainId)) {
      callbackSession = {
        transport: "desktop-bridge",
        address,
        publicKey,
        network,
        chainId: parsedChainId,
        sessionId,
        bridgeUrl: bridgeUrl ?? undefined,
        protocolPublicKey: protocolPublicKey ?? undefined,
        walletName: walletName ?? undefined
      };
      storeExternalSession(callbackSession);
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

  if (callbackSession) {
    broadcastReadySession(callbackSession);
    tryCloseCallbackWindow();
  }
}

/**
 * A3 (deeplink hardening, PKCE consumption): the dapp calls this
 * from its callback handler when the URL has a `code` param instead
 * of the legacy `address`/`sessionId` bundle. The helper reads the
 * `code_verifier` from `sessionStorage` (where the dapp stored it
 * before firing the deeplink), calls `exchangeCodeForSession`, and
 * stores the resulting session in `localStorage`. Cleans up the
 * `code` query param and the `sessionStorage` entry.
 *
 * Returns the consumed session, or `null` if no `code` param was
 * present (callers should fall through to `storeCallbackSession` in
 * that case for the legacy flow).
 */
export async function storeCallbackSessionViaPkce(input: {
  codeVerifier: string;
  options?: NovaWalletOptions;
}): Promise<NovaExternalSession | null> {
  if (!isBrowser()) return null;
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  if (!code) return null;
  if (typeof input.codeVerifier !== "string" || input.codeVerifier.length === 0) {
    throw new Error("codeVerifier is required to consume a PKCE callback");
  }

  const { exchangeCodeForSession } = await import("./bridge/pkce.js");
  const session = await exchangeCodeForSession({
    code,
    codeVerifier: input.codeVerifier,
    options: input.options
  });

  storeExternalSession({
    transport: "desktop-bridge",
    address: session.address,
    publicKey: session.publicKey,
    network: session.network,
    chainId: session.chainId,
    sessionId: session.sessionId,
    bridgeUrl: session.bridgeUrl,
    walletName: session.walletName ?? "Nova Connect"
  });

  // Mark the callback as resolved for the legacy marker path.
  window.sessionStorage.setItem(
    NOVA_CALLBACK_MARKER_STORAGE_KEY,
    JSON.stringify({
      requestId: "pkce",
      status: "approved"
    } satisfies NovaCallbackMarker)
  );

  // Strip the `code` query param from the URL.
  url.searchParams.delete("code");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);

  const stored = readExternalSession();
  if (stored) {
    broadcastReadySession(stored);
    tryCloseCallbackWindow();
  }
  return stored;
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

function hasPendingMobilePairingCallbackResume(): boolean {
  const marker = readCallbackMarker();
  const pendingPairing = readPendingMobilePairing();
  return !!marker && !!pendingPairing && marker.requestId === pendingPairing.pairingId;
}

export async function waitForExternalSession(
  options: NovaWalletOptions = {}
): Promise<NovaExternalSession | null> {
  if (!isBrowser()) return null;
  installExternalSessionResumeListeners();
  storeCallbackSession();

  const immediateSession = readExternalSession();
  if (immediateSession) {
    return immediateSession;
  }

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (session: NovaExternalSession | null) => {
      if (settled) {
        return;
      }
      settled = true;
      pendingExternalSessionWaiters.delete(handleReady);
      window.removeEventListener(
        NOVA_SESSION_READY_MESSAGE_TYPE,
        handleEvent as EventListener
      );
      window.clearInterval(pollId);
      window.clearTimeout(timeoutId);
      resolve(session);
    };

    const handleReady = (session: NovaExternalSession) => {
      finish(session);
    };

    const handleEvent = (event: Event) => {
      const session = (event as CustomEvent<NovaExternalSession | undefined>).detail;
      finish(session ?? readExternalSession());
    };

    pendingExternalSessionWaiters.add(handleReady);
    window.addEventListener(
      NOVA_SESSION_READY_MESSAGE_TYPE,
      handleEvent as EventListener
    );

    const pollId = window.setInterval(() => {
      storeCallbackSession();
      const session = readExternalSession();
      if (session) {
        finish(session);
      }
    }, bridgePollIntervalMs(options));

    const timeoutId = window.setTimeout(() => {
      finish(readExternalSession());
    }, bridgePollTimeoutMs(options));
  });
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

export async function tryResumeNovaWalletConnection(
  walletCore: NovaWalletCoreLike,
  options: NovaWalletOptions = {}
): Promise<boolean> {
  if (!isBrowser()) return false;
  installExternalSessionResumeListeners();

  // 0.2.0-rc.5: if Nova Desk redirected us back to the dapp with
  // a callback URL (legacy `?address=...&sessionId=...` or PKCE
  // `?code=...`), consume it BEFORE the localStorage read. The
  // dapp's useEffect calls this on every page load; if the URL
  // has callback params, they land in localStorage here and the
  // existing flow below picks them up. This makes the deeplink
  // path transparent to the dapp dev — no callback handling code
  // required.
  await consumeExternalCallbackIfPresent(options);

  const candidateWalletName = [NOVA_CONNECT_NAME, LEGACY_NOVA_DESK_LABEL].find((walletName) =>
    walletCore.wallets.some((wallet) => wallet.name === walletName)
  );
  if (!candidateWalletName) {
    return false;
  }

  // Tier 1 (deeplink hardening): if the dapp passed an `expectedOrigin`
  // option, verify that the callback URL's `window.location.origin`
  // matches. A mismatch indicates the deeplink was redirected to a
  // different origin than the dapp that initiated the connection —
  // usually a phishing attempt. This check fires after `readValidatedExternalSession`
  // has accepted the session shape; it's a defense-in-depth check on
  // where the callback actually landed.
  const expectedOrigin = (options as { expectedOrigin?: string }).expectedOrigin;
  if (expectedOrigin && typeof window !== "undefined") {
    const actualOrigin = window.location.origin;
    if (actualOrigin !== expectedOrigin) {
      // Clear the session so a subsequent retry starts clean.
      clearExternalSession();
      throw new CallbackOriginMismatch(expectedOrigin, actualOrigin);
    }
  }

  const hasPendingResume = hasPendingMobilePairingCallbackResume();
  if (!hasPendingResume) {
    const session = await readValidatedExternalSession(options);
    if (!session) {
      return false;
    }
  }

  await walletCore.connect(candidateWalletName);
  return true;
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

/**
 * v0.3.0+ pre-auth flow (Nova Desk 0.6.0-rc.3+, no-new-tab):
 *
 * The dapp's adapter calls `POST /preauth-connect` on the wallet's
 * bridge (no token required, `Origin` header is the auth — browsers
 * enforce it). The wallet returns a `requestId`. The adapter fires
 * the `inferenco://login?request=<requestId>&app=<name>` deeplink.
 * After the user approves in Nova Desk, the adapter polls
 * `GET /preauth-poll/<requestId>` and receives the session.
 *
 * This eliminates the legacy `xdg-open` step that opened a new tab
 * to deliver the session via a callback URL. The dapp's original
 * tab stays open the entire time.
 *
 * Returns `null` if the bridge is unreachable (e.g., wallet not
 * running). The caller should fall back to `tryLocalBridgeConnect`
 * for the legacy token-gated path (used by the embedded webview
 * path via postMessage).
 */
export interface PreauthStartResult {
  requestId: string;
  pollUrl: string;
  /**
   * Optional: present on older wallet builds (Nova Desk
   * < 0.6.0-rc.7), absent on newer builds (audit-08
   * ND-WEB-001 follow-on). Nova Desk no longer exposes the
   * process-global bridge URL to a dapp before approval —
   * the adapter falls back to its configured `bridgeBaseUrl`
   * for all sign operations via `bridgeUrlWithToken` /
   * `sessionBridgeBaseUrl` (both of which already treat
   * `session.bridgeUrl` as advisory).
   *
   * Direct API consumers (dapps calling `startPreauthConnect`
   * themselves) get `undefined` here and must rely on their
   * configured `bridgeBaseUrl` for sign operations.
   */
  bridgeUrl?: string;
}

export async function startPreauthConnect(input: {
  origin: string;
  app: string;
  expectedOrigin?: string;
  codeChallenge?: string;
  options?: NovaWalletOptions;
}): Promise<PreauthStartResult | null> {
  if (!isBrowser() || isMobileBrowser()) return null;

  const base = bridgeBaseUrl(input.options ?? {});
  // Strip any `/<token>` prefix from the configured bridge URL.
  // The pre-auth route is token-less; the wallet's `Origin`-based
  // auth is sufficient.
  const cleanedBase = base.replace(/\/[0-9a-f]{32,}\/?$/, "").replace(/\/$/, "");
  const url = `${cleanedBase}/preauth-connect`;
  const body = JSON.stringify({
    origin: input.origin,
    app: input.app,
    expected_origin: input.expectedOrigin,
    code_challenge: input.codeChallenge,
  });

  try {
    const response = await fetchJsonWithTimeout<{
      requestId: string;
      pollUrl: string;
      bridgeUrl: string;
      status?: string;
    }>(url, bridgeConnectTimeoutMs(input.options ?? {}), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
    });
    return {
      requestId: response.requestId,
      pollUrl: response.pollUrl,
      bridgeUrl: response.bridgeUrl,
    };
  } catch {
    return null;
  }
}

/**
 * v0.3.0+ pre-auth poll: `GET /preauth-poll/<requestId>`. Returns
 * `{status: "pending"}` while waiting; the flat
 * `ExternalBrowserConnectApproval` JSON (camelCase) when
 * approved; `{status: "rejected"}` on reject; null on bridge
 * failure (caller should retry).
 *
 * The adapter normalizes the wallet's flat shape into a
 * `NovaExternalSession`.
 */
export interface PreauthPollResult {
  status: "pending" | "approved" | "rejected";
  session?: NovaExternalSession;
  error?: string;
}

interface PreauthApprovedFlat {
  requestId: string;
  status: string;
  address: string;
  publicKey: string;
  network: string;
  chainId: number;
  sessionId: string;
  bridgeUrl: string;
  walletName: string;
}

function preauthFlatToSession(flat: PreauthApprovedFlat): NovaExternalSession {
  return {
    transport: "desktop-bridge",
    address: flat.address,
    publicKey: flat.publicKey,
    network: flat.network,
    chainId: flat.chainId,
    sessionId: flat.sessionId,
    bridgeUrl: flat.bridgeUrl,
    walletName: flat.walletName,
  };
}

export async function pollPreauthConnect(input: {
  requestId: string;
  options?: NovaWalletOptions;
}): Promise<PreauthPollResult | null> {
  if (!isBrowser() || isMobileBrowser()) return null;

  const base = bridgeBaseUrl(input.options ?? {})
    .replace(/\/[0-9a-f]{32,}\/?$/, "")
    .replace(/\/$/, "");
  const url = `${base}/preauth-poll/${encodeURIComponent(input.requestId)}`;
  try {
    const raw = await fetchJsonWithTimeout<unknown>(
      url,
      bridgeConnectTimeoutMs(input.options ?? {}),
    );
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;
    const status = obj.status;
    if (status === "approved") {
      const flat = obj as unknown as PreauthApprovedFlat;
      if (
        typeof flat.address === "string" &&
        typeof flat.publicKey === "string" &&
        typeof flat.network === "string" &&
        typeof flat.chainId === "number" &&
        typeof flat.sessionId === "string" &&
        typeof flat.bridgeUrl === "string"
      ) {
        return {
          status: "approved",
          session: preauthFlatToSession(flat),
        };
      }
      return null;
    }
    if (status === "rejected") {
      return {
        status: "rejected",
        error:
          typeof obj.error === "string"
            ? (obj.error as string)
            : "user_cancelled",
      };
    }
    return { status: "pending" };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      ((error as { status: number }).status === 404 ||
        (error as { status: number }).status === 410)
    ) {
      // Unknown / consumed request id — surface as a single
      // rejected result so the caller can error out cleanly.
      return { status: "rejected", error: "request_not_found" };
    }
    return null;
  }
}

/**
 * @deprecated since 0.2.0-rc.10. The pre-auth flow no longer
 * requires a deeplink in the success path. Nova Desk 0.6.0-rc.6+
 * auto-shows the approval sheet from `POST /preauth-connect` —
 * `NovaClient.connect()` no longer fires this URL internally. This
 * export remains for dapps that call it directly; it will be
 * removed in 0.4.0. When `startPreauthConnect` succeeds the wallet
 * surfaces the approval sheet via the bridge queue, so firing the
 * deeplink is redundant and triggers the browser's
 * external-protocol handler dialog (Chrome on Linux).
 *
 * @example
 * ```ts
 * // Old (rc.9 and earlier): fire the deeplink after a successful
 * // pre-auth POST.
 * const deeplink = buildDesktopOrMobileConnectUrlWithRequest(
 *   preauth.requestId,
 *   document.title,
 * );
 * window.location.href = deeplink;
 *
 * // New (rc.10+): the wallet surfaces the approval sheet
 * // automatically. Just poll.
 * const session = await pollPreauthUntilResolved(preauth.requestId);
 * ```
 */
export function buildDesktopOrMobileConnectUrlWithRequest(
  requestId: string,
  app: string,
  options: NovaWalletOptions = {},
): string {
  if (typeof console !== "undefined") {
    console.warn(
      "[inferenco-wallet-adapter] buildDesktopOrMobileConnectUrlWithRequest is deprecated since 0.2.0-rc.10. " +
      "When the pre-auth flow succeeds, Nova Desk auto-shows the approval sheet from the POST /preauth-connect queue — " +
      "no deeplink is needed. This export will be removed in 0.4.0.",
    );
  }
  if (isMobileBrowser()) {
    // Mobile path: emit the relay URL with the request_id encoded.
    const base = options.deeplinkBaseUrl ?? DEFAULT_DEEPLINK_BASE_URL;
    return `${base}${encodeURIComponent(requestId)}`;
  }
  const params = new URLSearchParams({
    request: requestId,
    app: app || "Nova Desk",
  });
  return `${DEFAULT_DESKTOP_LOGIN_URL}?${params.toString()}`;
}

export async function tryLocalBridgeConnect(options: NovaWalletOptions = {}): Promise<AccountInfo | null> {
  if (!isBrowser() || isMobileBrowser()) return null;

  // 0.2.0-rc.5: catch the synchronous `MissingBridgeTokenError` from
  // `bridgePathWithToken` (which calls `readBridgeToken`).
  // The dapp is in an external browser, the per-session URL token
  // is not available, and the bridge is unreachable. Return null
  // so the caller (`NovaClient.connect`) can fire its existing
  // deeplink fallback at line 340+. The page navigates away,
  // the user approves in Nova Desk, the browser returns to the
  // dapp's callback URL, and `tryResumeNovaWalletConnection` on
  // the new page consumes the session. The dapp dev code does
  // not need to change.
  let connectPath: string;
  try {
    connectPath = bridgePathWithToken("/connect", options);
  } catch (error) {
    if (
      error instanceof MissingBridgeTokenError ||
      // Some other synchronous failure (e.g. `bridgeBaseUrl` not a
      // URL): also fall through to the deeplink fallback rather
      // than surfacing a hard error.
      !(error instanceof NovaAdapterError)
    ) {
      return null;
    }
    throw error;
  }
  const connectUrl = new URL(connectPath, DEFAULT_DESKTOP_BRIDGE_URL);
  connectUrl.searchParams.set("origin", window.location.origin);
  connectUrl.searchParams.set("app", typeof document !== "undefined" ? document.title || "Nova Desk" : "Nova Desk");
  const connectUrlString = connectUrl.toString();
  const timeoutMs = bridgeConnectTimeoutMs(options);

  let start: NovaBridgeStartResponse;
  try {
    start = await fetchJsonWithTimeout<NovaBridgeStartResponse>(connectUrlString, timeoutMs);
  } catch {
    return null;
  }

  if (typeof start.requestId !== "string" || start.requestId.length === 0) {
    return null;
  }

  const pollUrl = bridgeUrlWithToken(`/request/${start.requestId}`, options);
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

/**
 * Tell the wallet to drop a `Pending` request that the dapp no longer cares
 * about (user hit "Cancel" in the dapp UI, dapp navigated, or the request
 * timed out). Fire-and-forget: a failure here is harmless because the wallet
 * also lazy-sweeps expired requests on its own.
 *
 * Without this, a cancelled dapp request would block the wallet's
 * "Another Nova Desk ... approval is already pending." guard for the
 * lifetime of the wallet process.
 */
function cancelPendingRequest(
  requestId: string,
  session: NovaExternalSession,
  options: NovaWalletOptions,
  reason: string
): void {
  if (!isBrowser() || !session.bridgeUrl) return;
  const url = bridgeUrlWithToken(`/cancel/${requestId}`, {
    ...options,
    bridgeBaseUrl: session.bridgeUrl
  });
  // Don't await — we don't want a network blip to delay the caller.
  // Fire-and-forget, with best-effort error suppression.
  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
    mode: "cors"
  }).catch(() => {
    /* wallet unreachable — the lazy sweep will eventually clear it */
  });
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
): CedraSignTransactionOutputV1_1 & { authenticatorHex: string; rawTransactionBcsHex: string } {
  const rawTransactionBcsHex = payload.rawTransactionBcsHex ?? payload.raw_transaction_bcs_hex;
  
  // Check for authenticatorHex directly, or nested in authenticator.hex
  let authenticatorHex = payload.authenticatorHex ?? payload.authenticator_hex;
  if (!authenticatorHex && payload.authenticator && typeof payload.authenticator === 'object') {
    const nestedAuthenticator = payload.authenticator as { hex?: string };
    authenticatorHex = nestedAuthenticator.hex;
  }

  if (typeof authenticatorHex !== "string" || typeof rawTransactionBcsHex !== "string") {
    throw new Error("Nova Desk bridge returned an incomplete signTransaction payload");
  }

  return {
    authenticator: ensureBcsToHex(AccountAuthenticator.deserialize(Deserializer.fromHex(authenticatorHex))),
    rawTransaction: deserializeAnyRawTransaction(rawTransactionBcsHex),
    authenticatorHex,
    rawTransactionBcsHex
  };
}

async function startBridgeRequest<T>(
  path: string,
  body: unknown,
  options: NovaWalletOptions,
  reconnectError: Error
): Promise<string> {
  // B+ retry logic: a 404 from the wallet's HTTP bridge most likely
  // means the wallet was restarted and the per-session URL token
  // rotated. We force-refresh the token (re-read pathname + re-arm
  // the postMessage listener) and retry once before giving up.
  const tryOnce = async () =>
    fetchJsonWithTimeout<NovaBridgeStartResponse>(
      bridgeUrlWithToken(path, options),
      bridgeConnectTimeoutMs(options),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }
    );

  let start: NovaBridgeStartResponse;
  try {
    start = await tryOnce();
  } catch (error) {
    if (error instanceof BridgeHttpError && error.status === 404) {
      try {
        forceRefreshBridgeToken();
        start = await tryOnce();
      } catch (retryError) {
        clearExternalSession();
        throw reconnectError;
      }
    } else if (error instanceof BridgeHttpError && (error.status === 403 || error.status >= 500)) {
      clearExternalSession();
      throw reconnectError;
    } else {
      throw error;
    }
  }

  if (typeof start.requestId !== "string" || start.requestId.length === 0) {
    throw new Error("Nova Desk bridge did not return a request id");
  }

  return start.requestId;
}

async function pollSignedResult<T extends { status?: string; error?: string }>(
  path: string,
  requestId: string,
  options: NovaWalletOptions,
  reconnectError: Error
): Promise<T> {
  // B+ retry logic: same token-refresh on 404, applied to the poll
  // loop. If the wallet rotated mid-session, the first poll returns
  // 404, the token is force-refreshed, and the second attempt uses
  // the new token.
  const tryOnce = () =>
    pollBridge<T>(bridgeUrlWithToken(`${path}/${requestId}`, options), options);

  try {
    return await tryOnce();
  } catch (error) {
    if (error instanceof BridgeHttpError && error.status === 404) {
      try {
        forceRefreshBridgeToken();
        return await tryOnce();
      } catch (retryError) {
        clearExternalSession();
        throw reconnectError;
      }
    }
    if (error instanceof BridgeHttpError && (error.status === 403 || error.status >= 500)) {
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
  try {
    const payload = await pollSignedResult<NovaBridgeMessagePoll>(
      "/message-request",
      requestId,
      { ...options, bridgeBaseUrl: session.bridgeUrl ?? options.bridgeBaseUrl },
      reconnectSigningError()
    );

    if (payload.status === "approved") return normalizeBridgeSignMessageOutput(payload);
    throw new Error(payload.error ?? "Nova Desk rejected the signMessage request");
  } catch (error) {
    cancelPendingRequest(
      requestId,
      session,
      options,
      error instanceof Error ? error.message : "adapter_error"
    );
    throw error;
  }
}

export async function tryLocalBridgeSignTransaction(
  input: CedraSignTransactionInputV1_1 | NovaExternalSignTransactionInput,
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
  try {
    const payload = await pollSignedResult<NovaBridgeSignTransactionPoll>(
      "/sign-transaction-request",
      requestId,
      { ...options, bridgeBaseUrl: session.bridgeUrl ?? options.bridgeBaseUrl },
      reconnectSigningError()
    );

    if (payload.status === "approved") return normalizeBridgeSignTransactionOutput(payload);
    throw new Error(payload.error ?? "Nova Desk rejected the signTransaction request");
  } catch (error) {
    cancelPendingRequest(
      requestId,
      session,
      options,
      error instanceof Error ? error.message : "adapter_error"
    );
    throw error;
  }
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
  try {
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
  } catch (error) {
    cancelPendingRequest(
      requestId,
      session,
      options,
      error instanceof Error ? error.message : "adapter_error"
    );
    throw error;
  }
}
