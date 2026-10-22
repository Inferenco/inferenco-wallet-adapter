# Mobile terminal failure acknowledgement — 22 October 2026

Status: implemented and tested locally on `fix/infer-connect-stale-session-reconnect`, based on `c7cb053ef99bc71e7dfffcb736c9f0b58f509619`. No commit, push, publication or other workspace edit was made for this repair.

## Problem and change

Wallet's external Infer Connect relay route already supplied authenticated `infer-connect-transaction-recovery-v1` evidence for a proved failure before broadcast. The adapter validated and saved it but restricted consumer acknowledgement, terminal-failure subscription delivery and related retention guards to desktop records. A mobile consumer could recover the result but could not finish accepting it.

The existing public APIs now deliver and locally acknowledge that same validated mobile evidence. The result remains `status: "unknown"`, `submissionDisposition: "not-submitted"`, with `EXECUTION_FAILED_BEFORE_BROADCAST`. It does not become a fabricated approval, rejection or chain receipt. The consumer persists its own terminal result before explicitly acknowledging.

Mobile acknowledgement works offline from the already verified origin-bound record, including after a reload or session/account change. It does not issue any read grant, remote acknowledgement, connection, wallet launch, signature or submission. Existing desktop remote revalidation/acknowledgement remains unchanged. No Wallet or relay schema change is needed for this adapter repair; Wallet's separate built-in-browser gap is outside scope.

The atomic transition checks the exact original proof and rejects uncertainty, substituted scope, conflicting hashes and malformed evidence. Verified terminal failures cannot be archived as unresolved work. Failed persistence retains active acknowledgement debt; concurrent acknowledgement is idempotent. Only acknowledged records older than 30 days and their exactly linked invocation are eligible for cleanup. Unresolved records remain retained.

## Verification

- Before the patch, the initial regression suite reproduced seven failures out of 22 cases (15 protective cases already passed).
- Final new mobile suite: 24 passed, including actual encrypted grant reads in original/renewed sessions, offline replay/acknowledgement, subscriber persistence failure/focus retry, malformed identity/scope, storage failure, concurrent acceptance, hash/proof race and cleanup.
- Full adapter suite: **728 passed, six existing opt-in live Desk tests skipped**; 46 test files passed, one skipped. Existing connection, first-connect, disconnect, mobile, native and desktop regressions ran in that suite.
- TypeScript checking passed. ESM, CommonJS and declaration builds passed.
- Actual local archive exports passed in ESM and CommonJS using existing local dependencies. This is not a fresh clean-install test or a registry publication.
- Independent read-only recovery/security review found no actionable issues.

Commands: `npm test`, `npm run typecheck`, `npm run build`, and `npm pack --ignore-scripts --pack-destination artifacts/mobile-terminal-ack-2026-10-22 --json`. WSL Node version was 24.11.1. Raw test/build logs and the local archive are under `artifacts/mobile-terminal-ack-2026-10-22/`; sanitized identities and results are in `verification.json`.

## Evidence limits

No phone, installed Wallet, deployed relay, real signing or blockchain transaction was tested here. No changes were made to Desk, Wallet or Infer NFT, and the running NFT preview still uses its existing adapter pin. Local implementation and package checks do not establish real-device acceptance.
