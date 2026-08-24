// @vitest-environment node
/**
 * Live wallet-bridge round-trip test (audit-08 ND-COMPAT-001, Stream 7.3.2).
 *
 * This file is the *adapter side* of the wallet-driven integration test
 * defined at `nova-desk-ui/tests/e2e_adapter_round_trip.rs`. It is run
 * by that Rust test, which:
 *
 *   1. Boots the wallet's HTTP bridge in-process via
 *      `nova_desk_ui::ui::pages::browser::ensure_external_browser_bridge()`,
 *      which binds `127.0.0.1:21984` and starts the accept loop.
 *   2. Spawns `npx vitest run tests/e2e/wallet_bridge_live.test.ts`
 *      with the bridge URL exposed via the `NOVA_DESK_BRIDGE_URL` env
 *      var (e.g. `http://127.0.0.1:21984/<token>`).
 *   3. In parallel, polls the wallet's bridge queues
 *      (`take_pending_preauth_requests`, `take_pending_message_requests`,
 *      `take_pending_sign_transaction_requests`,
 *      `take_pending_transaction_requests`) and approves every request
 *      via the public approval helpers
 *      (`approve_external_browser_connect_request_by_id`,
 *      `approve_external_browser_message_request`,
 *      `approve_external_browser_sign_transaction_request`,
 *      `approve_external_browser_transaction_request`).
 *
 * The vitest suite below is structurally identical to the fixture-driven
 * `wallet_bridge_round_trip.test.ts` — the only differences are:
 *
 *   - There is no `BridgeFixture` (the wallet is the server).
 *   - `bridgeBaseUrl` is read from `NOVA_DESK_BRIDGE_URL`.
 *   - The signer that approves requests runs in the Rust parent.
 *
 * Running locally:
 *
 *   # In the adapter repo:
 *   NOVA_DESK_BRIDGE_URL=http://127.0.0.1:21984/<token> \
 *     npx vitest run tests/e2e/wallet_bridge_live.test.ts
 *
 *   # From the wallet repo:
 *   NOVA_DESK_ADAPTER_DIR=/path/to/inferenco-wallet-adapter \
 *     cargo test -p nova-desk-ui --test e2e_adapter_round_trip \
 *       -- --ignored --nocapture
 *
 * Why a separate file?
 *
 * The fixture-driven test (`wallet_bridge_round_trip.test.ts`) must be
 * runnable in CI without a wallet binary — it has its own
 * `http.Server` speaking the same wire format. This file is *only*
 * runnable when the wallet bridge is up; the Rust test fails fast if
 * the env var is missing or the bridge port is bound by something else.
 */

import { Account, Ed25519PrivateKey } from "@cedra-labs/ts-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { _resetBridgeTokenForTesting, _setBridgeTokenForTesting } from "../../src/bridge/token.js";
import { _resetExternalSessionResumeListenersForTesting, clearExternalSession } from "../../src/bridge.js";
import { InferClient } from "../../src/InferClient.js";

import { browser } from "./_browser_shim.js";

const BRIDGE_URL_ENV = process.env["NOVA_DESK_BRIDGE_URL"];
const BRIDGE_TOKEN_ENV = process.env["NOVA_DESK_BRIDGE_TOKEN"];

const SKIP_LIVE =
  !BRIDGE_URL_ENV || !BRIDGE_TOKEN_ENV;

if (SKIP_LIVE) {
  // Soft-skip: when run as part of the adapter's default `npm test`
  // (no wallet bridge behind it), vitest reports the suite as
  // skipped instead of failed. To exercise the wallet-side path,
  // run from the Rust integration test in
  // nova-desk-ui/tests/e2e_adapter_round_trip.rs, which sets the env
  // vars and approves requests in the wallet's bridge queues.
  // You can also run directly with:
  //   NOVA_DESK_BRIDGE_URL=http://127.0.0.1:21984/<token> \
  //     NOVA_DESK_BRIDGE_TOKEN=<token> \
  //     npx vitest run tests/e2e/wallet_bridge_live.test.ts
}

const BRIDGE_BASE_URL = (BRIDGE_URL_ENV ?? "http://127.0.0.1:0").replace(/\/$/, "");

// 30 s ceiling on every wait; the Rust approver drains the wallet
// queues in real time so any hang means a wire-format mismatch.
const E2E_TIMEOUT_MS = Number(process.env["NOVA_DESK_E2E_TIMEOUT_MS"] ?? 30_000);

interface Signer {
  account: Account;
  privateKey: Ed25519PrivateKey;
  address: string;
  publicKeyHex: string;
}

async function makeSigner(): Promise<Signer> {
  const privateKey = Ed25519PrivateKey.generate();
  const account = Account.fromPrivateKey({ privateKey });
  return {
    account,
    privateKey,
    address: account.accountAddress.toString(),
    publicKeyHex: account.publicKey.toString()
  };
}

function ed25519Sign(privateKey: Ed25519PrivateKey, message: string): string {
  const bytes = new TextEncoder().encode(message);
  const hex = "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const sig = privateKey.sign(hex);
  return `0x${Buffer.from(sig.toUint8Array()).toString("hex")}`;
}

beforeAll(() => {
  if (SKIP_LIVE) return;
  // Token must match the wallet's per-session URL token (BRIDGE_BIND
  // serves `http://127.0.0.1:21984/<token>`). Pathname fallback matches
  // a real dapp loaded inside the wallet's embedded browser.
  _setBridgeTokenForTesting(BRIDGE_TOKEN_ENV!);
  browser.setPathname(`/${BRIDGE_TOKEN_ENV!}`);
  _resetExternalSessionResumeListenersForTesting();
  clearExternalSession();
}, E2E_TIMEOUT_MS);

