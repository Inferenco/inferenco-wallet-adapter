import { AccountInfo, CedraSignAndSubmitTransactionOutput, CedraSignMessageInput, CedraSignMessageOutput, NetworkInfo, CedraSignTransactionOutputV1_1, CedraWallet } from '@cedra-labs/wallet-standard';
import { Network, InputGenerateTransactionPayloadData, AccountAddressInput, InputGenerateTransactionOptions, AnyRawTransaction, AccountAuthenticator, InputSubmitTransactionData, PendingTransactionResponse, AnyPublicKey } from '@cedra-labs/ts-sdk';

type LegacyWalletName<T extends string = string> = T & {
    __brand__: "WalletName";
};
declare enum LegacyWalletReadyState {
    Installed = "Installed",
    NotDetected = "NotDetected",
    Loadable = "Loadable",
    Unsupported = "Unsupported"
}
interface LegacyAccountKeys {
    publicKey: string | string[] | null;
    address: string | null;
    authKey: string | null;
    minKeysRequired?: number;
}
interface LegacyNetworkInfo {
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
interface LegacySignMessageResponse {
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
    websiteUrl?: string;
    forceRegistration?: boolean;
    desktopRegistration?: boolean;
    detectAliases?: boolean;
    networkOverride?: Network;
    fullnodeUrl?: string;
    bridgeBaseUrl?: string;
    bridgeConnectTimeoutMs?: number;
    bridgePollIntervalMs?: number;
    bridgePollTimeoutMs?: number;
}
interface NovaExternalSession {
    address: string;
    publicKey: string;
    network: string;
    chainId: number;
    sessionId: string;
    bridgeUrl?: string;
    protocolPublicKey?: string;
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
type LegacyTransactionPayload = InputGenerateTransactionPayloadData | {
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
    signMessage?: (input: CedraSignMessageInput | SignMessagePayload) => Promise<CedraSignMessageOutput | LegacySignMessageResponse | NovaProviderResponse<CedraSignMessageOutput | LegacySignMessageResponse>>;
    signTransaction?: (transaction: AnyRawTransaction | LegacyTransactionPayload, options?: unknown) => Promise<AccountAuthenticator | Uint8Array | {
        authenticator: AccountAuthenticator;
        rawTransaction?: Uint8Array;
    } | CedraSignTransactionOutputV1_1 | NovaProviderResponse<AccountAuthenticator | Uint8Array | {
        authenticator: AccountAuthenticator;
        rawTransaction?: Uint8Array;
    } | CedraSignTransactionOutputV1_1>>;
    signAndSubmitTransaction?: (transaction: AnyRawTransaction | LegacyTransactionPayload, options?: unknown) => Promise<CedraSignAndSubmitTransactionOutput | NovaProviderResponse<CedraSignAndSubmitTransactionOutput>>;
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
interface LegacyWalletAdapterLike {
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
    signAndSubmitTransaction(transaction: LegacyTransactionPayload, options?: InputGenerateTransactionOptions): Promise<CedraSignAndSubmitTransactionOutput>;
    signAndSubmitBCSTransaction(transaction: LegacyTransactionPayload, options?: InputGenerateTransactionOptions): Promise<CedraSignAndSubmitTransactionOutput>;
    signTransaction(transaction: AnyRawTransaction | LegacyTransactionPayload, options?: InputGenerateTransactionOptions): Promise<Uint8Array | {
        authenticator: AccountAuthenticator;
        rawTransaction?: Uint8Array;
    }>;
    signMessage(message: CedraSignMessageInput | SignMessagePayload): Promise<CedraSignMessageOutput | LegacySignMessageResponse>;
    onAccountChange(callback: (account: AccountInfo) => void): Promise<void>;
    onNetworkChange(callback: (network: NetworkInfo) => void): Promise<void>;
    deeplinkProvider(url?: string): string;
}
interface NovaWalletLikeResult {
    account: AccountInfo;
    network: NetworkInfo | null;
    publicKey: AnyPublicKey;
}
type NovaSignTransactionResult = AccountAuthenticator | Uint8Array | {
    authenticator: AccountAuthenticator;
    rawTransaction?: Uint8Array;
} | CedraSignTransactionOutputV1_1;

declare function createNovaAIP62Wallet(options?: NovaWalletOptions): CedraWallet;
declare function registerNovaWallet(options?: NovaWalletOptions): void;

export { type LegacySignMessageResponse as L, type NovaWalletOptions as N, type SignMessagePayload as S, type NovaProvider as a, type NovaExternalSession as b, type NovaProviderAccount as c, type LegacyTransactionPayload as d, type NovaSignTransactionResult as e, type LegacyNetworkInfo as f, type LegacyWalletAdapterLike as g, type LegacyWalletName as h, LegacyWalletReadyState as i, type LegacyAccountKeys as j, type NormalizedConnectedAccount as k, type NovaBridgeConnectPoll as l, type NovaBridgeMessagePoll as m, type NovaBridgeSignTransactionPoll as n, type NovaBridgeStartResponse as o, type NovaBridgeTransactionPoll as p, type NovaProviderResponse as q, type NovaWalletLikeResult as r, type NovaWindow as s, createNovaAIP62Wallet as t, registerNovaWallet as u };
