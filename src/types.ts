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

export type InferWalletName<T extends string = string> = T & {
  __brand__: "WalletName";
};

export enum InferWalletReadyState {
  Installed = "Installed",
  NotDetected = "NotDetected",
  Loadable = "Loadable",
  Unsupported = "Unsupported"
}

export interface InferAccountKeys {
  publicKey: string | string[] | null;
  address: string | null;
  authKey: string | null;
  minKeysRequired?: number;
}

export interface InferNetworkInfo {
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

export interface InferSignMessageResponse {
  address: string;
  application?: string;
  chainId?: number;
  fullMessage: string;
  message: string;
  nonce: string;
  prefix: string;
  signature: string;
}

export interface InferWalletOptions {
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
  /**
   * Tier 1 (deeplink hardening): if set, the adapter verifies that
   * the deeplink callback's `window.location.origin` matches this
   * value before consuming the session. A mismatch throws
   * `CallbackOriginMismatch`. Defends against phishing sites that
   * redirect the deeplink flow to a different origin than the dapp
   * that initiated the connection.
   */
  expectedOrigin?: string;
  /**
   * v0.2.0-rc.8 (Phase 5 UX): opt-in liveness heartbeat for external
   * browsers. When set to a positive number of milliseconds, the
   * adapter periodically issues `GET /<token>/session/<id>` against
   * the local Infer Desk bridge. On a 403/404 (wallet revoked the
   * session), the new `"disconnect"` event is emitted on
   * `InferClient` / `InferWallet` / `cedra:onDisconnect` (AIP-62),
   * giving dapps sub-second disconnect detection without polling
   * the bridge themselves.
   *
   * Default: `0` (disabled) — backwards-compatible with v0.2.0-rc.7.
   * Dapps that don't opt in fall back to lazy detection on the next
   * user-initiated `connect()`/`getAccount()` (existing behaviour).
   *
   * Cost: 1 HTTP call per dapp tab per interval against `127.0.0.1`.
   * Recommended values: 15_000–60_000.
   */
  sessionLivenessIntervalMs?: number;
}

/** v0.2.0-rc.8 (Phase 5 UX): payload-less disconnect event surface,
 * shared by `InferClient`, `InferWallet`, and the AIP-62 `cedra:onDisconnect`
 * feature. Fires when either:
 *   (a) the dapp itself called `client.disconnect()`,
 *   (b) the wallet revoked the session from its dashboard,
 *   (c) a peer tab cleared `inferenco:nova-session` in localStorage,
 *   (d) the opt-in liveness heartbeat saw a 403/404 from
 *       `GET /<token>/session/<id>`.
 *
 * Subscribing to this event is the dapp's signal to drop any cached
 * account/network state, surface a "Disconnected by Infer Desk" toast,
 * and require a fresh `connect()` to resume.
 */
export type InferDisconnectEvent = void;

export interface InferExternalSession {
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

export interface InferBridgeStartResponse {
  requestId: string;
  status?: string;
}

export interface InferBridgeConnectPoll {
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

export interface InferBridgeMessagePoll {
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

export interface InferBridgeSignTransactionPoll {
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
  authenticator?: {
    hex?: string;
  };
}

export type InferTerminalStatus = "pending" | "approved" | "rejected" | "failed";

interface InferBridgeTransactionPollBase {
  requestId: string;
  signature?: unknown;
  result?: unknown;
  data?: unknown;
  args?: unknown;
  encryptedResult?: unknown;
  authenticator?: unknown;
  authenticatorHex?: unknown;
  authenticator_hex?: unknown;
  rawTransaction?: unknown;
  rawTransactionBcsHex?: unknown;
  raw_transaction_bcs_hex?: unknown;
  signedTransaction?: unknown;
  submission?: unknown;
  submittedTransaction?: unknown;
  transactionHash?: unknown;
  txHash?: unknown;
  error?: string;
}

export type InferBridgeTransactionPoll =
  | (InferBridgeTransactionPollBase & { status: "approved"; hash?: string })
  | (InferBridgeTransactionPollBase & { status: "rejected"; hash?: string })
  | (InferBridgeTransactionPollBase & { status: "failed"; hash?: string })
  | (InferBridgeTransactionPollBase & { status: "pending"; hash?: string });

export interface InferCallbackMarker {
  requestId: string;
  status: string;
}

export interface InferMobilePairingCreateResponse {
  pairingId: string;
  dappPairingToken: string;
  walletDeeplinkUrl: string;
  websocketUrl?: string;
  expiresAt: string;
}

export interface InferMobilePairingStatus {
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

export interface InferMobileRequestCreateResponse {
  requestId: string;
  walletDeeplinkUrl: string;
  expiresAt: string;
}

interface InferMobileRequestStatusBase {
  requestId: string;
  sessionId: string;
  method: "signMessage" | "signTransaction" | "signAndSubmitTransaction";
  callbackUrl: string;
  encryptedRequest?: string | null;
  encryptedResult?: string | null;
  requestMetadata?: Record<string, unknown> | null;
  resultMetadata?: Record<string, unknown> | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  origin?: string | null;
  appName?: string | null;
  accountAddress?: string | null;
  network?: string | null;
  chainId?: number | null;
  walletName?: string | null;
  expiresAt: string;
}

export type InferMobileRequestStatus =
  | (InferMobileRequestStatusBase & { status: "approved" })
  | (InferMobileRequestStatusBase & { status: "rejected" })
  | (InferMobileRequestStatusBase & { status: "failed" })
  | (InferMobileRequestStatusBase & { status: "pending" })
  | (InferMobileRequestStatusBase & { status: "expired" | "cancelled" | "revoked" });

export type InferTransactionPayload =
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

export interface InferProviderAccount {
  address: string;
  publicKey: Uint8Array | string;
  network?: string | number | NetworkInfo;
}

export interface InferProviderResponse<T> {
  status?: string | number;
  data?: T;
  args?: T;
  result?: T;
}

export type InferSignAndSubmitProviderResponse =
  | CedraSignAndSubmitTransactionOutput
  | {
      status: "Approved";
      args: CedraSignAndSubmitTransactionOutput;
    }
  | {
      status: "Rejected";
    };

export interface InferSignedTransactionWithAuthenticator {
  authenticator: AccountAuthenticator;
  rawTransaction?: Uint8Array | AnyRawTransaction;
}

export interface InferRawTransactionSignInput {
  rawTransactionBcsHex: string;
  bcsHex?: string;
  sender?: string;
  secondarySignerAddresses?: string[];
  feePayerAddress?: string;
  options?: unknown;
}

export interface InferExternalAccountInput {
  address: string;
  publicKey?: string;
}

export type InferExternalWalletStandardSignInput = Omit<
  CedraSignTransactionInputV1_1,
  "feePayer" | "secondarySigners" | "sender" | "signerAddress"
> & {
  feePayer?: InferExternalAccountInput;
  feePayerAddress?: string;
  secondarySigners?: InferExternalAccountInput[];
  secondarySignerAddresses?: string[];
  sender?: string;
  signerAddress?: string;
  options?: unknown;
};

export type InferExternalSignTransactionInput =
  | InferRawTransactionSignInput
  | InferExternalWalletStandardSignInput;

export interface InferProvider {
  /** Canonical brand flag set by Infer Desk (v0.6.0+) / Infer Wallet (post-rebrand). */
  isInferWallet?: boolean;
  /**
   * Legacy brand flag set by pre-0.6.0 Infer Desk (named "Infer Desk") and
   * pre-rebrand Infer Wallet (named "Nova Wallet"). Still recognised by
   * `isBrandedInferProvider` during the transition window. Will be removed
   * in 0.4.0.
   */
  isNovaWallet?: boolean;
  connect?: (...args: unknown[]) => Promise<InferProviderAccount | InferProviderResponse<InferProviderAccount>>;
  account?: () => Promise<InferProviderAccount | InferProviderResponse<InferProviderAccount>>;
  disconnect?: () => Promise<void | InferProviderResponse<void>>;
  network?: () => Promise<string | number | NetworkInfo | InferProviderResponse<string | number | NetworkInfo>>;
  signMessage?: (
    input: CedraSignMessageInput | SignMessagePayload
  ) => Promise<CedraSignMessageOutput | InferSignMessageResponse | InferProviderResponse<CedraSignMessageOutput | InferSignMessageResponse>>;
  signTransaction?: (
    transaction: AnyRawTransaction | InferTransactionPayload | CedraSignTransactionInputV1_1,
    options?: unknown
  ) => Promise<AccountAuthenticator | Uint8Array | InferSignedTransactionWithAuthenticator | CedraSignTransactionOutputV1_1 | InferProviderResponse<AccountAuthenticator | Uint8Array | InferSignedTransactionWithAuthenticator | CedraSignTransactionOutputV1_1>>;
  signAndSubmitTransaction?: (
    transaction: AnyRawTransaction | InferTransactionPayload,
    options?: unknown
  ) => Promise<InferSignAndSubmitProviderResponse>;
  onAccountChange?: (callback: (account: InferProviderAccount) => void) => Promise<void> | void;
  onNetworkChange?: (callback: (network: string | number | NetworkInfo) => void) => Promise<void> | void;
  submitTransaction?: (
    input: InputSubmitTransactionData
  ) => Promise<PendingTransactionResponse | InferProviderResponse<PendingTransactionResponse>>;
}

export interface InferWindow extends Window {
  inferenco?: InferProvider;
  /** New rebrand namespace (added in 0.3.0). Identical to `inferenco`. */
  infer?: InferProvider;
  /**
   * Legacy alias namespace (kept during the transition window so older
   * Infer Desk builds remain detectable). Will be removed in 0.4.0.
   */
  nova?: InferProvider;
  cedra?: InferProvider;
  aptos?: InferProvider;
}

export interface InferWalletAdapterLike {
  name: InferWalletName;
  url: string;
  icon: string;
  readyState: InferWalletReadyState;
  connecting: boolean;
  connected: boolean;
  publicAccount: InferAccountKeys;
  network: InferNetworkInfo;
  connect(): Promise<AccountInfo>;
  account(): Promise<AccountInfo>;
  disconnect(): Promise<void>;
  signAndSubmitTransaction(
    transaction: InferTransactionPayload,
    options?: InputGenerateTransactionOptions
  ): Promise<CedraSignAndSubmitTransactionOutput>;
  signAndSubmitBCSTransaction(
    transaction: InferTransactionPayload,
    options?: InputGenerateTransactionOptions
  ): Promise<CedraSignAndSubmitTransactionOutput>;
  signTransaction(
    transaction: AnyRawTransaction | InferTransactionPayload | CedraSignTransactionInputV1_1,
    options?: InputGenerateTransactionOptions
  ): Promise<Uint8Array | InferSignedTransactionWithAuthenticator>;
  signMessage(
    message: CedraSignMessageInput | SignMessagePayload
  ): Promise<CedraSignMessageOutput | InferSignMessageResponse>;
  onAccountChange(callback: (account: AccountInfo) => void): Promise<void>;
  onNetworkChange(callback: (network: NetworkInfo) => void): Promise<void>;
  deeplinkProvider(url?: string): string;
}

export interface InferWalletLikeResult {
  account: AccountInfo;
  network: NetworkInfo | null;
  publicKey: AnyPublicKey;
}

export interface InferWalletCoreLike {
  wallets: ReadonlyArray<{ name: string }>;
  connect(walletName: string): Promise<void | string>;
}

export type InferSignTransactionResult =
  | AccountAuthenticator
  | Uint8Array
  | InferSignedTransactionWithAuthenticator
  | CedraSignTransactionOutputV1_1;
