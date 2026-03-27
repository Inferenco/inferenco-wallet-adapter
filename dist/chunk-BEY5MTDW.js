// src/aip62.ts
import {
  CEDRA_CHAINS,
  UserResponseStatus,
  registerWallet
} from "@cedra-labs/wallet-standard";
import { SigningScheme } from "@cedra-labs/ts-sdk";

// src/constants.ts
import { Buffer } from "buffer";
var NOVA_WALLET_NAME = "Nova Wallet";
var DEFAULT_WEBSITE_URL = "https://inferenco.com";
var DEFAULT_DEEPLINK_BASE_URL = "inferenco://connect?callback=";
var DEFAULT_DETECT_ALIASES = true;
var DEFAULT_REGISTER_FORCE = false;
var svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#0a3d91"/><path d="M32 12 40 28 56 32 40 36 32 52 24 36 8 32 24 28Z" fill="#66d9ff"/></svg>`;
var NOVA_WALLET_ICON = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

// src/deeplink.ts
function buildCallbackUrl() {
  if (typeof window === "undefined") return "";
  return window.location.href;
}
function buildDeeplinkUrl(options = {}, callbackUrl = buildCallbackUrl()) {
  const base = options.deeplinkBaseUrl ?? DEFAULT_DEEPLINK_BASE_URL;
  return `${base}${encodeURIComponent(callbackUrl)}`;
}

// src/NovaClient.ts
import EventEmitter from "eventemitter3";

// src/errors.ts
var NovaErrorCode = /* @__PURE__ */ ((NovaErrorCode2) => {
  NovaErrorCode2["UserRejected"] = "USER_REJECTED";
  NovaErrorCode2["Unauthorized"] = "UNAUTHORIZED";
  NovaErrorCode2["Unsupported"] = "UNSUPPORTED";
  NovaErrorCode2["NotInstalled"] = "NOT_INSTALLED";
  NovaErrorCode2["InvalidParams"] = "INVALID_PARAMS";
  NovaErrorCode2["InvalidNetwork"] = "INVALID_NETWORK";
  NovaErrorCode2["InternalError"] = "INTERNAL_ERROR";
  return NovaErrorCode2;
})(NovaErrorCode || {});
var NovaAdapterError = class extends Error {
  constructor(code, message, cause) {
    super(message);
    this.code = code;
    this.cause = cause;
    this.name = "NovaAdapterError";
  }
};
function extractStatus(error) {
  if (!error || typeof error !== "object") return void 0;
  if ("status" in error) return error.status;
  if ("code" in error) return error.code;
  return void 0;
}
function remapNovaError(error) {
  if (error instanceof NovaAdapterError) {
    throw error;
  }
  const status = extractStatus(error);
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown Nova wallet error";
  if (status === "Rejected" || status === 401 || /reject/i.test(message)) {
    throw new NovaAdapterError("USER_REJECTED" /* UserRejected */, message, error);
  }
  if (status === "Unsupported" || status === 4200 || /unsupported/i.test(message)) {
    throw new NovaAdapterError("UNSUPPORTED" /* Unsupported */, message, error);
  }
  if (status === "InvalidParams" || status === 400 || /invalid/i.test(message)) {
    throw new NovaAdapterError("INVALID_PARAMS" /* InvalidParams */, message, error);
  }
  if (/not installed|no provider|missing provider/i.test(message)) {
    throw new NovaAdapterError("NOT_INSTALLED" /* NotInstalled */, message, error);
  }
  throw new NovaAdapterError("INTERNAL_ERROR" /* InternalError */, message, error);
}

// src/provider.ts
function isBrowser() {
  return typeof window !== "undefined";
}
function isBrandedNovaProvider(provider) {
  return !!provider && provider.isNovaWallet === true;
}
function detectProvider(options = {}) {
  if (!isBrowser()) return void 0;
  const win = window;
  if (win.inferenco) return win.inferenco;
  if (win.nova) return win.nova;
  const detectAliases = options.detectAliases ?? DEFAULT_DETECT_ALIASES;
  if (!detectAliases) return void 0;
  if (isBrandedNovaProvider(win.cedra)) return win.cedra;
  if (isBrandedNovaProvider(win.aptos)) return win.aptos;
  return void 0;
}

