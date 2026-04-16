import { NovaWallet } from "../src/NovaWallet";

describe("NovaWallet metadata", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the Nova Desk page on desktop by default", () => {
    const wallet = new NovaWallet();

    expect(wallet.url).toBe("https://inferenco.com/nova-desk");
  });

  it("uses the Nova Wallet page on mobile by default", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iphone");

    const wallet = new NovaWallet();

    expect(wallet.url).toBe("https://inferenco.com/nova-wallet");
  });

  it("allows overriding the website url", () => {
    const wallet = new NovaWallet({ websiteUrl: "https://example.com/custom" });

    expect(wallet.url).toBe("https://example.com/custom");
  });
});
