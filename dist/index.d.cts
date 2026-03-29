import { N as NovaWalletOptions, a as NovaProvider, b as NovaExternalSession, c as NovaProviderAccount, d as NovaSignMessageResponse, e as NovaTransactionPayload, f as NovaSignTransactionResult, g as NovaNetworkInfo, h as NovaWalletAdapterLike, i as NovaWalletName, j as NovaWalletReadyState, k as NovaAccountKeys } from './aip62-CcfV3rMt.cjs';
export { l as NormalizedConnectedAccount, m as NovaBridgeConnectPoll, n as NovaBridgeMessagePoll, o as NovaBridgeSignTransactionPoll, p as NovaBridgeStartResponse, q as NovaBridgeTransactionPoll, r as NovaProviderResponse, s as NovaWalletLikeResult, t as NovaWindow, S as SignMessagePayload, u as createNovaAIP62Wallet, v as registerNovaWallet } from './aip62-CcfV3rMt.cjs';
import { AccountInfo, CedraSignAndSubmitTransactionInput, CedraSignAndSubmitTransactionOutput, CedraSignMessageInput, CedraSignMessageOutput, CedraSignTransactionInputV1_1, CedraSignTransactionOutputV1_1, NetworkInfo } from '@cedra-labs/wallet-standard';
import { Cedra, AnyRawTransaction, InputGenerateTransactionPayloadData, InputGenerateTransactionOptions, AccountAuthenticator, PendingTransactionResponse } from '@cedra-labs/ts-sdk';
import EventEmitter from 'eventemitter3';

declare const NOVA_WALLET_NAME = "Nova Wallet";
declare const NOVA_DESK_NAME = "Nova Desk";
declare const DEFAULT_WEBSITE_URL = "https://inferenco.com";
declare const DEFAULT_DEEPLINK_BASE_URL = "inferenco://connect?callback=";
declare const DEFAULT_DESKTOP_LOGIN_URL = "inferenco://login";
declare const DEFAULT_DESKTOP_BRIDGE_URL = "http://127.0.0.1:21984";
declare const DEFAULT_DETECT_ALIASES = true;
declare const DEFAULT_REGISTER_FORCE = false;
declare const DEFAULT_DESKTOP_REGISTRATION = true;
declare const DEFAULT_BRIDGE_CONNECT_TIMEOUT_MS = 1200;
declare const DEFAULT_BRIDGE_POLL_INTERVAL_MS = 250;
declare const DEFAULT_BRIDGE_POLL_TIMEOUT_MS = 120000;
declare const NOVA_PROTOCOL_KEY_STORAGE_KEY = "inferenco:nova-protocol-key";
declare const NOVA_EXTERNAL_SESSION_STORAGE_KEY = "inferenco:nova-session";
declare const CALLBACK_ADDRESS_PARAM = "address";
declare const CALLBACK_PUBLIC_KEY_PARAM = "publicKey";
declare const CALLBACK_NETWORK_PARAM = "network";
declare const CALLBACK_CHAIN_ID_PARAM = "chainId";
declare const CALLBACK_SESSION_ID_PARAM = "sessionId";
declare const CALLBACK_BRIDGE_URL_PARAM = "bridgeUrl";
declare const CALLBACK_PROTOCOL_PUBLIC_KEY_PARAM = "protocolPublicKey";
declare const CALLBACK_WALLET_NAME_PARAM = "walletName";
declare const NOVA_WALLET_ICON: `data:image/svg+xml;base64,${string}`;

declare enum NovaErrorCode {
    UserRejected = "USER_REJECTED",
    Unauthorized = "UNAUTHORIZED",
    Unsupported = "UNSUPPORTED",
    NotInstalled = "NOT_INSTALLED",
    ConnectionTimeout = "CONNECTION_TIMEOUT",
    InvalidParams = "INVALID_PARAMS",
    InvalidNetwork = "INVALID_NETWORK",
    InternalError = "INTERNAL_ERROR"
}
declare class NovaAdapterError extends Error {
    readonly code: NovaErrorCode;
    readonly cause?: unknown | undefined;
    constructor(code: NovaErrorCode, message: string, cause?: unknown | undefined);
}
declare function remapNovaError(error: unknown): never;

declare function isBrowser(): boolean;
declare function detectProvider(options?: NovaWalletOptions): NovaProvider | undefined;

declare function buildCallbackUrl(): string;
declare function buildDeeplinkUrl(options?: NovaWalletOptions, callbackUrl?: string): string;

