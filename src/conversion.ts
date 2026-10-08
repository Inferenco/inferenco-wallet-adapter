import {
  canonicalAddress,
  MESSAGE_PROFILE,
  messagePreimage,
  validateMessageInput,
  type IntegrationScope
} from "./integrationContract";
import {
  AccountAddress,
  AccountAuthenticator,
  AnyPublicKey,
  Cedra,
  CedraConfig,
  Deserializer,
  Ed25519PublicKey,
  Ed25519Signature,
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
  InferSignMessageResponse,
  InferSignTransactionResult,
  InferTransactionPayload,
  InferProviderAccount
} from "./types";
import { InferAdapterError, InferErrorCode } from "./errors";

export function toUint8Array(input: string | Uint8Array): Uint8Array {
  if (input instanceof Uint8Array) return input;
  const hex = input.startsWith("0x") ? input.slice(2) : input;
  return new Uint8Array(hex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) ?? []);
}

function strictBcsBytes(hex: string): Uint8Array {
  if (typeof hex !== "string" || !/^(?:0x)?(?:[0-9a-fA-F]{2})+$/.test(hex)) {
    throw new InferAdapterError(InferErrorCode.InternalError, "Invalid transaction BCS hex");
  }
  return toUint8Array(hex);
}

export function deserializeAccountAuthenticator(hex: string): AccountAuthenticator {
  const result = tryDeserializeFinished(hex, (deserializer) => AccountAuthenticator.deserialize(deserializer));
  if (!result) {
    throw new InferAdapterError(InferErrorCode.InternalError, "Invalid or noncanonical authenticator BCS");
  }
  return ensureBcsToHex(result);
}

/** Hydrate the JSON signing boundary and bind a prebuilt request to the returned bytes. */
export function deserializeSignTransactionResult(result: unknown, expectedBcsHex?: string) {
  const fields = result && typeof result === "object" ? (result as Record<string, unknown>)
      : {};
  const authenticatorHex = stringField(result, "authenticatorHex") ??
    (fields.authenticator instanceof AccountAuthenticator ? fields.authenticator.toString() : undefined);
  const raw = fields.rawTransaction;
  const rawTransactionBcsHex = stringField(result, "rawTransactionBcsHex") ??
    (raw instanceof SimpleTransaction || raw instanceof MultiAgentTransaction || raw instanceof RawTransaction
      ? raw.toString() : undefined);
  if (!authenticatorHex || !rawTransactionBcsHex) {
    throw new InferAdapterError(InferErrorCode.InternalError, "Missing signed transaction BCS fields");
  }
  const authenticator = deserializeAccountAuthenticator(authenticatorHex);
  const rawTransaction = deserializeAnyRawTransaction(rawTransactionBcsHex);
  if (expectedBcsHex !== undefined) {
    const expected = strictBcsBytes(expectedBcsHex);
    const returned = strictBcsBytes(rawTransactionBcsHex);
    if (expected.length !== returned.length || expected.some((byte, i) => byte !== returned[i])) {
      throw new InferAdapterError(InferErrorCode.InternalError, "Wallet changed the prebuilt transaction");
    }
  }
  return { authenticator, rawTransaction, authenticatorHex, rawTransactionBcsHex };
}

