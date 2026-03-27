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
  NetworkInfo
} from "@cedra-labs/wallet-standard";
import {
  NOVA_DESK_NAME,
  DEFAULT_WEBSITE_URL,
  NOVA_WALLET_ICON,
  NOVA_WALLET_NAME
} from "./constants";
import { hasStoredExternalSession, isMobileBrowser } from "./bridge";
import { buildDeeplinkUrl } from "./deeplink";
import { detectProvider } from "./provider";
import { NovaClient } from "./NovaClient";
import {
  LegacyAccountKeys,
  LegacyNetworkInfo,
  LegacyWalletAdapterLike,
  LegacyWalletName,
  LegacyWalletReadyState,
  LegacySignMessageResponse,
  LegacyTransactionPayload,
  NovaWalletOptions
} from "./types";

type LegacyEvents = {
  accountChange: [string];
  networkChange: [LegacyNetworkInfo];
};

export class NovaWallet
  extends EventEmitter<LegacyEvents>
  implements LegacyWalletAdapterLike
{
  readonly name = (isMobileBrowser() ? NOVA_WALLET_NAME : NOVA_DESK_NAME) as LegacyWalletName<"Nova Wallet">;
  readonly url: string;
  readonly icon = NOVA_WALLET_ICON;

  private readonly client: NovaClient;
  private cachedAccount: AccountInfo | null = null;
  private cachedNetwork: NetworkInfo | null = null;
  private isConnecting = false;

  constructor(private readonly options: NovaWalletOptions = {}) {
    super();
    this.url = options.websiteUrl ?? DEFAULT_WEBSITE_URL;
    this.client = new NovaClient(options);
  }

  get readyState(): LegacyWalletReadyState {
    if (typeof window === "undefined") return LegacyWalletReadyState.Unsupported;
    return detectProvider(this.options) || hasStoredExternalSession() || !isMobileBrowser()
      ? LegacyWalletReadyState.Installed
      : LegacyWalletReadyState.NotDetected;
  }

  get connecting(): boolean {
    return this.isConnecting;
  }

  get connected(): boolean {
    return !!this.cachedAccount;
  }

  get publicAccount(): LegacyAccountKeys {
    return {
      publicKey: this.cachedAccount?.publicKey.toString() ?? null,
      address: this.cachedAccount?.address.toString() ?? null,
      authKey: null
    };
  }

  get network(): LegacyNetworkInfo {
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
    transaction: LegacyTransactionPayload,
    options?: unknown
  ): Promise<CedraSignAndSubmitTransactionOutput> {
    return this.client.signAndSubmitTransaction(transaction, options);
  }

  async signAndSubmitBCSTransaction(
    transaction: LegacyTransactionPayload,
    options?: unknown
  ): Promise<CedraSignAndSubmitTransactionOutput> {
    return this.client.signAndSubmitBCSTransaction(transaction, options);
  }

  async signTransaction(
    transaction: AnyRawTransaction | LegacyTransactionPayload,
    options?: unknown
  ): Promise<Uint8Array | { authenticator: AccountAuthenticator; rawTransaction?: Uint8Array }> {
    const result = await this.client.signTransaction(transaction, options);
    if (result instanceof Uint8Array) return result;
    if (result && typeof result === "object" && "authenticator" in result) {
      return result as { authenticator: AccountAuthenticator; rawTransaction?: Uint8Array };
    }
    return {
      authenticator: result as AccountAuthenticator
    };
  }

  async signMessage(
    message: CedraSignMessageInput
  ): Promise<CedraSignMessageOutput | LegacySignMessageResponse> {
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

  deeplinkProvider(url?: string): string {
    return buildDeeplinkUrl(this.options, url);
  }
}