afterAll(() => {
  if (SKIP_LIVE) return;
  _resetBridgeTokenForTesting();
  _resetExternalSessionResumeListenersForTesting();
  clearExternalSession();
  browser.reset();
});

describe("wallet-bridge live round-trip (audit-08 ND-COMPAT-001 7.3.2)", () => {
  const skipIfNoBridge = SKIP_LIVE ? it.skip : it;

  skipIfNoBridge(
    "connect: InferClient.connect() against a live wallet bridge",
    async () => {
      const client = new InferClient({ bridgeBaseUrl: BRIDGE_BASE_URL });
      const result = await client.connect();

      expect(result.account).toBeDefined();
      expect(result.account.address.toString().length).toBeGreaterThan(0);
      // The Rust approver hands back a hard-coded address ("0x" +
      // 32-byte "11"), so the connected account must match that
      // shape (not the address of any real signer — the wallet
      // is the source of truth here, not the adapter).
      expect(result.account.address.toString()).toMatch(/^0x[0-9a-f]{64}$/);
    },
    E2E_TIMEOUT_MS
  );

  skipIfNoBridge(
    "sign_message: client.signMessage against a live wallet bridge",
    async () => {
      const client = new InferClient({ bridgeBaseUrl: BRIDGE_BASE_URL });
      await client.connect();

      // The Rust approver signs nothing — it returns an all-zero
      // signature (64 zero bytes). The adapter deserializes it via
      // `Ed25519Signature.deserialize`; all-zero is a syntactically
      // valid 64-byte signature. Wire-format round-trip is the
      // contract under test, not cryptographic validity.
      const output = await client.signMessage({ message: "live-bridge-hello", nonce: "0x00" });

      expect(output.signature).toBeDefined();
      expect(output.signature).toMatch(/^0x[0-9a-f]+$/);
      expect(output.address).toMatch(/^0x[0-9a-f]{64}$/);
      expect(output.fullMessage).toBe("live-bridge-hello");
    },
    E2E_TIMEOUT_MS
  );

  skipIfNoBridge(
    "sign_transaction: client.signTransaction against a live wallet bridge",
    async () => {
      const client = new InferClient({ bridgeBaseUrl: BRIDGE_BASE_URL });
      await client.connect();

      const sdk = await import("@cedra-labs/ts-sdk");
      const { RawTransaction, TransactionPayloadEntryFunction, EntryFunction, ChainId, parseTypeTag, SimpleTransaction } = sdk;

      // The adapter validates only that `rawTransaction` is an
      // SDK transaction instance with the right shape (RawTransaction
      // for the BCS serialization on the wire). We use the
      // connected account's address so the BCS-encoded payload
      // passes any sender-presence checks downstream.
      const rawTransaction = new RawTransaction(
        client.account!.address,
        0n,
        new TransactionPayloadEntryFunction(EntryFunction.build("0x1::account", "transfer", [], [])),
        1_000n,
        1n,
        60n,
        new ChainId(2),
        parseTypeTag("0x1::cedra_coin::CedraCoin")
      );
      const simpleTransaction = new SimpleTransaction(rawTransaction);

      const output = (await client.signTransaction(
        simpleTransaction as unknown as Parameters<typeof client.signTransaction>[0]
      )) as unknown as {
        authenticatorHex: string;
        rawTransactionBcsHex: string;
      };

      // Rust approver returns 105 zero bytes for the authenticator
      // (0x00 variant + u32_LE(32) + 32 pubkey + u32_LE(64) + 64 sig).
      expect(output.authenticatorHex).toMatch(/^0x[0-9a-f]+$/);
      expect(output.authenticatorHex.replace(/^0x/, "").length).toBe(210);
      expect(output.rawTransactionBcsHex).toMatch(/^0x[0-9a-f]+$/);
    },
    E2E_TIMEOUT_MS
  );

  skipIfNoBridge(
    "sign_and_submit: client.signAndSubmitTransaction against a live wallet bridge",
    async () => {
      const client = new InferClient({ bridgeBaseUrl: BRIDGE_BASE_URL });
      await client.connect();

      const output = await client.signAndSubmitTransaction({
        transactionOrPayload: {
          function: "0x1::coin::transfer",
          typeArguments: [],
          functionArguments: []
        }
      } as never);

      // Rust approver returns 32 zero bytes for the hash.
      expect(output.hash).toMatch(/^0x[0-9a-f]{64}$/);
    },
    E2E_TIMEOUT_MS
  );

  skipIfNoBridge(
    "disconnect: client.disconnect against a live wallet bridge",
    async () => {
      const client = new InferClient({ bridgeBaseUrl: BRIDGE_BASE_URL });
      await client.connect();
      expect(browser.window.localStorage.getItem("inferenco:nova-session")).not.toBeNull();

      await client.disconnect();
      expect(browser.window.localStorage.getItem("inferenco:nova-session")).toBeNull();
    },
    E2E_TIMEOUT_MS
  );

  // Silence the unused-import warning for ed25519Sign — it's
  // exported as a helper for ad-hoc local debugging only.
  it.skip("smoke: ed25519Sign helper round-trips", () => {
    const signer = ed25519Sign(Ed25519PrivateKey.generate(), "smoke");
    expect(signer).toMatch(/^0x[0-9a-f]+$/);
  });
});

// Mark unused signer helpers as referenced so vitest's
// `noUnusedLocals` doesn't fail. The `makeSigner` helper is reserved
// for tests that need to compare an adapter-side signer against a
// wallet-returned address; current scenarios read all identity data
// from the wallet's response.
void makeSigner;