import {
  Network
} from "@cedra-labs/ts-sdk";
import {
  CallbackOriginMismatch,
  isValidTransactionHash,
  InferAdapterError,
  InferRequestError,
  unresolvedRequestError,
  InferErrorCode
} from "./errors.js";
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
  InferBridgeConnectPoll,
  InferCallbackMarker,
  InferBridgeMessagePoll,
  InferBridgeSignTransactionPoll,
  InferBridgeStartResponse,
  InferBridgeTransactionPoll,
  InferExternalSession,
  InferExternalSignTransactionInput,
  InferWalletCoreLike,
  InferWalletOptions
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
  INFER_CALLBACK_MARKER_STORAGE_KEY,
  INFER_SESSION_CLEARED_MESSAGE_TYPE,
  INFER_EXTERNAL_SESSION_STORAGE_KEY,
  INFER_PENDING_MOBILE_PAIRING_STORAGE_KEY,
  INFER_CONNECT_NAME,
  INFER_WALLET_NAME,
  INFER_DESK_APP_NAME,
  INFER_PROTOCOL_KEY_STORAGE_KEY,
  LEGACY_CALLBACK_REQUEST_ID_PARAM,
  LEGACY_CALLBACK_STATUS_PARAM,
  LEGACY_INFER_CONNECT_NAME,
  LEGACY_INFER_DESK_LABEL,
  LEGACY_NOVA_EXTERNAL_SESSION_STORAGE_KEY,
  LEGACY_NOVA_PROTOCOL_KEY_STORAGE_KEY,
  LEGACY_NOVA_PENDING_MOBILE_PAIRING_STORAGE_KEY,
  LEGACY_NOVA_CALLBACK_MARKER_STORAGE_KEY,
  PKCE_VERIFIER_STORAGE_KEY
} from "./constants";
import { BRIDGE_TOKEN_PATH_REGEX } from "./bridge/token.js";
import { forceRefreshBridgeToken } from "./bridge/token.js";
import { bridgePathWithToken, bridgeUrlWithToken, getBridgeBaseUrlWithToken } from "./bridge/url.js";
import { deserializeSignTransactionResult, normalizeProviderAccount } from "./conversion";
import { prepareDurableInvocation, saveDurableRequest, saveDurableFinal, serializeStoredFinal, updateDurableInvocation } from "./durableRecovery";
import { desktopBridgeOrigin, storePendingDesktopBridgeRequest, readPendingDesktopBridgeRequests, type PendingDesktopBridgeRequest } from "./desktopRequests";

type InferPendingMobilePairing = {
  pairingId: string;
  dappPairingToken: string;
  privateKey: string;
  publicKey: string;
  relayBaseUrl: string;
  expiresAt: string;
};

// v0.3.0 (rebrand): the canonical pub/sub channel is renamed to
// `inferenco:infer-session-ready`. We keep the legacy string on the wire
// during the transition window so identical sessions created by older Infer
// Desk builds (which still post to `inferenco:nova-session-ready`) are still
// observed by the same listener. Both channel names share the listener; the
// legacy one is slated for removal in 0.4.0.
const INFER_SESSION_READY_MESSAGE_TYPE = "inferenco:infer-session-ready";
const LEGACY_INFER_SESSION_READY_MESSAGE_TYPE = "inferenco:nova-session-ready";
const INFER_CALLBACK_OVERLAY_ID = "inferenco-infer-callback-overlay";

type InferSessionReadyPayload = {
  type: typeof INFER_SESSION_READY_MESSAGE_TYPE;
  session?: InferExternalSession;
};

type InferSessionClearedPayload = {
  type: typeof INFER_SESSION_CLEARED_MESSAGE_TYPE;
};

let sessionResumeListenersInstalled = false;
let sessionReadyChannel: BroadcastChannel | null | undefined;
let sessionClearedChannel: BroadcastChannel | null | undefined;
const pendingExternalSessionWaiters = new Set<(session: InferExternalSession) => void>();
/** v0.2.0-rc.8 (Phase 5 UX): wakeup set for any caller awaiting the
 * next external-session *clear* event. Used by InferClient's storage-event
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

/**
 * v0.3.0 (rebrand): dual-read localStorage helpers.
 *
 * Each helper reads the primary (rebranded) storage key first; if
 * it is missing, falls back to the legacy `inferenco:nova-*` key.
 * On a successful read from the legacy key, the helper writes the
 * data to the primary key (eager migration) and removes the legacy
 * key so subsequent reads find the primary only. Writes always go to
 * the primary key — no dual-write.
 *
 * The legacy read paths will be removed in 0.4.0 once every active
 * wallet version writes to the primary keys.
 */
function dualReadItem(
  store: Storage,
  primaryKey: string,
  legacyKey: string
): string | null {
  const primary = store.getItem(primaryKey);
  if (primary !== null) return primary;
  const legacy = store.getItem(legacyKey);
  if (legacy === null) return null;
  try {
    store.setItem(primaryKey, legacy);
    store.removeItem(legacyKey);
  } catch {
    /* ignore — best-effort migration */
  }
  return legacy;
}

function readPrimaryOrLegacyItem(
  store: Storage,
  primaryKey: string,
  legacyKey: string
): string | null {
  return dualReadItem(store, primaryKey, legacyKey);
}

function dualReadSession(): string | null {
  if (!isBrowser()) return null;
  return readPrimaryOrLegacyItem(
    window.localStorage,
    INFER_EXTERNAL_SESSION_STORAGE_KEY,
    LEGACY_NOVA_EXTERNAL_SESSION_STORAGE_KEY
  );
}

function dualReadProtocolPublicKey(): string | null {
  if (!isBrowser()) return null;
  return readPrimaryOrLegacyItem(
    window.localStorage,
    INFER_PROTOCOL_KEY_STORAGE_KEY,
    LEGACY_NOVA_PROTOCOL_KEY_STORAGE_KEY
  );
}

