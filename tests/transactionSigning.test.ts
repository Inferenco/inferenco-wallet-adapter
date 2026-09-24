import {
  Account, ChainId, EntryFunction, MultiAgentTransaction, RawTransaction,
  SimpleTransaction, TransactionPayloadEntryFunction, parseTypeTag
} from "@cedra-labs/ts-sdk";
import { tryLocalBridgeSignTransaction } from "../src/bridge";
import { _setBridgeTokenForTesting } from "../src/bridge/token";
import { InferClient } from "../src/InferClient";
import { createInferAIP62Wallet } from "../src/aip62";
import { deserializeAccountAuthenticator, deserializeSignTransactionResult } from "../src/conversion";
import type { InferWindow } from "../src/types";

function fixture(legacy = false) {
  const signer = Account.generate({ legacy });
  const raw = new RawTransaction(
    signer.accountAddress, 123n,
    new TransactionPayloadEntryFunction(EntryFunction.build("0x1::account", "transfer", [], [])),
    25000n, 7n, 1900000123n, new ChainId(2), parseTypeTag("0x1::cedra_coin::CedraCoin")
  );
  const transaction = new SimpleTransaction(raw);
  const authenticator = signer.signTransactionWithAuthenticator(transaction);
  return { signer, raw, transaction, authenticator,
    wire: { authenticatorHex: authenticator.toString(), rawTransactionBcsHex: transaction.toString() } };
}