declare class BridgeHttpError extends Error {
    readonly status: number;
    constructor(status: number, message: string);
}
declare function isMobileBrowser(): boolean;
declare function bridgeBaseUrl(options?: NovaWalletOptions): string;
declare function currentUrlWithoutCallbackKey(): string;
declare function buildDesktopOrMobileConnectUrl(options?: NovaWalletOptions, callbackUrl?: string): string;
declare function launchDesktopOrMobileConnect(options?: NovaWalletOptions, callbackUrl?: string): string;
declare function readExternalSession(): NovaExternalSession | null;
declare function hasStoredExternalSession(): boolean;
declare function storeExternalSession(session: NovaExternalSession): void;
declare function clearExternalSession(): void;
declare function sessionToAccountInfo(session: NovaExternalSession): AccountInfo;
declare function storeCallbackSession(): void;
declare function waitForExternalSession(options?: NovaWalletOptions): Promise<NovaExternalSession | null>;
declare function fetchJsonWithTimeout<T>(url: string, timeoutMs: number, init?: RequestInit): Promise<T>;
declare function tryLocalBridgeConnect(options?: NovaWalletOptions): Promise<AccountInfo | null>;
declare function tryLocalBridgeSignMessage(input: CedraSignMessageInput, session: NovaExternalSession, options?: NovaWalletOptions): Promise<CedraSignMessageOutput>;
declare function tryLocalBridgeSignTransaction(input: CedraSignTransactionInputV1_1, session: NovaExternalSession, options?: NovaWalletOptions): Promise<CedraSignTransactionOutputV1_1>;
declare function tryLocalBridgeSignAndSubmit(input: CedraSignAndSubmitTransactionInput, session: NovaExternalSession, options?: NovaWalletOptions): Promise<CedraSignAndSubmitTransactionOutput>;

declare function toUint8Array(input: string | Uint8Array): Uint8Array;
declare function normalizeProviderAccount(account: NovaProviderAccount): AccountInfo;
declare function normalizeNetwork(network: string | number | NetworkInfo): NetworkInfo;
declare function normalizeTransactionPayload(transaction: AnyRawTransaction | NovaTransactionPayload): {
    sender?: string;
    data?: InputGenerateTransactionPayloadData;
    options?: InputGenerateTransactionOptions;
    rawTransaction?: AnyRawTransaction;
};
declare function normalizeSignMessageOutput(output: CedraSignMessageOutput | NovaSignMessageResponse): CedraSignMessageOutput;
declare function getSdkNetwork(networkInfo: NetworkInfo | null, fullnodeUrl?: string): Cedra;
declare function submitSignedTransaction(args: {
    network: NetworkInfo | null;
    fullnodeUrl?: string;
    transaction: AnyRawTransaction;
    authenticator: AccountAuthenticator;
}): Promise<PendingTransactionResponse>;
declare function createFullMessage(input: CedraSignMessageInput, address: string, chainId?: number): string;

type NovaClientEvents = {
    accountChange: [AccountInfo];
    networkChange: [NetworkInfo];
};
declare class NovaClient extends EventEmitter<NovaClientEvents> {
    private readonly options;
    private provider?;
    private accountInfo;
    private networkInfo;
    constructor(options?: NovaWalletOptions);
    refreshProvider(): NovaProvider | undefined;
    hasProvider(): boolean;
    hasExternalSession(): boolean;
    get account(): AccountInfo | null;
    get cachedNetwork(): NetworkInfo | null;
    private connectResultFromExternalSession;
    connect(): Promise<{
        account: AccountInfo;
        network: NetworkInfo | null;
    }>;
    getAccount(): Promise<AccountInfo>;
    disconnect(): Promise<void>;
    getNetwork(): Promise<NetworkInfo>;
    signMessage(input: CedraSignMessageInput): Promise<CedraSignMessageOutput>;
    signMessageAndVerify(input: CedraSignMessageInput): Promise<boolean>;
    signTransaction(transaction: AnyRawTransaction | NovaTransactionPayload | CedraSignTransactionInputV1_1, options?: unknown): Promise<NovaSignTransactionResult>;
    signAndSubmitTransaction(transaction: AnyRawTransaction | NovaTransactionPayload | CedraSignAndSubmitTransactionInput, options?: unknown): Promise<CedraSignAndSubmitTransactionOutput>;
    signAndSubmitBCSTransaction(transaction: AnyRawTransaction | NovaTransactionPayload, options?: unknown): Promise<CedraSignAndSubmitTransactionOutput>;
    subscribe(): Promise<void>;
}