function dualReadPendingMobilePairing(): string | null {
  if (!isBrowser()) return null;
  return readPrimaryOrLegacyItem(
    window.localStorage,
    INFER_PENDING_MOBILE_PAIRING_STORAGE_KEY,
    LEGACY_NOVA_PENDING_MOBILE_PAIRING_STORAGE_KEY
  );
}

function dualReadCallbackMarker(): string | null {
  if (!isBrowser()) return null;
  return readPrimaryOrLegacyItem(
    window.sessionStorage,
    INFER_CALLBACK_MARKER_STORAGE_KEY,
    LEGACY_NOVA_CALLBACK_MARKER_STORAGE_KEY
  );
}

export function isMobileBrowser(): boolean {
  if (!isBrowser()) return false;
  const userAgent = navigator.userAgent.toLowerCase();
  const coarsePointer = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  return /android|iphone|ipad|ipod|mobile/.test(userAgent) || coarsePointer;
}

export function bridgeBaseUrl(options: InferWalletOptions = {}): string {
  return options.bridgeBaseUrl ?? DEFAULT_DESKTOP_BRIDGE_URL;
}

function bridgeConnectTimeoutMs(options: InferWalletOptions = {}): number {
  return options.bridgeConnectTimeoutMs ?? DEFAULT_BRIDGE_CONNECT_TIMEOUT_MS;
}

function bridgePollIntervalMs(options: InferWalletOptions = {}): number {
  return options.bridgePollIntervalMs ?? DEFAULT_BRIDGE_POLL_INTERVAL_MS;
}

export { bridgePollIntervalMs };

function bridgePollTimeoutMs(options: InferWalletOptions = {}): number {
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
    LEGACY_CALLBACK_REQUEST_ID_PARAM,
    CALLBACK_STATUS_PARAM,
    LEGACY_CALLBACK_STATUS_PARAM
  ]) {
    url.searchParams.delete(key);
  }
  return url.toString();
}

