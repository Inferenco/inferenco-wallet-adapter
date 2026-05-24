import EventEmitter from "eventemitter3";
import type {
  AnyRawTransaction,
  Network,
} from "@cedra-labs/ts-sdk";
import type {
  AccountInfo,
  CedraSignAndSubmitTransactionInput,
  CedraSignAndSubmitTransactionOutput,
  CedraSignMessageInput,
  CedraSignMessageOutput,
  CedraSignTransactionInputV1_1,
  NetworkInfo
} from "@cedra-labs/wallet-standard";
import {
  clearPendingMobilePairing,
  clearExternalSession,
  installExternalSessionResumeListeners,
  isMobileBrowser,
  launchDesktopOrMobileConnect,
  readExternalSession,
  readValidatedExternalSession,
  revokeExternalSession,
  sessionToAccountInfo,
  storeCallbackSession,
  tryLocalBridgeConnect,
  tryLocalBridgeSignAndSubmit,
  tryLocalBridgeSignMessage,
  tryLocalBridgeSignTransaction,
  waitForExternalSession
} from "./bridge";
import { createFullMessage, normalizeNetwork, normalizeProviderAccount, normalizeSignMessageOutput } from "./conversion";
import { NovaAdapterError, NovaErrorCode, remapNovaError } from "./errors";
import { buildDeeplinkUrl } from "./deeplink";
import {
  connectViaMobileRelay,
  resumeMobileRelaySessionFromCallback,
  signAndSubmitViaMobileRelay,
  signMessageViaMobileRelay,
  signTransactionViaMobileRelay
} from "./mobileRelay";
import { detectProvider } from "./provider";
import type {
  NovaExternalAccountInput,
  NovaExternalSignTransactionInput,
  NovaSignMessageResponse,
  NovaExternalSession,
  NovaProvider,
  NovaRawTransactionSignInput,
  NovaSignTransactionResult,
  NovaTransactionPayload,
  NovaWalletOptions
} from "./types";

type NovaClientEvents = {
  accountChange: [AccountInfo];
  networkChange: [NetworkInfo];
};

function isWalletStandardSignTransactionInput(
  transaction: unknown
): transaction is CedraSignTransactionInputV1_1 {
  return (
    !!transaction &&
    typeof transaction === "object" &&
    "payload" in transaction &&
    !("rawTransaction" in transaction) &&
    !("data" in transaction)
  );
}

function isSdkRawTransaction(transaction: unknown): transaction is AnyRawTransaction {
  return (
    !!transaction &&
    typeof transaction === "object" &&
    "rawTransaction" in transaction &&
    typeof (transaction as { toString?: unknown }).toString === "function"
  );
}

function addressToString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "address" in value) {
    return addressToString((value as { address?: unknown }).address);
  }
  if (
    typeof value === "object" &&
    "toString" in value &&
    typeof (value as { toString?: unknown }).toString === "function"
  ) {
    const text = (value as { toString: () => string }).toString();
    return text && text !== "[object Object]" ? text : undefined;
  }
  return undefined;
}

function publicKeyToString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    "toString" in value &&
    typeof (value as { toString?: unknown }).toString === "function"
  ) {
    const text = (value as { toString: () => string }).toString();
    return text && text !== "[object Object]" ? text : undefined;
  }
  return undefined;
}

function normalizeExternalAccountInput(input: unknown): NovaExternalAccountInput | undefined {
  const address = addressToString(input);
  if (!address) return undefined;

  const publicKey =
    input && typeof input === "object" && "publicKey" in input
      ? publicKeyToString((input as { publicKey?: unknown }).publicKey)
      : undefined;

  return publicKey ? { address, publicKey } : { address };
}

function toJsonCompatibleValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(toJsonCompatibleValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        toJsonCompatibleValue(item)
      ])
    );
  }
  return value;
}

function normalizeWalletStandardSignTransactionInput(
  transaction: CedraSignTransactionInputV1_1,
  options?: unknown
): NovaExternalSignTransactionInput {
  const input: Record<string, unknown> = { ...transaction };
  const sender = normalizeExternalAccountInput(transaction.sender);
  const signerAddress = addressToString(transaction.signerAddress);
  const feePayer = normalizeExternalAccountInput(transaction.feePayer);
  const secondarySigners = transaction.secondarySigners
    ?.map(normalizeExternalAccountInput)
    .filter((account): account is NovaExternalAccountInput => !!account);

  if (sender) input.sender = sender.address;
  if (signerAddress) input.signerAddress = signerAddress;
  if (feePayer) {
    input.feePayer = feePayer;
    input.feePayerAddress = feePayer.address;
  }
  if (secondarySigners?.length) {
    input.secondarySigners = secondarySigners;
    input.secondarySignerAddresses = secondarySigners.map((account) => account.address);
  }
  if (options !== undefined) input.options = options;

  return toJsonCompatibleValue(input) as NovaExternalSignTransactionInput;
}

