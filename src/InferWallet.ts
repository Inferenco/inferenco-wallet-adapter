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
  INFER_CONNECT_NAME,
  INFER_DESK_NAME,
  DEFAULT_DESKTOP_WEBSITE_URL,
  DEFAULT_MOBILE_WEBSITE_URL,
  INFER_WALLET_ICON,
  INFER_WALLET_NAME
} from "./constants";
import { hasStoredExternalSession, isMobileBrowser } from "./bridge";
import { buildDeeplinkUrl } from "./deeplink";
import { detectProvider } from "./provider";
import { InferClient } from "./InferClient";
import {
  InferAccountKeys,
  InferNetworkInfo,
  InferWalletAdapterLike,
  InferWalletName,
  InferWalletReadyState,
  InferSignMessageResponse,
  InferSignedTransactionWithAuthenticator,
  InferTransactionPayload,
  InferWalletOptions
} from "./types";

type InferWalletEvents = {
  accountChange: [string];
  networkChange: [InferNetworkInfo];
  /**
   * v0.2.0-rc.8 (Phase 5 UX): mirror of `InferClient`'s
   * `"disconnect"` event. Fires when Infer Connect revokes the
   * dapp's session (either from the wallet's own UI, or via the
   * opt-in liveness heartbeat), or when the dapp itself calls
   * `disconnect()`. Subscribers should drop cached state and
   * surface a "Reconnect to Infer Connect" affordance.
   */
  disconnect: [];
};

export class InferWallet
  extends EventEmitter<InferWalletEvents>
  implements InferWalletAdapterLike
{
  readonly name = INFER_CONNECT_NAME as InferWalletName<"Infer Connect">;
  readonly url: string;
  readonly icon = INFER_WALLET_ICON;

  private readonly client: InferClient;
  private cachedAccount: AccountInfo | null = null;
  private cachedNetwork: NetworkInfo | null = null;
  private isConnecting = false;

  constructor(private readonly options: InferWalletOptions = {}) {
    super();
    this.url = options.websiteUrl ?? (isMobileBrowser() ? DEFAULT_MOBILE_WEBSITE_URL : DEFAULT_DESKTOP_WEBSITE_URL);
    this.client = new InferClient(options);
  }

  get readyState(): InferWalletReadyState {
    if (typeof window === "undefined") return InferWalletReadyState.Unsupported;
    return detectProvider(this.options) || hasStoredExternalSession() || !isMobileBrowser()
      ? InferWalletReadyState.Installed
      : InferWalletReadyState.NotDetected;
  }

  get connecting(): boolean {
    return this.isConnecting;
  }

  get connected(): boolean {
    return !!this.cachedAccount;
  }

  get publicAccount(): InferAccountKeys {
    return {
      publicKey: this.cachedAccount?.publicKey.toString() ?? null,
      address: this.cachedAccount?.address.toString() ?? null,
      authKey: null
    };
  }

  get network(): InferNetworkInfo {
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
    transaction: InferTransactionPayload,
    options?: unknown
  ): Promise<CedraSignAndSubmitTransactionOutput> {
    return this.client.signAndSubmitTransaction(transaction, options);
  }

  async signAndSubmitBCSTransaction(
    transaction: InferTransactionPayload,
    options?: unknown
  ): Promise<CedraSignAndSubmitTransactionOutput> {
    return this.client.signAndSubmitBCSTransaction(transaction, options);
  }

  async signTransaction(
    transaction: AnyRawTransaction | InferTransactionPayload | CedraSignTransactionInputV1_1,
    options?: unknown
  ): Promise<Uint8Array | InferSignedTransactionWithAuthenticator> {
    const result = await this.client.signTransaction(transaction, options);
    if (result instanceof Uint8Array) return result;
    if (result && typeof result === "object" && "authenticator" in result) {
      return result as InferSignedTransactionWithAuthenticator;
    }
    return {
      authenticator: result as AccountAuthenticator
    };
  }

  async signMessage(
    message: CedraSignMessageInput
  ): Promise<CedraSignMessageOutput | InferSignMessageResponse> {
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
   *     `__inferDeskHostUpdate` (Infer Desk wallet's webview).
   *
   * Subscribers should drop cached account/network state, surface
   * a "Reconnect to Infer Connect" affordance, and avoid making
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
