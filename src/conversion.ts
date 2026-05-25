import {
  AccountAddress,
  AccountAuthenticator,
  AnyPublicKey,
  Cedra,
  CedraConfig,
  Deserializer,
  Ed25519PublicKey,
  Hex,
  MultiAgentTransaction,
  Network,
  RawTransaction,
  SimpleTransaction
} from "@cedra-labs/ts-sdk";
import type {
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
  NovaSignMessageResponse,
  NovaSignTransactionResult,
  NovaTransactionPayload,
  NovaProviderAccount
} from "./types";
import { NovaAdapterError, NovaErrorCode } from "./errors";

export function toUint8Array(input: string | Uint8Array): Uint8Array {
  if (input instanceof Uint8Array) return input;
  const hex = input.startsWith("0x") ? input.slice(2) : input;
  return new Uint8Array(hex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) ?? []);
}

function tryDeserializeFinished<T>(
  hex: string,
  deserialize: (deserializer: Deserializer) => T
): T | null {
  return tryDeserializeBytesFinished(toUint8Array(hex), deserialize);
}

function tryDeserializeBytesFinished<T>(
  bytes: Uint8Array,
  deserialize: (deserializer: Deserializer) => T
): T | null {
  try {
    const deserializer = new Deserializer(bytes);
    const value = deserialize(deserializer);
    deserializer.assertFinished();
    return value;
  } catch {
    return null;
  }
}

export function deserializeAnyRawTransaction(hex: string): AnyRawTransaction {
  const multiAgentTransaction = tryDeserializeFinished(hex, (deserializer) =>
    MultiAgentTransaction.deserialize(deserializer)
  );
  if (multiAgentTransaction) return multiAgentTransaction;

  const simpleTransaction = tryDeserializeFinished(hex, (deserializer) =>
    SimpleTransaction.deserialize(deserializer)
  );
  if (simpleTransaction) return simpleTransaction;

  const rawTransaction = tryDeserializeFinished(hex, (deserializer) =>
    RawTransaction.deserialize(deserializer)
  );
  if (rawTransaction) return new SimpleTransaction(rawTransaction);

  throw new Error("Unable to deserialize signed raw transaction payload");
}

export function ensureBcsToHex<T extends { toString: () => string }>(
  value: T
): T & { bcsToHex: () => Hex } {
  const target = value as T & { bcsToHex?: () => Hex };
  if (typeof target.bcsToHex !== "function") {
    Object.defineProperty(target, "bcsToHex", {
      configurable: true,
      value: () => Hex.fromHexInput(value.toString())
    });
  }
  return target as T & { bcsToHex: () => Hex };
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || !(key in value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function normalizeAuthenticator(value: unknown, hex?: string): AccountAuthenticator | undefined {
  const nestedHex = stringField(value, "hex");
  if (hex || nestedHex) {
    return ensureBcsToHex(AccountAuthenticator.deserialize(Deserializer.fromHex(hex ?? nestedHex!)));
  }
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { toString?: unknown }).toString === "function"
  ) {
    const text = (value as { toString: () => string }).toString();
    if (text && text !== "[object Object]") {
      return ensureBcsToHex(value as AccountAuthenticator);
    }
  }
  return undefined;
}

function normalizeRawTransaction(value: unknown, hex?: string): AnyRawTransaction | Uint8Array | undefined {
  if (hex) return deserializeAnyRawTransaction(hex);
  if (value instanceof Uint8Array) return value;
  if (value && typeof value === "object") return value as AnyRawTransaction;
  return undefined;
}

export function normalizeSignTransactionResult(result: unknown): NovaSignTransactionResult {
  if (result instanceof Uint8Array || !result || typeof result !== "object") {
    return result as NovaSignTransactionResult;
  }

  const authenticatorHex =
    stringField(result, "authenticatorHex") ?? stringField(result, "authenticator_hex");
  const rawTransactionBcsHex =
    stringField(result, "rawTransactionBcsHex") ?? stringField(result, "raw_transaction_bcs_hex");
  const hasAuthenticatorField = "authenticator" in result;
  const hasRawTransactionField = "rawTransaction" in result;
  const authenticator = normalizeAuthenticator(
    hasAuthenticatorField ? (result as { authenticator?: unknown }).authenticator : result,
    authenticatorHex
  );

  if (!authenticator) return result as NovaSignTransactionResult;

  const rawTransaction = normalizeRawTransaction(
    hasRawTransactionField ? (result as { rawTransaction?: unknown }).rawTransaction : undefined,
    rawTransactionBcsHex
  );
  if (rawTransaction) {
    return {
      ...(result as Record<string, unknown>),
      authenticator,
      rawTransaction
    } as NovaSignTransactionResult;
  }

  if (hasAuthenticatorField) {
    return {
      ...(result as Record<string, unknown>),
      authenticator
    } as NovaSignTransactionResult;
  }

  return authenticator;
}

function normalizeProviderPublicKey(publicKey: string | Uint8Array): Ed25519PublicKey | AnyPublicKey {
  const bytes = publicKey instanceof Uint8Array ? publicKey : toUint8Array(publicKey);
  if (bytes.length === Ed25519PublicKey.LENGTH) {
    return new Ed25519PublicKey(bytes);
  }

  const anyPublicKey = tryDeserializeBytesFinished(bytes, (deserializer) =>
    AnyPublicKey.deserialize(deserializer)
  );
  if (anyPublicKey?.publicKey instanceof Ed25519PublicKey) {
    return anyPublicKey.publicKey;
  }
  if (anyPublicKey) return anyPublicKey;

  return new Ed25519PublicKey(bytes);
}

export function normalizeProviderAccount(account: NovaProviderAccount): AccountInfo {
  return new AccountInfo({
    address: AccountAddress.from(account.address),
    publicKey: normalizeProviderPublicKey(account.publicKey)
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
  transaction: AnyRawTransaction | NovaTransactionPayload
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
  output: CedraSignMessageOutput | NovaSignMessageResponse
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
  feePayerAuthenticator?: AccountAuthenticator;
  additionalSignersAuthenticators?: AccountAuthenticator[];
}): Promise<PendingTransactionResponse> {
  const cedra = getSdkNetwork(args.network, args.fullnodeUrl);
  if (args.transaction.secondarySignerAddresses?.length || args.additionalSignersAuthenticators) {
    if (!args.additionalSignersAuthenticators) {
      throw new Error("Missing additionalSignersAuthenticators for multi-agent transaction submission");
    }

    return cedra.transaction.submit.multiAgent({
      transaction: args.transaction,
      senderAuthenticator: args.authenticator,
      additionalSignersAuthenticators: args.additionalSignersAuthenticators,
      feePayerAuthenticator: args.feePayerAuthenticator
    });
  }

  return cedra.transaction.submit.simple({
    transaction: args.transaction,
    senderAuthenticator: args.authenticator,
    feePayerAuthenticator: args.feePayerAuthenticator
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