function normalizeSdkRawTransactionInput(
  transaction: AnyRawTransaction,
  options?: unknown
): NovaRawTransactionSignInput {
  const rawTransactionBcsHex = transaction.toString();
  const input: NovaRawTransactionSignInput = {
    rawTransactionBcsHex,
    bcsHex: rawTransactionBcsHex
  };
  const rawTransaction = (transaction as { rawTransaction?: { sender?: unknown } }).rawTransaction;
  const sender = addressToString(rawTransaction?.sender);
  const secondarySignerAddresses = (transaction as { secondarySignerAddresses?: unknown[] })
    .secondarySignerAddresses
    ?.map(addressToString)
    .filter((address): address is string => !!address);
  const feePayerAddress = addressToString(
    (transaction as { feePayerAddress?: unknown }).feePayerAddress
  );

  if (sender) input.sender = sender;
  if (secondarySignerAddresses?.length) input.secondarySignerAddresses = secondarySignerAddresses;
  if (feePayerAddress) input.feePayerAddress = feePayerAddress;
  if (options !== undefined) input.options = options;

  return input;
}

function toExternalSignTransactionInput(
  transaction: AnyRawTransaction | NovaTransactionPayload | CedraSignTransactionInputV1_1,
  options?: unknown
): NovaExternalSignTransactionInput {
  if (isWalletStandardSignTransactionInput(transaction)) {
    return normalizeWalletStandardSignTransactionInput(transaction, options);
  }

  if (isSdkRawTransaction(transaction)) {
    return normalizeSdkRawTransactionInput(transaction, options);
  }

  throw new NovaAdapterError(
    NovaErrorCode.Unsupported,
    "Nova external signTransaction requires a wallet-standard v1.1 payload or prebuilt SDK transaction"
  );
}

function unwrap<T>(value: T | { data?: T; args?: T; result?: T }): T {
  if (value && typeof value === "object") {
    if ("data" in value && value.data !== undefined) return value.data;
    if ("args" in value && value.args !== undefined) return value.args;
    if ("result" in value && value.result !== undefined) return value.result;
  }
  return value as T;
}

const DESKTOP_BRIDGE_RETRY_WINDOW_MS = 8_000;
const DESKTOP_BRIDGE_RETRY_DELAY_MS = 250;
const DESKTOP_BRIDGE_RETRY_CONNECT_TIMEOUT_MS = 1_000;

async function retryLocalBridgeConnectAfterDeeplink(
  options: NovaWalletOptions
): Promise<AccountInfo | null> {
  const deadline = Date.now() + DESKTOP_BRIDGE_RETRY_WINDOW_MS;

  while (Date.now() < deadline) {
    const account = await tryLocalBridgeConnect({
      ...options,
      bridgeConnectTimeoutMs: DESKTOP_BRIDGE_RETRY_CONNECT_TIMEOUT_MS
    });
    if (account) {
      return account;
    }

    await new Promise((resolve) => window.setTimeout(resolve, DESKTOP_BRIDGE_RETRY_DELAY_MS));
  }

  return null;
}

export class NovaClient extends EventEmitter<NovaClientEvents> {
  private provider?: NovaProvider;
  private accountInfo: AccountInfo | null = null;
  private networkInfo: NetworkInfo | null = null;

  constructor(private readonly options: NovaWalletOptions = {}) {
    super();
    installExternalSessionResumeListeners();
    storeCallbackSession();
    this.provider = detectProvider(options);
  }

  refreshProvider(): NovaProvider | undefined {
    this.provider = detectProvider(this.options);
    return this.provider;
  }

  hasProvider(): boolean {
    return !!this.refreshProvider();
  }

  hasExternalSession(): boolean {
    return !!readExternalSession();
  }

  get account(): AccountInfo | null {
    return this.accountInfo;
  }

  get cachedNetwork(): NetworkInfo | null {
    return this.networkInfo;
  }

  private connectResultFromExternalSession(
    externalSession: NovaExternalSession
  ): { account: AccountInfo; network: NetworkInfo } {
    const account = sessionToAccountInfo(externalSession);
    const network = normalizeNetwork({
      name: externalSession.network as Network,
      chainId: externalSession.chainId
    });

    this.accountInfo = account;
    this.networkInfo = network;

    return { account, network };
  }

