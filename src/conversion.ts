import {
  AccountAddress,
  AnyPublicKey,
  Cedra,
  CedraConfig,
  Ed25519PublicKey,
  Network
} from "@cedra-labs/ts-sdk";
import type {
  AccountAuthenticator,
  AnyRawTransaction,
  InputGenerateTransactionOptions,
  InputGenerateTransactionPayloadData,
  PendingTransactionResponse
} from "@cedra-labs/ts-sdk";
import type {
  CedraSignMessageInput,
  CedraSignMessageOutput,
  NetworkInfo
} from "@cedra-labs/wallet-standard";
import { AccountInfo } from "@cedra-labs/wallet-standard";
import type {
  LegacySignMessageResponse,
  LegacyTransactionPayload,
  NovaProviderAccount
} from "./types";
import { NovaAdapterError, NovaErrorCode } from "./errors";

export function toUint8Array(input: string | Uint8Array): Uint8Array {
  if (input instanceof Uint8Array) return input;
  const hex = input.startsWith("0x") ? input.slice(2) : input;
  return new Uint8Array(hex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) ?? []);
}

export function normalizeProviderAccount(account: NovaProviderAccount): AccountInfo {
  const publicKey = account.publicKey instanceof Uint8Array ? account.publicKey : toUint8Array(account.publicKey);
  return new AccountInfo({
    address: AccountAddress.from(account.address),
    publicKey: new AnyPublicKey(new Ed25519PublicKey(publicKey))
  });
}

export function normalizeNetwork(network: string | number | NetworkInfo): NetworkInfo {
  if (typeof network === "object") {
    return {
      chainId: network.chainId ?? 3,
      name: network.name ?? Network.DEVNET,
      url: network.url
    };
  }

  const rawName =
    typeof network === "number"
      ? ({ 1: "mainnet", 2: "testnet", 3: "devnet", 4: "local" }[network] ?? undefined)
      : network;

  if (!rawName) {
    throw new NovaAdapterError(NovaErrorCode.InvalidNetwork, `Unsupported network value: ${String(network)}`);
  }

  const name =
    rawName === "mainnet"
      ? Network.MAINNET
      : rawName === "testnet"
        ? Network.TESTNET
        : rawName === "local"
          ? Network.LOCAL
          : Network.DEVNET;

  const chainId =
    typeof network === "number"
      ? network
      : ({ mainnet: 1, testnet: 2, devnet: 3, local: 4 } as Record<string, number | undefined>)[rawName] ?? 3;

  return {
    name,
    chainId
  };
}

export function normalizeTransactionPayload(
  transaction: AnyRawTransaction | LegacyTransactionPayload
): {
  sender?: string;
  data?: InputGenerateTransactionPayloadData;
  options?: InputGenerateTransactionOptions;
  rawTransaction?: AnyRawTransaction;
} {
  if ("rawTransaction" in transaction) {
    return {
      rawTransaction: transaction
    };
  }

  if ("data" in transaction) {
    return {
      sender: transaction.sender ? AccountAddress.from(transaction.sender).toString() : undefined,
      data: transaction.data,
      options: transaction.options
    };
  }

  return {
    data: transaction
  };
}

export function normalizeSignMessageOutput(
  output: CedraSignMessageOutput | LegacySignMessageResponse
): CedraSignMessageOutput {
  return {
    address: output.address,
    application: "application" in output ? output.application : undefined,
    chainId: "chainId" in output ? output.chainId : undefined,
    fullMessage: output.fullMessage,
    message: output.message,
    nonce: output.nonce,
    prefix: (output.prefix ?? "CEDRA") as "CEDRA",
    signature: output.signature as CedraSignMessageOutput["signature"]
  };
}

export function getSdkNetwork(networkInfo: NetworkInfo | null, fullnodeUrl?: string): Cedra {
  if (fullnodeUrl) {
    return new Cedra(new CedraConfig({ network: Network.CUSTOM, fullnode: fullnodeUrl }));
  }

  const name = networkInfo?.name;
  const sdkNetwork =
    name === "mainnet"
      ? Network.MAINNET
      : name === "testnet"
        ? Network.TESTNET
        : name === "local"
          ? Network.LOCAL
          : Network.DEVNET;

  return new Cedra(new CedraConfig({ network: sdkNetwork }));
}

export async function submitSignedTransaction(args: {
  network: NetworkInfo | null;
  fullnodeUrl?: string;
  transaction: AnyRawTransaction;
  authenticator: AccountAuthenticator;
}): Promise<PendingTransactionResponse> {
  const cedra = getSdkNetwork(args.network, args.fullnodeUrl);
  return cedra.transaction.submit.simple({
    transaction: args.transaction,
    senderAuthenticator: args.authenticator
  });
}

export function createFullMessage(input: CedraSignMessageInput, address: string, chainId?: number): string {
  return [
    "CEDRA",
    input.application ?? "",
    address,
    input.nonce,
    input.chainId ?? chainId ?? "",
    input.message
  ].join("\n");
}
