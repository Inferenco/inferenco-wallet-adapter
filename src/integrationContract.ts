import { AccountAddress } from "@cedra-labs/ts-sdk";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { InferAdapterError, InferErrorCode } from "./errors";

export const INTEGRATION_CONTRACT_VERSION = 1 as const;
export const MESSAGE_PROFILE = "cedra:message:v1" as const;
export const WIRE_BOUNDS = Object.freeze({
  depth: 32,
  nodes: 10000,
  utf8Bytes: 262144
});
export type WireValue =
  | null
  | boolean
  | string
  | number
  | WireValue[]
  | { [key: string]: WireValue };
export interface IntegrationScope {
  origin: string;
  accountAddress: string;
  network: string;
  chainId: number;
}
export interface CanonicalTransactionInput {
  contractVersion: 1;
  data: {
    function: string;
    typeArguments: string[];
    functionArguments: WireValue[];
  };
  options: {
    maxGasAmount?: string;
    gasUnitPrice?: string;
    sequenceNumber?: string;
    expireTimestamp?: string;
  };
  sender?: string;
  chainId?: number;
}
export interface MessageInput {
  profile?: typeof MESSAGE_PROFILE;
  message: string;
  nonce: string;
  address?: boolean;
  application?: boolean;
  chainId?: boolean;
}
function invalid(message: string): never {
  throw new InferAdapterError(InferErrorCode.InvalidParams, message);
}
/** Snapshots own data properties without invoking getters or toJSON. */
export function encodeWireValue(input: unknown): WireValue {
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (value: unknown, depth: number): WireValue => {
    if (++nodes > WIRE_BOUNDS.nodes || depth > WIRE_BOUNDS.depth)
      invalid("Request exceeds wire complexity bounds");
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "string"
    )
      return value;
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 0)
        invalid("Wire numbers must be nonnegative safe integers");
      return value;
    }
    if (typeof value === "bigint") {
      if (value < 0n || value >= 1n << 256n)
        invalid("Wire integer is outside u256");
      return value.toString();
    }
    if (value instanceof AccountAddress) return value.toStringLong();
    if (value instanceof Uint8Array) {
      if (value.length > WIRE_BOUNDS.nodes - nodes)
        invalid("Byte vector exceeds wire value bound");
      nodes += value.length;
      return Array.from(value);
    }
    if (!value || typeof value !== "object") invalid("Unsupported wire value");
    if (ancestors.has(value)) invalid("Cyclic request is unsupported");
    ancestors.add(value);
    try {
      if (Object.getOwnPropertySymbols(value).length)
        invalid("Symbol keys are unsupported");
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Object.values(descriptors).some((d) => !("value" in d)))
        invalid("Accessor properties are unsupported");
      if (Array.isArray(value)) {
        if (
          Object.keys(descriptors).some(
            (key) => key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)
          )
        )
          invalid("Array properties are unsupported");
        const result: WireValue[] = [];
        for (let i = 0; i < value.length; i++) {
          if (!Object.prototype.hasOwnProperty.call(descriptors, String(i)))
            invalid("Sparse arrays are unsupported");
          result.push(visit(descriptors[String(i)].value, depth + 1));
        }
        return result;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null)
        invalid("Unsupported object prototype");
      const result: Record<string, WireValue> = {};
      for (const key of Object.keys(descriptors).sort()) {
        if (
          !/^[\x20-\x7e]+$/.test(key) ||
          ["__proto__", "prototype", "constructor"].includes(key)
        )
          invalid("Unsupported object key");
        if (!descriptors[key].enumerable)
          invalid("Nonenumerable properties are unsupported");
        if (descriptors[key].value !== undefined)
          result[key] = visit(descriptors[key].value, depth + 1);
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  };
  const result = visit(input, 0);
  if (
    new TextEncoder().encode(JSON.stringify(result)).length >
    WIRE_BOUNDS.utf8Bytes
  )
    invalid("Request exceeds wire byte bound");
  return result;
}
export function canonicalJson(input: unknown): string {
  const serialize = (value: WireValue): string => {
    if (Array.isArray(value)) return "[" + value.map(serialize).join(",") + "]";
    if (value && typeof value === "object")
      return (
        "{" +
        Object.keys(value)
          .sort()
          .map((key) => JSON.stringify(key) + ":" + serialize(value[key]))
          .join(",") +
        "}"
      );
    return JSON.stringify(value);
  };
  return serialize(encodeWireValue(input));
}
export function requestCommitment(
  method: string,
  scope: IntegrationScope,
  payload: unknown
): string {
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        canonicalJson({ contractVersion: 1, method, scope, payload })
      )
    )
  );
}
export function canonicalAddress(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value))
    invalid("Invalid account address");
  return "0x" + value.slice(2).toLowerCase().padStart(64, "0");
}
function record(value: unknown, name: string): Record<string, WireValue> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(`${name} must be an object`);
  return value as Record<string, WireValue>;
}
function u64(value: unknown, name: string): string {
  if (typeof value !== "string" && typeof value !== "number")
    invalid(`${name} must be an unsigned integer`);
  if (typeof value === "number" && !Number.isSafeInteger(value))
    invalid(`${name} is not an exact integer`);
  if (!/^[0-9]+$/.test(String(value)))
    invalid(`${name} must be an unsigned integer`);
  const n = BigInt(value);
  if (n >= 1n << 64n) invalid(`${name} exceeds u64`);
  return n.toString();
}
const ALIASES = {
  maxGasAmount: ["maxGasAmount", "max_gas_amount"],
  gasUnitPrice: ["gasUnitPrice", "gas_unit_price"],
  sequenceNumber: [
    "sequenceNumber",
    "sequence_number",
    "accountSequenceNumber"
  ],
  expireTimestamp: [
    "expireTimestamp",
    "expirationTimestamp",
    "expirationTimestampSecs",
    "expiration_timestamp_secs"
  ],
  expirationSecondsFromNow: ["expirationSecondsFromNow"]
} as const;
/** Normalization is separate from serialization; no restriction disappears. */
export function normalizeSubmitInput(
  input: unknown,
  mode: "standard" | "convenience" = "convenience",
  nowSeconds = Math.floor(Date.now() / 1000)
): CanonicalTransactionInput {
  const top = record(encodeWireValue(input), "Transaction");
  if (top.contractVersion !== undefined && top.contractVersion !== 1)
    invalid("Unsupported integration contract version");
  if (top.payload !== undefined && top.data !== undefined)
    invalid("Conflicting transaction wrappers");
  if (
    mode === "standard" &&
    (top.payload === undefined ||
      top.data !== undefined ||
      top.options !== undefined ||
      top.contractVersion !== undefined)
  )
    invalid("Standard submission requires payload and standard gas fields");
  const wrapped = top.payload !== undefined || top.data !== undefined;
  const data = record(
    wrapped ? (top.payload ?? top.data) : top,
    "Transaction payload"
  );
  const opts =
    top.options === undefined ? {} : record(top.options, "Transaction options");
  const optionNames: string[] = Object.values(ALIASES).flat();
  const allowedTop =
    mode === "standard"
      ? ["payload", "maxGasAmount", "gasUnitPrice"]
      : [
          "payload",
          "data",
          "options",
          "contractVersion",
          "sender",
          "chainId",
          "chain_id",
          ...optionNames
        ];
  if (wrapped) {
    for (const key of Object.keys(top))
      if (!allowedTop.includes(key))
        invalid(`Unsupported transaction field: ${key}`);
  }
  for (const key of Object.keys(opts))
    if (!optionNames.includes(key))
      invalid(`Unsupported transaction option: ${key}`);
  const allowedData = [
    "function",
    "typeArguments",
    "functionArguments",
    "type_arguments",
    "arguments"
  ];
  for (const key of Object.keys(data))
    if (!allowedData.includes(key))
      invalid(`Unsupported payload field: ${key}`);
  if (
    typeof data.function !== "string" ||
    !/^0x[0-9a-fA-F]{1,64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/.test(
      data.function
    )
  )
    invalid("Invalid entry function");
  const types = data.typeArguments ?? data.type_arguments ?? [];
  const args = data.functionArguments ?? data.arguments ?? [];
  if (
    data.typeArguments !== undefined &&
    data.type_arguments !== undefined &&
    canonicalJson(data.typeArguments) !== canonicalJson(data.type_arguments)
  )
    invalid("Conflicting type arguments");
  if (
    data.functionArguments !== undefined &&
    data.arguments !== undefined &&
    canonicalJson(data.functionArguments) !== canonicalJson(data.arguments)
  )
    invalid("Conflicting function arguments");
  if (!Array.isArray(types) || types.some((t) => typeof t !== "string"))
    invalid("Invalid type arguments");
  if (!Array.isArray(args)) invalid("Invalid function arguments");
  const options: CanonicalTransactionInput["options"] = {};
  let relative: string | undefined;
  for (const [name, aliases] of Object.entries(ALIASES)) {
    let normalized: string | undefined;
    for (const source of [wrapped ? top : {}, opts])
      for (const alias of aliases) {
        if (source[alias] === undefined) continue;
        const value = u64(source[alias], alias);
        if (normalized !== undefined && value !== normalized)
          invalid(`Conflicting ${name}`);
        normalized = value;
      }
    if (normalized !== undefined) {
      if (name === "expirationSecondsFromNow") relative = normalized;
      else options[name as keyof typeof options] = normalized;
    }
  }
  if (relative !== undefined) {
    if (options.expireTimestamp !== undefined)
      invalid("Relative and absolute expiry cannot be combined");
    const seconds = BigInt(relative);
    if (
      seconds === 0n ||
      seconds > 0xffffffffn ||
      !Number.isSafeInteger(nowSeconds) ||
      nowSeconds < 0
    )
      invalid("Invalid relative expiry or preparation clock");
    options.expireTimestamp = u64(
      (BigInt(nowSeconds) + seconds).toString(),
      "expireTimestamp"
    );
  }
  let chainId: number | undefined;
  for (const name of ["chainId", "chain_id"])
    if (wrapped && top[name] !== undefined) {
      const id = Number(u64(top[name], name));
      if (id > 255 || (chainId !== undefined && id !== chainId))
        invalid("Invalid or conflicting chainId");
      chainId = id;
    }
  return {
    contractVersion: 1,
    data: {
      function: data.function,
      typeArguments: types as string[],
      functionArguments: args
    },
    options,
    ...(wrapped && top.sender !== undefined
      ? { sender: canonicalAddress(top.sender) }
      : {}),
    ...(chainId === undefined ? {} : { chainId })
  };
}
export function validateMessageInput(input: unknown): MessageInput {
  const fields = record(encodeWireValue(input), "Message input");
  for (const key of Object.keys(fields))
    if (
      ![
        "profile",
        "message",
        "nonce",
        "address",
        "application",
        "chainId"
      ].includes(key)
    )
      invalid(`Unsupported message field: ${key}`);
  if (fields.profile !== undefined && fields.profile !== MESSAGE_PROFILE)
    invalid("Unsupported message profile");
  if (
    typeof fields.message !== "string" ||
    typeof fields.nonce !== "string" ||
    /[\r\n]/.test(fields.nonce)
  )
    invalid("Message and single-line nonce are required strings");
  for (const key of ["address", "application", "chainId"])
    if (fields[key] !== undefined && typeof fields[key] !== "boolean")
      invalid(`${key} must be boolean`);
  return fields as unknown as MessageInput;
}
export function messagePreimage(
  input: MessageInput,
  scope: IntegrationScope
): string {
  const value = validateMessageInput(input);
  if (/[\r\n]/.test(scope.origin)) invalid("Invalid message origin");
  const lines = ["CEDRA"];
  if (value.address)
    lines.push(`address: ${canonicalAddress(scope.accountAddress)}`);
  if (value.application) lines.push(`application: ${scope.origin}`);
  if (value.chainId) lines.push(`chainId: ${scope.chainId}`);
  lines.push(`message: ${value.message}`, `nonce: ${value.nonce}`);
  return lines.join("\n");
}

/** Translate only the standard subset for a peer without v1 capability. */
export function legacySubmitInput(wire: CanonicalTransactionInput): {
  payload: CanonicalTransactionInput["data"];
  maxGasAmount?: number;
  gasUnitPrice?: number;
} {
  if (
    wire.sender !== undefined ||
    wire.chainId !== undefined ||
    wire.options.expireTimestamp !== undefined ||
    wire.options.sequenceNumber !== undefined
  )
    invalid("Legacy wallet cannot preserve required restrictions");
  const gas: { maxGasAmount?: number; gasUnitPrice?: number } = {};
  for (const name of ["maxGasAmount", "gasUnitPrice"] as const)
    if (wire.options[name] !== undefined) {
      const value = Number(wire.options[name]);
      if (!Number.isSafeInteger(value))
        invalid("Legacy wallet gas option is outside its exact numeric range");
      gas[name] = value;
    }
  return { payload: wire.data, ...gas };
}
