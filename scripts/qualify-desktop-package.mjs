// Run against an extracted npm archive and the fixture verified by Desk's Rust router.
// No wallet process, RPC or network is used; any unexpected request fails the check.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";

const [packageDirectory, fixturePath] = process.argv.slice(2);
assert(packageDirectory && fixturePath, "Pass extracted package directory and Rust-produced fixture path");
const manifest = JSON.parse(await readFile(resolve(packageDirectory, "package.json"), "utf8"));
assert.equal(manifest.name, "@inferenco/infer-wallet-adapter");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
assert.equal(fixture.schema, "infer-desk-desktop-transaction-responses-v1");
assert.equal(fixture.cases.length, 6);
const dom = new JSDOM("<!doctype html><title>Local package qualification</title>", {
  url: "https://desktop-contract.invalid"
});
for (const key of ["window", "document", "location", "localStorage", "sessionStorage", "navigator", "Event", "CustomEvent"])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
const adapter = await import(pathToFileURL(resolve(packageDirectory, "dist/index.js")).href);
const session = { transport: "desktop-bridge", address: "0x1", publicKey: "0x2",
  network: "testnet", chainId: 2, sessionId: "qualification-session",
  bridgeUrl: "http://127.0.0.1:21984/" + "12".repeat(32) };
const input = { payload: { function: "0x1::fixture::run", typeArguments: [], functionArguments: [] } };
const originalFetch = globalThis.fetch;
const results = [];
try {
  for (const sample of fixture.cases) {
    for (const loseDirectReply of sample.response.status === "approved" ? [false, true] : [false]) {
      globalThis.indexedDB = new IDBFactory();
      localStorage.clear(); sessionStorage.clear();
      adapter.storeExternalSession(session);
      let submissions = 0, polls = 0;
      globalThis.fetch = async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/transaction") && init?.method === "POST") {
          submissions++;
          return Response.json({ requestId: sample.requestId });
        }
        assert.equal(init?.method ?? "GET", "GET");
        assert(path.endsWith(`/transaction-request/${sample.requestId}`), "Only original request may be read");
        if (++polls === 1 && loseDirectReply) throw new Error("deliberate direct delivery loss");
        return Response.json(sample.response, { status: sample.httpStatus });
      };
      const operation = adapter.tryLocalBridgeSignAndSubmit(input, session);
      if (sample.response.status === "approved" && !loseDirectReply)
        assert.deepEqual(await operation, { hash: sample.response.hash });
      else await assert.rejects(operation, { code: sample.response.status === "rejected"
        ? "USER_REJECTED" : "REQUEST_OUTCOME_UNKNOWN" });
      const requests = await adapter.listRecoverableRequests();
      assert.equal(requests.length, 1);
      assert.equal(requests[0].requestId, sample.requestId);
      sessionStorage.clear();
      const recovered = await adapter.readRecoverableRequest(requests[0].recoveryId);
      assert.equal(recovered.status, sample.response.status === "failed" ? "unknown" : sample.response.status);
      if (sample.response.status === "approved") {
        assert.deepEqual(recovered.output, { hash: sample.response.hash });
        const reads = polls;
        localStorage.clear();
        const replay = await adapter.readRecoverableRequest(requests[0].recoveryId);
        assert.deepEqual(replay.output, { hash: sample.response.hash });
        assert.equal(polls, reads, "Final evidence must replay durably without transport");
        assert.equal(polls, loseDirectReply ? 2 : 1);
      }
      assert.equal(submissions, 1, "Recovery must not submit again");
      results.push({ case: sample.name, loseDirectReply, submissions, polls, outcome: recovered.status });
    }
  }
  // Derive negative envelopes from the actual producer, rather than a separate
  // hand-maintained success fixture. Keep this matrix outside the producer file.
  const approved = fixture.cases.find(sample => sample.response.status === "approved");
  const rejected = fixture.cases.find(sample => sample.response.status === "rejected");
  const without = (value, ...keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
  const variants = [
    ["legacy-minimal-approval", without(approved.response, "integrationContractVersion", "capabilities"), "approved"],
    ["wrong-request-id", { ...approved.response, requestId: "different-request" }, "unknown"],
    ["missing-request-id", without(approved.response, "requestId"), "unknown"],
    ["invalid-hash", { ...approved.response, hash: "0xinvalid" }, "unknown"],
    ["unsupported-version", { ...approved.response, integrationContractVersion: 2 }, "unknown"],
    ["capabilities-without-version", without(approved.response, "integrationContractVersion"), "unknown"],
    ["malformed-capabilities", { ...approved.response, capabilities: { completeResults: "true" } }, "unknown"],
    ["unknown-capability", { ...approved.response, capabilities: { newAuthority: true } }, "unknown"],
    ["approval-with-error", { ...approved.response, error: "contradictory result" }, "unknown"],
    ["rejection-with-null-hash", { ...rejected.response, requestId: approved.requestId, hash: null }, "unknown"],
    ["rejection-with-signature", { ...rejected.response, requestId: approved.requestId, signature: "unexpected" }, "unknown"],
    ["receipt-write-failure", approved.response, "approved", true],
  ];
  for (const [name, response, expected, failReceiptWrite = false] of variants) {
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear(); sessionStorage.clear();
    adapter.storeExternalSession(session);
    let submissions = 0, polls = 0, failedWrites = 0;
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, ...args) {
      if (failReceiptWrite && failedWrites === 0 && value?.final?.status === "approved") {
        failedWrites++;
        throw new Error("deliberate durable final write failure");
      }
      return originalPut.call(this, value, ...args);
    };
    try {
      globalThis.fetch = async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/transaction") && init?.method === "POST") {
          submissions++;
          return Response.json({ requestId: approved.requestId });
        }
        assert.equal(init?.method ?? "GET", "GET");
        assert(path.endsWith(`/transaction-request/${approved.requestId}`), "Only the original request may be read");
        polls++;
        return Response.json(response);
      };
      const operation = adapter.tryLocalBridgeSignAndSubmit(input, session);
      if (expected === "approved" && !failReceiptWrite)
        assert.deepEqual(await operation, { hash: approved.response.hash }, name);
      else await assert.rejects(operation, { code: "REQUEST_OUTCOME_UNKNOWN" }, name);
      assert.equal(failedWrites, failReceiptWrite ? 1 : 0, name);
      const requests = await adapter.listRecoverableRequests();
      assert.equal(requests.length, 1, name);
      assert.equal(requests[0].requestId, approved.requestId, name);
      sessionStorage.clear();
      const recovered = await adapter.readRecoverableRequest(requests[0].recoveryId);
      assert.equal(recovered.status, expected, name);
      if (expected === "approved") {
        assert.deepEqual(recovered.output, { hash: approved.response.hash }, name);
        assert.equal(polls, failReceiptWrite ? 2 : 1, name);
        const reads = polls;
        localStorage.clear();
        assert.deepEqual((await adapter.readRecoverableRequest(requests[0].recoveryId)).output,
          { hash: approved.response.hash }, name);
        assert.equal(polls, reads, "Durable replay must not contact the transport");
      } else {
        assert.equal(recovered.output, undefined, name);
        assert.equal(polls, 2, "Malformed evidence must be rechecked, never cached as final");
      }
      assert.equal(submissions, 1, "Status recovery must never submit again");
      results.push({ case: name, submissions, polls, failedWrites, outcome: recovered.status });
    } finally { IDBObjectStore.prototype.put = originalPut; }
  }
  console.log(JSON.stringify({ packageVersion: manifest.version, cases: results }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  dom.window.close();
}