// src/conversion.ts
import {
  AccountAddress,
  AnyPublicKey,
  Cedra,
  CedraConfig,
  Ed25519PublicKey,
  Network
} from "@cedra-labs/ts-sdk";
import { AccountInfo } from "@cedra-labs/wallet-standard";
function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  const hex = input.startsWith("0x") ? input.slice(2) : input;
  return new Uint8Array(hex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) ?? []);
}
function normalizeProviderAccount(account) {
  const publicKey = account.publicKey instanceof Uint8Array ? account.publicKey : toUint8Array(account.publicKey);
  return new AccountInfo({
    address: AccountAddress.from(account.address),
    publicKey: new AnyPublicKey(new Ed25519PublicKey(publicKey))
  });
}
function normalizeNetwork(network) {
  if (typeof network === "object") {
    return {
      chainId: network.chainId ?? 3,
      name: network.name ?? Network.DEVNET,
      url: network.url
    };
  }
  const rawName = typeof network === "number" ? { 1: "mainnet", 2: "testnet", 3: "devnet", 4: "local" }[network] ?? void 0 : network;
  if (!rawName) {
    throw new NovaAdapterError("INVALID_NETWORK" /* InvalidNetwork */, `Unsupported network value: ${String(network)}`);
  }
  const name = rawName === "mainnet" ? Network.MAINNET : rawName === "testnet" ? Network.TESTNET : rawName === "local" ? Network.LOCAL : Network.DEVNET;
  const chainId = typeof network === "number" ? network : { mainnet: 1, testnet: 2, devnet: 3, local: 4 }[rawName] ?? 3;
  return {
    name,
    chainId
  };
}
function normalizeTransactionPayload(transaction) {
  if ("rawTransaction" in transaction) {
    return {
      rawTransaction: transaction
    };
  }
  if ("data" in transaction) {
    return {
      sender: transaction.sender ? AccountAddress.from(transaction.sender).toString() : void 0,
      data: transaction.data,
      options: transaction.options
    };
  }
  return {
    data: transaction
  };
}
function normalizeSignMessageOutput(output) {
  return {
    address: output.address,
    application: "application" in output ? output.application : void 0,
    chainId: "chainId" in output ? output.chainId : void 0,
    fullMessage: output.fullMessage,
    message: output.message,
    nonce: output.nonce,
    prefix: output.prefix ?? "CEDRA",
    signature: output.signature
  };
}
function getSdkNetwork(networkInfo, fullnodeUrl) {
  if (fullnodeUrl) {
    return new Cedra(new CedraConfig({ network: Network.CUSTOM, fullnode: fullnodeUrl }));
  }
  const name = networkInfo?.name;
  const sdkNetwork = name === "mainnet" ? Network.MAINNET : name === "testnet" ? Network.TESTNET : name === "local" ? Network.LOCAL : Network.DEVNET;
  return new Cedra(new CedraConfig({ network: sdkNetwork }));
}
async function submitSignedTransaction(args) {
  const cedra = getSdkNetwork(args.network, args.fullnodeUrl);
  return cedra.transaction.submit.simple({
    transaction: args.transaction,
    senderAuthenticator: args.authenticator
  });
}
function createFullMessage(input, address, chainId) {
  return [
    "CEDRA",
    input.application ?? "",
    address,
    input.nonce,
    input.chainId ?? chainId ?? "",
    input.message
  ].join("\n");
}

