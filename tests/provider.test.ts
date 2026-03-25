import { detectProvider } from "../src/provider";

describe("detectProvider", () => {
  afterEach(() => {
    delete (window as any).inferenco;
    delete (window as any).nova;
    delete (window as any).cedra;
    delete (window as any).aptos;
  });

  it("prefers window.inferenco over window.nova", () => {
    const inferenco = { isNovaWallet: true };
    const nova = { isNovaWallet: true };
    (window as any).inferenco = inferenco;
    (window as any).nova = nova;

    expect(detectProvider()).toBe(inferenco);
  });

  it("rejects unbranded aliases", () => {
    (window as any).cedra = { isNovaWallet: false };
    expect(detectProvider()).toBeUndefined();
  });

  it("accepts branded aliases", () => {
    const branded = { isNovaWallet: true };
    (window as any).aptos = branded;
    expect(detectProvider()).toBe(branded);
  });
});