  async connect(): Promise<{ account: AccountInfo; network: NetworkInfo | null }> {
    try {
      const provider = this.refreshProvider();
      if (provider?.connect) {
        const account = normalizeProviderAccount(unwrap(await provider.connect()));
        this.accountInfo = account;

        if (provider.network) {
          this.networkInfo = normalizeNetwork(unwrap(await provider.network()));
        }

        return { account, network: this.networkInfo };
      }

      const resumedMobileSession = await resumeMobileRelaySessionFromCallback(this.options);
      if (resumedMobileSession) {
        return this.connectResultFromExternalSession(resumedMobileSession);
      }

      const externalSession = await readValidatedExternalSession(this.options);
      if (externalSession) {
        return this.connectResultFromExternalSession(externalSession);
      }

      if (typeof window !== "undefined" && isMobileBrowser()) {
        const mobileSession = await connectViaMobileRelay(this.options);
        return this.connectResultFromExternalSession(mobileSession);
      }

      const bridgedAccount = await tryLocalBridgeConnect(this.options);
      if (bridgedAccount) {
        this.accountInfo = bridgedAccount;
        const bridgedSession = await readValidatedExternalSession(this.options);
        this.networkInfo = bridgedSession
          ? normalizeNetwork({
              name: bridgedSession.network as Network,
              chainId: bridgedSession.chainId
            })
          : null;
        return { account: bridgedAccount, network: this.networkInfo };
      }

      if (typeof window !== "undefined") {
        launchDesktopOrMobileConnect(this.options);

        const retriedAccount = await retryLocalBridgeConnectAfterDeeplink(this.options);
        if (retriedAccount) {
          this.accountInfo = retriedAccount;
          const retriedSession = await readValidatedExternalSession(this.options);
          this.networkInfo = retriedSession
            ? normalizeNetwork({
                name: retriedSession.network as Network,
                chainId: retriedSession.chainId
              })
            : null;
          return { account: retriedAccount, network: this.networkInfo };
        }

        const handoffSession = await waitForExternalSession(this.options);
        if (handoffSession) {
          return this.connectResultFromExternalSession(handoffSession);
        }

        throw new NovaAdapterError(
          NovaErrorCode.ConnectionTimeout,
          "Timed out waiting for Nova Desk to complete the external connection handoff."
        );
      }

      throw new NovaAdapterError(
        NovaErrorCode.NotInstalled,
        `Nova provider not found. Open ${buildDeeplinkUrl(this.options)}`
      );
    } catch (error) {
      remapNovaError(error);
    }
  }

  async getAccount(): Promise<AccountInfo> {
    if (this.accountInfo) return this.accountInfo;

    try {
      const provider = this.refreshProvider();
      if (provider?.account) {
        const account = normalizeProviderAccount(unwrap(await provider.account()));
        this.accountInfo = account;
        return account;
      }

      const externalSession = await readValidatedExternalSession(this.options);
      if (externalSession) {
        const account = sessionToAccountInfo(externalSession);
        this.accountInfo = account;
        return account;
      }

      throw new NovaAdapterError(NovaErrorCode.NotInstalled, "Nova provider account() unavailable");
    } catch (error) {
      remapNovaError(error);
    }
  }

  async disconnect(): Promise<void> {
    const provider = this.refreshProvider();
    const externalSession = readExternalSession();
    try {
      await provider?.disconnect?.();
      if (externalSession) {
        await revokeExternalSession(externalSession, this.options);
      }
    } catch (error) {
      remapNovaError(error);
    } finally {
      clearExternalSession();
      clearPendingMobilePairing();
      this.accountInfo = null;
      this.networkInfo = null;
    }
  }

  async getNetwork(): Promise<NetworkInfo> {
    if (this.networkInfo) return this.networkInfo;

    try {
      const provider = this.refreshProvider();
      if (provider?.network) {
        const network = normalizeNetwork(unwrap(await provider.network()));
        this.networkInfo = network;
        return network;
      }

      const externalSession = await readValidatedExternalSession(this.options);
      if (externalSession) {
        const network = normalizeNetwork({
          name: externalSession.network as Network,
          chainId: externalSession.chainId
        });
        this.networkInfo = network;
        return network;
      }

      throw new NovaAdapterError(NovaErrorCode.NotInstalled, "Nova provider network() unavailable");
    } catch (error) {
      remapNovaError(error);
    }
  }