// src/NovaClient.ts
function unwrap(value) {
  if (value && typeof value === "object") {
    if ("data" in value && value.data !== void 0) return value.data;
    if ("args" in value && value.args !== void 0) return value.args;
    if ("result" in value && value.result !== void 0) return value.result;
  }
  return value;
}
var NovaClient = class extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.provider = detectProvider(options);
  }
  provider;
  accountInfo = null;
  networkInfo = null;
  refreshProvider() {
    this.provider = detectProvider(this.options);
    return this.provider;
  }
  hasProvider() {
    return !!this.refreshProvider();
  }
  get account() {
    return this.accountInfo;
  }
  get cachedNetwork() {
    return this.networkInfo;
  }
  async connect() {
    try {
      const provider = this.refreshProvider();
      if (!provider?.connect) {
        throw new NovaAdapterError(
          "NOT_INSTALLED" /* NotInstalled */,
          `Nova provider not found. Open ${buildDeeplinkUrl(this.options)}`
        );
      }
      const account = normalizeProviderAccount(unwrap(await provider.connect()));
      this.accountInfo = account;
      if (provider.network) {
        this.networkInfo = normalizeNetwork(unwrap(await provider.network()));
      }
      return { account, network: this.networkInfo };
    } catch (error) {
      remapNovaError(error);
    }
  }
  async getAccount() {
    if (this.accountInfo) return this.accountInfo;
    try {
      const provider = this.refreshProvider();
      if (!provider?.account) {
        throw new NovaAdapterError("NOT_INSTALLED" /* NotInstalled */, "Nova provider account() unavailable");
      }
      const account = normalizeProviderAccount(unwrap(await provider.account()));
      this.accountInfo = account;
      return account;
    } catch (error) {
      remapNovaError(error);
    }
  }
  async disconnect() {
    try {
      const provider = this.refreshProvider();
      await provider?.disconnect?.();
      this.accountInfo = null;
      this.networkInfo = null;
    } catch (error) {
      remapNovaError(error);
    }
  }
  async getNetwork() {
    if (this.networkInfo) return this.networkInfo;
    try {
      const provider = this.refreshProvider();
      if (!provider?.network) {
        throw new NovaAdapterError("NOT_INSTALLED" /* NotInstalled */, "Nova provider network() unavailable");
      }
      const network = normalizeNetwork(unwrap(await provider.network()));
      this.networkInfo = network;
      return network;
    } catch (error) {
      remapNovaError(error);
    }
  }
  async signMessage(input) {
    try {
      const provider = this.refreshProvider();
      if (!provider?.signMessage) {
        throw new NovaAdapterError("UNSUPPORTED" /* Unsupported */, "Nova provider signMessage() unavailable");
      }
      const result = unwrap(await provider.signMessage(input));
      return normalizeSignMessageOutput(result);
    } catch (error) {
      remapNovaError(error);
    }
  }
  async signMessageAndVerify(input) {
    const account = await this.getAccount();
    const output = await this.signMessage(input);
    const publicKey = account.publicKey;
    const message = new TextEncoder().encode(
      output.fullMessage || createFullMessage(input, account.address.toString())
    );
    if (publicKey.verifySignature) {
      return publicKey.verifySignature({
        message,
        signature: output.signature
      });
    }
    if (publicKey.verifySignatureAsync) {
      return publicKey.verifySignatureAsync({
        message,
        signature: output.signature
      });
    }
    return false;
  }
  async signTransaction(transaction, options) {
    try {
      const provider = this.refreshProvider();
      if (!provider?.signTransaction) {
        throw new NovaAdapterError("UNSUPPORTED" /* Unsupported */, "Nova provider signTransaction() unavailable");
      }
      return unwrap(await provider.signTransaction(transaction, options));
    } catch (error) {
      remapNovaError(error);
    }
  }
  async signAndSubmitTransaction(transaction, options) {
    try {
      const provider = this.refreshProvider();
      if (provider?.signAndSubmitTransaction) {
        return unwrap(await provider.signAndSubmitTransaction(transaction, options));
      }
      const normalized = normalizeTransactionPayload(transaction);
      if (!normalized.rawTransaction) {
        throw new NovaAdapterError(
          "UNSUPPORTED" /* Unsupported */,
          "Nova provider cannot fall back submit without a raw transaction"
        );
      }
      const signed = await this.signTransaction(normalized.rawTransaction, options);
      if (!signed || typeof signed !== "object" || !("authenticator" in signed)) {
        throw new NovaAdapterError(
          "UNSUPPORTED" /* Unsupported */,
          "Nova provider signTransaction() fallback did not return an authenticator"
        );
      }
      const submitted = await submitSignedTransaction({
        network: await this.getNetwork().catch(() => null),
        fullnodeUrl: this.options.fullnodeUrl,
        transaction: normalized.rawTransaction,
        authenticator: signed.authenticator
      });
      return { hash: submitted.hash };
    } catch (error) {
      remapNovaError(error);
    }
  }
  async signAndSubmitBCSTransaction(transaction, options) {
    try {
      return await this.signAndSubmitTransaction(transaction, options);
    } catch (error) {
      if (options !== void 0) {
        return this.signAndSubmitTransaction(transaction);
      }
      remapNovaError(error);
    }
  }
  async submitTransaction(input) {
    return submitSignedTransaction({
      network: await this.getNetwork().catch(() => null),
      fullnodeUrl: this.options.fullnodeUrl,
      transaction: input.transaction,
      authenticator: input.authenticator
    });
  }
  async subscribe() {
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
};

