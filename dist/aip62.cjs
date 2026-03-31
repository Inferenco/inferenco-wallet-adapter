"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/aip62.ts
var aip62_exports = {};
__export(aip62_exports, {
  createNovaAIP62Wallet: () => createNovaAIP62Wallet,
  registerNovaWallet: () => registerNovaWallet
});
module.exports = __toCommonJS(aip62_exports);
var import_wallet_standard2 = require("@cedra-labs/wallet-standard");
var import_ts_sdk3 = require("@cedra-labs/ts-sdk");

// src/constants.ts
var import_node_buffer = require("buffer");
var NOVA_WALLET_NAME = "Nova Wallet";
var NOVA_DESK_NAME = "Nova Desk";
var DEFAULT_WEBSITE_URL = "https://inferenco.com";
var DEFAULT_DEEPLINK_BASE_URL = "inferenco://connect?callback=";
var DEFAULT_DESKTOP_LOGIN_URL = "inferenco://login";
var DEFAULT_DESKTOP_BRIDGE_URL = "http://127.0.0.1:21984";
var DEFAULT_DETECT_ALIASES = true;
var DEFAULT_REGISTER_FORCE = false;
var DEFAULT_DESKTOP_REGISTRATION = true;
var DEFAULT_BRIDGE_CONNECT_TIMEOUT_MS = 1200;
var DEFAULT_BRIDGE_POLL_INTERVAL_MS = 250;
var DEFAULT_BRIDGE_POLL_TIMEOUT_MS = 12e4;
var NOVA_PROTOCOL_KEY_STORAGE_KEY = "inferenco:nova-protocol-key";
var NOVA_EXTERNAL_SESSION_STORAGE_KEY = "inferenco:nova-session";
var CALLBACK_ADDRESS_PARAM = "address";
var CALLBACK_PUBLIC_KEY_PARAM = "publicKey";
var CALLBACK_NETWORK_PARAM = "network";
var CALLBACK_CHAIN_ID_PARAM = "chainId";
var CALLBACK_SESSION_ID_PARAM = "sessionId";
var CALLBACK_BRIDGE_URL_PARAM = "bridgeUrl";
var CALLBACK_PROTOCOL_PUBLIC_KEY_PARAM = "protocolPublicKey";
var CALLBACK_WALLET_NAME_PARAM = "walletName";
var svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#0a3d91"/><path d="M32 12 40 28 56 32 40 36 32 52 24 36 8 32 24 28Z" fill="#66d9ff"/></svg>`;
var NOVA_WALLET_ICON = `data:image/svg+xml;base64,${import_node_buffer.Buffer.from(svg).toString("base64")}`;

// src/bridge.ts
var import_ts_sdk2 = require("@cedra-labs/ts-sdk");

// src/conversion.ts
var import_ts_sdk = require("@cedra-labs/ts-sdk");
var import_wallet_standard = require("@cedra-labs/wallet-standard");

// src/errors.ts
var NovaAdapterError = class extends Error {
  constructor(code, message, cause) {
    super(message);
    this.code = code;
    this.cause = cause;
    this.name = "NovaAdapterError";
  }
};
function extractStatus(error) {
  if (!error || typeof error !== "object") return void 0;
  if ("status" in error) return error.status;
  if ("code" in error) return error.code;
  return void 0;
}
function remapNovaError(error) {
  if (error instanceof NovaAdapterError) {
    throw error;
  }
  const status = extractStatus(error);
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown Nova wallet error";
  if (status === "Rejected" || status === 401 || /reject/i.test(message)) {
    throw new NovaAdapterError("USER_REJECTED" /* UserRejected */, message, error);
  }
  if (status === "Unsupported" || status === 4200 || /unsupported/i.test(message)) {
    throw new NovaAdapterError("UNSUPPORTED" /* Unsupported */, message, error);
  }
  if (status === "InvalidParams" || status === 400 || /invalid/i.test(message)) {
    throw new NovaAdapterError("INVALID_PARAMS" /* InvalidParams */, message, error);
  }
  if (status === "Timeout" || /timed out waiting for nova desk/i.test(message)) {
    throw new NovaAdapterError("CONNECTION_TIMEOUT" /* ConnectionTimeout */, message, error);
  }
  if (/not installed|no provider|missing provider/i.test(message)) {
    throw new NovaAdapterError("NOT_INSTALLED" /* NotInstalled */, message, error);
  }
  throw new NovaAdapterError("INTERNAL_ERROR" /* InternalError */, message, error);
}

