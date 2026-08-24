import { getCedraWallets } from "@cedra-labs/wallet-standard";
import { isHostedInInferDesk } from "../src/hosted";

// Helper: reset module state between tests so the module-level
// `registered` boolean in aip62.ts does not leak across cases.
function resetAdapter() {
  delete (window as any).cedra;
  delete (window as any).nova;
  delete (window as any).aptos;
  delete (window as any).infer;
  delete (window as any).inferenco;
  delete (window as any).__novaDeskProviderInjected;
  delete (window as any).__inferDeskProviderInjected;
  window.localStorage.clear();
  vi.resetModules();
  vi.restoreAllMocks();
}

describe("isHostedInInferDesk", () => {
  afterEach(() => {
    resetAdapter();
  });

  it("returns true when window.cedra.isInferDesk === true (canonical rebrand flag)", () => {
    (window as any).cedra = { isInferDesk: true, name: "Infer Desk" };
    expect(isHostedInInferDesk()).toBe(true);
  });

  it("returns true when window.cedra.isNovaDesk === true (legacy alias)", () => {
    (window as any).cedra = { isNovaDesk: true, name: "Nova Desk" };
    expect(isHostedInInferDesk()).toBe(true);
  });

  it("returns true when window.infer.isInferDesk === true (new rebrand namespace)", () => {
    (window as any).infer = { isInferDesk: true, name: "Infer Desk" };
    expect(isHostedInInferDesk()).toBe(true);
  });

  it("returns true when window.nova.isInferDesk === true (legacy namespace + rebrand flag)", () => {
    (window as any).nova = { isInferDesk: true, name: "Infer Desk" };
    expect(isHostedInInferDesk()).toBe(true);
  });

  it("returns true when window.nova.isNovaDesk === true (legacy namespace + legacy flag)", () => {
    (window as any).nova = { isNovaDesk: true, name: "Nova Desk" };
    expect(isHostedInInferDesk()).toBe(true);
  });

  it("returns true when window.aptos.isNovaDesk === true", () => {
    (window as any).aptos = { isNovaDesk: true, name: "Nova Desk" };
    expect(isHostedInInferDesk()).toBe(true);
  });

  it("returns true when __novaDeskProviderInjected === true", () => {
    (window as any).__novaDeskProviderInjected = true;
    expect(isHostedInInferDesk()).toBe(true);
  });

  it("returns true when __inferDeskProviderInjected === true", () => {
    (window as any).__inferDeskProviderInjected = true;
    expect(isHostedInInferDesk()).toBe(true);
  });

  it("returns false when no Infer Desk signal is present", () => {
    expect(isHostedInInferDesk()).toBe(false);
  });

  it("returns false when window.cedra is present but neither flag is set", () => {
    (window as any).cedra = { isNovaWallet: true, name: "Some Other Wallet" };
    expect(isHostedInInferDesk()).toBe(false);
  });

  it("returns false when window.cedra.isInferDesk is a truthy non-true value (strict check)", () => {
    (window as any).cedra = { isInferDesk: 1 as unknown as boolean };
    // strict `=== true` is intentional: a forged truthy value must
    // not flip the gate. Only the wallet's own sentinel counts.
    expect(isHostedInInferDesk()).toBe(false);
  });
});

describe("registerInferWallet (v0.2.0-rc.12 in-Nova-Desk suppression)", () => {
  afterEach(() => {
    resetAdapter();
  });

  it("skips registration when window.cedra.isNovaDesk === true", async () => {
    (window as any).cedra = { isNovaDesk: true, name: "Nova Desk" };
    const before = getCedraWallets().cedraWallets.length;
    const { registerInferWallet } = await import("../src/aip62");
    registerInferWallet();
    const after = getCedraWallets().cedraWallets.length;
    expect(after).toBe(before);
  });

  it("skips registration when window.nova.isNovaDesk === true", async () => {
    (window as any).nova = { isNovaDesk: true, name: "Nova Desk" };
    const before = getCedraWallets().cedraWallets.length;
    const { registerInferWallet } = await import("../src/aip62");
    registerInferWallet();
    const after = getCedraWallets().cedraWallets.length;
    expect(after).toBe(before);
  });

  it("skips registration when window.aptos.isNovaDesk === true", async () => {
    (window as any).aptos = { isNovaDesk: true, name: "Nova Desk" };
    const before = getCedraWallets().cedraWallets.length;
    const { registerInferWallet } = await import("../src/aip62");
    registerInferWallet();
    const after = getCedraWallets().cedraWallets.length;
    expect(after).toBe(before);
  });

  it("skips registration when __novaDeskProviderInjected === true (sentinel fallback)", async () => {
    (window as any).__novaDeskProviderInjected = true;
    const before = getCedraWallets().cedraWallets.length;
    const { registerInferWallet } = await import("../src/aip62");
    registerInferWallet();
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
    const { registerInferWallet } = await import("../src/aip62");
    registerInferWallet();
    const after = getCedraWallets().cedraWallets.length;
    expect(after).toBe(before + 1);
  });

  it("forceRegistration: true overrides the in-Nova-Desk suppression", async () => {
    (window as any).cedra = { isNovaDesk: true, name: "Nova Desk" };
    const before = getCedraWallets().cedraWallets.length;
    const { registerInferWallet } = await import("../src/aip62");
    registerInferWallet({ forceRegistration: true });
    const after = getCedraWallets().cedraWallets.length;
    expect(after).toBe(before + 1);
  });

  it("regression: registers normally when no Nova Desk signal is present (external browser)", async () => {
    const before = getCedraWallets().cedraWallets.length;
    const { registerInferWallet } = await import("../src/aip62");
    registerInferWallet();
    const after = getCedraWallets().cedraWallets.length;
    expect(after).toBe(before + 1);
  });
});
