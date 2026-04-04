import { NetworkInfo, CedraSignMessageInput, CedraSignMessageOutput, CedraSignTransactionOutputV1_1, CedraSignAndSubmitTransactionOutput, AccountInfo, CedraWallet } from '@cedra-labs/wallet-standard';
import { Network, AnyRawTransaction, InputGenerateTransactionPayloadData, AccountAddressInput, InputGenerateTransactionOptions, AccountAuthenticator, InputSubmitTransactionData, PendingTransactionResponse, AnyPublicKey } from '@cedra-labs/ts-sdk';

type NovaWalletName<T extends string = string> = T & {
    __brand__: "WalletName";
};
declare enum NovaWalletReadyState {
    Installed = "Installed",
    NotDetected = "NotDetected",
    Loadable = "Loadable",
    Unsupported = "Unsupported"
}
interface NovaAccountKeys {
    publicKey: string | string[] | null;
    address: string | null;
    authKey: string | null;
    minKeysRequired?: number;
}
interface NovaNetworkInfo {
    api?: string;
    chainId?: string;
    name: string | undefined;
}
interface SignMessagePayload {
    address?: boolean;
    application?: boolean;
    chainId?: boolean;
    message: string;
    nonce: string;
}
interface NovaSignMessageResponse {
    address: string;
    application?: string;
    chainId?: number;
    fullMessage: string;
    message: string;
    nonce: string;
    prefix: string;
    signature: string;
}
interface NovaWalletOptions {
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
interface NovaExternalSession {
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
interface NovaBridgeStartResponse {
    requestId: string;
    status?: string;
}
interface NovaBridgeConnectPoll {
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
interface NovaBridgeMessagePoll {
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
interface NovaBridgeSignTransactionPoll {
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
interface NovaBridgeTransactionPoll {
    status?: string;
    requestId?: string;
    hash?: string;
    error?: string;
}
interface NovaCallbackMarker {
    requestId: string;
    status: string;
}
interface NovaMobilePairingCreateResponse {
    pairingId: string;
    dappPairingToken: string;
    walletDeeplinkUrl: string;
    websocketUrl?: string;
    expiresAt: string;
}
interface NovaMobilePairingStatus {
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
interface NovaMobileRequestCreateResponse {
    requestId: string;
    walletDeeplinkUrl: string;
    expiresAt: string;
}
interface NovaMobileRequestStatus {
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
type NovaTransactionPayload = InputGenerateTransactionPayloadData | {
    sender?: AccountAddressInput;
    data: InputGenerateTransactionPayloadData;
    options?: InputGenerateTransactionOptions;
    withFeePayer?: boolean;
};
interface NormalizedConnectedAccount {
    address: string;
    publicKey: Uint8Array;
    network?: NetworkInfo | null;
}
interface NovaProviderAccount {
    address: string;
    publicKey: Uint8Array | string;
    network?: string | number | NetworkInfo;
}
interface NovaProviderResponse<T> {
    status?: string | number;
    data?: T;
    args?: T;
    result?: T;
}
interface NovaProvider {
    isNovaWallet?: boolean;
    connect?: (...args: unknown[]) => Promise<NovaProviderAccount | NovaProviderResponse<NovaProviderAccount>>;
    account?: () => Promise<NovaProviderAccount | NovaProviderResponse<NovaProviderAccount>>;
    disconnect?: () => Promise<void | NovaProviderResponse<void>>;
    network?: () => Promise<string | number | NetworkInfo | NovaProviderResponse<string | number | NetworkInfo>>;
    signMessage?: (input: CedraSignMessageInput | SignMessagePayload) => Promise<CedraSignMessageOutput | NovaSignMessageResponse | NovaProviderResponse<CedraSignMessageOutput | NovaSignMessageResponse>>;
    signTransaction?: (transaction: AnyRawTransaction | NovaTransactionPayload, options?: unknown) => Promise<AccountAuthenticator | Uint8Array | {
        authenticator: AccountAuthenticator;
        rawTransaction?: Uint8Array;
    } | CedraSignTransactionOutputV1_1 | NovaProviderResponse<AccountAuthenticator | Uint8Array | {
        authenticator: AccountAuthenticator;
        rawTransaction?: Uint8Array;
    } | CedraSignTransactionOutputV1_1>>;
    signAndSubmitTransaction?: (transaction: AnyRawTransaction | NovaTransactionPayload, options?: unknown) => Promise<CedraSignAndSubmitTransactionOutput | NovaProviderResponse<CedraSignAndSubmitTransactionOutput>>;
    onAccountChange?: (callback: (account: NovaProviderAccount) => void) => Promise<void> | void;
    onNetworkChange?: (callback: (network: string | number | NetworkInfo) => void) => Promise<void> | void;
    submitTransaction?: (input: InputSubmitTransactionData) => Promise<PendingTransactionResponse | NovaProviderResponse<PendingTransactionResponse>>;
}
interface NovaWindow extends Window {
    inferenco?: NovaProvider;
    nova?: NovaProvider;
    cedra?: NovaProvider;
    aptos?: NovaProvider;
}
interface NovaWalletAdapterLike {
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
    signAndSubmitTransaction(transaction: NovaTransactionPayload, options?: InputGenerateTransactionOptions): Promise<CedraSignAndSubmitTransactionOutput>;
    signAndSubmitBCSTransaction(transaction: NovaTransactionPayload, options?: InputGenerateTransactionOptions): Promise<CedraSignAndSubmitTransactionOutput>;
    signTransaction(transaction: AnyRawTransaction | NovaTransactionPayload, options?: InputGenerateTransactionOptions): Promise<Uint8Array | {
        authenticator: AccountAuthenticator;
        rawTransaction?: Uint8Array;
    }>;
    signMessage(message: CedraSignMessageInput | SignMessagePayload): Promise<CedraSignMessageOutput | NovaSignMessageResponse>;
    onAccountChange(callback: (account: AccountInfo) => void): Promise<void>;
    onNetworkChange(callback: (network: NetworkInfo) => void): Promise<void>;
    deeplinkProvider(url?: string): string;
}
interface NovaWalletLikeResult {
    account: AccountInfo;
    network: NetworkInfo | null;
    publicKey: AnyPublicKey;
}
interface NovaWalletCoreLike {
    wallets: ReadonlyArray<{
        name: string;
    }>;
    connect(walletName: string): Promise<void | string>;
}
type NovaSignTransactionResult = AccountAuthenticator | Uint8Array | {
    authenticator: AccountAuthenticator;
    rawTransaction?: Uint8Array;
} | CedraSignTransactionOutputV1_1;

declare function createNovaAIP62Wallet(options?: NovaWalletOptions): CedraWallet;
declare function registerNovaWallet(options?: NovaWalletOptions): void;

export { createNovaAIP62Wallet as A, registerNovaWallet as B, type NovaWalletOptions as N, type SignMessagePayload as S, type NovaProvider as a, type NovaCallbackMarker as b, type NovaExternalSession as c, type NovaWalletCoreLike as d, type NovaProviderAccount as e, type NovaSignMessageResponse as f, type NovaTransactionPayload as g, type NovaSignTransactionResult as h, type NovaNetworkInfo as i, type NovaWalletAdapterLike as j, type NovaWalletName as k, NovaWalletReadyState as l, type NovaAccountKeys as m, type NormalizedConnectedAccount as n, type NovaBridgeConnectPoll as o, type NovaBridgeMessagePoll as p, type NovaBridgeSignTransactionPoll as q, type NovaBridgeStartResponse as r, type NovaBridgeTransactionPoll as s, type NovaMobilePairingCreateResponse as t, type NovaMobilePairingStatus as u, type NovaMobileRequestCreateResponse as v, type NovaMobileRequestStatus as w, type NovaProviderResponse as x, type NovaWalletLikeResult as y, type NovaWindow as z };
