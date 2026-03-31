import {
  BridgeHttpError,
  CALLBACK_ADDRESS_PARAM,
  CALLBACK_BRIDGE_URL_PARAM,
  CALLBACK_CHAIN_ID_PARAM,
  CALLBACK_NETWORK_PARAM,
  CALLBACK_PROTOCOL_PUBLIC_KEY_PARAM,
  CALLBACK_PUBLIC_KEY_PARAM,
  CALLBACK_SESSION_ID_PARAM,
  CALLBACK_WALLET_NAME_PARAM,
  DEFAULT_BRIDGE_CONNECT_TIMEOUT_MS,
  DEFAULT_BRIDGE_POLL_INTERVAL_MS,
  DEFAULT_BRIDGE_POLL_TIMEOUT_MS,
  DEFAULT_DEEPLINK_BASE_URL,
  DEFAULT_DESKTOP_BRIDGE_URL,
  DEFAULT_DESKTOP_LOGIN_URL,
  DEFAULT_DESKTOP_REGISTRATION,
  DEFAULT_DETECT_ALIASES,
  DEFAULT_REGISTER_FORCE,
  DEFAULT_WEBSITE_URL,
  NOVA_DESK_NAME,
  NOVA_EXTERNAL_SESSION_STORAGE_KEY,
  NOVA_PROTOCOL_KEY_STORAGE_KEY,
  NOVA_WALLET_ICON,
  NOVA_WALLET_NAME,
  NovaAdapterError,
  NovaClient,
  NovaErrorCode,
  bridgeBaseUrl,
  buildCallbackUrl,
  buildDeeplinkUrl,
  buildDesktopOrMobileConnectUrl,
  clearExternalSession,
  createFullMessage,
  createNovaAIP62Wallet,
  currentUrlWithoutCallbackKey,
  detectProvider,
  fetchJsonWithTimeout,
  getSdkNetwork,
  hasStoredExternalSession,
  isBrowser,
  isMobileBrowser,
  launchDesktopOrMobileConnect,
  normalizeNetwork,
  normalizeProviderAccount,
  normalizeSignMessageOutput,
  normalizeTransactionPayload,
  readExternalSession,
  readValidatedExternalSession,
  registerNovaWallet,
  remapNovaError,
  revokeExternalSession,
  sessionToAccountInfo,
  storeCallbackSession,
  storeExternalSession,
  submitSignedTransaction,
  toUint8Array,
  tryLocalBridgeConnect,
  tryLocalBridgeSignAndSubmit,
  tryLocalBridgeSignMessage,
  tryLocalBridgeSignTransaction,
  validateExternalSession,
  waitForExternalSession
} from "./chunk-XVUNA2GW.js";

// src/types.ts
var NovaWalletReadyState = /* @__PURE__ */ ((NovaWalletReadyState2) => {
  NovaWalletReadyState2["Installed"] = "Installed";
  NovaWalletReadyState2["NotDetected"] = "NotDetected";
  NovaWalletReadyState2["Loadable"] = "Loadable";
  NovaWalletReadyState2["Unsupported"] = "Unsupported";
  return NovaWalletReadyState2;
})(NovaWalletReadyState || {});

