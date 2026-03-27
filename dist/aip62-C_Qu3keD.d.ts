import { AccountInfo, CedraSignAndSubmitTransactionOutput, CedraSignMessageInput, CedraSignMessageOutput, NetworkInfo, CedraWallet } from '@cedra-labs/wallet-standard';
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
    detectAliases?: boolean;
    networkOverride?: Network;
    fullnodeUrl?: string;
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
    } | NovaProviderResponse<AccountAuthenticator | Uint8Array | {
        authenticator: AccountAuthenticator;
        rawTransaction?: Uint8Array;
    }>>;
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

declare function createNovaAIP62Wallet(options?: NovaWalletOptions): CedraWallet;
declare function registerNovaWallet(options?: NovaWalletOptions): void;

export { type LegacySignMessageResponse as L, type NovaWalletOptions as N, type SignMessagePayload as S, type NovaProvider as a, type NovaProviderAccount as b, type LegacyTransactionPayload as c, type LegacyNetworkInfo as d, type LegacyWalletAdapterLike as e, type LegacyWalletName as f, LegacyWalletReadyState as g, type LegacyAccountKeys as h, type NormalizedConnectedAccount as i, type NovaProviderResponse as j, type NovaWalletLikeResult as k, type NovaWindow as l, createNovaAIP62Wallet as m, registerNovaWallet as r };
