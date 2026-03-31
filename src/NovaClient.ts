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
  clearExternalSession,
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
import { detectProvider } from "./provider";
import type {
  NovaSignMessageResponse,
  NovaExternalSession,
  NovaProvider,
  NovaSignTransactionResult,
  NovaTransactionPayload,
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

      const externalSession = await readValidatedExternalSession(this.options);
      if (externalSession) {
        return this.connectResultFromExternalSession(externalSession);
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
    try {
      const provider = this.refreshProvider();
      const externalSession = readExternalSession();
      await provider?.disconnect?.();
      if (externalSession) {
        await revokeExternalSession(externalSession, this.options);
      }
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
    transaction: AnyRawTransaction | NovaTransactionPayload | CedraSignTransactionInputV1_1,
    options?: unknown
  ): Promise<NovaSignTransactionResult> {
    try {
      const provider = this.refreshProvider();
      if (provider?.signTransaction) {
        return unwrap(
          await provider.signTransaction(transaction as AnyRawTransaction | NovaTransactionPayload, options)
        );
      }

      const externalSession = await readValidatedExternalSession(this.options);
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
        return tryLocalBridgeSignAndSubmit(
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