type NovaWalletEvents = {
    accountChange: [string];
    networkChange: [NovaNetworkInfo];
};
declare class NovaWallet extends EventEmitter<NovaWalletEvents> implements NovaWalletAdapterLike {
    private readonly options;
    readonly name: NovaWalletName<"Nova Wallet">;
    readonly url: string;
    readonly icon: `data:image/svg+xml;base64,${string}`;
    private readonly client;
    private cachedAccount;
    private cachedNetwork;
    private isConnecting;
    constructor(options?: NovaWalletOptions);
    get readyState(): NovaWalletReadyState;
    get connecting(): boolean;
    get connected(): boolean;
    get publicAccount(): NovaAccountKeys;
    get network(): NovaNetworkInfo;
    connect(): Promise<AccountInfo>;
    account(): Promise<AccountInfo>;
    disconnect(): Promise<void>;
    signAndSubmitTransaction(transaction: NovaTransactionPayload, options?: unknown): Promise<CedraSignAndSubmitTransactionOutput>;
    signAndSubmitBCSTransaction(transaction: NovaTransactionPayload, options?: unknown): Promise<CedraSignAndSubmitTransactionOutput>;
    signTransaction(transaction: AnyRawTransaction | NovaTransactionPayload, options?: unknown): Promise<Uint8Array | {
        authenticator: AccountAuthenticator;
        rawTransaction?: Uint8Array;
    }>;
    signMessage(message: CedraSignMessageInput): Promise<CedraSignMessageOutput | NovaSignMessageResponse>;
    onAccountChange(callback: (account: AccountInfo) => void): Promise<void>;
    onNetworkChange(callback: (network: NetworkInfo) => void): Promise<void>;
    deeplinkProvider(url?: string): string;
}

export { BridgeHttpError, CALLBACK_ADDRESS_PARAM, CALLBACK_BRIDGE_URL_PARAM, CALLBACK_CHAIN_ID_PARAM, CALLBACK_NETWORK_PARAM, CALLBACK_PROTOCOL_PUBLIC_KEY_PARAM, CALLBACK_PUBLIC_KEY_PARAM, CALLBACK_SESSION_ID_PARAM, CALLBACK_WALLET_NAME_PARAM, DEFAULT_BRIDGE_CONNECT_TIMEOUT_MS, DEFAULT_BRIDGE_POLL_INTERVAL_MS, DEFAULT_BRIDGE_POLL_TIMEOUT_MS, DEFAULT_DEEPLINK_BASE_URL, DEFAULT_DESKTOP_BRIDGE_URL, DEFAULT_DESKTOP_LOGIN_URL, DEFAULT_DESKTOP_REGISTRATION, DEFAULT_DETECT_ALIASES, DEFAULT_REGISTER_FORCE, DEFAULT_WEBSITE_URL, NOVA_DESK_NAME, NOVA_EXTERNAL_SESSION_STORAGE_KEY, NOVA_PROTOCOL_KEY_STORAGE_KEY, NOVA_WALLET_ICON, NOVA_WALLET_NAME, NovaAccountKeys, NovaAdapterError, NovaClient, NovaErrorCode, NovaExternalSession, NovaNetworkInfo, NovaProvider, NovaProviderAccount, NovaSignMessageResponse, NovaSignTransactionResult, NovaTransactionPayload, NovaWallet, NovaWalletAdapterLike, NovaWalletName, NovaWalletOptions, NovaWalletReadyState, bridgeBaseUrl, buildCallbackUrl, buildDeeplinkUrl, buildDesktopOrMobileConnectUrl, clearExternalSession, createFullMessage, currentUrlWithoutCallbackKey, detectProvider, fetchJsonWithTimeout, getSdkNetwork, hasStoredExternalSession, isBrowser, isMobileBrowser, launchDesktopOrMobileConnect, normalizeNetwork, normalizeProviderAccount, normalizeSignMessageOutput, normalizeTransactionPayload, readExternalSession, remapNovaError, sessionToAccountInfo, storeCallbackSession, storeExternalSession, submitSignedTransaction, toUint8Array, tryLocalBridgeConnect, tryLocalBridgeSignAndSubmit, tryLocalBridgeSignMessage, tryLocalBridgeSignTransaction, waitForExternalSession };
