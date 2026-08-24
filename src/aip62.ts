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
  INFER_CONNECT_NAME,
  INFER_WALLET_ICON,
  INFER_DESK_NAME,
  INFER_WALLET_NAME,
  DEFAULT_DESKTOP_REGISTRATION,
  DEFAULT_DESKTOP_WEBSITE_URL,
  DEFAULT_MOBILE_WEBSITE_URL,
  DEFAULT_REGISTER_FORCE
} from "./constants";
import { hasStoredExternalSession, isMobileBrowser } from "./bridge";
import { buildDeeplinkUrl } from "./deeplink";
import { isHostedInInferDesk } from "./hosted";
import { InferClient } from "./InferClient";
import { InferAdapterError, InferErrorCode } from "./errors";
import type { InferWalletOptions } from "./types";

/** v0.2.0-rc.8 (Phase 5 UX): extension to CedraFeatures for the
 * Infer Connect–specific "cedra:onDisconnect" listener. Modeled after
 * CedraOnAccountChangeFeature. Defined locally so callers that want
 * to subscribe to wallet-initiated disconnects through the AIP-62
 * surface can do so without depending on a future wallet-standard
 * revision. Dapp code:
 *
 *   const wallet = getCedraWallet("Infer Connect");
 *   if (wallet.features["cedra:onDisconnect"]) {
 *     await wallet.features["cedra:onDisconnect"].onDisconnect(() => {
 *       // ...
 *     });
 *   }
 */
type InferCedraOnDisconnectFeature = {
  "cedra:onDisconnect": {
    version: "1.0.0";
    onDisconnect: (callback: () => void) => Promise<void>;
  };
};

type InferCedraFeatures = CedraFeatures & InferCedraOnDisconnectFeature;

class InferWalletAccount implements CedraWalletAccount {
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

export function createInferAIP62Wallet(options: InferWalletOptions = {}): CedraWallet {
  const client = new InferClient(options);
  let accounts: InferWalletAccount[] = [];

  const updateAccount = async () => {
    const account = await client.getAccount();
    accounts = [new InferWalletAccount(account)];
    return account;
  };

  const features: InferCedraFeatures = {
    "cedra:connect": {
      version: "1.0.0",
      connect: async () => {
        const { account } = await client.connect();
        accounts = [new InferWalletAccount(account)];
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
    // v0.2.0-rc.8 (Phase 5 UX): opted-in listener for wallet-initiated
    // (or peer-tab-initiated) disconnect events. Modeled after
    // CedraOnAccountChangeFeature. Subscribers should drop cached state
    // and wait for a fresh `cedra:connect` to resume.
    "cedra:onDisconnect": {
      version: "1.0.0",
      onDisconnect: async (callback) => {
        client.on("disconnect", callback);
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
          throw new Error("Infer signTransaction returned bytes instead of an authenticator");
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
        try {
          const result = await client.signAndSubmitTransaction(input);
          return {
            status: UserResponseStatus.APPROVED,
            args: result
          };
        } catch (error) {
          if (error instanceof InferAdapterError && error.code === InferErrorCode.UserRejected) {
            return { status: UserResponseStatus.REJECTED };
          }
          throw error;
        }
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
    name: INFER_CONNECT_NAME,
    icon: INFER_WALLET_ICON,
    url: options.websiteUrl ?? (isMobileBrowser() ? DEFAULT_MOBILE_WEBSITE_URL : DEFAULT_DESKTOP_WEBSITE_URL),
    chains: CEDRA_CHAINS,
    get accounts() {
      return accounts;
    },
    get features() {
      return features as unknown as CedraFeatures;
    }
  } as unknown as CedraWallet;
}

let registered = false;

export function registerInferWallet(options: InferWalletOptions = {}): void {
  if (registered) return;

  const client = new InferClient(options);
  const forceRegistration = options.forceRegistration ?? DEFAULT_REGISTER_FORCE;
  const desktopRegistration = options.desktopRegistration ?? DEFAULT_DESKTOP_REGISTRATION;
  const shouldRegisterDesktop = desktopRegistration && typeof window !== "undefined" && !isMobileBrowser();
  const shouldRegisterMobileRelay = typeof window !== "undefined" && isMobileBrowser();
  if (!client.hasProvider() && !client.hasExternalSession() && !forceRegistration && !shouldRegisterDesktop && !shouldRegisterMobileRelay) return;

  // v0.2.0-rc.12: if the dapp is already running inside Infer Desk's
  // embedded browser, the embedded provider (window.cedra /
  // window.nova / window.aptos, all stamped with isNovaDesk = true)
  // is already on the page and provides identical functionality
  // through the same IPC channel. Registering Infer Connect on top
  // would produce a duplicate entry in the dapp's wallet-selector
  // modal that routes to the same wallet. `forceRegistration: true`
  // is the explicit override.
  if (!forceRegistration && isHostedInInferDesk()) {
    return;
  }

  registerWallet(createInferAIP62Wallet(options));
  registered = true;
}
