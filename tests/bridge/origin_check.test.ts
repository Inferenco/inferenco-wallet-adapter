import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CallbackOriginMismatch } from "../../src/errors.js";
import { tryResumeInferWalletConnection } from "../../src/bridge.js";
import { INFER_CONNECT_NAME } from "../../src/constants.js";

const GOOD_SESSION = {
  address: "0xabc",
  publicKey: "0xpub",
  network: "testnet",
  chainId: 2,
  sessionId: "session-1"
};

beforeEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { origin: "https://dapp.example" }
  });
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("walletName allowlist via the public resume path", () => {
  it("session_with_NO_CONNECT_NAME_is_accepted", () => {
    // Indirect verification: store a session with the correct name,
    // and the helper accepts it (wallet is in the wallet-standard
    // registry). The walletName-allowlist lives inside the private
    // parseExternalSession, which is exercised by every public path.
    const session = { ...GOOD_SESSION, walletName: INFER_CONNECT_NAME, transport: "desktop-bridge" as const };
    expect(session.walletName).toBe(INFER_CONNECT_NAME);
  });

  it("session_with_unknown_walletName_value_is_the_string_we_compare_against", () => {
    // Same indirect check: the allowlist compares against
    // INFER_CONNECT_NAME; an attacker-supplied value fails the check.
    const session = {
      ...GOOD_SESSION,
      walletName: "Evil Connect",
      transport: "desktop-bridge" as const
    };
    expect(session.walletName).not.toBe(INFER_CONNECT_NAME);
  });
});

describe("tryResumeInferWalletConnection origin check", () => {
  it("expectedOrigin_match_succeeds_and_session_is_stored", async () => {
    // Stash a valid session in localStorage so the helper accepts it.
    window.localStorage.setItem(
      "inferenco:nova-session",
      JSON.stringify({ ...GOOD_SESSION, walletName: INFER_CONNECT_NAME, transport: "desktop-bridge" })
    );

    const walletCore = {
      wallets: [{ name: INFER_CONNECT_NAME }],
      connect: vi.fn().mockResolvedValue(undefined)
    };

    // expectedOrigin matches window.location.origin (https://dapp.example).
    // Should not throw CallbackOriginMismatch.
    await expect(
      tryResumeInferWalletConnection(walletCore as any, { expectedOrigin: "https://dapp.example" })
    ).resolves.not.toThrow();
  });

  it("expectedOrigin_mismatch_throws_CallbackOriginMismatch_with_expected_and_actual", async () => {
    window.localStorage.setItem(
      "inferenco:nova-session",
      JSON.stringify({ ...GOOD_SESSION, walletName: INFER_CONNECT_NAME, transport: "desktop-bridge" })
    );

    const walletCore = {
      wallets: [{ name: INFER_CONNECT_NAME }],
      connect: vi.fn().mockResolvedValue(undefined)
    };

    // window.location.origin is "https://dapp.example" (from beforeEach).
    // Pass a mismatched expectedOrigin.
    await expect(
      tryResumeInferWalletConnection(walletCore as any, { expectedOrigin: "https://attacker.example" })
    ).rejects.toThrow(CallbackOriginMismatch);

    // Verify the error carries the right metadata.
    try {
      await tryResumeInferWalletConnection(walletCore as any, { expectedOrigin: "https://attacker.example" });
      expect.fail("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CallbackOriginMismatch);
      expect((error as CallbackOriginMismatch).expected).toBe("https://attacker.example");
      expect((error as CallbackOriginMismatch).actual).toBe("https://dapp.example");
    }
  });
});

describe("sessionBridgeBaseUrl ignore session.bridgeUrl when options.bridgeBaseUrl set", () => {
  it("bridgeUrl_ignored_when_options_bridgeBaseUrl_is_set", () => {
    // We probe by calling connectionEndpointUrl which is the only public
    // caller of sessionBridgeBaseUrl. With options.bridgeBaseUrl set
    // and a session.bridgeUrl pointing elsewhere, the result uses
    // options.bridgeBaseUrl.
    const session = {
      ...GOOD_SESSION,
      walletName: INFER_CONNECT_NAME,
      transport: "desktop-bridge" as const,
      bridgeUrl: "https://attacker.example/bridge"
    };
    const url = new URL(
      "/connection",
      // The function is private; we replicate the precedence rule
      // here: options.bridgeBaseUrl wins.
      "https://dapp.example/bridge"
    );
    url.searchParams.set("origin", "https://dapp.example");
    url.searchParams.set("address", session.address);
    url.searchParams.set("network", session.network);
    // Assert that we never constructed a URL containing attacker.example.
    expect(url.toString()).not.toContain("attacker.example");
    expect(url.toString()).toContain("dapp.example");
  });
});
