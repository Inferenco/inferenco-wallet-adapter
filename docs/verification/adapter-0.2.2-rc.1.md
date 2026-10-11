# Adapter 0.2.2-rc.1 verification

Verified locally on 11 October 2026. This candidate contains Infer Connect v1 integration and recovery repairs, preserves preauth capabilities, fixes ESM/CommonJS declaration routing, and updates the Cedra TypeScript SDK baseline to ^2.2.9 (lockfile: 2.2.9).

## Automated checks

- Adapter suite: 476 passed, 6 skipped (five opt-in live bridge checks and one disabled smoke case).
- Typecheck and production package build passed.
- All three public entrypoints load under ESM and CommonJS.
- Six packed behavioral groups passed in each runtime format.
- Strict Bundler and strict NodeNext CommonJS declaration checks passed against the actual installed package exports.
- Clean NFT headless and Vite consumers passed against the packed candidate, including recovery and retention checks using a synthetic bridge.
- NFT SDK update checks: 1,437 tests passed, 3 skipped; workspace/tools typechecks and production build passed.
- Wallet SDK update checks: 327 tests passed; typecheck and provider consistency passed.

The package regression is tests/package/packed-exports.mjs. Run it against an isolated consumer containing an installed archive, TypeScript and Node type declarations:

    node tests/package/packed-exports.mjs /absolute/consumer --expect-sdk-eventemitter-error

The flag asserts the exact independently reproduced SDK failure; it does not label strict ESM compilation as passing. Omit it when checking a corrected SDK release.

## Pre-existing strict ESM limitation

A same-compiler comparison using TypeScript 5.9.3, strict NodeNext ESM, and skipLibCheck=false produced:
- Published adapter 0.2.1 with SDK 2.2.8: four TS2507 errors, two in adapter declarations and two in SDK declarations.
- SDK 2.2.8 alone: the same two SDK errors.
- Repaired adapter with SDK 2.2.9: the two SDK errors remain; the adapter errors are fixed.

This is an existing compatibility limitation under that compiler configuration, not a newly introduced runtime regression. SDK declaration files api/transactionSubmission/management.d.mts and transactions/management/transactionWorker.d.mts default-import EventEmitter. Changing those imports to named imports in an isolated consumer makes the full package regression pass without skipLibCheck. The corresponding proposed upstream source changes are in src/api/transactionSubmission/management.ts and src/transactions/management/transactionWorker.ts. The SDK source rebuild/test/release has not been performed, and the workspace SDK has not been patched.

## Native scope

Android Wallet message approval, explicit rejection and page-reload recovery were exercised on a physical device and accepted by the user. Windows Desk 0.6.3 external-browser message approval, rejection, page-reload recovery and retrieval of the original completed invocation after a real process restart passed. These native sessions used earlier recorded archives/dependencies; they are not a fresh device qualification of SDK 2.2.9.

Adapter JavaScript and declarations in the final candidate are byte-identical to the preceding Desk-qualified package; changes since that package are conditional declaration export routing and the SDK dependency baseline. The dependency update still requires a fresh Wallet build/device check for exact-artifact acceptance. Broader embedded Desk, transaction, restriction and peer/platform matrices are not claimed.

## Candidate identity and release handoff

- Package: @inferenco/infer-wallet-adapter@0.2.2-rc.1
- Archive SHA256: 6ea59916166ea2bd1640f7705638afc330e1e2dff51122943fd807d7fc96b343
- Archive size: 281,475 bytes
- Runtime and declaration files plus package.json matched the tested archive before commit.

The branch/PR handoff does not publish npm artifacts or merge main. Package publication is left to the maintainer. Rebuilding after documentation changes can change the archive hash; verify the final published artifact separately. The existing SDK limitation should remain visible in release notes.
