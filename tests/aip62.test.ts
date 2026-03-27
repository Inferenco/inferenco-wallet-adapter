import { getCedraWallets } from "@cedra-labs/wallet-standard";

describe("registerNovaWallet", () => {
  afterEach(() => {
    delete (window as any).inferenco;
    window.localStorage.clear();
    vi.resetModules();
  });

  it("does not register when desktop registration is disabled and no provider exists", async () => {
    const before = getCedraWallets().cedraWallets.length;
    const { registerNovaWallet } = await import("../src/aip62");
    registerNovaWallet({ desktopRegistration: false });
    const after = getCedraWallets().cedraWallets.length;
    expect(after).toBe(before);
  });

  it("registers on desktop without a provider by default", async () => {
    const before = getCedraWallets().cedraWallets.length;
    const { registerNovaWallet } = await import("../src/aip62");
    registerNovaWallet();
    const after = getCedraWallets().cedraWallets.length;
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
    const { registerNovaWallet } = await import("../src/aip62");
    registerNovaWallet();
    const after = getCedraWallets().cedraWallets.length;
    expect(after).toBe(before + 1);
  });
});
