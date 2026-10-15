# Adapter 0.2.2-rc.2 local artifact qualification

This unpublished candidate packages the completed connection and transaction recovery source at b72306fea767ebf34689ab14dea981544d5bd38e. Its only packaged local delta is the version change to 0.2.2-rc.2. The supplied version-only.patch also includes the matching root lockfile metadata update. Source files and dependency versions are unchanged.

## Artifact

- Name: @inferenco/infer-wallet-adapter
- Version: 0.2.2-rc.2
- Archive: /tmp/point8-adapter-20261014/inferenco-infer-wallet-adapter-0.2.2-rc.2.tgz
- SHA256: 4aa4403abb61836c6bce8bd71e86d63f1f52f133476135620dd29dafa563cf77
- SHA512 npm integrity: sha512-2mdtU0aSgayuxcxXDIspxvJSTzHCcnJdxR0Q735PzyV3pP6tlziKkjvdQ27zZZtIBjTBStIGuIdRIEGFXRXpJg==
- Version patch SHA256: 560ea0fb8db8317e428584a93a9b964e75b882560485f83e6ad53f0dccdaa605
- SDK remains 2.2.9; the complete dependency lock closure is unchanged.

artifact-provenance.json records source identity, patch identity, archive integrity and a SHA256 inventory of every packaged file. Every installed file in the isolated consumer matched this inventory. qualification.json records the local gates and current Wallet provider source used read-only.

## Local validation

- Full Adapter suite: 581 passed, 6 deliberately skipped live/Desk cases.
- Typecheck and ESM/CommonJS/declarations build passed.
- All three installed public entrypoints load under ESM and CommonJS.
- Strict Bundler and NodeNext CommonJS consumer compilation passed, including the native recovery factory and feature types.
- 27 installed-package registered-provider and connection tests passed without skips. These execute the current Wallet provider template and generated codec; only the React Native host response boundary is synthetic.
- No linter is configured. Both package qualification JavaScript runners pass node --check.
- The first unrestricted full run had one timing-sensitive failure: a real-time 20ms hidden desktop poll performed 3 reads rather than the expected 2. The isolated 17-case suite passed, then the full suite passed with maxWorkers=2. No runtime logic or assertion was changed to hide this result.

### Existing SDK declaration limitation

Strict NodeNext ESM with skipLibCheck=false still fails on the same two SDK 2.2.9 EventEmitter declarations. The same compiler, TypeScript 5.9.3, reproduces both diagnostics using an SDK-only import. The Adapter adds no errors. This is a documented pre-existing SDK compatibility limitation, not a passing strict ESM gate. The SDK remains unmodified.

## Reproduce against the installed archive

The isolated consumer is /tmp/point8-adapter-20261014/consumer. It was installed offline from the existing locked dependencies and this exact archive.

    node tests/package/packed-exports.mjs /tmp/point8-adapter-20261014/consumer --expect-sdk-eventemitter-error
    node tests/package/packed-native-recovery.mjs /tmp/point8-adapter-20261014/consumer

The first runner discovers the installed package version instead of reporting a hardcoded prior candidate. The second rewrites only test imports to the installed public exports and rejects remaining private source imports. The tests do not alias the Adapter source.

## Original qualification acceptance boundary

Ecosystem owns the combined installed external HTTP recovery and application-state checks and records those separately. No Wallet code, device data, relay configuration or chain state was changed here. No package was published and no commit, push or PR update was performed. Physical-device acceptance remains point 9.

## Delivery verification - 15 October 2026

The original qualification above records the 14 October checkpoint. The maintainer subsequently authorized committing and pushing the completed Adapter work and updating PR #20. Package publication remains separate.

- Fresh typecheck, ESM/CommonJS/declaration build and diff checks passed.
- The full suite returned 580 passed, 1 failed and 6 skipped: the same documented real-time hidden desktop poll expected 2 reads and observed 3. Its isolated 17-test suite passed. This delivery run is not recorded as an all-green full suite; the timing-sensitive test remains a known limitation.
- Recreated an isolated offline consumer from the existing lockfile and a newly packed rc.2 archive because the earlier temporary consumer had been removed. All 27 installed-package registered-provider and connection cases passed, with no skipped cases.
- ESM/CommonJS runtime entrypoints, strict Bundler and NodeNext CommonJS declarations passed. Strict NodeNext ESM reproduced only the same two upstream SDK EventEmitter errors, also reproduced by an SDK-only import.
- No Adapter runtime source or dependency versions changed during delivery. The stored provenance and qualification JSON retain their original artifact/checkpoint identities.
- These checks do not establish physical-device interrupted-response recovery or live-chain acceptance.