function tryDeserializeFinished<T extends { bcsToBytes(): Uint8Array }>(
  hex: string,
  deserialize: (deserializer: Deserializer) => T
): T | null {
  const bytes = strictBcsBytes(hex);
  const value = tryDeserializeBytesFinished(bytes, deserialize);
  if (value) {
    const canonical = value.bcsToBytes();
    if (canonical.length !== bytes.length || canonical.some((byte, i) => byte !== bytes[i])) return null;
  }
  return value;
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

  throw new InferAdapterError(InferErrorCode.InternalError, "Unable to deserialize signed raw transaction payload");
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
    return deserializeAccountAuthenticator(hex ?? nestedHex!);
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

export function normalizeSignTransactionResult(result: unknown): InferSignTransactionResult {
  if (result instanceof Uint8Array || !result || typeof result !== "object") {
    return result as InferSignTransactionResult;
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

  if (!authenticator) return result as InferSignTransactionResult;

  const rawTransaction = normalizeRawTransaction(
    hasRawTransactionField ? (result as { rawTransaction?: unknown }).rawTransaction : undefined,
    rawTransactionBcsHex
  );
  if (rawTransaction) {
    return {
      ...(result as Record<string, unknown>),
      authenticator,
      rawTransaction
    } as InferSignTransactionResult;
  }

  if (hasAuthenticatorField) {
    return {
      ...(result as Record<string, unknown>),
      authenticator
    } as InferSignTransactionResult;
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

export function normalizeProviderAccount(account: InferProviderAccount): AccountInfo {
  return new AccountInfo({
    address: AccountAddress.from(account.address),
    publicKey: normalizeProviderPublicKey(account.publicKey)
  });
}

export function normalizeNetwork(network: string | number | NetworkInfo): NetworkInfo {
  if (network && typeof network === "object") {
    const fields = Object.getOwnPropertyDescriptors(network);
    const chainId = fields.chainId?.value;
    if (
      Object.values(fields).some((d) => !("value" in d)) ||
      typeof fields.name?.value !== "string" ||
      !fields.name.value ||
      typeof chainId !== "number" ||
      !Number.isInteger(chainId) ||
      chainId < 0 ||
      chainId > 255 ||
      (fields.url?.value !== undefined && typeof fields.url.value !== "string")
    ) {
      throw new InferAdapterError(
        InferErrorCode.InvalidNetwork,
        "Provider must report an explicit network and u8 chainId"
      );
    }
    return { name: fields.name.value, chainId, url: fields.url?.value };
  }
  const chains: Record<string, number> = {
    mainnet: 1,
    testnet: 2,
    devnet: 3,
    local: 4
  };
  const rawName =
    typeof network === "number"
      ? Object.keys(chains).find((key) => chains[key] === network)
      : network;
  if (
    typeof rawName !== "string" ||
    !Object.prototype.hasOwnProperty.call(chains, rawName)
  ) {
    throw new InferAdapterError(
      InferErrorCode.InvalidNetwork,
      "Unsupported provider network report"
    );
  }
  return { name: rawName as Network, chainId: chains[rawName] };
}

export function normalizeTransactionPayload(
  transaction: AnyRawTransaction | InferTransactionPayload
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
      sender: transaction.sender
        ? AccountAddress.from(transaction.sender).toString()
        : undefined,
      data: transaction.data,
      options: transaction.options
    };
  }

  return {
    data: transaction
  };
}

export function normalizeSignMessageOutput(
  output: CedraSignMessageOutput | InferSignMessageResponse | unknown
): CedraSignMessageOutput {
  if (!output || typeof output !== "object" || Array.isArray(output))
    throw new InferAdapterError(
      InferErrorCode.InternalError,
      "Malformed signed message"
    );
  const descriptors = Object.getOwnPropertyDescriptors(output);
  if (Object.values(descriptors).some((d) => !("value" in d)))
    throw new InferAdapterError(
      InferErrorCode.InternalError,
      "Unreadable signed message"
    );
  const fields = Object.fromEntries(
    Object.entries(descriptors).map(([k, d]) => [k, d.value])
  );
  for (const name of ["fullMessage", "message", "nonce", "prefix"])
    if (typeof fields[name] !== "string")
      throw new InferAdapterError(
        InferErrorCode.InternalError,
        `Incomplete signed message: ${name}`
      );
  for (const name of ["address", "signerAddress", "application"])
    if (fields[name] !== undefined && typeof fields[name] !== "string")
      throw new InferAdapterError(
        InferErrorCode.InternalError,
        `Invalid message ${name}`
      );
  if (
    fields.chainId !== undefined &&
    (!Number.isInteger(fields.chainId) ||
      fields.chainId < 0 ||
      fields.chainId > 255)
  )
    throw new InferAdapterError(
      InferErrorCode.InternalError,
      "Invalid signed chainId"
    );
  if (
    fields.profile === MESSAGE_PROFILE &&
    (typeof fields.signerAddress !== "string" ||
      typeof fields.publicKey !== "string" ||
      !/^(?:0x)?[0-9a-fA-F]{64}$/.test(fields.publicKey))
  )
    throw new InferAdapterError(
      InferErrorCode.InternalError,
      "Incomplete v1 message signer"
    );
  let signature: Ed25519Signature;
  if (fields.signature instanceof Ed25519Signature)
    signature = fields.signature;
  else {
    if (
      typeof fields.signature !== "string" ||
      !/^(?:0x)?[0-9a-fA-F]{128}$/.test(fields.signature)
    )
      throw new InferAdapterError(
        InferErrorCode.InternalError,
        "Invalid Ed25519 message signature"
      );
    signature = new Ed25519Signature(fields.signature);
  }
  return {
    ...fields,
    fullMessage: fields.fullMessage,
    message: fields.message,
    nonce: fields.nonce,
    prefix: fields.prefix as "CEDRA",
    signature
  } as CedraSignMessageOutput;
}

/** Bind the requested challenge and every requested context before accepting a signature. */
export function assertSignedMessageBinding(
  input: CedraSignMessageInput,
  output: CedraSignMessageOutput,
  scope: IntegrationScope
): void {
  const request = validateMessageInput(input);
  const fields = output as unknown as Record<string, unknown>;
  if (output.message !== request.message || output.nonce !== request.nonce)
    throw new InferAdapterError(
      InferErrorCode.InternalError,
      "Wallet signed a different message or nonce"
    );
  const signer = fields.signerAddress ?? fields.address;
  if (canonicalAddress(signer) !== canonicalAddress(scope.accountAddress))
    throw new InferAdapterError(
      InferErrorCode.InternalError,
      "Signed message has a different signer"
    );
  if (fields.profile === MESSAGE_PROFILE || fields.profile === undefined) {
    if (
      output.prefix !== "CEDRA" ||
      output.fullMessage !== messagePreimage(request, scope)
    )
      throw new InferAdapterError(
        InferErrorCode.InternalError,
        "Signed message preimage differs from the request"
      );
    for (const [key, expected] of [
      ["address", canonicalAddress(scope.accountAddress)],
      ["application", scope.origin],
      ["chainId", scope.chainId]
    ] as const) {
      if (request[key] ? fields[key] !== expected : fields[key] !== undefined)
        throw new InferAdapterError(
          InferErrorCode.InternalError,
          `Signed ${key} context differs from the request`
        );
    }
    return;
  }
  if (
    fields.profile === "cedra:legacy:v0" &&
    request.profile !== MESSAGE_PROFILE &&
    !request.address &&
    !request.application &&
    !request.chainId
  ) {
    const expected = [
      "CEDRA",
      "",
      fields.address,
      request.nonce,
      "",
      request.message
    ].join("\n");
    if (output.fullMessage === expected) return;
  }
  if (
    fields.profile === "raw" &&
    request.profile !== MESSAGE_PROFILE &&
    !request.address &&
    !request.application &&
    !request.chainId &&
    output.fullMessage === request.message &&
    request.nonce.length > 0 &&
    request.message.includes(request.nonce)
  )
    return;
  throw new InferAdapterError(
    InferErrorCode.InternalError,
    "Unsupported or unbound signed message profile"
  );
}

export function verifySignedMessageOutput(
  output: unknown,
  input: CedraSignMessageInput,
  scope: IntegrationScope,
  publicKey: string,
  allowLegacy = false
): CedraSignMessageOutput {
  const request = validateMessageInput(input);
  if (
    allowLegacy &&
    request.profile !== MESSAGE_PROFILE &&
    !request.address &&
    !request.application &&
    !request.chainId &&
    output &&
    typeof output === "object" &&
    !Array.isArray(output)
  ) {
    const descriptors = Object.getOwnPropertyDescriptors(output);
    if (Object.values(descriptors).some((d) => !("value" in d)))
      throw new InferAdapterError(
        InferErrorCode.InternalError,
        "Unreadable legacy signed message"
      );
    const fields = Object.fromEntries(
      Object.entries(descriptors).map(([key, d]) => [key, d.value])
    );
    if (
      fields.profile === undefined &&
      fields.message === request.message &&
      typeof fields.address === "string" &&
      canonicalAddress(fields.address) ===
        canonicalAddress(scope.accountAddress)
    ) {
      const raw =
        fields.fullMessage === request.message &&
        request.nonce.length > 0 &&
        request.message.includes(request.nonce);
      const positional =
        fields.prefix === "CEDRA" &&
        fields.nonce === request.nonce &&
        fields.fullMessage ===
          [
            "CEDRA",
            "",
            fields.address,
            request.nonce,
            "",
            request.message
          ].join("\n");
      if (raw || positional) {
        // Old producers return unsigned application/chain echoes. Discard them.
        const {
          application: _application,
          chainId: _chainId,
          ...bound
        } = fields;
        output = {
          ...bound,
          profile: raw ? "raw" : "cedra:legacy:v0",
          prefix: "CEDRA",
          nonce: request.nonce,
          signerAddress: canonicalAddress(scope.accountAddress)
        };
      }
    }
  }
  const normalized = normalizeSignMessageOutput(output);
  assertSignedMessageBinding(input, normalized, scope);
  const resultPublicKey = (normalized as unknown as Record<string, unknown>)
    .publicKey;
  if (
    typeof resultPublicKey === "string" &&
    new Ed25519PublicKey(resultPublicKey).toString().toLowerCase() !==
      new Ed25519PublicKey(publicKey).toString().toLowerCase()
  )
    throw new InferAdapterError(
      InferErrorCode.InternalError,
      "Message result public key differs from the approved key"
    );
  if (
    !new Ed25519PublicKey(publicKey).verifySignature({
      message:
        "0x" +
        Array.from(new TextEncoder().encode(normalized.fullMessage), (b) =>
          b.toString(16).padStart(2, "0")
        ).join(""),
      signature: normalized.signature
    })
  ) {
    throw new InferAdapterError(
      InferErrorCode.InternalError,
      "Signed message cryptographic verification failed"
    );
  }
  return normalized;
}

export function getSdkNetwork(
  networkInfo: NetworkInfo | null,
  fullnodeUrl?: string
): Cedra {
  if (fullnodeUrl) {
    return new Cedra(
      new CedraConfig({ network: Network.CUSTOM, fullnode: fullnodeUrl })
    );
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
  if (
    args.transaction.secondarySignerAddresses?.length ||
    args.additionalSignersAuthenticators
  ) {
    if (!args.additionalSignersAuthenticators) {
      throw new Error(
        "Missing additionalSignersAuthenticators for multi-agent transaction submission"
      );
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

export function createFullMessage(
  input: CedraSignMessageInput,
  address: string,
  chainId = 0
): string {
  return messagePreimage(validateMessageInput(input), {
    origin: typeof window === "undefined" ? "" : window.location.origin,
    accountAddress: canonicalAddress(address),
    network: "",
    chainId
  });
}