export function buildDesktopOrMobileConnectUrl(
  options: InferWalletOptions = {},
  callbackUrl = currentUrlWithoutCallbackKey()
): string {
  if (isMobileBrowser()) {
    const base = options.deeplinkBaseUrl ?? DEFAULT_DEEPLINK_BASE_URL;
    return `${base}${encodeURIComponent(callbackUrl)}`;
  }

  const params = new URLSearchParams({
    redirect: callbackUrl,
    app: typeof document !== "undefined" ? document.title || "Infer Desk" : "Infer Desk"
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
  options: InferWalletOptions = {},
  callbackUrl = currentUrlWithoutCallbackKey()
): string {
  const url = buildDesktopOrMobileConnectUrl(options, callbackUrl);
  if (!isBrowser()) return url;

  window.location.href = url;
  return url;
}

function parseExternalSession(
  candidate: Partial<InferExternalSession> | null | undefined
): InferExternalSession | null {
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
  // value other than the canonical rebrand names, including Infer Wallet
  // returned by approved mobile pairings (Infer Connect is the adapter name).
  // The legacy aliases
  // (`LEGACY_INFER_CONNECT_NAME` = "Nova Connect" and
  // `LEGACY_INFER_DESK_LABEL` = "Nova Desk") are also accepted during
  // the transition window for previously-stored sessions and cached
  // callback URLs. Slated for removal in 0.4.0.
  if (
    typeof candidate.walletName === "string" &&
    candidate.walletName !== INFER_CONNECT_NAME &&
    candidate.walletName !== INFER_WALLET_NAME &&
    candidate.walletName !== INFER_DESK_APP_NAME &&
    candidate.walletName !== LEGACY_INFER_DESK_LABEL &&
    candidate.walletName !== LEGACY_INFER_CONNECT_NAME
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

export function readExternalSession(): InferExternalSession | null {
  if (!isBrowser()) return null;
  const raw = dualReadSession();
  if (!raw) return null;

  try {
    return parseExternalSession(JSON.parse(raw) as Partial<InferExternalSession>);
  } catch {
    return null;
  }
}

export function hasStoredExternalSession(): boolean {
  return !!readExternalSession();
}

/**
 * 0.2.0-rc.5: if the dapp just returned from a Infer Desk
 * deeplink handoff, the URL has either the legacy
 * `?address=...&sessionId=...` bundle or the PKCE
 * `?code=...` query param. Consume it into localStorage so the
 * rest of the resume flow (which reads from localStorage) can
 * pick it up. The dapp dev does not need to call any of this
 * directly — `tryResumeInferWalletConnection` invokes this on
 * every page load.
 */
export async function consumeExternalCallbackIfPresent(
  options: InferWalletOptions = {}
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
        // Swallow; the caller is `tryResumeInferWalletConnection`,
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

export function storeExternalSession(session: InferExternalSession): void {
  if (!isBrowser()) return;
  window.localStorage.setItem(INFER_EXTERNAL_SESSION_STORAGE_KEY, JSON.stringify(session));
  if (session.protocolPublicKey) {
    window.localStorage.setItem(INFER_PROTOCOL_KEY_STORAGE_KEY, session.protocolPublicKey);
  }
  resolvePendingExternalSessionWaiters(session);
}

export function clearExternalSession(): void {
  if (!isBrowser()) return;
  window.localStorage.removeItem(INFER_EXTERNAL_SESSION_STORAGE_KEY);
  window.localStorage.removeItem(INFER_PROTOCOL_KEY_STORAGE_KEY);
  // v0.3.0 (rebrand): also clear legacy aliases so a wallet that migrates a
  // previous user immediately picks up the new key.
  window.localStorage.removeItem(LEGACY_NOVA_EXTERNAL_SESSION_STORAGE_KEY);
  window.localStorage.removeItem(LEGACY_NOVA_PROTOCOL_KEY_STORAGE_KEY);
}

function parsePendingMobilePairing(
  candidate: Partial<InferPendingMobilePairing> | null | undefined
): InferPendingMobilePairing | null {
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

export function readPendingMobilePairing(): InferPendingMobilePairing | null {
  if (!isBrowser()) return null;
  const raw = dualReadPendingMobilePairing();
  if (!raw) return null;

  try {
    const pairing = parsePendingMobilePairing(JSON.parse(raw) as Partial<InferPendingMobilePairing>);
    if (!pairing) {
      clearPendingMobilePairing();
    }
    return pairing;
  } catch {
    clearPendingMobilePairing();
    return null;
  }
}

export function storePendingMobilePairing(pairing: InferPendingMobilePairing): void {
  if (!isBrowser()) return;
  window.localStorage.setItem(INFER_PENDING_MOBILE_PAIRING_STORAGE_KEY, JSON.stringify(pairing));
}

export function clearPendingMobilePairing(): void {
  if (!isBrowser()) return;
  window.localStorage.removeItem(INFER_PENDING_MOBILE_PAIRING_STORAGE_KEY);
  window.localStorage.removeItem(LEGACY_NOVA_PENDING_MOBILE_PAIRING_STORAGE_KEY);
}

function sessionEndpointUrl(
  session: Pick<InferExternalSession, "sessionId" | "bridgeUrl">,
  options: InferWalletOptions = {}
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
  session: Pick<InferExternalSession, "sessionId" | "bridgeUrl">,
  options: InferWalletOptions = {}
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
  session: Pick<InferExternalSession, "address" | "network" | "bridgeUrl">,
  options: InferWalletOptions = {}
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
  session: Pick<InferExternalSession, "address" | "network" | "bridgeUrl">,
  options: InferWalletOptions = {}
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
  options: InferWalletOptions = {}
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
  session: Pick<InferExternalSession, "bridgeUrl">,
  options: InferWalletOptions = {}
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
    // 0.2.0-rc.17: graft the per-session URL token from `session.bridgeUrl`
    // onto a bare `options.bridgeBaseUrl`. Required because the Tier 1
    // hardening (commit 4e68273, rc.4) prefers `options.bridgeBaseUrl`
    // over `session.bridgeUrl`, which silently strips the token for dApps
    // that pass a bare base URL (e.g. infer-ecosystem). Without the
    // token, every disconnect-signalling route (`/session/<id>`,
    // `/connection`) hits the wallet's F-03 token gate, returns 404
    // without CORS, and `validateExternalSession()` (rc.15) clears its
    // own localStorage session on every page load.
    //
    // ND-WEB-001 (deeplink hardening) stays closed: the HOST still comes
    // from `options.bridgeBaseUrl`. An attacker who substitutes
    // `session.bridgeUrl` can only inject a forged token SEGMENT onto
    // the dApp's own trusted host — the request goes to the dApp's
    // server, where it 404s. No signed messages leak.
    //
    // We skip the graft when the configured base already carries a token
    // (avoids double-prefix) and when no token is available in the
    // session (mobile-relay, pre-token storage).
    if (options.bridgeBaseUrl && session.bridgeUrl) {
      const baseHasToken = extractBridgeTokenFromBaseUrl(
        url.toString(),
        options
      );
      if (!baseHasToken) {
        const sessionToken = extractBridgeTokenFromBaseUrl(
          session.bridgeUrl,
          {}
        );
        if (sessionToken) {
          url.pathname = `/${sessionToken}${
            url.pathname === "/" ? "" : url.pathname
          }`;
        }
      }
    }
    return url.toString();
  } catch {
    return options.bridgeBaseUrl ?? bridgeBaseUrl(options);
  }
}

export function sessionToAccountInfo(session: InferExternalSession): AccountInfo {
  return normalizeProviderAccount({
    address: session.address,
    publicKey: session.publicKey,
    network: {
      name: session.network as Network,
      chainId: session.chainId
    }
  });
}

function sessionFromBridgePoll(payload: InferBridgeConnectPoll): InferExternalSession {
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
    throw new Error("Infer Desk bridge returned an incomplete session payload");
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

function dispatchSessionReadyEvent(session: InferExternalSession): void {
  window.dispatchEvent(
    new CustomEvent<InferExternalSession>(INFER_SESSION_READY_MESSAGE_TYPE, {
      detail: session
    })
  );
}

/** v0.2.0-rc.8 (Phase 5 UX): payload-less same-window dispatch. Dapp code
 * that wants to observe disconnect events without going through
 * `InferClient` can listen directly with
 * `window.addEventListener(INFER_SESSION_CLEARED_MESSAGE_TYPE, ...)`.
 * Mirror of `dispatchSessionReadyEvent`. */
function dispatchExternalDisconnect(): void {
  if (!isBrowser()) return;
  window.dispatchEvent(new CustomEvent(INFER_SESSION_CLEARED_MESSAGE_TYPE));
}

function resolvePendingExternalSessionWaiters(session: InferExternalSession): void {
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

  sessionReadyChannel = new BroadcastChannel(INFER_SESSION_READY_MESSAGE_TYPE);
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

  sessionClearedChannel = new BroadcastChannel(INFER_SESSION_CLEARED_MESSAGE_TYPE);
  return sessionClearedChannel;
}

function parseSessionReadyPayload(payload: unknown): InferExternalSession | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as Partial<InferSessionReadyPayload>;
  if (candidate.type !== INFER_SESSION_READY_MESSAGE_TYPE) {
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

  const candidate = payload as Partial<InferSessionClearedPayload>;
  return candidate.type === INFER_SESSION_CLEARED_MESSAGE_TYPE;
}

function syncReadySession(session: InferExternalSession | null): void {
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
    // v0.3.0 (rebrand): listen for BOTH the canonical rebrand key and the
    // legacy alias key so cross-tab events from older Infer Desk builds that
    // still write to the legacy key are also observed.
    if (
      event.key !== INFER_EXTERNAL_SESSION_STORAGE_KEY &&
      event.key !== LEGACY_NOVA_EXTERNAL_SESSION_STORAGE_KEY
    ) {
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
      const session = parseExternalSession(JSON.parse(event.newValue) as Partial<InferExternalSession>);
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

  const payload: InferSessionClearedPayload = {
    type: INFER_SESSION_CLEARED_MESSAGE_TYPE
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
 * by `InferClient` to wait for a disconnect signal to settle (e.g., to
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
 * broadcast a disconnect to peer tabs and listeners. `InferClient`
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

function broadcastReadySession(session: InferExternalSession): void {
  if (!isBrowser()) {
    return;
  }

  const payload: InferSessionReadyPayload = {
    type: INFER_SESSION_READY_MESSAGE_TYPE,
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
  if (!isBrowser() || !document.body || document.getElementById(INFER_CALLBACK_OVERLAY_ID)) {
    return;
  }

  const overlay = document.createElement("div");
  overlay.id = INFER_CALLBACK_OVERLAY_ID;
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
  overlay.textContent = "Infer Connect is complete. Return to the original tab.";
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
  // v0.3.0 (rebrand): dual-read the callback URL params. The rebrand
  // canonical names are `inferRequestId` / `inferStatus`; the legacy
  // names `novaRequestId` / `novaStatus` are still accepted during the
  // transition window because older Infer Desk builds (pre-rebrand) and
  // any dapps that cached the old URLs may still issue them. Remove the
  // legacy fallbacks in 0.4.0.
  const requestId =
    url.searchParams.get(CALLBACK_REQUEST_ID_PARAM) ??
    url.searchParams.get(LEGACY_CALLBACK_REQUEST_ID_PARAM);
  const status =
    url.searchParams.get(CALLBACK_STATUS_PARAM) ??
    url.searchParams.get(LEGACY_CALLBACK_STATUS_PARAM);
  let callbackSession: InferExternalSession | null = null;

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
    window.localStorage.setItem(INFER_PROTOCOL_KEY_STORAGE_KEY, publicKey);
  }

  if (requestId && status) {
    window.sessionStorage.setItem(
      INFER_CALLBACK_MARKER_STORAGE_KEY,
      JSON.stringify({ requestId, status } satisfies InferCallbackMarker)
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
    CALLBACK_STATUS_PARAM,
    LEGACY_CALLBACK_REQUEST_ID_PARAM,
    LEGACY_CALLBACK_STATUS_PARAM
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
  options?: InferWalletOptions;
}): Promise<InferExternalSession | null> {
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
    walletName: session.walletName ?? "Infer Connect"
  });

  // Mark the callback as resolved for the legacy marker path.
  window.sessionStorage.setItem(
    INFER_CALLBACK_MARKER_STORAGE_KEY,
    JSON.stringify({
      requestId: "pkce",
      status: "approved"
    } satisfies InferCallbackMarker)
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

export function readCallbackMarker(): InferCallbackMarker | null {
  if (!isBrowser()) return null;
  const raw = dualReadCallbackMarker();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<InferCallbackMarker>;
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
  window.sessionStorage.removeItem(INFER_CALLBACK_MARKER_STORAGE_KEY);
  window.sessionStorage.removeItem(LEGACY_NOVA_CALLBACK_MARKER_STORAGE_KEY);
}

function hasPendingMobilePairingCallbackResume(): boolean {
  const marker = readCallbackMarker();
  const pendingPairing = readPendingMobilePairing();
  return !!marker && !!pendingPairing && marker.requestId === pendingPairing.pairingId;
}

export async function waitForExternalSession(
  options: InferWalletOptions = {}
): Promise<InferExternalSession | null> {
  if (!isBrowser()) return null;
  installExternalSessionResumeListeners();
  storeCallbackSession();

  const immediateSession = readExternalSession();
  if (immediateSession) {
    return immediateSession;
  }

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (session: InferExternalSession | null) => {
      if (settled) {
        return;
      }
      settled = true;
      pendingExternalSessionWaiters.delete(handleReady);
      window.removeEventListener(
        INFER_SESSION_READY_MESSAGE_TYPE,
        handleEvent as EventListener
      );
      window.clearInterval(pollId);
      window.clearTimeout(timeoutId);
      resolve(session);
    };

    const handleReady = (session: InferExternalSession) => {
      finish(session);
    };

    const handleEvent = (event: Event) => {
      const session = (event as CustomEvent<InferExternalSession | undefined>).detail;
      finish(session ?? readExternalSession());
    };

    pendingExternalSessionWaiters.add(handleReady);
    window.addEventListener(
      INFER_SESSION_READY_MESSAGE_TYPE,
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

function publicSessionIdentity(session: InferExternalSession): import("./types").InferConnectionIdentity {
  return {
    transport: session.transport, sessionId: session.sessionId,
    address: session.address, network: session.network, chainId: session.chainId
  };
}

/** A cached identity is never itself evidence that the transport is usable. */
export async function checkExternalConnectionHealth(
  session: InferExternalSession | null = readExternalSession(),
  options: InferWalletOptions = {}
): Promise<import("./types").InferConnectionHealth> {
  if (!isBrowser() || !session) return { state: "disconnected", identity: null };
  const identity = publicSessionIdentity(session);
  if (session.transport === "mobile-relay") {
    return session.dappSessionToken && session.sharedSecret
      ? { state: "checking", identity,
          reason: "The relay has no authenticated session-health read endpoint" }
      : { state: "reconnect-required", identity,
          reason: "Mobile session credentials are unavailable" };
  }
  try {
    const payload = await fetchJsonWithTimeout<Partial<InferExternalSession>>(
      sessionEndpointUrl(session, options), bridgeConnectTimeoutMs(options)
    );
    const parsed = parseExternalSession(payload);
    if (!parsed || parsed.sessionId !== session.sessionId ||
        parsed.address !== session.address || parsed.network !== session.network ||
        parsed.chainId !== session.chainId) {
      return { state: "unreachable", identity, reason: "Infer Desk returned an invalid session response" };
    }
    storeExternalSession({
      ...session, ...parsed, bridgeUrl: parsed.bridgeUrl ?? session.bridgeUrl,
      protocolPublicKey: parsed.protocolPublicKey ?? session.protocolPublicKey,
      walletName: parsed.walletName ?? session.walletName
    });
    return { state: "connected", identity };
  } catch (error) {
    if (error instanceof BridgeHttpError && (error.status === 403 || error.status === 404)) {
      clearExternalSession();
      return { state: "reconnect-required", identity, reason: "Infer Desk rejected the cached session" };
    }
    return { state: "unreachable", identity,
      reason: error instanceof TypeError ? "Infer Desk could not be reached or the browser blocked access"
        : "Infer Desk session validation could not complete" };
  }
}

export async function validateExternalSession(
  session: InferExternalSession,
  options: InferWalletOptions = {}
): Promise<InferExternalSession | null> {
  const health = await checkExternalConnectionHealth(session, options);
  if (session.transport === "mobile-relay" && health.state === "checking") {
    return readExternalSession();
  }
  return health.state === "connected" ? readExternalSession() : null;
}

export async function revokeExternalSession(
  session: InferExternalSession,
  options: InferWalletOptions = {}
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
          "x-infer-session-token": session.dappSessionToken
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
  options: InferWalletOptions = {}
): Promise<InferExternalSession | null> {
  const session = readExternalSession();
  if (!session) {
    return null;
  }

  return validateExternalSession(session, options);
}

export async function tryResumeInferWalletConnection(
  walletCore: InferWalletCoreLike,
  options: InferWalletOptions = {}
): Promise<boolean> {
  if (!isBrowser()) return false;
  installExternalSessionResumeListeners();

  // 0.2.0-rc.5: if Infer Desk redirected us back to the dapp with
  // a callback URL (legacy `?address=...&sessionId=...` or PKCE
  // `?code=...`), consume it BEFORE the localStorage read. The
  // dapp's useEffect calls this on every page load; if the URL
  // has callback params, they land in localStorage here and the
  // existing flow below picks them up. This makes the deeplink
  // path transparent to the dapp dev — no callback handling code
  // required.
  await consumeExternalCallbackIfPresent(options);

  const candidateWalletName = [
    INFER_CONNECT_NAME,
    INFER_DESK_APP_NAME,
    LEGACY_INFER_DESK_LABEL,
    LEGACY_INFER_CONNECT_NAME
  ].find((walletName) =>
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
      throw new BridgeHttpError(response.status, body || `Infer Desk bridge request failed with status ${response.status}`);
    }

    return (await response.json()) as T;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function pollBridge<T extends { status?: string; error?: string }>(
  url: string,
  options: InferWalletOptions
): Promise<T> {
  const deadline = Date.now() + bridgePollTimeoutMs(options);
  while (Date.now() < deadline) {
    const payload = await fetchJsonWithTimeout<T>(url, bridgeConnectTimeoutMs(options));
    if (payload.status && payload.status !== "pending") return payload;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        window.removeEventListener("focus", finish);
        document.removeEventListener("visibilitychange", finish);
        resolve();
      };
      const timer = window.setTimeout(finish,
        Math.max(1, Math.min(bridgePollIntervalMs(options), remaining)));
      window.addEventListener("focus", finish);
      document.addEventListener("visibilitychange", finish);
    });
  }
  // Browser suspension can pass the deadline without running a timer. Read the
  // same request once more on resume, then settle with an unresolved receipt.
  const finalPayload = await fetchJsonWithTimeout<T>(url, bridgeConnectTimeoutMs(options));
  if (finalPayload.status && finalPayload.status !== "pending") return finalPayload;
  throw new Error("Infer Desk outcome is unknown; recover the existing request before trying again");
}

/**
 * v0.3.0+ pre-auth flow (Infer Desk 0.6.0-rc.3+, no-new-tab):
 *
 * The dapp's adapter calls `POST /preauth-connect` on the wallet's
 * bridge (no token required, `Origin` header is the auth — browsers
 * enforce it). The wallet returns a `requestId`. The adapter fires
 * the `inferenco://login?request=<requestId>&app=<name>` deeplink.
 * After the user approves in Infer Desk, the adapter polls
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
   * Optional: present on older wallet builds (Infer Desk
   * < 0.6.0-rc.7), absent on newer builds (audit-08
   * ND-WEB-001 follow-on). Infer Desk no longer exposes the
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
  options?: InferWalletOptions;
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
  } catch (error) {
    // P-04 (HTTPS connect reload, 0.2.0-rc.18): when the fetch
    // throws a TypeError, this is the canonical signal that the
    // browser blocked the cross-origin request (most commonly
    // Chrome ≥142's Local Network Access / PNA enforcement when
    // a public HTTPS origin tries to reach loopback). Surface a
    // TYPED error so dApps can match `err instanceof
    // InferAdapterError && err.code === BRIDGE_PRIVATE_NETWORK_BLOCKED`
    // and render an actionable message.
    //
    // Connection refused / ECONNREFUSED throws WITHOUT a
    // TypeError (it's a `TypeError` from fetch on some browsers
    // but a `DOMException` or `Error` with a different message
    // on others). We branch on `TypeError` strictly so that
    // connection-refused falls through to the generic error
    // path (`return null` below) and stays backward-compatible
    // with rc.16's "silently null on connection failure"
    // semantics.
    if (error instanceof TypeError) {
      // Wrap in InferAdapterError so consumers can do
      // `instanceof` + `err.code === BRIDGE_PRIVATE_NETWORK_BLOCKED`.
      // We throw it (not return null) so the caller can decide
      // how to handle it — pre-fix this function silently
      // returned null, which masked the actual cause and
      // triggered the spurious deeplink-fallback re-navigation
      // (the "page reload" UX bug).
      throw new InferAdapterError(
        InferErrorCode.BridgePrivateNetworkBlocked,
        "Browser blocked access to the local wallet bridge (PNA / LNA). " +
          "Public HTTPS origins need explicit local-network permission to " +
          "reach the loopback wallet bridge. See infer-connect skill 'Bridge " +
          "Private Network Blocked' section for the dApp-side recovery UX.",
        error
      );
    }

    // Connection refused / ECONNREFUSED / 5xx / parse error:
    // preserve the legacy "return null" semantics so existing
    // dApps fall through to the deeplink fallback path (where
    // appropriate).
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
 * `InferExternalSession`.
 */
export interface PreauthPollResult {
  status: "pending" | "approved" | "rejected";
  session?: InferExternalSession;
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

function preauthFlatToSession(flat: PreauthApprovedFlat): InferExternalSession {
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
  options?: InferWalletOptions;
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
 * requires a deeplink in the success path. Infer Desk 0.6.0-rc.6+
 * auto-shows the approval sheet from `POST /preauth-connect` —
 * `InferClient.connect()` no longer fires this URL internally. This
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
  options: InferWalletOptions = {},
): string {
  if (typeof console !== "undefined") {
    console.warn(
      "[inferenco-wallet-adapter] buildDesktopOrMobileConnectUrlWithRequest is deprecated since 0.2.0-rc.10. " +
      "When the pre-auth flow succeeds, Infer Desk auto-shows the approval sheet from the POST /preauth-connect queue — " +
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
    app: app || "Infer Desk",
  });
  return `${DEFAULT_DESKTOP_LOGIN_URL}?${params.toString()}`;
}

export async function tryLocalBridgeConnect(options: InferWalletOptions = {}): Promise<AccountInfo | null> {
  if (!isBrowser() || isMobileBrowser()) return null;

  // 0.2.0-rc.5: catch the synchronous `MissingBridgeTokenError` from
  // `bridgePathWithToken` (which calls `readBridgeToken`).
  // The dapp is in an external browser, the per-session URL token
  // is not available, and the bridge is unreachable. Return null
  // so the caller (`InferClient.connect`) can fire its existing
  // deeplink fallback at line 340+. The page navigates away,
  // the user approves in Infer Desk, the browser returns to the
  // dapp's callback URL, and `tryResumeInferWalletConnection` on
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
      !(error instanceof InferAdapterError)
    ) {
      return null;
    }
    throw error;
  }
  const connectUrl = new URL(connectPath, DEFAULT_DESKTOP_BRIDGE_URL);
  connectUrl.searchParams.set("origin", window.location.origin);
  connectUrl.searchParams.set("app", typeof document !== "undefined" ? document.title || "Infer Desk" : "Infer Desk");
  const connectUrlString = connectUrl.toString();
  const timeoutMs = bridgeConnectTimeoutMs(options);

  let start: InferBridgeStartResponse;
  try {
    start = await fetchJsonWithTimeout<InferBridgeStartResponse>(connectUrlString, timeoutMs);
  } catch {
    return null;
  }

  if (typeof start.requestId !== "string" || start.requestId.length === 0) {
    return null;
  }

  const pollUrl = bridgeUrlWithToken(`/request/${start.requestId}`, options);
  const payload = await pollBridge<InferBridgeConnectPoll>(pollUrl, options);

  if (payload.status === "approved") {
    const session = sessionFromBridgePoll(payload);
    storeExternalSession(session);
    return sessionToAccountInfo(session);
  }

  if (payload.status === "rejected") {
    throw new Error(payload.error ?? "Infer Desk rejected the browser bridge request");
  }

  throw new Error(payload.error ?? "Infer Desk bridge connect failed");
}

function reconnectSigningError(): Error {
  return new Error("Infer Desk is not reachable for signing. Reconnect the wallet and try again.");
}

function reconnectTransactionError(): Error {
  return new Error("Infer Desk is not reachable for transaction approval. Reconnect the wallet and try again.");
}

function normalizeBridgeSignMessageOutput(payload: InferBridgeMessagePoll): CedraSignMessageOutput {
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
    throw new Error("Infer Desk bridge returned an incomplete signMessage payload");
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
  payload: InferBridgeSignTransactionPoll,
  expectedBcsHex?: string
): CedraSignTransactionOutputV1_1 & { authenticatorHex: string; rawTransactionBcsHex: string } {
  const rawTransactionBcsHex = payload.rawTransactionBcsHex ?? payload.raw_transaction_bcs_hex;
  
  // Check for authenticatorHex directly, or nested in authenticator.hex
  let authenticatorHex = payload.authenticatorHex ?? payload.authenticator_hex;
  if (!authenticatorHex && payload.authenticator && typeof payload.authenticator === 'object') {
    const nestedAuthenticator = payload.authenticator as { hex?: string };
    authenticatorHex = nestedAuthenticator.hex;
  }

  if (typeof authenticatorHex !== "string" || typeof rawTransactionBcsHex !== "string") {
    throw new Error("Infer Desk bridge returned an incomplete signTransaction payload");
  }

  return deserializeSignTransactionResult({ authenticatorHex, rawTransactionBcsHex }, expectedBcsHex);
}

async function startBridgeRequest<T>(
  path: string,
  body: unknown,
  options: InferWalletOptions,
  reconnectError: Error
): Promise<string> {
  // B+ retry logic: a 404 from the wallet's HTTP bridge most likely
  // means the wallet was restarted and the per-session URL token
  // rotated. We force-refresh the token (re-read pathname + re-arm
  // the postMessage listener) and retry once before giving up.
  const tryOnce = async () =>
    fetchJsonWithTimeout<InferBridgeStartResponse>(
      bridgeUrlWithToken(path, options),
      bridgeConnectTimeoutMs(options),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }
    );

  let start: InferBridgeStartResponse;
  try {
    start = await tryOnce();
  } catch (error) {
    if (error instanceof BridgeHttpError && error.status === 404) {
      try {
        forceRefreshBridgeToken();
        start = await tryOnce();
      } catch (retryError) {
        if (retryError instanceof BridgeHttpError &&
            (retryError.status === 403 || retryError.status === 404)) throw reconnectError;
        throw retryError;
      }
    } else if (error instanceof BridgeHttpError && error.status === 403) {
      throw reconnectError;
    } else {
      throw error;
    }
  }

  if (typeof start.requestId !== "string" || start.requestId.length === 0) {
    throw new Error("Infer Desk bridge did not return a request id");
  }

  return start.requestId;
}

async function pollSignedResult<T extends { status?: string; error?: string }>(
  path: string,
  requestId: string,
  options: InferWalletOptions,
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
        if (retryError instanceof BridgeHttpError &&
            (retryError.status === 403 || retryError.status === 404)) throw reconnectError;
        throw retryError;
      }
    }
    if (error instanceof BridgeHttpError && error.status === 403) {
      throw reconnectError;
    }
    throw error;
  }
}

function saveDesktopRequest(
  requestId: string,
  method: PendingDesktopBridgeRequest["method"],
  session: InferExternalSession,
  options: InferWalletOptions,
  expectedTransactionBcsHex?: string,
  invocationId?: string
): PendingDesktopBridgeRequest {
  const pending: PendingDesktopBridgeRequest = {
    version: 2, transport: "desktop-bridge", requestId, method,
    ...(invocationId ? { invocationId } : {}),
    sessionId: session.sessionId, address: session.address,
    network: session.network, chainId: session.chainId,
    origin: window.location.origin,
    bridgeOrigin: desktopBridgeOrigin(session, options),
    ...(expectedTransactionBcsHex ? { expectedTransactionBcsHex } : {})
  };
  storePendingDesktopBridgeRequest(pending);
  return pending;
}

async function startDurableDesktopRequest(
  path: string,
  body: unknown,
  method: PendingDesktopBridgeRequest["method"],
  session: InferExternalSession,
  options: InferWalletOptions,
  requestOptions: InferWalletOptions,
  reconnectError: Error,
  expectedTransactionBcsHex?: string
): Promise<{ requestId: string; pending: PendingDesktopBridgeRequest; durableId: string }> {
  let invocation;
  try {
    invocation = await prepareDurableInvocation(session, method);
  } catch (cause) {
    throw new InferRequestError(InferErrorCode.RequestNotInvoked,
      "Wallet request was not sent because its invocation could not be saved",
      null, null, cause);
  }
  try {
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
  let requestId: string;
  try {
    requestId = await startBridgeRequest(path, body, requestOptions, reconnectError);
  } catch (cause) {
    await updateDurableInvocation(invocation.id, "unknown").catch(() => undefined);
    throw unresolvedRequestError(
      "Wallet request creation may have reached Infer Desk; reconcile before retrying",
      invocation.id, null, cause);
  }
  try {
    const pending = saveDesktopRequest(requestId, method, session, options,
      expectedTransactionBcsHex, invocation.id);
    const durable = await saveDurableRequest(pending, invocation.id);
    await updateDurableInvocation(invocation.id, "created", requestId);
    await options.onRequestCreated?.(Object.freeze({ ...pending }));
    return { requestId, pending, durableId: durable.id };
  } catch (cause) {
    await updateDurableInvocation(invocation.id, "unknown", requestId).catch(() => undefined);
    throw unresolvedRequestError(
      "Wallet request exists but its receipt could not be fully recorded",
      invocation.id, requestId, cause);
  }
}

async function pollDurableDesktopResult<T extends { status?: string; error?: string }>(
  path: string,
  requestId: string,
  invocationId: string,
  options: InferWalletOptions,
  reconnectError: Error
): Promise<T> {
  try {
    return await pollSignedResult<T>(path, requestId, options, reconnectError);
  } catch (cause) {
    throw unresolvedRequestError(
      "Wallet request outcome is unresolved; read the original request before retrying",
      invocationId, requestId, cause);
  }
}

async function completeDesktopResult(
  payload: InferBridgeMessagePoll | InferBridgeSignTransactionPoll | InferBridgeTransactionPoll,
  pending: PendingDesktopBridgeRequest,
  durableId: string
): Promise<CedraSignMessageOutput | CedraSignTransactionOutputV1_1 | CedraSignAndSubmitTransactionOutput> {
  const invocationId = pending.invocationId!;
  let output: CedraSignMessageOutput | CedraSignTransactionOutputV1_1 | CedraSignAndSubmitTransactionOutput;
  try {
    if (pending.method === "signAndSubmitTransaction" && payload.requestId !== pending.requestId) {
      throw new InferAdapterError(InferErrorCode.InternalError,
        "Infer Desk returned a missing or different transaction request id");
    }
    output = decodeDesktopResult(payload, pending);
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

function decodeDesktopResult(
  payload: InferBridgeMessagePoll | InferBridgeSignTransactionPoll | InferBridgeTransactionPoll,
  pending: PendingDesktopBridgeRequest
): CedraSignMessageOutput | CedraSignTransactionOutputV1_1 | CedraSignAndSubmitTransactionOutput {
  // Infer Desk sign-only poll payloads can omit requestId. Their GET route
  // already names the original request; reject any conflicting ID if present.
  // Recovery separately requires an echoed exact ID before trusting a final read.
  if (payload.requestId !== undefined && payload.requestId !== pending.requestId) {
    throw new InferAdapterError(InferErrorCode.InternalError, "Infer Desk returned a different request");
  }
  if (payload.status === "approved") {
    if (payload.error !== undefined) {
      throw new InferAdapterError(InferErrorCode.InternalError,
        "Infer Desk returned mixed approval and error fields");
    }
    if (pending.method === "signMessage") {
      const result = normalizeBridgeSignMessageOutput(payload as InferBridgeMessagePoll);
      if (String(result.address).toLowerCase() !== pending.address.toLowerCase()) {
        throw new InferAdapterError(InferErrorCode.InternalError, "Infer Desk signed for a different account");
      }
      return result;
    }
    if (pending.method === "signTransaction") {
      return normalizeBridgeSignTransactionOutput(
        payload as InferBridgeSignTransactionPoll, pending.expectedTransactionBcsHex
      );
    }
    const submitted = payload as InferBridgeTransactionPoll;
    if (submitted.requestId === pending.requestId &&
        hasOnlyKeys(submitted, ["status", "requestId", "hash"]) &&
        isValidTransactionHash(submitted.hash)) {
      return { hash: submitted.hash };
    }
  }
  if (payload.status === "rejected" &&
      hasOnlyKeys(payload, ["status", "requestId", "error"]) &&
      (payload.error === undefined || typeof payload.error === "string")) {
    throw new InferAdapterError(InferErrorCode.UserRejected, "User rejected the request");
  }
  throw new InferAdapterError(InferErrorCode.InternalError, "Infer Desk returned an ambiguous signing result");
}

/** One read of the original bridge request; never POSTs or cancels. */
export async function readDesktopBridgeRequestOnce(
  requestId: string,
  session: InferExternalSession,
  options: InferWalletOptions = {},
  durablePending?: PendingDesktopBridgeRequest
): Promise<{ pending: PendingDesktopBridgeRequest; status: "pending" | "approved"; output?: CedraSignMessageOutput | CedraSignTransactionOutputV1_1 | CedraSignAndSubmitTransactionOutput }> {
  const pending = durablePending ?? readPendingDesktopBridgeRequests(session, options).find((item) => item.requestId === requestId);
  if (!pending || pending.requestId !== requestId ||
      pending.sessionId !== session.sessionId || pending.address !== session.address ||
      pending.network !== session.network || pending.chainId !== session.chainId ||
      pending.origin !== window.location.origin ||
      pending.bridgeOrigin !== desktopBridgeOrigin(session, options)) {
    throw new InferAdapterError(InferErrorCode.Unauthorized, "Request does not belong to this Infer Desk session");
  }
  const path = pending.method === "signMessage" ? "/message-request" :
    pending.method === "signTransaction" ? "/sign-transaction-request" : "/transaction-request";
  const payload = await fetchJsonWithTimeout<InferBridgeMessagePoll | InferBridgeSignTransactionPoll | InferBridgeTransactionPoll>(
    bridgeUrlWithToken(path + "/" + encodeURIComponent(requestId), {
      ...options, bridgeBaseUrl: options.bridgeBaseUrl ?? session.bridgeUrl
    }),
    bridgeConnectTimeoutMs(options)
  );
  if (payload.requestId !== requestId) {
    throw new InferAdapterError(InferErrorCode.InternalError, "Infer Desk returned a missing or different request id");
  }
  if (payload.status === "pending") return { pending, status: "pending" };
  return { pending, status: "approved", output: decodeDesktopResult(payload, pending) };
}

export async function tryLocalBridgeSignMessage(
  input: CedraSignMessageInput,
  session: InferExternalSession,
  options: InferWalletOptions = {}
): Promise<CedraSignMessageOutput> {
  if (!isBrowser() || !session.sessionId) throw reconnectSigningError();
  const requestOptions = { ...options, bridgeBaseUrl: options.bridgeBaseUrl ?? session.bridgeUrl };
  const { requestId, pending, durableId } = await startDurableDesktopRequest("/sign-message", {
    origin: window.location.origin,
    app: typeof document !== "undefined" ? document.title || "Infer Desk" : "Infer Desk",
    sessionId: session.sessionId, message: input
  }, "signMessage", session, options, requestOptions, reconnectSigningError());
  const payload = await pollDurableDesktopResult<InferBridgeMessagePoll>(
    "/message-request", requestId, pending.invocationId!, requestOptions, reconnectSigningError()
  );
  return completeDesktopResult(payload, pending, durableId) as Promise<CedraSignMessageOutput>;
}

export async function tryLocalBridgeSignTransaction(
  input: CedraSignTransactionInputV1_1 | InferExternalSignTransactionInput,
  session: InferExternalSession,
  options: InferWalletOptions = {}
): Promise<CedraSignTransactionOutputV1_1> {
  if (!isBrowser() || !session.sessionId) throw reconnectSigningError();
  const requestOptions = { ...options, bridgeBaseUrl: options.bridgeBaseUrl ?? session.bridgeUrl };
  const { requestId, pending, durableId } = await startDurableDesktopRequest("/sign-transaction", {
    origin: window.location.origin,
    app: typeof document !== "undefined" ? document.title || "Infer Desk" : "Infer Desk",
    sessionId: session.sessionId, transaction: input
  }, "signTransaction", session, options, requestOptions, reconnectSigningError(),
    "rawTransactionBcsHex" in input ? input.rawTransactionBcsHex : undefined);
  const payload = await pollDurableDesktopResult<InferBridgeSignTransactionPoll>(
    "/sign-transaction-request", requestId, pending.invocationId!, requestOptions, reconnectSigningError()
  );
  return completeDesktopResult(payload, pending, durableId) as Promise<CedraSignTransactionOutputV1_1>;
}

function hasOnlyKeys(value: object, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export async function tryLocalBridgeSignAndSubmit(
  input: CedraSignAndSubmitTransactionInput,
  session: InferExternalSession,
  options: InferWalletOptions = {}
): Promise<CedraSignAndSubmitTransactionOutput> {
  if (!isBrowser() || !session.sessionId) throw reconnectTransactionError();
  const requestOptions = { ...options, bridgeBaseUrl: options.bridgeBaseUrl ?? session.bridgeUrl };
  const { requestId, pending, durableId } = await startDurableDesktopRequest("/transaction", {
    origin: window.location.origin,
    app: typeof document !== "undefined" ? document.title || "Infer Desk" : "Infer Desk",
    sessionId: session.sessionId, transaction: input
  }, "signAndSubmitTransaction", session, options, requestOptions, reconnectTransactionError());
  const payload = await pollDurableDesktopResult<InferBridgeTransactionPoll>(
    "/transaction-request", requestId, pending.invocationId!, requestOptions, reconnectTransactionError()
  );
  return completeDesktopResult(payload, pending, durableId) as Promise<CedraSignAndSubmitTransactionOutput>;
}
