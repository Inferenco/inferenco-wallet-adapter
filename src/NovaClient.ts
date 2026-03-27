import EventEmitter from "eventemitter3";
import type {
  AccountAuthenticator,
  AnyRawTransaction,
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
  NetworkInfo
} from "@cedra-labs/wallet-standard";
import {
  buildDesktopOrMobileConnectUrl,
  clearExternalSession,
  readExternalSession,
  sessionToAccountInfo,
  storeCallbackSession,
  tryLocalBridgeConnect,
  tryLocalBridgeSignAndSubmit,
  tryLocalBridgeSignMessage,
  tryLocalBridgeSignTransaction
} from "./bridge";
import { createFullMessage, normalizeNetwork, normalizeProviderAccount, normalizeSignMessageOutput, normalizeTransactionPayload, submitSignedTransaction } from "./conversion";
import { NovaAdapterError, NovaErrorCode, remapNovaError } from "./errors";
import { buildDeeplinkUrl } from "./deeplink";
import { detectProvider } from "./provider";
import type {
  LegacySignMessageResponse,
  LegacyTransactionPayload,
  NovaProvider,
  NovaSignTransactionResult,
  NovaWalletOptions
} from "./types";

type NovaClientEvents = {
  accountChange: [AccountInfo];
  networkChange: [NetworkInfo];
};

function unwrap<T>(value: T | { data?: T; args?: T; result?: T }): T {
  if (value && typeof value === "object") {
    if ("data" in value && value.data !== undefined) return value.data;
    if ("args" in value && value.args !== undefined) return value.args;
    if ("result" in value && value.result !== undefined) return value.result;
  }
  return value as T;
}

export class NovaClient extends EventEmitter<NovaClientEvents> {
  private provider?: NovaProvider;
  private accountInfo: AccountInfo | null = null;
  private networkInfo: NetworkInfo | null = null;

  constructor(private readonly options: NovaWalletOptions = {}) {
    super();
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

      const externalSession = readExternalSession();
      if (externalSession) {
        this.accountInfo = sessionToAccountInfo(externalSession);
        this.networkInfo = normalizeNetwork({
          name: externalSession.network as Network,
          chainId: externalSession.chainId
        });
        return { account: this.accountInfo, network: this.networkInfo };
      }

      const bridgedAccount = await tryLocalBridgeConnect(this.options);
      if (bridgedAccount) {
        this.accountInfo = bridgedAccount;
        const bridgedSession = readExternalSession();
        this.networkInfo = bridgedSession
          ? normalizeNetwork({
              name: bridgedSession.network as Network,
              chainId: bridgedSession.chainId
            })
          : null;
        return { account: bridgedAccount, network: this.networkInfo };
      }

      if (typeof window !== "undefined") {
        window.location.href = buildDesktopOrMobileConnectUrl(this.options);
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

      const externalSession = readExternalSession();
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
    try {
      const provider = this.refreshProvider();
      await provider?.disconnect?.();
      clearExternalSession();
      this.accountInfo = null;
      this.networkInfo = null;
    } catch (error) {
      remapNovaError(error);
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

      const externalSession = readExternalSession();
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
        const result = unwrap(await provider.signMessage(input)) as CedraSignMessageOutput | LegacySignMessageResponse;
        return normalizeSignMessageOutput(result);
      }

      const externalSession = readExternalSession();
      if (externalSession) {
        return tryLocalBridgeSignMessage(input, externalSession, this.options);
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
    transaction: AnyRawTransaction | LegacyTransactionPayload | CedraSignTransactionInputV1_1,
    options?: unknown
  ): Promise<NovaSignTransactionResult> {
    try {
      const provider = this.refreshProvider();
      if (provider?.signTransaction) {
        return unwrap(
          await provider.signTransaction(transaction as AnyRawTransaction | LegacyTransactionPayload, options)
        );
      }

      const externalSession = readExternalSession();
      if (externalSession) {
        if (
          !transaction ||
          typeof transaction !== "object" ||
          !("payload" in transaction) ||
          "rawTransaction" in transaction ||
          "data" in transaction
        ) {
          throw new NovaAdapterError(
            NovaErrorCode.Unsupported,
            "Nova Desk browser signTransaction requires a wallet-standard v1.1 payload"
          );
        }
        return tryLocalBridgeSignTransaction(
          transaction as CedraSignTransactionInputV1_1,
          externalSession,
          this.options
        );
      }

      throw new NovaAdapterError(NovaErrorCode.Unsupported, "Nova provider signTransaction() unavailable");
    } catch (error) {
      remapNovaError(error);
    }
  }

  async signAndSubmitTransaction(
    transaction: AnyRawTransaction | LegacyTransactionPayload | CedraSignAndSubmitTransactionInput,
    options?: unknown
  ): Promise<CedraSignAndSubmitTransactionOutput> {
    try {
      const provider = this.refreshProvider();
      if (provider?.signAndSubmitTransaction) {
        return unwrap(
          await provider.signAndSubmitTransaction(
            transaction as AnyRawTransaction | LegacyTransactionPayload,
            options
          )
        );
      }

      const externalSession = readExternalSession();
      if (externalSession) {
        return tryLocalBridgeSignAndSubmit(
          transaction as CedraSignAndSubmitTransactionInput,
          externalSession,
          this.options
        );
      }

      if (
        transaction &&
        typeof transaction === "object" &&
        "payload" in transaction &&
        !("rawTransaction" in transaction) &&
        !("data" in transaction)
      ) {
        throw new NovaAdapterError(
          NovaErrorCode.Unsupported,
          "Nova provider fallback submit requires a raw transaction-compatible payload"
        );
      }

      const normalized = normalizeTransactionPayload(transaction as AnyRawTransaction | LegacyTransactionPayload);
      if (!normalized.rawTransaction) {
        throw new NovaAdapterError(
          NovaErrorCode.Unsupported,
          "Nova provider cannot fall back submit without a raw transaction"
        );
      }

      const signed = await this.signTransaction(normalized.rawTransaction, options);
      if (!signed || typeof signed !== "object" || !("authenticator" in signed)) {
        throw new NovaAdapterError(
          NovaErrorCode.Unsupported,
          "Nova provider signTransaction() fallback did not return an authenticator"
        );
      }

      const submitted = await submitSignedTransaction({
        network: await this.getNetwork().catch(() => null),
        fullnodeUrl: this.options.fullnodeUrl,
        transaction: normalized.rawTransaction,
        authenticator: signed.authenticator as AccountAuthenticator
      });

      return { hash: submitted.hash };
    } catch (error) {
      remapNovaError(error);
    }
  }

  async signAndSubmitBCSTransaction(
    transaction: AnyRawTransaction | LegacyTransactionPayload,
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

  async submitTransaction(input: {
    transaction: AnyRawTransaction;
    authenticator: AccountAuthenticator;
  }): Promise<PendingTransactionResponse> {
    return submitSignedTransaction({
      network: await this.getNetwork().catch(() => null),
      fullnodeUrl: this.options.fullnodeUrl,
      transaction: input.transaction,
      authenticator: input.authenticator
    });
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
