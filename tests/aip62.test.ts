import { getCedraWallets } from "@cedra-labs/wallet-standard";
import {
  Account,
  ChainId,
  EntryFunction,
  MultiAgentTransaction,
  parseTypeTag,
  RawTransaction,
  TransactionPayloadEntryFunction
} from "@cedra-labs/ts-sdk";

describe("registerInferWallet", () => {
  afterEach(() => {
    delete (window as any).inferenco;
    window.localStorage.clear();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("does not register when desktop registration is disabled and no provider exists", async () => {
    const before = getCedraWallets().cedraWallets.length;
    const { registerInferWallet } = await import("../src/aip62");
    registerInferWallet({ desktopRegistration: false });
    const after = getCedraWallets().cedraWallets.length;
    expect(after).toBe(before);
  });

  it("registers on desktop without a provider by default", async () => {
    const before = getCedraWallets().cedraWallets.length;
    const { registerInferWallet, createInferAIP62Wallet } = await import("../src/aip62");
    const wallet = createInferAIP62Wallet();
    registerInferWallet();
    const after = getCedraWallets().cedraWallets.length;
    expect(wallet.name).toBe("Infer Connect");
    expect(wallet.url).toBe("https://inferenco.com/infer-desk");
    expect(after).toBe(before + 1);
  });

  it("registers when provider exists", async () => {
    (window as any).inferenco = {
      isNovaWallet: true,
      connect: async () => {
        throw new Error("not called");
      },
      account: async () => {
        throw new Error("not called");
      },
      disconnect: async () => {},
      network: async () => "devnet",
      signMessage: async () => {
        throw new Error("not called");
      },
      signTransaction: async () => {
        throw new Error("not called");
      }
    };

    const before = getCedraWallets().cedraWallets.length;
    const { registerInferWallet } = await import("../src/aip62");
    registerInferWallet();
    const after = getCedraWallets().cedraWallets.length;
    expect(after).toBe(before + 1);
  });

  it("registers for mobile relay flows", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iphone");
    const before = getCedraWallets().cedraWallets.length;
    const { registerInferWallet, createInferAIP62Wallet } = await import("../src/aip62");
    const wallet = createInferAIP62Wallet();
    registerInferWallet();
    const after = getCedraWallets().cedraWallets.length;
    expect(wallet.name).toBe("Infer Connect");
    expect(wallet.url).toBe("https://inferenco.com/infer-wallet");
    expect(after).toBe(before + 1);
  });

  it("returns SDK-compatible authenticators from provider JSON signTransaction results", async () => {
    const sender = Account.generate();
    const secondarySigner = Account.generate();
    const rawTransaction = new RawTransaction(
      sender.accountAddress,
      0n,
      new TransactionPayloadEntryFunction(
        EntryFunction.build("0x1::account", "transfer", [], [])
      ),
      1_000n,
      1n,
      60n,
      new ChainId(3),
      parseTypeTag("0x1::cedra_coin::CedraCoin")
    );
    const transaction = new MultiAgentTransaction(rawTransaction, [
      secondarySigner.accountAddress
    ]);
    const authenticator = sender.signTransactionWithAuthenticator(transaction);
    (window as any).inferenco = {
      isNovaWallet: true,
      signTransaction: vi.fn().mockResolvedValue({
        authenticatorHex: authenticator.toString(),
        authenticator: { hex: authenticator.toString() },
        rawTransactionBcsHex: transaction.toString()
      })
    };

    const { createInferAIP62Wallet } = await import("../src/aip62");
    const wallet = createInferAIP62Wallet();
    const response = await wallet.features["cedra:signTransaction"].signTransaction(transaction);

    expect(response.status).toBe("Approved");
    if (!("args" in response)) throw new Error("Expected approved signTransaction response");
    const args = response.args as unknown as {
      authenticator: {
        bcsToHex?: () => { toString: () => string };
      };
    };
    expect(
      "authenticator" in args &&
        typeof args.authenticator.bcsToHex === "function" &&
        args.authenticator.bcsToHex().toString()
    ).toBe(authenticator.toString());
  });

  // v0.2.0-rc.8 (Phase 5 UX): cedra:onDisconnect AIP-62 feature
  it("exposes cedra:onDisconnect on the wallet features object", async () => {
    const { createInferAIP62Wallet } = await import("../src/aip62");
    const wallet = createInferAIP62Wallet();
    const features = wallet.features as unknown as Record<string, unknown>;
    expect(features["cedra:onDisconnect"]).toBeDefined();
    const feature = features["cedra:onDisconnect"] as {
      version?: string;
      onDisconnect?: unknown;
    };
    expect(feature.version).toBe("1.0.0");
    expect(typeof feature.onDisconnect).toBe("function");
  });
});
