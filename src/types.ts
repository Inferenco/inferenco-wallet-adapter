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
  CedraSignAndSubmitTransactionInput,
  CedraSignAndSubmitTransactionOutput,
  CedraSignMessageInput,
  CedraSignMessageOutput,
  CedraSignTransactionInputV1_1,
  CedraSignTransactionOutputV1_1,
  NetworkInfo
} from "@cedra-labs/wallet-standard";

export type NovaWalletName<T extends string = string> = T & {
  __brand__: "WalletName";
};

export enum NovaWalletReadyState {
  Installed = "Installed",
  NotDetected = "NotDetected",
  Loadable = "Loadable",
  Unsupported = "Unsupported"
}

export interface NovaAccountKeys {
  publicKey: string | string[] | null;
  address: string | null;
  authKey: string | null;
  minKeysRequired?: number;
}

export interface NovaNetworkInfo {
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

export interface NovaSignMessageResponse {
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
  deeplinkScheme?: string;
  websiteUrl?: string;
  forceRegistration?: boolean;
  desktopRegistration?: boolean;
  detectAliases?: boolean;
  networkOverride?: Network;
  fullnodeUrl?: string;
  bridgeBaseUrl?: string;
  relayBaseUrl?: string;
  websocketBaseUrl?: string;
  bridgeConnectTimeoutMs?: number;
  bridgePollIntervalMs?: number;
  bridgePollTimeoutMs?: number;
  mobilePollIntervalMs?: number;
  mobileRequestTimeoutMs?: number;
  mobileSocketTimeoutMs?: number;
}

export interface NovaExternalSession {
  transport: "desktop-bridge" | "mobile-relay";
  address: string;
  publicKey: string;
  network: string;
  chainId: number;
  sessionId: string;
  bridgeUrl?: string;
  relayBaseUrl?: string;
  protocolPublicKey?: string;
  dappSessionToken?: string;
  sharedSecret?: string;
  walletPublicKey?: string;
  walletName?: string;
}

export interface NovaBridgeStartResponse {
  requestId: string;
  status?: string;
}

export interface NovaBridgeConnectPoll {
  status?: string;
  requestId?: string;
  address?: string;
  publicKey?: string;
  public_key?: string;
  network?: string;
  chainId?: number;
  chain_id?: number;
  sessionId?: string;
  session_id?: string;
  bridgeUrl?: string;
  bridge_url?: string;
  walletName?: string;
  wallet_name?: string;
  error?: string;
}

export interface NovaBridgeMessagePoll {
  status?: string;
  requestId?: string;
  address?: string;
  publicKey?: string;
  public_key?: string;
  signature?: string;
  fullMessage?: string;
  full_message?: string;
  message?: string;
  error?: string;
}

export interface NovaBridgeSignTransactionPoll {
  status?: string;
  requestId?: string;
  address?: string;
  publicKey?: string;
  public_key?: string;
  authenticatorHex?: string;
  authenticator_hex?: string;
  rawTransactionBcsHex?: string;
  raw_transaction_bcs_hex?: string;
  role?: string;
  sender?: string;
  error?: string;
}

export interface NovaBridgeTransactionPoll {
  status?: string;
  requestId?: string;
  hash?: string;
  error?: string;
}

export interface NovaCallbackMarker {
  requestId: string;
  status: string;
}

export interface NovaMobilePairingCreateResponse {
  pairingId: string;
  dappPairingToken: string;
  walletDeeplinkUrl: string;
  websocketUrl?: string;
  expiresAt: string;
}

export interface NovaMobilePairingStatus {
  pairingId: string;
  status: "pending" | "claimed" | "approved" | "rejected" | "expired" | "revoked";
  callbackUrl: string;
  encryptedResult?: string;
  dappSessionToken?: string;
  sessionId?: string;
  walletPublicKey?: string;
  accountAddress?: string;
  publicKey?: string;
  network?: string;
  chainId?: number;
  walletName?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface NovaMobileRequestCreateResponse {
  requestId: string;
  walletDeeplinkUrl: string;
  expiresAt: string;
}

export interface NovaMobileRequestStatus {
  requestId: string;
  sessionId: string;
  method: "signMessage" | "signTransaction" | "signAndSubmitTransaction";
  status: "pending" | "approved" | "rejected" | "expired" | "cancelled";
  callbackUrl: string;
  encryptedRequest?: string;
  encryptedResult?: string;
  requestMetadata?: Record<string, unknown> | null;
  resultMetadata?: Record<string, unknown> | null;
  errorCode?: string;
  errorMessage?: string;
  origin?: string;
  appName?: string;
  accountAddress?: string;
  network?: string;
  chainId?: number;
  walletName?: string;
  expiresAt: string;
}

export type NovaTransactionPayload =
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
  ) => Promise<CedraSignMessageOutput | NovaSignMessageResponse | NovaProviderResponse<CedraSignMessageOutput | NovaSignMessageResponse>>;
  signTransaction?: (
    transaction: AnyRawTransaction | NovaTransactionPayload,
    options?: unknown
  ) => Promise<AccountAuthenticator | Uint8Array | { authenticator: AccountAuthenticator; rawTransaction?: Uint8Array } | CedraSignTransactionOutputV1_1 | NovaProviderResponse<AccountAuthenticator | Uint8Array | { authenticator: AccountAuthenticator; rawTransaction?: Uint8Array } | CedraSignTransactionOutputV1_1>>;
  signAndSubmitTransaction?: (
    transaction: AnyRawTransaction | NovaTransactionPayload,
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

export interface NovaWalletAdapterLike {
  name: NovaWalletName;
  url: string;
  icon: string;
  readyState: NovaWalletReadyState;
  connecting: boolean;
  connected: boolean;
  publicAccount: NovaAccountKeys;
  network: NovaNetworkInfo;
  connect(): Promise<AccountInfo>;
  account(): Promise<AccountInfo>;
  disconnect(): Promise<void>;
  signAndSubmitTransaction(
    transaction: NovaTransactionPayload,
    options?: InputGenerateTransactionOptions
  ): Promise<CedraSignAndSubmitTransactionOutput>;
  signAndSubmitBCSTransaction(
    transaction: NovaTransactionPayload,
    options?: InputGenerateTransactionOptions
  ): Promise<CedraSignAndSubmitTransactionOutput>;
  signTransaction(
    transaction: AnyRawTransaction | NovaTransactionPayload,
    options?: InputGenerateTransactionOptions
  ): Promise<Uint8Array | { authenticator: AccountAuthenticator; rawTransaction?: Uint8Array }>;
  signMessage(
    message: CedraSignMessageInput | SignMessagePayload
  ): Promise<CedraSignMessageOutput | NovaSignMessageResponse>;
  onAccountChange(callback: (account: AccountInfo) => void): Promise<void>;
  onNetworkChange(callback: (network: NetworkInfo) => void): Promise<void>;
  deeplinkProvider(url?: string): string;
}

export interface NovaWalletLikeResult {
  account: AccountInfo;
  network: NetworkInfo | null;
  publicKey: AnyPublicKey;
}

export type NovaSignTransactionResult =
  | AccountAuthenticator
  | Uint8Array
  | { authenticator: AccountAuthenticator; rawTransaction?: Uint8Array }
  | CedraSignTransactionOutputV1_1;
