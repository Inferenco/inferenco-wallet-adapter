import { getCedraWallets } from "@cedra-labs/wallet-standard";
import { isHostedInNovaDesk } from "../src/hosted";

// Helper: reset module state between tests so the module-level
// `registered` boolean in aip62.ts does not leak across cases.
function resetAdapter() {
  delete (window as any).cedra;
  delete (window as any).nova;
  delete (window as any).aptos;
  delete (window as any).inferenco;
  delete (window as any).__novaDeskProviderInjected;
  window.localStorage.clear();
  vi.resetModules();
  vi.restoreAllMocks();
}

describe("isHostedInNovaDesk", () => {
  afterEach(() => {
    resetAdapter();
  });

  it("returns true when window.cedra.isNovaDesk === true", () => {
    (window as any).cedra = { isNovaDesk: true, name: "Nova Desk" };
    expect(isHostedInNovaDesk()).toBe(true);
  });

  it("returns true when window.nova.isNovaDesk === true", () => {
    (window as any).nova = { isNovaDesk: true, name: "Nova Desk" };
    expect(isHostedInNovaDesk()).toBe(true);
  });

  it("returns true when window.aptos.isNovaDesk === true", () => {
    (window as any).aptos = { isNovaDesk: true, name: "Nova Desk" };
    expect(isHostedInNovaDesk()).toBe(true);
  });

  it("returns true when __novaDeskProviderInjected === true", () => {
    (window as any).__novaDeskProviderInjected = true;
    expect(isHostedInNovaDesk()).toBe(true);
  });

  it("returns false when no Nova Desk signal is present", () => {
    expect(isHostedInNovaDesk()).toBe(false);
  });

  it("returns false when window.cedra is present but isNovaDesk is missing", () => {
    (window as any).cedra = { isNovaWallet: true, name: "Some Other Wallet" };
    expect(isHostedInNovaDesk()).toBe(false);
  });

  it("returns false when window.cedra.isNovaDesk is a truthy non-true value (strict check)", () => {
    (window as any).cedra = { isNovaDesk: 1 as unknown as boolean };
    // strict `=== true` is intentional: a forged truthy value must
    // not flip the gate. Only the wallet's own sentinel counts.
    expect(isHostedInNovaDesk()).toBe(false);
  });
});

describe("registerNovaWallet (v0.2.0-rc.12 in-Nova-Desk suppression)", () => {
  afterEach(() => {
    resetAdapter();
  });

  it("skips registration when window.cedra.isNovaDesk === true", async () => {
    (window as any).cedra = { isNovaDesk: true, name: "Nova Desk" };
    const before = getCedraWallets().cedraWallets.length;
    const { registerNovaWallet } = await import("../src/aip62");
    registerNovaWallet();
    const after = getCedraWallets().cedraWallets.length;
    expect(after).toBe(before);
  });

  it("skips registration when window.nova.isNovaDesk === true", async () => {
    (window as any).nova = { isNovaDesk: true, name: "Nova Desk" };
    const before = getCedraWallets().cedraWallets.length;
    const { registerNovaWallet } = await import("../src/aip62");
    registerNovaWallet();
    const after = getCedraWallets().cedraWallets.length;
    expect(after).toBe(before);
  });

  it("skips registration when window.aptos.isNovaDesk === true", async () => {
    (window as any).aptos = { isNovaDesk: true, name: "Nova Desk" };
    const before = getCedraWallets().cedraWallets.length;
    const { registerNovaWallet } = await import("../src/aip62");
    registerNovaWallet();
    const after = getCedraWallets().cedraWallets.length;
    expect(after).toBe(before);
  });

  it("skips registration when __novaDeskProviderInjected === true (sentinel fallback)", async () => {
    (window as any).__novaDeskProviderInjected = true;
    const before = getCedraWallets().cedraWallets.length;
    const { registerNovaWallet } = await import("../src/aip62");
    registerNovaWallet();
    const after = getCedraWallets().cedraWallets.length;
    expect(after).toBe(before);
  });

  it("does NOT skip when an extension sets isNovaWallet: true (different brand)", async () => {
    // Extension: isNovaWallet = true, no isNovaDesk. Should still register
    // because Nova Connect is a separate wallet-standard entry, not a
    // duplicate of the local extension.
    (window as any).inferenco = {
      isNovaWallet: true,
      connect: async () => undefined,
      account: async () => undefined,
      disconnect: async () => undefined,
      network: async () => "testnet",
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

  it("forceRegistration: true overrides the in-Nova-Desk suppression", async () => {
    (window as any).cedra = { isNovaDesk: true, name: "Nova Desk" };
    const before = getCedraWallets().cedraWallets.length;
    const { registerNovaWallet } = await import("../src/aip62");
    registerNovaWallet({ forceRegistration: true });
    const after = getCedraWallets().cedraWallets.length;
    expect(after).toBe(before + 1);
  });

  it("regression: registers normally when no Nova Desk signal is present (external browser)", async () => {
    const before = getCedraWallets().cedraWallets.length;
    const { registerNovaWallet } = await import("../src/aip62");
    registerNovaWallet();
    const after = getCedraWallets().cedraWallets.length;
    expect(after).toBe(before + 1);
  });
});
