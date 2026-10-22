# Desktop terminal recovery — local implementation evidence

22 October 2026. Workspace: `/home/james/nova-plugin-wallet-adapter`.
Branch: `fix/infer-connect-stale-session-reconnect`.
Base commit: `3f60b4cfefb1a0655906b216c674dec27e7be3e2`.
This evidence was captured before the local repair commit. The base commit
identifies the comparison baseline; `candidate.json` records the exact tested
source and archive hashes. Use `git log -1 -- tests/desktopTerminalRecovery.test.ts`
to identify the commit containing this repair. James authorised that local commit
on 22 October 2026; no push or package publication was authorised.

## Confirmed baseline

Before edits, the saved NFT five-case reproduction ran against the pinned adapter:
`approved`, `rejected`, `pending`, `unknown` passed; `failed` returned unavailable.
All requests were mocked. No network, wallet approval, transaction or funds.

## Implementation

- Qualified desktop `failed` envelopes carry `transactionRecovery` using the
  existing strict `infer-connect-transaction-recovery-v1` representation.
- The outer envelope binds contract version, original/current session, request,
  invocation, commitment, origin, canonical account, network, chain and method.
- Commitment is recomputed from saved immutable request input. Bare failures
  never imply rejection or non-submission.
- Ordinary signing polls persist verified evidence then throw scoped unknown;
  standard signing output is never forged. Ordinary read and authenticated
  new-session recovery return the existing public unknown plus explicit
  not-submitted disposition/failureCode.
- IndexedDB write-before-return, replay, terminal-result subscription and exact
  remote revalidation/acknowledgement support the desktop result. Failed writes
  remain unresolved; lost acknowledgement retains retryable debt.
- Hash/proof competing writes are serialized; a known hash/final result cannot
  be overwritten by not-submitted and a terminal proof cannot gain a hash.
- Mobile transport implementation, connection/deep-link/disconnect behaviour,
  and request commitment encoding remain unchanged.

## Acceptance evidence

`tests.log`, `typecheck.log`, `build.log`, `diff-check.log` record the exact local
commands/results in the local workspace (ignored logs are not distributed). The focused suite covers ordinary polling, new-session lookup,
real fake-indexeddb transactions/reload, late subscribers, consumer write failure,
canonical-address handling, tamper/contradiction rejection, stale authorization,
acknowledgement retry, and racing hash/proof writes.

The unchanged shared fixture is
`tests/fixtures/desktop-expiry-recovery-v1.json`:
SHA-256 `866c5d49b1ff8c65b4757ceaf8c8829561805660d6fd6b22d85f076c4d4a9ea1`.
It is decoded by the real scoped-read API, matching the NFT/Desk fixture contract.

## Limits

No live Desk binary, testnet or mobile-device qualification was performed here.
Six live-wallet tests remain deliberately skipped. No commits, pushes, package
publication, new wallet requests, deployment, funds, or blockchain transactions
were part of the pre-commit verification. The subsequently authorised local commit
does not change those live-qualification limits.
The local archive is for authorised cross-workspace testing only.


## Independent review correction — identical-evidence notification loop

The initial local candidate had a feedback loop: acknowledgement revalidation
rewrote identical terminal evidence and broadcast a change; a subscriber awaiting
a failed remote acknowledgement then retried immediately on its own write.
The bounded before-fix regression observed three callbacks where one was expected.

The writer now treats a semantically identical merged snapshot (including hash
and final result) as a true transaction no-op: no write, revision/timestamp change,
or BroadcastChannel notification. Monotonic merge validation still runs first.
The regression asserts one failed acknowledgement, unchanged retained evidence,
no self-notification, and a successful later retry wake. A concurrent reordered
identical-evidence test verifies exactly one revision and zero redundant puts.
The new archive in `candidate.json` supersedes the earlier candidate.

## Local commit check

Immediately before committing, the full adapter suite passed again: 704 tests
passed and six existing live tests skipped. Type checking, package build and
`git diff --check` also passed. Runtime source remains byte-identical to the
recorded final archive. Generated archives and unrelated earlier evidence are
excluded from the commit.