afterEach(() => {
  delete (window as InferWindow).inferenco;
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("exact prebuilt signing", () => {
  it.each([false, true])("hydrates canonical BCS for legacy Ed25519 = %s", async (legacy) => {
    const { transaction, wire, authenticator } = fixture(legacy);
    const signTransaction = vi.fn().mockImplementation(async (input) => {
      // Simulate the injected provider's actual JSON boundary.
      const json = JSON.parse(JSON.stringify(input));
      expect(json.rawTransactionBcsHex).toBe(transaction.toString());
      expect(json.bcsHex).toBe(transaction.toString());
      expect(json.rawTransaction).toBeUndefined();
      return wire;
    });
    (window as InferWindow).inferenco = { isInferWallet: true, signTransaction };
    const client = new InferClient();
    const result = await client.signTransaction(transaction);
    expect(result).toHaveProperty("rawTransaction");
    if (!("rawTransaction" in result) || !result.rawTransaction || !("authenticator" in result)) throw new Error("Missing result");
    expect(result.rawTransaction.toString()).toBe(transaction.toString());
    expect(result.authenticator.bcsToHex().toString()).toBe(authenticator.toString());
    expect(signTransaction).toHaveBeenCalledTimes(1);
  });

  it("continues accepting real SDK provider objects", async () => {
    const { transaction, authenticator } = fixture();
    (window as InferWindow).inferenco = { isInferWallet: true,
      signTransaction: vi.fn().mockResolvedValue({ authenticator, rawTransaction: transaction }) };
    const result = await new InferClient().signTransaction(transaction);
    expect(result).toMatchObject({ rawTransaction: expect.any(SimpleTransaction) });
  });

  it.each(["inherited", "getter", "non-enumerable", "symbol", "approved conflict"])(
    "rejects a malformed %s status without interpreting it as a user decision", async (kind) => {
      const { transaction, wire } = fixture();
      const record = kind === "inherited" ? Object.assign(Object.create({ status: "Rejected" }), { hash: "0xabc" })
        : kind === "getter" ? { get status() { throw new Error("Getter executed"); } }
        : kind === "non-enumerable" ? Object.defineProperty({}, "status", { value: "Rejected" })
        : kind === "symbol" ? { status: "Rejected", [Symbol("extra")]: 1 }
        : { status: "Approved", args: wire, error: "Rejected" };
      (window as InferWindow).inferenco = { isInferWallet: true, signTransaction: vi.fn().mockResolvedValue(record) };
      await expect(new InferClient().signTransaction(transaction)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    });

  it("preserves multi-agent and fee-payer metadata", () => {
    const { signer, raw } = fixture();
    const peer = Account.generate().accountAddress;
    const payer = Account.generate().accountAddress;
    for (const tx of [new SimpleTransaction(raw, payer), new MultiAgentTransaction(raw, [peer], payer)]) {
      const wire = { authenticatorHex: signer.signTransactionWithAuthenticator(tx).toString(), rawTransactionBcsHex: tx.toString() };
      const output = deserializeSignTransactionResult(wire, tx.toString());
      expect(output.rawTransaction.toString()).toBe(tx.toString());
      expect(output.rawTransaction.feePayerAddress?.toString()).toBe(payer.toString());
    }
  });

  it.each(["sender", "sequence_number", "payload", "max_gas_amount", "gas_unit_price",
    "expiration_timestamp_secs", "chain_id", "fa_address"])("refuses a changed %s", async (field) => {
    const { raw, transaction, wire } = fixture();
    const changes: Record<string, unknown> = {
      sender: Account.generate().accountAddress, sequence_number: 124n,
      payload: new TransactionPayloadEntryFunction(EntryFunction.build("0x1::account", "create_account", [], [])),
      max_gas_amount: 25001n, gas_unit_price: 8n, expiration_timestamp_secs: 1900000124n,
      chain_id: new ChainId(3), fa_address: parseTypeTag("0x1::other::Coin")
    };
    const changed = Object.assign(Object.create(Object.getPrototypeOf(raw)), raw, { [field]: changes[field] }) as RawTransaction;
    (window as InferWindow).inferenco = { isInferWallet: true,
      signTransaction: vi.fn().mockResolvedValue({ ...wire, rawTransactionBcsHex: new SimpleTransaction(changed).toString() }) };
    await expect(new InferClient().signTransaction(transaction)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it.each(["missing raw", "plain JSON raw", "trailing authenticator", "trailing raw", "odd hex", "non-hex"])(
    "rejects %s", async (kind) => {
      const { transaction, wire } = fixture();
      const result: Record<string, unknown> = { ...wire };
      if (kind === "missing raw") delete result.rawTransactionBcsHex;
      if (kind === "plain JSON raw") { delete result.rawTransactionBcsHex; result.rawTransaction = JSON.parse(JSON.stringify(transaction, (_, v) => typeof v === "bigint" ? String(v) : v)); }
      if (kind === "trailing authenticator") result.authenticatorHex += "00";
      if (kind === "trailing raw") result.rawTransactionBcsHex += "ff";
      if (kind === "odd hex") result.authenticatorHex = "0x123";
      if (kind === "non-hex") result.rawTransactionBcsHex = "0xgg";
      (window as InferWindow).inferenco = { isInferWallet: true, signTransaction: vi.fn().mockResolvedValue(result) };
      await expect(new InferClient().signTransaction(transaction)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    });

  it.each(["approved", "trailing authenticator", "changed raw", "rejected", "ambiguous rejection"])(
    "validates original desktop signing bytes: %s", async (kind) => {
      const { transaction, wire } = fixture();
      _setBridgeTokenForTesting("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
      const payload = kind === "rejected" ? { status: "rejected", error: "Declined" } :
        { status: kind === "ambiguous rejection" ? "rejected" : "approved", ...wire,
          ...(kind === "trailing authenticator" ? { authenticatorHex: wire.authenticatorHex + "00" } : {}),
          ...(kind === "changed raw" ? { rawTransactionBcsHex: fixture().transaction.toString() } : {}) };
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        const body = String(url).endsWith("/sign-transaction") ? { requestId: "request-1" } : payload;
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      });
      const promise = tryLocalBridgeSignTransaction({ rawTransactionBcsHex: transaction.toString() }, {
        transport: "desktop-bridge", address: "0x1", publicKey: "0x2", network: "testnet",
        chainId: 2, sessionId: "session-1", bridgeUrl: "https://bridge.example"
      });
      if (kind === "approved") await expect(promise).resolves.toHaveProperty("rawTransaction");
      else await expect(promise).rejects.toMatchObject({ code: kind === "rejected" ? "USER_REJECTED" : "REQUEST_OUTCOME_UNKNOWN" });
      expect(fetch.mock.calls.filter(([url, init]) => init?.method === "POST" && String(url).endsWith("/sign-transaction"))).toHaveLength(1);
    });

  it("rejects a noncanonical authenticator enum encoding", () => {
    const { wire } = fixture(true);
    // Ed25519 enum tag 0 encoded with redundant ULEB128 continuation.
    const hex = "0x8000" + wire.authenticatorHex.replace(/^0x/, "").slice(2);
    expect(() => deserializeAccountAuthenticator(hex)).toThrow();
  });

  it("returns a structured sign-only rejection through AIP-62", async () => {
    const { transaction } = fixture();
    (window as InferWindow).inferenco = { isInferWallet: true,
      signTransaction: vi.fn().mockResolvedValue({ status: "Rejected" }) };
    const wallet = createInferAIP62Wallet();
    expect(wallet.features["cedra:signTransaction"].version).toBe("1.1");
    await expect(wallet.features["cedra:signTransaction"].signTransaction(transaction)).resolves.toEqual({ status: "Rejected" });
  });

  it.each(["throw", "conflicting rejection"])("does not classify %s as user rejection", async (kind) => {
    const { transaction, wire } = fixture();
    (window as InferWindow).inferenco = { isInferWallet: true,
      signTransaction: kind === "throw" ? vi.fn().mockRejectedValue(new Error("Server rejected request"))
        : vi.fn().mockResolvedValue({ status: "Rejected", ...wire }) };
    await expect(new InferClient().signTransaction(transaction)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });
});
