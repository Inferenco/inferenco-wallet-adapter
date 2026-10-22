# Native non-submission proof consumption — 22 October 2026

Implemented locally on `fix/infer-connect-stale-session-reconnect` after external mobile-relay acknowledgement commit `949da5c`. This is generic native recovery behavior, with no Infer NFT addresses or business rules. No commit, push, publication or NFT dependency adoption was performed.

## Contract

The Wallet-side repair retains provable pre-broadcast failures and publishes the original native invocation envelope with `status: "unknown"`, `submissionDisposition: "not-submitted"`, and `failureCode: "EXECUTION_FAILED_BEFORE_BROADCAST"`. The adapter now validates that exact envelope, recomputes its original payload commitment and binds it to current selected wallet/account/network authority. Hashes, payloads, chain/acceptance claims, unsupported fields and changed scope invalidate this proof.

Validated proof is retained atomically in the existing invocation journal, without manufacturing approval or user rejection. Known signed identity and terminal failure cannot overwrite each other. Reload reads use the original retained operation; cached evidence alone cannot replace a current authorized native read. Contradictory or unavailable wallet results remain unknown and do not erase the accepted proof.

Recovery subscriptions deliver this distinct terminal outcome. The consumer persists its own outcome before explicitly acknowledging. Native acknowledgement rereads/revalidates Wallet evidence, requires its scoped `acknowledgeInvocation` response, rechecks authority and only then accepts local delivery. Capability downgrade, remote failure, local write failure or a wrong invocation retain pending acknowledgement. Identical proof merges are no-ops so retries do not wake their own subscribers. Confirmed proof cannot be archived as unresolved work; acknowledged delivery follows existing retention cleanup. No recovery path launches a wallet or repeats execution.

Desktop and external mobile-relay acknowledgement rules are unchanged. No public API rename, new dependency or database migration is required.

## Local verification

- Full adapter suite: **753 passed, six existing live tests skipped** (47 test files passed, one skipped).
- 25 new native proof tests cover identity/scope substitution, missing or contradictory evidence, durable writes, reload, local/remote acknowledgement failure, downgraded peers, authority changes, hash/proof races, callback delivery and retention.
- Existing native selection/lifecycle, external relay, desktop, first-connect and disconnect regressions passed in the full suite.
- Type checking, ESM/CommonJS/declaration builds, whitespace checks and actual extracted-package ESM/CommonJS public export checks passed. Archive checks use existing local dependencies, not a new clean installation.

Raw logs, the local archive and its SHA-256 are under `artifacts/native-not-submitted-2026-10-22/`. Source identities and observed results are recorded in `verification.json`. No physical phone, running Wallet binary, relay deployment, wallet signing or blockchain transaction was qualified. The repaired Wallet and adapter builds must still be adopted together and tested on-device; the current NFT preview retains its previous pin.
