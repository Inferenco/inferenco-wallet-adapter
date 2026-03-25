import { getCedraWallets } from "@cedra-labs/wallet-standard";
import { registerNovaWallet } from "../src/aip62";

describe("registerNovaWallet", () => {
  afterEach(() => {
    delete (window as any).inferenco;
  });

  it("does not register by default without a provider", () => {
    const before = getCedraWallets().cedraWallets.length;
    registerNovaWallet();
    const after = getCedraWallets().cedraWallets.length;
    expect(after).toBe(before);
  });

  it("registers when provider exists", () => {
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
    registerNovaWallet();
    const after = getCedraWallets().cedraWallets.length;
    expect(after).toBe(before + 1);
  });
});
