import {
  AccountInfo,
  CEDRA_CHAINS,
  UserResponseStatus,
  registerWallet,
  type CedraSignAndSubmitTransactionInput,
  type CedraSignTransactionInputV1_1,
  type CedraSignTransactionMethod,
  type CedraSignTransactionMethodV1_1,
  type CedraFeatures,
  type CedraWallet,
  type CedraWalletAccount
} from "@cedra-labs/wallet-standard";
import { SigningScheme, type AnyRawTransaction } from "@cedra-labs/ts-sdk";
import {
  NOVA_WALLET_ICON,
  NOVA_DESK_NAME,
  NOVA_WALLET_NAME,
  DEFAULT_DESKTOP_REGISTRATION,
  DEFAULT_WEBSITE_URL,
  DEFAULT_REGISTER_FORCE
} from "./constants";
import { hasStoredExternalSession, isMobileBrowser } from "./bridge";
import { buildDeeplinkUrl } from "./deeplink";
import { NovaClient } from "./NovaClient";
import type { NovaWalletOptions } from "./types";

class NovaWalletAccount implements CedraWalletAccount {
  address: string;
  publicKey: Uint8Array;
  chains = CEDRA_CHAINS;
  features = [
    "cedra:connect",
    "cedra:disconnect",
    "cedra:network",
    "cedra:account",
    "cedra:onAccountChange",
    "cedra:onNetworkChange",
    "cedra:signMessage",
    "cedra:signTransaction",
    "cedra:signAndSubmitTransaction"
  ] as const;
  signingScheme = SigningScheme.Ed25519;

  constructor(account: AccountInfo) {
    this.address = account.address.toString();
    this.publicKey = account.publicKey.toUint8Array();
  }
}

export function createNovaAIP62Wallet(options: NovaWalletOptions = {}): CedraWallet {
  const client = new NovaClient(options);
  let accounts: NovaWalletAccount[] = [];

  const updateAccount = async () => {
    const account = await client.getAccount();
    accounts = [new NovaWalletAccount(account)];
    return account;
  };

  const features: CedraFeatures = {
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
      version: "1.1",
      signTransaction: (async (input: CedraSignTransactionInputV1_1 | AnyRawTransaction) => {
        const result = await client.signTransaction(input);
        if (result instanceof Uint8Array) {
          throw new Error("Nova signTransaction returned bytes instead of an authenticator");
        }
        if (result && typeof result === "object" && "authenticator" in result) {
          return {
            status: UserResponseStatus.APPROVED,
            args: "rawTransaction" in result && result.rawTransaction
              ? result
              : result.authenticator
          };
        }
        return {
          status: UserResponseStatus.APPROVED,
          args: result
        };
      }) as CedraSignTransactionMethod & CedraSignTransactionMethodV1_1
    },
    "cedra:signAndSubmitTransaction": {
      version: "1.1.0",
      signAndSubmitTransaction: async (input: CedraSignAndSubmitTransactionInput) => {
        const result = await client.signAndSubmitTransaction(input);
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
    name: isMobileBrowser() ? NOVA_WALLET_NAME : NOVA_DESK_NAME,
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

let registered = false;

export function registerNovaWallet(options: NovaWalletOptions = {}): void {
  if (registered) return;

  const client = new NovaClient(options);
  const forceRegistration = options.forceRegistration ?? DEFAULT_REGISTER_FORCE;
  const desktopRegistration = options.desktopRegistration ?? DEFAULT_DESKTOP_REGISTRATION;
  const shouldRegisterDesktop = desktopRegistration && typeof window !== "undefined" && !isMobileBrowser();
  if (!client.hasProvider() && !client.hasExternalSession() && !forceRegistration && !shouldRegisterDesktop) return;

  registerWallet(createNovaAIP62Wallet(options));
  registered = true;
}
