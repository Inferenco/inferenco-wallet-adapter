import EventEmitter from "eventemitter3";
import type {
  AccountAuthenticator,
  AnyRawTransaction
} from "@cedra-labs/ts-sdk";
import type {
  AccountInfo,
  CedraSignAndSubmitTransactionOutput,
  CedraSignMessageInput,
  CedraSignMessageOutput,
  CedraSignTransactionInputV1_1,
  NetworkInfo
} from "@cedra-labs/wallet-standard";
import {
  NOVA_CONNECT_NAME,
  NOVA_DESK_NAME,
  DEFAULT_DESKTOP_WEBSITE_URL,
  DEFAULT_MOBILE_WEBSITE_URL,
  NOVA_WALLET_ICON,
  NOVA_WALLET_NAME
} from "./constants";
import { hasStoredExternalSession, isMobileBrowser } from "./bridge";
import { buildDeeplinkUrl } from "./deeplink";
import { detectProvider } from "./provider";
import { NovaClient } from "./NovaClient";
import {
  NovaAccountKeys,
  NovaNetworkInfo,
  NovaWalletAdapterLike,
  NovaWalletName,
  NovaWalletReadyState,
  NovaSignMessageResponse,
  NovaSignedTransactionWithAuthenticator,
  NovaTransactionPayload,
  NovaWalletOptions
} from "./types";

type NovaWalletEvents = {
  accountChange: [string];
  networkChange: [NovaNetworkInfo];
  /**
   * v0.2.0-rc.8 (Phase 5 UX): mirror of `NovaClient`'s
   * `"disconnect"` event. Fires when Nova Connect revokes the
   * dapp's session (either from the wallet's own UI, or via the
   * opt-in liveness heartbeat), or when the dapp itself calls
   * `disconnect()`. Subscribers should drop cached state and
   * surface a "Reconnect to Nova Connect" affordance.
   */
  disconnect: [];
};

export class NovaWallet
  extends EventEmitter<NovaWalletEvents>
  implements NovaWalletAdapterLike
{
  readonly name = NOVA_CONNECT_NAME as NovaWalletName<"Nova Connect">;
  readonly url: string;
  readonly icon = NOVA_WALLET_ICON;

  private readonly client: NovaClient;
  private cachedAccount: AccountInfo | null = null;
  private cachedNetwork: NetworkInfo | null = null;
  private isConnecting = false;

  constructor(private readonly options: NovaWalletOptions = {}) {
    super();
    this.url = options.websiteUrl ?? (isMobileBrowser() ? DEFAULT_MOBILE_WEBSITE_URL : DEFAULT_DESKTOP_WEBSITE_URL);
    this.client = new NovaClient(options);
  }

  get readyState(): NovaWalletReadyState {
    if (typeof window === "undefined") return NovaWalletReadyState.Unsupported;
    return detectProvider(this.options) || hasStoredExternalSession() || !isMobileBrowser()
      ? NovaWalletReadyState.Installed
      : NovaWalletReadyState.NotDetected;
  }

  get connecting(): boolean {
    return this.isConnecting;
  }

  get connected(): boolean {
    return !!this.cachedAccount;
  }

  get publicAccount(): NovaAccountKeys {
    return {
      publicKey: this.cachedAccount?.publicKey.toString() ?? null,
      address: this.cachedAccount?.address.toString() ?? null,
      authKey: null
    };
  }

  get network(): NovaNetworkInfo {
    return {
      api: this.cachedNetwork?.url,
      chainId: this.cachedNetwork?.chainId?.toString(),
      name: this.cachedNetwork?.name
    };
  }

  async connect(): Promise<AccountInfo> {
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

  async account(): Promise<AccountInfo> {
    this.cachedAccount = await this.client.getAccount();
    return this.cachedAccount;
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
    this.cachedAccount = null;
    this.cachedNetwork = null;
  }

  async signAndSubmitTransaction(
    transaction: NovaTransactionPayload,
    options?: unknown
  ): Promise<CedraSignAndSubmitTransactionOutput> {
    return this.client.signAndSubmitTransaction(transaction, options);
  }

  async signAndSubmitBCSTransaction(
    transaction: NovaTransactionPayload,
    options?: unknown
  ): Promise<CedraSignAndSubmitTransactionOutput> {
    return this.client.signAndSubmitBCSTransaction(transaction, options);
  }

  async signTransaction(
    transaction: AnyRawTransaction | NovaTransactionPayload | CedraSignTransactionInputV1_1,
    options?: unknown
  ): Promise<Uint8Array | NovaSignedTransactionWithAuthenticator> {
    const result = await this.client.signTransaction(transaction, options);
    if (result instanceof Uint8Array) return result;
    if (result && typeof result === "object" && "authenticator" in result) {
      return result as NovaSignedTransactionWithAuthenticator;
    }
    return {
      authenticator: result as AccountAuthenticator
    };
  }

  async signMessage(
    message: CedraSignMessageInput
  ): Promise<CedraSignMessageOutput | NovaSignMessageResponse> {
    return this.client.signMessage(message);
  }

  async onAccountChange(callback: (account: AccountInfo) => void): Promise<void> {
    this.client.on("accountChange", (account) => {
      this.cachedAccount = account;
      callback(account);
      this.emit("accountChange", account.address.toString());
    });
    await this.client.subscribe();
  }

  async onNetworkChange(callback: (network: NetworkInfo) => void): Promise<void> {
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

  /**
   * v0.2.0-rc.8 (Phase 5 UX): subscribe to wallet-initiated or
   * peer-tab-initiated disconnects. The callback fires on either:
   * (a) wallet revocation detected via liveness heartbeat (opt-in)
   *     or on next user-initiated `connect()`/`getAccount()`,
   * (b) the dapp itself called `disconnect()`,
   * (c) a peer tab cleared `inferenco:nova-session` in localStorage,
   * (d) the embedded provider was pushed a disconnect via
   *     `__novaDeskHostUpdate` (Nova Desk wallet's webview).
   *
   * Subscribers should drop cached account/network state, surface
   * a "Reconnect to Nova Connect" affordance, and avoid making
   * signing requests until a fresh `connect()` resolves.
   */
  async onDisconnect(callback: () => void): Promise<void> {
    this.client.on("disconnect", () => {
      this.cachedAccount = null;
      this.cachedNetwork = null;
      callback();
      this.emit("disconnect");
    });
  }

  deeplinkProvider(url?: string): string {
    return buildDeeplinkUrl(this.options, url);
  }
}
