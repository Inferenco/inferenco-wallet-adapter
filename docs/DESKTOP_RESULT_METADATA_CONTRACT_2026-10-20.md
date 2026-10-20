# Desktop result metadata compatibility

Local repair, 20 October 2026. No publication or live-wallet acceptance is implied.

The desktop combined-submission poll accepts the legacy `status`, `requestId`,
`hash` approval and the shipped Desk envelope with `integrationContractVersion: 1`
and an optional `capabilities` object. The metadata describes the producer; it
never proves submission or authorizes a retry.

Capabilities are optional booleans for `transactionRestrictions`, `completeResults`,
`durableInvocationLookup`, `durableExternalSubmissionRecovery`, and
`durableInvocationSubmission`; `messageProfile`, when present, must equal
`cedra:message:v1`. Unknown capability keys fail closed until explicitly supported.
Capabilities without version 1, malformed values, unexpected top-level approval or
rejection keys, mixed error/success fields, and mismatched request IDs remain
`REQUEST_OUTCOME_UNKNOWN`. Null-valued success material on a rejection is still
contradictory. Sign-only results retain their existing account/bytes validation;
legacy sign-only routes may still omit their echoed request ID.

Validated approvals/rejections are saved before the live call returns. The
separately authorized read-result envelope retains its existing identity,
commitment and payload validation; it is not made permissive by this repair.
Mobile relay and injected provider validators are unchanged.

## Evidence

- Added regression first failed on the original decoder: three versioned approvals
  and one clean versioned rejection.
- After repair: full adapter suite 639 passing, six live tests intentionally skipped;
  type check and package build passed.
- Durable tests cover failed receipt writes and lost direct delivery, replacement
  tab recovery and local replay with exactly one transaction POST.
- `scripts/qualify-desktop-package.mjs` uses only public package exports from an
  extracted npm archive, consuming the actual Desk Rust route fixture. It checks
  six producer cases, two lost-delivery cases, and twelve derived legacy, malformed-envelope and failed-persistence cases (20 total). Unexpected requests
  fail; no real network or wallet is used.

Run the package check with existing WSL Node tooling:

```sh
node scripts/qualify-desktop-package.mjs /absolute/extracted/package \
  tests/fixtures/desktop-transaction-responses-v1.json
```

The application has a private local artifact `0.3.0-rc.2-local.20261020`, pinned by
archive integrity and a recorded source patch over `641782a18a25e076ebc9ffed8e2b2f662b791d12`.
That archive preserves the earlier source-package baseline; the current branch now prepares `0.3.1-rc.1`. Its local archive
manifest overrides the version, marks it private, and removes lifecycle scripts.
No published 0.3.0-rc.1 artifact has been replaced.

The completion audit extended the packed harness without changing the archive or
production source. Wrong/missing IDs, invalid hashes, unsupported/malformed
metadata, mixed results and null success fields remain unknown on both direct
return and read-only recovery. An injected IndexedDB final-write failure returns
unknown, then recovers and persists the original hash with exactly one POST.

Sign-only transaction and real Ed25519 message tests now exercise both legacy
and metadata-bearing Desk replies: 98 tests pass across the two suites, including
13 additional versioned cases. This supplements the earlier 639-test full suite;
the full suite was not rerun for test-only changes.

## 0.3.1-rc.1 branch handoff

The candidate updates the root manifest and lockfile to `0.3.1-rc.1`. The earlier
private application archive remains historical evidence and is not repacked or
repinned by this adapter release preparation. The standalone fixture copied into
`tests/fixtures/desktop-transaction-responses-v1.json` is byte-identical to the Desk
Rust-produced fixture used during qualification (SHA256 `942fb1bdd5c315c8ace7cbc4b8620e87540b70afc7c72310bca981cfad917610`).

For this candidate the complete suite was rerun: **652 tests pass, six live tests
skip**; typecheck and build pass. All **20 extracted-package qualification cases**
pass against the versioned archive. The extracted archive used the existing
lockfile-installed runtime dependencies via a temporary `node_modules` symlink;
install the declared dependencies before reproducing the standalone archive check.
See [verification identities](verification/adapter-0.3.1-rc.1/verification.json) and
[package case results](verification/adapter-0.3.1-rc.1/desktop-package-qualification.json).
No package publication or live-wallet acceptance is implied.