// src/conversion.ts
function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  const hex = input.startsWith("0x") ? input.slice(2) : input;
  return new Uint8Array(hex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) ?? []);
}
function normalizeProviderAccount(account) {
  const publicKey = account.publicKey instanceof Uint8Array ? account.publicKey : toUint8Array(account.publicKey);
  return new import_wallet_standard.AccountInfo({
    address: import_ts_sdk.AccountAddress.from(account.address),
    publicKey: new import_ts_sdk.AnyPublicKey(new import_ts_sdk.Ed25519PublicKey(publicKey))
  });
}
function normalizeNetwork(network) {
  if (typeof network === "object") {
    return {
      chainId: network.chainId ?? 3,
      name: network.name ?? import_ts_sdk.Network.DEVNET,
      url: network.url
    };
  }
  const rawName = typeof network === "number" ? { 1: "mainnet", 2: "testnet", 3: "devnet", 4: "local" }[network] ?? void 0 : network;
  if (!rawName) {
    throw new NovaAdapterError("INVALID_NETWORK" /* InvalidNetwork */, `Unsupported network value: ${String(network)}`);
  }
  const name = rawName === "mainnet" ? import_ts_sdk.Network.MAINNET : rawName === "testnet" ? import_ts_sdk.Network.TESTNET : rawName === "local" ? import_ts_sdk.Network.LOCAL : import_ts_sdk.Network.DEVNET;
  const chainId = typeof network === "number" ? network : { mainnet: 1, testnet: 2, devnet: 3, local: 4 }[rawName] ?? 3;
  return {
    name,
    chainId
  };
}
function normalizeSignMessageOutput(output) {
  return {
    address: output.address,
    application: "application" in output ? output.application : void 0,
    chainId: "chainId" in output ? output.chainId : void 0,
    fullMessage: output.fullMessage,
    message: output.message,
    nonce: output.nonce,
    prefix: output.prefix ?? "CEDRA",
    signature: output.signature
  };
}
function createFullMessage(input, address, chainId) {
  return [
    "CEDRA",
    input.application ?? "",
    address,
    input.nonce,
    input.chainId ?? chainId ?? "",
    input.message
  ].join("\n");
}