// src/NovaWallet.ts
import EventEmitter from "eventemitter3";
var NovaWallet = class extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.url = options.websiteUrl ?? DEFAULT_WEBSITE_URL;
    this.client = new NovaClient(options);
  }
  name = isMobileBrowser() ? NOVA_WALLET_NAME : NOVA_DESK_NAME;
  url;
  icon = NOVA_WALLET_ICON;
  client;
  cachedAccount = null;
  cachedNetwork = null;
  isConnecting = false;
  get readyState() {
    if (typeof window === "undefined") return "Unsupported" /* Unsupported */;
    return detectProvider(this.options) || hasStoredExternalSession() || !isMobileBrowser() ? "Installed" /* Installed */ : "NotDetected" /* NotDetected */;
  }
  get connecting() {
    return this.isConnecting;
  }
  get connected() {
    return !!this.cachedAccount;
  }
  get publicAccount() {
    return {
      publicKey: this.cachedAccount?.publicKey.toString() ?? null,
      address: this.cachedAccount?.address.toString() ?? null,
      authKey: null
    };
  }
  get network() {
    return {
      api: this.cachedNetwork?.url,
      chainId: this.cachedNetwork?.chainId?.toString(),
      name: this.cachedNetwork?.name
    };
  }
  async connect() {
    this.isConnecting = true;
    try {
      const result = await this.client.connect();
      this.cachedAccount = result.account;
      this.cachedNetwork = result.network;
      await this.client.subscribe();
      return result.account;
    } finally {
      this.isConnecting = false;
    }
  }
  async account() {
    this.cachedAccount = await this.client.getAccount();
    return this.cachedAccount;
  }
  async disconnect() {
    await this.client.disconnect();
    this.cachedAccount = null;
    this.cachedNetwork = null;
  }
  async signAndSubmitTransaction(transaction, options) {
    return this.client.signAndSubmitTransaction(transaction, options);
  }
  async signAndSubmitBCSTransaction(transaction, options) {
    return this.client.signAndSubmitBCSTransaction(transaction, options);
  }
  async signTransaction(transaction, options) {
    const result = await this.client.signTransaction(transaction, options);
    if (result instanceof Uint8Array) return result;
    if (result && typeof result === "object" && "authenticator" in result) {
      return result;
    }
    return {
      authenticator: result
    };
  }
  async signMessage(message) {
    return this.client.signMessage(message);
  }
  async onAccountChange(callback) {
    this.client.on("accountChange", (account) => {
      this.cachedAccount = account;
      callback(account);
      this.emit("accountChange", account.address.toString());
    });
    await this.client.subscribe();
  }
  async onNetworkChange(callback) {
    this.client.on("networkChange", (network) => {
      this.cachedNetwork = network;
      callback(network);
      this.emit("networkChange", {
        api: network.url,
        chainId: network.chainId?.toString(),
        name: network.name
      });
    });
    await this.client.subscribe();
  }
  deeplinkProvider(url) {
    return buildDeeplinkUrl(this.options, url);
  }
};
export {
  BridgeHttpError,
  CALLBACK_ADDRESS_PARAM,
  CALLBACK_BRIDGE_URL_PARAM,
  CALLBACK_CHAIN_ID_PARAM,
  CALLBACK_NETWORK_PARAM,
  CALLBACK_PROTOCOL_PUBLIC_KEY_PARAM,
  CALLBACK_PUBLIC_KEY_PARAM,
  CALLBACK_SESSION_ID_PARAM,
  CALLBACK_WALLET_NAME_PARAM,
  DEFAULT_BRIDGE_CONNECT_TIMEOUT_MS,
  DEFAULT_BRIDGE_POLL_INTERVAL_MS,
  DEFAULT_BRIDGE_POLL_TIMEOUT_MS,
  DEFAULT_DEEPLINK_BASE_URL,
  DEFAULT_DESKTOP_BRIDGE_URL,
  DEFAULT_DESKTOP_LOGIN_URL,
  DEFAULT_DESKTOP_REGISTRATION,
  DEFAULT_DETECT_ALIASES,
  DEFAULT_REGISTER_FORCE,
  DEFAULT_WEBSITE_URL,
  NOVA_DESK_NAME,
  NOVA_EXTERNAL_SESSION_STORAGE_KEY,
  NOVA_PROTOCOL_KEY_STORAGE_KEY,
  NOVA_WALLET_ICON,
  NOVA_WALLET_NAME,
  NovaAdapterError,
  NovaClient,
  NovaErrorCode,
  NovaWallet,
  NovaWalletReadyState,
  bridgeBaseUrl,
  buildCallbackUrl,
  buildDeeplinkUrl,
  buildDesktopOrMobileConnectUrl,
  clearExternalSession,
  createFullMessage,
  createNovaAIP62Wallet,
  currentUrlWithoutCallbackKey,
  detectProvider,
  fetchJsonWithTimeout,
  getSdkNetwork,
  hasStoredExternalSession,
  isBrowser,
  isMobileBrowser,
  launchDesktopOrMobileConnect,
  normalizeNetwork,
  normalizeProviderAccount,
  normalizeSignMessageOutput,
  normalizeTransactionPayload,
  readExternalSession,
  readValidatedExternalSession,
  registerNovaWallet,
  remapNovaError,
  revokeExternalSession,
  sessionToAccountInfo,
  storeCallbackSession,
  storeExternalSession,
  submitSignedTransaction,
  toUint8Array,
  tryLocalBridgeConnect,
  tryLocalBridgeSignAndSubmit,
  tryLocalBridgeSignMessage,
  tryLocalBridgeSignTransaction,
  validateExternalSession,
  waitForExternalSession
};
