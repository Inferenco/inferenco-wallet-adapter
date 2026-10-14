# External Infer Connect durable submission recovery (point 5)

## Scope and delivery

This change is confined to Infer Wallet and the Adapter. It extends the existing native persistence-before-broadcast boundary to external Infer Connect `signAndSubmitTransaction`. No relay schema, hosted configuration, contract, ecosystem source, or transaction policy changes are required by this implementation. Local commits require explicit approval; committing does not authorize a push.

## Execution and retained evidence

The Wallet admits the exact request and fixes relative expiration once. The newly negotiated request wrapper includes an authenticated invocation ID; the Wallet checks any repeated relay metadata against the decrypted request. Legacy admitted requests continue to bind their original session, request, payload commitment and constraints.

After the user's approval, the Wallet durably claims execution, signs once, captures owned signed bytes, derives the canonical transaction hash, and verifies the saved identity against the active vault generation and native storage barrier before broadcast. Authorization and the original expiry are checked again immediately before the single POST. A failed or unverifiable storage transition prevents broadcast. The existing native path and sign-only/message paths retain their behavior.

A live failure proven to precede both identity persistence and broadcast can be retained as `EXECUTION_FAILED_BEFORE_BROADCAST`. Once signed identity exists, the conservative result retains that identity and uncertainty. A process interruption with only a historical `started` record remains unresolved. No recovery operation signs again, changes expiry, or automatically resubmits.

An accepted SDK response must match the saved hash. The Wallet preserves its receipt before delivering the existing encrypted `{hash}` result. Duplicate invocations return retained evidence or remain uncertain; protected execution IDs survive acknowledgement and retention cleanup. Chain reconciliation reads only the exact hash on the original network and validates the returned transaction identity. Acceptance, pending execution and committed success/abort are separate evidence.

## Recovery protocol

Ordinary relay completion remains the existing `{hash}` success or rejection contract. It is immutable: an unknown result must never be posted as a successful completion merely to make it readable.

Existing authenticated read grants carry an additive encrypted result schema:

`infer-connect-transaction-recovery-v1`

It binds `requestId`, `invocationId`, `requestCommitment`, scope (origin, account, network, chain ID) and method. It carries `unknown`, `approved` (submission acceptance, not necessarily chain success), or `not-submitted`, with optional canonical hash, acceptance, chain state/version and the fixed pre-broadcast failure code. The Adapter validates the exact original payload commitment and retains evidence atomically. Older snapshots cannot replace a known hash or erase stronger evidence. Historical encrypted hash-only results remain supported.

## Explicit read-only mobile handoff

The existing relay has no Wallet-facing grant discovery endpoint or grant-created notification. Rather than relying on its placeholder discovery functions, the clients use an explicit read-only handoff:

```text
inferenco://recover?grantId=...&requestId=...&originSessionId=...&authorizedSessionId=...
```

All four values are UUIDs. The link contains no credentials, transaction payload, supplied relay address, or signing authority. The Wallet derives relay and scope from retained authorized credentials, rechecks ownership around asynchronous operations, delivers the grant and returns to the saved same-origin page. Missing evidence cannot enter the approval queue. A locked Wallet holds only a bounded transient wake hint until normal unlock; if the process exits before unlock, another explicit recovery handoff is needed. Saved transaction evidence remains durable.

The pairing capability `durableExternalSubmissionRecovery` is advertised only when the native durable-storage boundary is available. Ordinary Adapter recovery reads never open the Wallet. An explicit user status-check action may opt in per call:

```ts
wallet.readRecoverableRequest(requestId, { allowMobileRecoveryHandoff: true });
// Registered recovery feature: read(requestId, { allowMobileRecoveryHandoff: true })
```

A definite non-submission is exposed through the existing outcome interface as `status: "unknown"`, `reason: "transaction_not_submitted"`, and `submissionDisposition: "not-submitted"`; it is not represented as a user rejection or chain confirmation.

## Acceptance boundary

Local fixtures cover interruption at storage/signing/broadcast/receipt boundaries, duplicate execution prevention, lost acknowledgements, exact chain evidence, ownership changes, strict binding and read-only handoff. No live blockchain transactions are used.

Ecosystem adoption of the new Adapter artifact and explicit user-triggered read option belongs to the later integration work package. A rebuilt Wallet and Adapter must then be tested together on the affected Pixel. Local tests do not establish physical-device latency, successful recovery of the historical chip claim, or deployed behavior.

## Local validation — 2026-10-14

| Check | Result |
| --- | --- |
| Wallet full Jest suite | 142 suites, 2,472 tests passed |
| Wallet TypeScript and provider codec check | Passed |
| Wallet Android JavaScript export | Passed; no APK/AAB installation |
| Adapter full Vitest suite | 41 suites, 559 tests passed; 6 live Desk tests skipped |
| Adapter TypeScript and CJS/ESM/declaration builds | Passed |
| Actual Wallet serializer against Adapter validator | 7 conformance cases passed; included in Adapter count |
| Both repositories: diff whitespace checks | Passed |

Wallet log: `/tmp/infer-point5-wallet-final.log`. Android export: `/tmp/infer-point5-android-z8bt_oxv` (log `/tmp/infer-point5-android.log`). Adapter logs: `/tmp/adapter-point5-tests.log`, `/tmp/adapter-point5-build.log`. The optional conformance suite uses the sibling Wallet checkout or `INFER_WALLET_WORKSPACE`; it is explicitly skipped when that source is absent.

Branches remain `fix/native-transaction-recovery` (Wallet) and `fix/infer-connect-0.2.2-rc.1` (Adapter). Point 5 changes are approved for local commits only; no push is authorized. The ecosystem checkout is unchanged. Physical-device, deployed relay and historical-transaction acceptance remain unverified.