// src/bridge.ts
var BridgeHttpError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = "BridgeHttpError";
  }
};
function isBrowser() {
  return typeof window !== "undefined";
}
function isMobileBrowser() {
  if (!isBrowser()) return false;
  const userAgent = navigator.userAgent.toLowerCase();
  const coarsePointer = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  return /android|iphone|ipad|ipod|mobile/.test(userAgent) || coarsePointer;
}
function bridgeBaseUrl(options = {}) {
  return options.bridgeBaseUrl ?? DEFAULT_DESKTOP_BRIDGE_URL;
}
function bridgeConnectTimeoutMs(options = {}) {
  return options.bridgeConnectTimeoutMs ?? DEFAULT_BRIDGE_CONNECT_TIMEOUT_MS;
}
function bridgePollIntervalMs(options = {}) {
  return options.bridgePollIntervalMs ?? DEFAULT_BRIDGE_POLL_INTERVAL_MS;
}
function bridgePollTimeoutMs(options = {}) {
  return options.bridgePollTimeoutMs ?? DEFAULT_BRIDGE_POLL_TIMEOUT_MS;
}
function currentUrlWithoutCallbackKey() {
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
    CALLBACK_WALLET_NAME_PARAM
  ]) {
    url.searchParams.delete(key);
  }
  return url.toString();
}
function buildDesktopOrMobileConnectUrl(options = {}, callbackUrl = currentUrlWithoutCallbackKey()) {
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
function launchDesktopOrMobileConnect(options = {}, callbackUrl = currentUrlWithoutCallbackKey()) {
  const url = buildDesktopOrMobileConnectUrl(options, callbackUrl);
  if (!isBrowser()) return url;
  window.location.href = url;
  return url;
}
function parseExternalSession(candidate) {
  if (!candidate || typeof candidate.address !== "string" || typeof candidate.publicKey !== "string" || typeof candidate.network !== "string" || typeof candidate.chainId !== "number" || typeof candidate.sessionId !== "string") {
    return null;
  }
  return {
    address: candidate.address,
    publicKey: candidate.publicKey,
    network: candidate.network,
    chainId: candidate.chainId,
    sessionId: candidate.sessionId,
    bridgeUrl: typeof candidate.bridgeUrl === "string" ? candidate.bridgeUrl : void 0,
    protocolPublicKey: typeof candidate.protocolPublicKey === "string" ? candidate.protocolPublicKey : void 0,
    walletName: typeof candidate.walletName === "string" ? candidate.walletName : void 0
  };
}
function readExternalSession() {
  if (!isBrowser()) return null;
  const raw = window.localStorage.getItem(NOVA_EXTERNAL_SESSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    return parseExternalSession(JSON.parse(raw));
  } catch {
    return null;
  }
}
function storeExternalSession(session) {
  if (!isBrowser()) return;
  window.localStorage.setItem(NOVA_EXTERNAL_SESSION_STORAGE_KEY, JSON.stringify(session));
  if (session.protocolPublicKey) {
    window.localStorage.setItem(NOVA_PROTOCOL_KEY_STORAGE_KEY, session.protocolPublicKey);
  }
}
function clearExternalSession() {
  if (!isBrowser()) return;
  window.localStorage.removeItem(NOVA_EXTERNAL_SESSION_STORAGE_KEY);
  window.localStorage.removeItem(NOVA_PROTOCOL_KEY_STORAGE_KEY);
}
function sessionEndpointUrl(session, options = {}) {
  return new URL(
    `/session/${encodeURIComponent(session.sessionId)}`,
    sessionBridgeBaseUrl(session, options)
  ).toString();
}
function connectionEndpointUrl(session, options = {}) {
  const url = new URL("/connection", sessionBridgeBaseUrl(session, options));
  url.searchParams.set("origin", window.location.origin);
  url.searchParams.set("address", session.address);
  url.searchParams.set("network", session.network);
  return url.toString();
}
function sessionBridgeBaseUrl(session, options = {}) {
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
function sessionToAccountInfo(session) {
  return normalizeProviderAccount({
    address: session.address,
    publicKey: session.publicKey,
    network: {
      name: session.network,
      chainId: session.chainId
    }
  });
}
function sessionFromBridgePoll(payload) {
  const address = payload.address;
  const publicKey = payload.publicKey ?? payload.public_key;
  const network = payload.network;
  const chainId = payload.chainId ?? payload.chain_id;
  const sessionId = payload.sessionId ?? payload.session_id;
  const bridgeUrl = payload.bridgeUrl ?? payload.bridge_url;
  const walletName = payload.walletName ?? payload.wallet_name;
  if (typeof address !== "string" || typeof publicKey !== "string" || typeof network !== "string" || typeof chainId !== "number" || typeof sessionId !== "string") {
    throw new Error("Nova Desk bridge returned an incomplete session payload");
  }
  return {
    address,
    publicKey,
    network,
    chainId,
    sessionId,
    bridgeUrl,
    walletName
  };
}
function storeCallbackSession() {
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
  if (address && publicKey && network && chainId && sessionId) {
    const parsedChainId = Number.parseInt(chainId, 10);
    if (!Number.isNaN(parsedChainId)) {
      storeExternalSession({
        address,
        publicKey,
        network,
        chainId: parsedChainId,
        sessionId,
        bridgeUrl: bridgeUrl ?? void 0,
        protocolPublicKey: protocolPublicKey ?? void 0,
        walletName: walletName ?? void 0
      });
    }
  } else if (publicKey) {
    window.localStorage.setItem(NOVA_PROTOCOL_KEY_STORAGE_KEY, publicKey);
  }
  for (const key of [
    CALLBACK_ADDRESS_PARAM,
    CALLBACK_PUBLIC_KEY_PARAM,
    CALLBACK_NETWORK_PARAM,
    CALLBACK_CHAIN_ID_PARAM,
    CALLBACK_SESSION_ID_PARAM,
    CALLBACK_BRIDGE_URL_PARAM,
    CALLBACK_PROTOCOL_PUBLIC_KEY_PARAM,
    CALLBACK_WALLET_NAME_PARAM
  ]) {
    url.searchParams.delete(key);
  }
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}
async function waitForExternalSession(options = {}) {
  if (!isBrowser()) return null;
  const deadline = Date.now() + bridgePollTimeoutMs(options);
  while (Date.now() < deadline) {
    storeCallbackSession();
    const session = readExternalSession();
    if (session) {
      return session;
    }
    await new Promise(
      (resolve) => window.setTimeout(resolve, bridgePollIntervalMs(options))
    );
  }
  return null;
}
async function validateExternalSession(session, options = {}) {
  if (!isBrowser()) return null;
  try {
    const sessionUrl = sessionEndpointUrl(session, options);
    const payload = await fetchJsonWithTimeout(
      sessionUrl,
      bridgeConnectTimeoutMs(options)
    );
    const validatedSession = parseExternalSession(payload) ?? session;
    const refreshedSession = {
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
async function revokeExternalSession(session, options = {}) {
  if (!isBrowser()) return;
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
        if (fallbackError instanceof BridgeHttpError && (fallbackError.status === 403 || fallbackError.status === 404)) {
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
async function readValidatedExternalSession(options = {}) {
  const session = readExternalSession();
  if (!session) {
    return null;
  }
  return validateExternalSession(session, options);
}
async function fetchJsonWithTimeout(url, timeoutMs, init) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        ...init?.headers ?? {}
      },
      mode: "cors",
      signal: controller.signal,
      ...init
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new BridgeHttpError(response.status, body || `Nova Desk bridge request failed with status ${response.status}`);
    }
    return await response.json();
  } finally {
    window.clearTimeout(timeoutId);
  }
}
async function pollBridge(url, options) {
  const deadline = Date.now() + bridgePollTimeoutMs(options);
  while (Date.now() < deadline) {
    const payload = await fetchJsonWithTimeout(url, bridgeConnectTimeoutMs(options));
    if (payload.status && payload.status !== "pending") {
      return payload;
    }
    await new Promise((resolve) => window.setTimeout(resolve, bridgePollIntervalMs(options)));
  }
  throw new Error("Timed out waiting for Nova Desk approval");
}
async function tryLocalBridgeConnect(options = {}) {
  if (!isBrowser() || isMobileBrowser()) return null;
  const connectUrl = new URL("/connect", bridgeBaseUrl(options));
  connectUrl.searchParams.set("origin", window.location.origin);
  connectUrl.searchParams.set("app", typeof document !== "undefined" ? document.title || "Nova Desk" : "Nova Desk");
  let start;
  try {
    start = await fetchJsonWithTimeout(connectUrl.toString(), bridgeConnectTimeoutMs(options));
  } catch {
    return null;
  }
  if (typeof start.requestId !== "string" || start.requestId.length === 0) {
    return null;
  }
  const pollUrl = new URL(`/request/${start.requestId}`, bridgeBaseUrl(options)).toString();
  const payload = await pollBridge(pollUrl, options);
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
function reconnectSigningError() {
  return new Error("Nova Desk is not reachable for signing. Reconnect the wallet and try again.");
}
function reconnectTransactionError() {
  return new Error("Nova Desk is not reachable for transaction approval. Reconnect the wallet and try again.");
}
function normalizeBridgeSignMessageOutput(payload) {
  const address = payload.address;
  const signature = payload.signature;
  const fullMessage = payload.fullMessage ?? payload.full_message;
  const message = payload.message;
  if (typeof address !== "string" || typeof signature !== "string" || typeof fullMessage !== "string" || typeof message !== "string") {
    throw new Error("Nova Desk bridge returned an incomplete signMessage payload");
  }
  return {
    address,
    fullMessage,
    message,
    nonce: "",
    prefix: "CEDRA",
    signature
  };
}
function normalizeBridgeSignTransactionOutput(payload) {
  const authenticatorHex = payload.authenticatorHex ?? payload.authenticator_hex;
  const rawTransactionBcsHex = payload.rawTransactionBcsHex ?? payload.raw_transaction_bcs_hex;
  if (typeof authenticatorHex !== "string" || typeof rawTransactionBcsHex !== "string") {
    throw new Error("Nova Desk bridge returned an incomplete signTransaction payload");
  }
  return {
    authenticator: import_ts_sdk2.AccountAuthenticator.deserialize(import_ts_sdk2.Deserializer.fromHex(authenticatorHex)),
    rawTransaction: new import_ts_sdk2.SimpleTransaction(import_ts_sdk2.RawTransaction.deserialize(import_ts_sdk2.Deserializer.fromHex(rawTransactionBcsHex)))
  };
}
async function startBridgeRequest(path, body, options, reconnectError) {
  try {
    const start = await fetchJsonWithTimeout(
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
async function pollSignedResult(path, requestId, options, reconnectError) {
  try {
    return await pollBridge(new URL(`${path}/${requestId}`, bridgeBaseUrl(options)).toString(), options);
  } catch (error) {
    if (error instanceof BridgeHttpError && (error.status === 403 || error.status === 404)) {
      clearExternalSession();
      throw reconnectError;
    }
    throw error;
  }
}
async function tryLocalBridgeSignMessage(input, session, options = {}) {
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
  const payload = await pollSignedResult(
    "/message-request",
    requestId,
    { ...options, bridgeBaseUrl: session.bridgeUrl ?? options.bridgeBaseUrl },
    reconnectSigningError()
  );
  if (payload.status === "approved") return normalizeBridgeSignMessageOutput(payload);
  throw new Error(payload.error ?? "Nova Desk rejected the signMessage request");
}
async function tryLocalBridgeSignTransaction(input, session, options = {}) {
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
  const payload = await pollSignedResult(
    "/sign-transaction-request",
    requestId,
    { ...options, bridgeBaseUrl: session.bridgeUrl ?? options.bridgeBaseUrl },
    reconnectSigningError()
  );
  if (payload.status === "approved") return normalizeBridgeSignTransactionOutput(payload);
  throw new Error(payload.error ?? "Nova Desk rejected the signTransaction request");
}
async function tryLocalBridgeSignAndSubmit(input, session, options = {}) {
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
  const payload = await pollSignedResult(
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

// src/deeplink.ts
function buildCallbackUrl() {
  if (typeof window === "undefined") return "";
  return window.location.href;
}
function buildDeeplinkUrl(options = {}, callbackUrl = buildCallbackUrl()) {
  const base = options.deeplinkBaseUrl ?? DEFAULT_DEEPLINK_BASE_URL;
  return `${base}${encodeURIComponent(callbackUrl)}`;
}

// src/NovaClient.ts
var import_eventemitter3 = __toESM(require("eventemitter3"), 1);

// src/provider.ts
function isBrowser2() {
  return typeof window !== "undefined";
}
function isBrandedNovaProvider(provider) {
  return !!provider && provider.isNovaWallet === true;
}
function detectProvider(options = {}) {
  if (!isBrowser2()) return void 0;
  const win = window;
  if (win.inferenco) return win.inferenco;
  if (win.nova) return win.nova;
  const detectAliases = options.detectAliases ?? DEFAULT_DETECT_ALIASES;
  if (!detectAliases) return void 0;
  if (isBrandedNovaProvider(win.cedra)) return win.cedra;
  if (isBrandedNovaProvider(win.aptos)) return win.aptos;
  return void 0;
}

// src/NovaClient.ts
function unwrap(value) {
  if (value && typeof value === "object") {
    if ("data" in value && value.data !== void 0) return value.data;
    if ("args" in value && value.args !== void 0) return value.args;
    if ("result" in value && value.result !== void 0) return value.result;
  }
  return value;
}
var NovaClient = class extends import_eventemitter3.default {
  constructor(options = {}) {
    super();
    this.options = options;
    storeCallbackSession();
    this.provider = detectProvider(options);
  }
  provider;
  accountInfo = null;
  networkInfo = null;
  refreshProvider() {
    this.provider = detectProvider(this.options);
    return this.provider;
  }
  hasProvider() {
    return !!this.refreshProvider();
  }
  hasExternalSession() {
    return !!readExternalSession();
  }
  get account() {
    return this.accountInfo;
  }
  get cachedNetwork() {
    return this.networkInfo;
  }
  connectResultFromExternalSession(externalSession) {
    const account = sessionToAccountInfo(externalSession);
    const network = normalizeNetwork({
      name: externalSession.network,
      chainId: externalSession.chainId
    });
    this.accountInfo = account;
    this.networkInfo = network;
    return { account, network };
  }
  async connect() {
    try {
      const provider = this.refreshProvider();
      if (provider?.connect) {
        const account = normalizeProviderAccount(unwrap(await provider.connect()));
        this.accountInfo = account;
        if (provider.network) {
          this.networkInfo = normalizeNetwork(unwrap(await provider.network()));
        }
        return { account, network: this.networkInfo };
      }
      const externalSession = await readValidatedExternalSession(this.options);
      if (externalSession) {
        return this.connectResultFromExternalSession(externalSession);
      }
      const bridgedAccount = await tryLocalBridgeConnect(this.options);
      if (bridgedAccount) {
        this.accountInfo = bridgedAccount;
        const bridgedSession = await readValidatedExternalSession(this.options);
        this.networkInfo = bridgedSession ? normalizeNetwork({
          name: bridgedSession.network,
          chainId: bridgedSession.chainId
        }) : null;
        return { account: bridgedAccount, network: this.networkInfo };
      }
      if (typeof window !== "undefined") {
        launchDesktopOrMobileConnect(this.options);
        const handoffSession = await waitForExternalSession(this.options);
        if (handoffSession) {
          return this.connectResultFromExternalSession(handoffSession);
        }
        throw new NovaAdapterError(
          "CONNECTION_TIMEOUT" /* ConnectionTimeout */,
          "Timed out waiting for Nova Desk to complete the external connection handoff."
        );
      }
      throw new NovaAdapterError(
        "NOT_INSTALLED" /* NotInstalled */,
        `Nova provider not found. Open ${buildDeeplinkUrl(this.options)}`
      );
    } catch (error) {
      remapNovaError(error);
    }
  }
  async getAccount() {
    if (this.accountInfo) return this.accountInfo;
    try {
      const provider = this.refreshProvider();
      if (provider?.account) {
        const account = normalizeProviderAccount(unwrap(await provider.account()));
        this.accountInfo = account;
        return account;
      }
      const externalSession = await readValidatedExternalSession(this.options);
      if (externalSession) {
        const account = sessionToAccountInfo(externalSession);
        this.accountInfo = account;
        return account;
      }
      throw new NovaAdapterError("NOT_INSTALLED" /* NotInstalled */, "Nova provider account() unavailable");
    } catch (error) {
      remapNovaError(error);
    }
  }
  async disconnect() {
    try {
      const provider = this.refreshProvider();
      const externalSession = readExternalSession();
      await provider?.disconnect?.();
      if (externalSession) {
        await revokeExternalSession(externalSession, this.options);
      }
      clearExternalSession();
      this.accountInfo = null;
      this.networkInfo = null;
    } catch (error) {
      remapNovaError(error);
    }
  }
  async getNetwork() {
    if (this.networkInfo) return this.networkInfo;
    try {
      const provider = this.refreshProvider();
      if (provider?.network) {
        const network = normalizeNetwork(unwrap(await provider.network()));
        this.networkInfo = network;
        return network;
      }
      const externalSession = await readValidatedExternalSession(this.options);
      if (externalSession) {
        const network = normalizeNetwork({
          name: externalSession.network,
          chainId: externalSession.chainId
        });
        this.networkInfo = network;
        return network;
      }
      throw new NovaAdapterError("NOT_INSTALLED" /* NotInstalled */, "Nova provider network() unavailable");
    } catch (error) {
      remapNovaError(error);
    }
  }
  async signMessage(input) {
    try {
      const provider = this.refreshProvider();
      if (provider?.signMessage) {
        const result = unwrap(await provider.signMessage(input));
        return normalizeSignMessageOutput(result);
      }
      const externalSession = await readValidatedExternalSession(this.options);
      if (externalSession) {
        return tryLocalBridgeSignMessage(input, externalSession, this.options);
      }
      throw new NovaAdapterError("UNSUPPORTED" /* Unsupported */, "Nova provider signMessage() unavailable");
    } catch (error) {
      remapNovaError(error);
    }
  }
  async signMessageAndVerify(input) {
    const account = await this.getAccount();
    const output = await this.signMessage(input);
    const publicKey = account.publicKey;
    const message = new TextEncoder().encode(output.fullMessage || createFullMessage(input, account.address.toString()));
    if (publicKey.verifySignature) {
      return publicKey.verifySignature({ message, signature: output.signature });
    }
    if (publicKey.verifySignatureAsync) {
      return publicKey.verifySignatureAsync({ message, signature: output.signature });
    }
    return false;
  }
  async signTransaction(transaction, options) {
    try {
      const provider = this.refreshProvider();
      if (provider?.signTransaction) {
        return unwrap(
          await provider.signTransaction(transaction, options)
        );
      }
      const externalSession = await readValidatedExternalSession(this.options);
      if (externalSession) {
        if (!transaction || typeof transaction !== "object" || !("payload" in transaction) || "rawTransaction" in transaction || "data" in transaction) {
          throw new NovaAdapterError(
            "UNSUPPORTED" /* Unsupported */,
            "Nova Desk browser signTransaction requires a wallet-standard v1.1 payload"
          );
        }
        return tryLocalBridgeSignTransaction(
          transaction,
          externalSession,
          this.options
        );
      }
      throw new NovaAdapterError("UNSUPPORTED" /* Unsupported */, "Nova provider signTransaction() unavailable");
    } catch (error) {
      remapNovaError(error);
    }
  }
  async signAndSubmitTransaction(transaction, options) {
    try {
      const provider = this.refreshProvider();
      if (provider?.signAndSubmitTransaction) {
        return unwrap(
          await provider.signAndSubmitTransaction(
            transaction,
            options
          )
        );
      }
      const externalSession = await readValidatedExternalSession(this.options);
      if (externalSession) {
        return tryLocalBridgeSignAndSubmit(
          transaction,
          externalSession,
          this.options
        );
      }
      throw new NovaAdapterError(
        "UNSUPPORTED" /* Unsupported */,
        "Nova provider signAndSubmitTransaction() unavailable"
      );
    } catch (error) {
      remapNovaError(error);
    }
  }
  async signAndSubmitBCSTransaction(transaction, options) {
    try {
      return await this.signAndSubmitTransaction(transaction, options);
    } catch (error) {
      if (options !== void 0) {
        return this.signAndSubmitTransaction(transaction);
      }
      remapNovaError(error);
    }
  }
  async subscribe() {
    const provider = this.refreshProvider();
    if (provider?.onAccountChange) {
      await provider.onAccountChange((account) => {
        this.accountInfo = normalizeProviderAccount(account);
        this.emit("accountChange", this.accountInfo);
      });
    }
    if (provider?.onNetworkChange) {
      await provider.onNetworkChange((network) => {
        this.networkInfo = normalizeNetwork(network);
        this.emit("networkChange", this.networkInfo);
      });
    }
  }
};

// src/aip62.ts
var NovaWalletAccount = class {
  address;
  publicKey;
  chains = import_wallet_standard2.CEDRA_CHAINS;
  features = [
    "cedra:connect",
    "cedra:disconnect",
    "cedra:network",
    "cedra:account",
    "cedra:onAccountChange",
    "cedra:onNetworkChange",
    "cedra:signMessage",
    "cedra:signTransaction",
    "cedra:signAndSubmitTransaction"
  ];
  signingScheme = import_ts_sdk3.SigningScheme.Ed25519;
  constructor(account) {
    this.address = account.address.toString();
    this.publicKey = account.publicKey.toUint8Array();
  }
};
function createNovaAIP62Wallet(options = {}) {
  const client = new NovaClient(options);
  let accounts = [];
  const updateAccount = async () => {
    const account = await client.getAccount();
    accounts = [new NovaWalletAccount(account)];
    return account;
  };
  const features = {
    "cedra:connect": {
      version: "1.0.0",
      connect: async () => {
        const { account } = await client.connect();
        accounts = [new NovaWalletAccount(account)];
        return { status: import_wallet_standard2.UserResponseStatus.APPROVED, args: account };
      }
    },
    "cedra:disconnect": {
      version: "1.0.0",
      disconnect: async () => {
        await client.disconnect();
        accounts = [];
      }
    },
    "cedra:network": {
      version: "1.0.0",
      network: async () => client.getNetwork()
    },
    "cedra:account": {
      version: "1.0.0",
      account: updateAccount
    },
    "cedra:onAccountChange": {
      version: "1.0.0",
      onAccountChange: async (callback) => {
        client.on("accountChange", callback);
        await client.subscribe();
      }
    },
    "cedra:onNetworkChange": {
      version: "1.0.0",
      onNetworkChange: async (callback) => {
        client.on("networkChange", callback);
        await client.subscribe();
      }
    },
    "cedra:signMessage": {
      version: "1.0.0",
      signMessage: async (input) => {
        const output = await client.signMessage(input);
        return {
          status: import_wallet_standard2.UserResponseStatus.APPROVED,
          args: output
        };
      }
    },
    "cedra:signTransaction": {
      version: "1.1",
      signTransaction: (async (input) => {
        const result = await client.signTransaction(input);
        if (result instanceof Uint8Array) {
          throw new Error("Nova signTransaction returned bytes instead of an authenticator");
        }
        if (result && typeof result === "object" && "authenticator" in result) {
          return {
            status: import_wallet_standard2.UserResponseStatus.APPROVED,
            args: "rawTransaction" in result && result.rawTransaction ? result : result.authenticator
          };
        }
        return {
          status: import_wallet_standard2.UserResponseStatus.APPROVED,
          args: result
        };
      })
    },
    "cedra:signAndSubmitTransaction": {
      version: "1.1.0",
      signAndSubmitTransaction: async (input) => {
        const result = await client.signAndSubmitTransaction(input);
        return {
          status: import_wallet_standard2.UserResponseStatus.APPROVED,
          args: result
        };
      }
    },
    "cedra:openInMobileApp": {
      version: "1.0.0",
      openInMobileApp: () => {
        if (typeof window !== "undefined") {
          window.location.href = buildDeeplinkUrl(options);
        }
      }
    }
  };
  return {
    version: "1.0.0",
    name: isMobileBrowser() ? NOVA_WALLET_NAME : NOVA_DESK_NAME,
    icon: NOVA_WALLET_ICON,
    url: options.websiteUrl ?? DEFAULT_WEBSITE_URL,
    chains: import_wallet_standard2.CEDRA_CHAINS,
    get accounts() {
      return accounts;
    },
    get features() {
      return features;
    }
  };
}
var registered = false;
function registerNovaWallet(options = {}) {
  if (registered) return;
  const client = new NovaClient(options);
  const forceRegistration = options.forceRegistration ?? DEFAULT_REGISTER_FORCE;
  const desktopRegistration = options.desktopRegistration ?? DEFAULT_DESKTOP_REGISTRATION;
  const shouldRegisterDesktop = desktopRegistration && typeof window !== "undefined" && !isMobileBrowser();
  if (!client.hasProvider() && !client.hasExternalSession() && !forceRegistration && !shouldRegisterDesktop) return;
  (0, import_wallet_standard2.registerWallet)(createNovaAIP62Wallet(options));
  registered = true;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createNovaAIP62Wallet,
  registerNovaWallet
});
