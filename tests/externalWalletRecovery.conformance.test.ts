import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { canonicalAddress, requestCommitment } from "../src/integrationContract";
import { validateExternalTransactionRecovery } from "../src/externalTransactionRecovery";

// Execute the actual Wallet recovery serializer with already-validated storage
// and exact-chain observations supplied at its boundaries. This is contract
// conformance, not an APK, storage durability, or live-chain test.
const walletWorkspace = process.env.INFER_WALLET_WORKSPACE ?? resolve(process.cwd(), "../nova-wallet");
const serializerPath = resolve(walletWorkspace, "src/services/relayTransactionRecovery.ts");
const available = existsSync(serializerPath);
if (!available) console.warn("External recovery conformance skipped: set INFER_WALLET_WORKSPACE to the point 5 Wallet checkout.");
const conformance = available ? describe : describe.skip;
const payload = { contractVersion: 1, data: { function: "0x1::chips::claim", typeArguments: [], functionArguments: [] } };
const scope = { origin: "https://fixture.example", accountAddress: canonicalAddress("0x1"), network: "testnet", chainId: 2 };
const hash = "0x" + "ab".repeat(32);
const binding = { requestId: "original", invocationId: "invocation", requestCommitment: requestCommitment("signAndSubmitTransaction", scope, payload),
  origin: scope.origin, address: scope.accountAddress, network: scope.network, chainId: 2, method: "signAndSubmitTransaction", pending: { requestPayload: payload } };
function serializer(chain: Record<string, unknown>) {
  const javascript = ts.transpileModule(readFileSync(serializerPath, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("exports", "require", javascript)(exports, (name: string) => {
    if (name === "../core/transactions") return { getCedraClient: () => { throw new Error("No network client allowed"); } };
    if (name === "../utils/constants") return { NETWORKS: { testnet: { chainId: 2 } } };
    if (name === "./nativeTransactionRecovery") return { exactChainRead: async () => chain };
    if (name === "./inferConnectContract") return { inferRequestCommitment: requestCommitment };
    if (name === "./inferConnectTransactions") return { isValidRelaySubmission: () => true };
    throw new Error("Unexpected Wallet serializer dependency");
  });
  return exports.recoverRelayTransaction as (saved: unknown, options: unknown) => Promise<unknown>;
}
conformance("actual Wallet external recovery serializer contract", () => {
  it.each([
    { submission: {}, chain: {}, status: "unknown" },
    { submission: { notSubmitted: "EXECUTION_FAILED_BEFORE_BROADCAST" }, chain: {}, status: "not-submitted" },
    { submission: { identity: { hash }, acceptance: "unknown" }, chain: { chainStatus: "unknown" }, status: "unknown" },
    { submission: { identity: { hash }, acceptance: "unknown" }, chain: { chainStatus: "pending" }, status: "unknown" },
    { submission: { identity: { hash }, acceptance: "accepted" }, chain: { chainStatus: "unknown" }, status: "approved" },
    { submission: { identity: { hash }, acceptance: "unknown" }, chain: { chainStatus: "confirmed", chainVersion: "42" }, status: "approved" },
    { submission: { identity: { hash }, acceptance: "unknown" }, chain: { chainStatus: "aborted", chainVersion: "42" }, status: "approved" }
  ])("validates Wallet $status evidence for $chain", async ({ submission, chain, status }) => {
    const recover = serializer(chain);
    const value = await recover({ ...binding, accountAddress: scope.accountAddress, admission: { payload }, submission,
      relayBaseUrl: "https://relay.example", sessionId: "original-session" }, { assertAuthorized: () => {}, client: {} });
    expect(validateExternalTransactionRecovery(value, binding)).toMatchObject({ status });
  });
});