// src/aip62.ts
var NovaWalletAccount = class {
  address;
  publicKey;
  chains = CEDRA_CHAINS;
  features = [
    "cedra:connect",
    "cedra:disconnect",
    "cedra:network",
    "cedra:account",
    "cedra:onAccountChange",
    "cedra:onNetworkChange",
    "cedra:signMessage",
    "cedra:signTransaction"
  ];
  signingScheme = SigningScheme.Ed25519;
  constructor(account) {
    this.address = account.address.toString();
    this.publicKey = account.publicKey.toUint8Array();
  }
};
function createNovaAIP62Wallet(options = {}) {
  const client = new NovaClient(options);
  let accounts = [];
  const updateAccount = async () => {
    const account = await client.getAccount();
    accounts = [new NovaWalletAccount(account)];
    return account;
  };
  const features = {
    "cedra:connect": {
      version: "1.0.0",
      connect: async () => {
        const { account } = await client.connect();
        accounts = [new NovaWalletAccount(account)];
        return { status: UserResponseStatus.APPROVED, args: account };
      }
    },
    "cedra:disconnect": {
      version: "1.0.0",
      disconnect: async () => {
        await client.disconnect();
        accounts = [];
      }
    },
    "cedra:network": {
      version: "1.0.0",
      network: async () => client.getNetwork()
    },
    "cedra:account": {
      version: "1.0.0",
      account: updateAccount
    },
    "cedra:onAccountChange": {
      version: "1.0.0",
      onAccountChange: async (callback) => {
        client.on("accountChange", callback);
        await client.subscribe();
      }
    },
    "cedra:onNetworkChange": {
      version: "1.0.0",
      onNetworkChange: async (callback) => {
        client.on("networkChange", callback);
        await client.subscribe();
      }
    },
    "cedra:signMessage": {
      version: "1.0.0",
      signMessage: async (input) => {
        const output = await client.signMessage(input);
        return {
          status: UserResponseStatus.APPROVED,
          args: output
        };
      }
    },
    "cedra:signTransaction": {
      version: "1.0.0",
      signTransaction: async (input) => {
        const result = await client.signTransaction(input);
        if (result instanceof Uint8Array) {
          throw new Error("Nova signTransaction returned bytes instead of an authenticator");
        }
        if (result && typeof result === "object" && "authenticator" in result) {
          return {
            status: UserResponseStatus.APPROVED,
            args: result.authenticator
          };
        }
        return {
          status: UserResponseStatus.APPROVED,
          args: result
        };
      }
    },
    "cedra:openInMobileApp": {
      version: "1.0.0",
      openInMobileApp: () => {
        if (typeof window !== "undefined") {
          window.location.href = buildDeeplinkUrl(options);
        }
      }
    }
  };
  return {
    version: "1.0.0",
    name: NOVA_WALLET_NAME,
    icon: NOVA_WALLET_ICON,
    url: options.websiteUrl ?? DEFAULT_WEBSITE_URL,
    chains: CEDRA_CHAINS,
    get accounts() {
      return accounts;
    },
    get features() {
      return features;
    }
  };
}
var registered = false;
function registerNovaWallet(options = {}) {
  if (registered) return;
  const client = new NovaClient(options);
  const forceRegistration = options.forceRegistration ?? DEFAULT_REGISTER_FORCE;
  if (!client.hasProvider() && !forceRegistration) return;
  registerWallet(createNovaAIP62Wallet(options));
  registered = true;
}

export {
  NOVA_WALLET_NAME,
  DEFAULT_WEBSITE_URL,
  DEFAULT_DEEPLINK_BASE_URL,
  DEFAULT_DETECT_ALIASES,
  DEFAULT_REGISTER_FORCE,
  NOVA_WALLET_ICON,
  buildCallbackUrl,
  buildDeeplinkUrl,
  NovaErrorCode,
  NovaAdapterError,
  remapNovaError,
  isBrowser,
  detectProvider,
  toUint8Array,
  normalizeProviderAccount,
  normalizeNetwork,
  normalizeTransactionPayload,
  normalizeSignMessageOutput,
  getSdkNetwork,
  submitSignedTransaction,
  createFullMessage,
  NovaClient,
  createNovaAIP62Wallet,
  registerNovaWallet
};