  async signMessage(input: CedraSignMessageInput): Promise<CedraSignMessageOutput> {
    try {
      const provider = this.refreshProvider();
      if (provider?.signMessage) {
        const result = unwrap(await provider.signMessage(input)) as CedraSignMessageOutput | NovaSignMessageResponse;
        return normalizeSignMessageOutput(result);
      }

      const externalSession = await readValidatedExternalSession(this.options);
      if (externalSession) {
        return externalSession.transport === "mobile-relay"
          ? signMessageViaMobileRelay(input, externalSession, this.options)
          : tryLocalBridgeSignMessage(input, externalSession, this.options);
      }

      throw new NovaAdapterError(NovaErrorCode.Unsupported, "Nova provider signMessage() unavailable");
    } catch (error) {
      remapNovaError(error);
    }
  }

  async signMessageAndVerify(input: CedraSignMessageInput): Promise<boolean> {
    const account = await this.getAccount();
    const output = await this.signMessage(input);
    const publicKey = account.publicKey as unknown as {
      verifySignature?: (args: { message: Uint8Array; signature: unknown }) => boolean;
      verifySignatureAsync?: (args: { message: Uint8Array; signature: unknown }) => Promise<boolean>;
    };
    const message = new TextEncoder().encode(output.fullMessage || createFullMessage(input, account.address.toString()));

    if (publicKey.verifySignature) {
      return publicKey.verifySignature({ message, signature: output.signature });
    }

    if (publicKey.verifySignatureAsync) {
      return publicKey.verifySignatureAsync({ message, signature: output.signature });
    }

    return false;
  }

  async signTransaction(
    transaction: AnyRawTransaction | NovaTransactionPayload | CedraSignTransactionInputV1_1,
    options?: unknown
  ): Promise<NovaSignTransactionResult> {
    try {
      const provider = this.refreshProvider();
      if (provider?.signTransaction) {
        return unwrap(
          await provider.signTransaction(
            transaction as AnyRawTransaction | NovaTransactionPayload | CedraSignTransactionInputV1_1,
            options
          )
        );
      }

      const externalSession = await readValidatedExternalSession(this.options);
      if (externalSession) {
        const externalInput = toExternalSignTransactionInput(transaction, options);
        return externalSession.transport === "mobile-relay"
          ? signTransactionViaMobileRelay(externalInput, externalSession, this.options)
          : tryLocalBridgeSignTransaction(externalInput, externalSession, this.options);
      }

      throw new NovaAdapterError(NovaErrorCode.Unsupported, "Nova provider signTransaction() unavailable");
    } catch (error) {
      remapNovaError(error);
    }
  }

  async signAndSubmitTransaction(
    transaction: AnyRawTransaction | NovaTransactionPayload | CedraSignAndSubmitTransactionInput,
    options?: unknown
  ): Promise<CedraSignAndSubmitTransactionOutput> {
    try {
      const provider = this.refreshProvider();
      if (provider?.signAndSubmitTransaction) {
        return unwrap(
          await provider.signAndSubmitTransaction(
            transaction as AnyRawTransaction | NovaTransactionPayload,
            options
          )
        );
      }

      const externalSession = await readValidatedExternalSession(this.options);
      if (externalSession) {
        return externalSession.transport === "mobile-relay"
          ? signAndSubmitViaMobileRelay(
              transaction as CedraSignAndSubmitTransactionInput,
              externalSession,
              this.options
            )
          : tryLocalBridgeSignAndSubmit(
              transaction as CedraSignAndSubmitTransactionInput,
              externalSession,
              this.options
            );
      }

      throw new NovaAdapterError(
        NovaErrorCode.Unsupported,
        "Nova provider signAndSubmitTransaction() unavailable"
      );
    } catch (error) {
      remapNovaError(error);
    }
  }

  async signAndSubmitBCSTransaction(
    transaction: AnyRawTransaction | NovaTransactionPayload,
    options?: unknown
  ): Promise<CedraSignAndSubmitTransactionOutput> {
    try {
      return await this.signAndSubmitTransaction(transaction, options);
    } catch (error) {
      if (options !== undefined) {
        return this.signAndSubmitTransaction(transaction);
      }
      remapNovaError(error);
    }
  }

  async subscribe(): Promise<void> {
    const provider = this.refreshProvider();

    if (provider?.onAccountChange) {
      await provider.onAccountChange((account) => {
        this.accountInfo = normalizeProviderAccount(account);
        this.emit("accountChange", this.accountInfo);
      });
    }

    if (provider?.onNetworkChange) {
      await provider.onNetworkChange((network) => {
        this.networkInfo = normalizeNetwork(network);
        this.emit("networkChange", this.networkInfo);
      });
    }
  }
}
