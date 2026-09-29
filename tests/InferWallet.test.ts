import { InferWallet } from "../src/InferWallet";

describe("InferWallet metadata", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the Infer Desk page on desktop by default", () => {
    const wallet = new InferWallet();

    expect(wallet.url).toBe("https://inferenco.com/infer-desk");
  });

  it("uses the Infer Wallet page on mobile by default", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iphone");

    const wallet = new InferWallet();

    expect(wallet.url).toBe("https://inferenco.com/infer-wallet");
  });

  it("allows overriding the website url", () => {
    const wallet = new InferWallet({ websiteUrl: "https://example.com/custom" });

    expect(wallet.url).toBe("https://example.com/custom");
  });
});
