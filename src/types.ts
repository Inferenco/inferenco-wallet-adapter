import type {
  AccountAuthenticator,
  AccountAddressInput,
  AnyRawTransaction,
  AnyPublicKey,
  InputGenerateTransactionOptions,
  InputGenerateTransactionPayloadData,
  InputSubmitTransactionData,
  Network,
  PendingTransactionResponse
} from "@cedra-labs/ts-sdk";
import type {
  AccountInfo,
  CedraSignAndSubmitTransactionOutput,
  CedraSignMessageInput,
  CedraSignMessageOutput,
  NetworkInfo
} from "@cedra-labs/wallet-standard";

export type LegacyWalletName<T extends string = string> = T & {
  __brand__: "WalletName";
};

export enum LegacyWalletReadyState {
  Installed = "Installed",
  NotDetected = "NotDetected",
  Loadable = "Loadable",
  Unsupported = "Unsupported"
}

export interface LegacyAccountKeys {
  publicKey: string | string[] | null;
  address: string | null;
  authKey: string | null;
  minKeysRequired?: number;
}

export interface LegacyNetworkInfo {
  api?: string;
  chainId?: string;
  name: string | undefined;
}

export interface SignMessagePayload {
  address?: boolean;
  application?: boolean;
  chainId?: boolean;
  message: string;
  nonce: string;
}

export interface LegacySignMessageResponse {
  address: string;
  application?: string;
  chainId?: number;
  fullMessage: string;
  message: string;
  nonce: string;
  prefix: string;
  signature: string;
}

export interface NovaWalletOptions {
  deeplinkBaseUrl?: string;
  websiteUrl?: string;
  forceRegistration?: boolean;
  detectAliases?: boolean;
  networkOverride?: Network;
  fullnodeUrl?: string;
}

export type LegacyTransactionPayload =
  | InputGenerateTransactionPayloadData
  | {
      sender?: AccountAddressInput;
      data: InputGenerateTransactionPayloadData;
      options?: InputGenerateTransactionOptions;
      withFeePayer?: boolean;
    };

export interface NormalizedConnectedAccount {
  address: string;
  publicKey: Uint8Array;
  network?: NetworkInfo | null;
}

export interface NovaProviderAccount {
  address: string;
  publicKey: Uint8Array | string;
  network?: string | number | NetworkInfo;
}

export interface NovaProviderResponse<T> {
  status?: string | number;
  data?: T;
  args?: T;
  result?: T;
}

export interface NovaProvider {
  isNovaWallet?: boolean;
  connect?: (...args: unknown[]) => Promise<NovaProviderAccount | NovaProviderResponse<NovaProviderAccount>>;
  account?: () => Promise<NovaProviderAccount | NovaProviderResponse<NovaProviderAccount>>;
  disconnect?: () => Promise<void | NovaProviderResponse<void>>;
  network?: () => Promise<string | number | NetworkInfo | NovaProviderResponse<string | number | NetworkInfo>>;
  signMessage?: (
    input: CedraSignMessageInput | SignMessagePayload
  ) => Promise<CedraSignMessageOutput | LegacySignMessageResponse | NovaProviderResponse<CedraSignMessageOutput | LegacySignMessageResponse>>;
  signTransaction?: (
    transaction: AnyRawTransaction | LegacyTransactionPayload,
    options?: unknown
  ) => Promise<AccountAuthenticator | Uint8Array | { authenticator: AccountAuthenticator; rawTransaction?: Uint8Array } | NovaProviderResponse<AccountAuthenticator | Uint8Array | { authenticator: AccountAuthenticator; rawTransaction?: Uint8Array }>>;
  signAndSubmitTransaction?: (
    transaction: AnyRawTransaction | LegacyTransactionPayload,
    options?: unknown
  ) => Promise<CedraSignAndSubmitTransactionOutput | NovaProviderResponse<CedraSignAndSubmitTransactionOutput>>;
  onAccountChange?: (callback: (account: NovaProviderAccount) => void) => Promise<void> | void;
  onNetworkChange?: (callback: (network: string | number | NetworkInfo) => void) => Promise<void> | void;
  submitTransaction?: (
    input: InputSubmitTransactionData
  ) => Promise<PendingTransactionResponse | NovaProviderResponse<PendingTransactionResponse>>;
}

export interface NovaWindow extends Window {
  inferenco?: NovaProvider;
  nova?: NovaProvider;
  cedra?: NovaProvider;
  aptos?: NovaProvider;
}

export interface LegacyWalletAdapterLike {
  name: LegacyWalletName;
  url: string;
  icon: string;
  readyState: LegacyWalletReadyState;
  connecting: boolean;
  connected: boolean;
  publicAccount: LegacyAccountKeys;
  network: LegacyNetworkInfo;
  connect(): Promise<AccountInfo>;
  account(): Promise<AccountInfo>;
  disconnect(): Promise<void>;
  signAndSubmitTransaction(
    transaction: LegacyTransactionPayload,
    options?: InputGenerateTransactionOptions
  ): Promise<CedraSignAndSubmitTransactionOutput>;
  signAndSubmitBCSTransaction(
    transaction: LegacyTransactionPayload,
    options?: InputGenerateTransactionOptions
  ): Promise<CedraSignAndSubmitTransactionOutput>;
  signTransaction(
    transaction: AnyRawTransaction | LegacyTransactionPayload,
    options?: InputGenerateTransactionOptions
  ): Promise<Uint8Array | { authenticator: AccountAuthenticator; rawTransaction?: Uint8Array }>;
  signMessage(
    message: CedraSignMessageInput | SignMessagePayload
  ): Promise<CedraSignMessageOutput | LegacySignMessageResponse>;
  onAccountChange(callback: (account: AccountInfo) => void): Promise<void>;
  onNetworkChange(callback: (network: NetworkInfo) => void): Promise<void>;
  deeplinkProvider(url?: string): string;
}

export interface NovaWalletLikeResult {
  account: AccountInfo;
  network: NetworkInfo | null;
  publicKey: AnyPublicKey;
}
