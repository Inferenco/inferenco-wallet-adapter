# Stale-session reconnect repair — local verification

Date: 22 October 2026

Branch: `fix/infer-connect-stale-session-reconnect`

Base: fetched `origin/fix/infer-connect-0.2.2-rc.1`, commit `e3b5c8572e6de72be7a2e5f4c88ec72cf85d2708` (package version `0.3.0-rc.2`). The branch name and package version are distinct. This is an unreleased local patch; the manifest version was not changed.

## Reproduction and boundary

When session health fails with a browser-hidden CORS/network error, retaining the session record is intentional: previously submitted requests may still need recovery. However, desktop preauth raced its fresh approval poll against a waiter that immediately returned that retained, unvalidated session. Connection therefore appeared successful before approval; later message signing could not find a valid session and returned `UNSUPPORTED` without contacting Desk.

Before production edits, the existing targeted baseline passed 81 tests. The added real-fetch-fixture regression failed in both stale-session cases because connection resolved while fresh approval was still held. Readable-404 and empty-cache controls passed unchanged.

## Narrow repair

- Capture the cached session before validation.
- Only when a fresh desktop preauth request is needed, exclude that unvalidated session from the peer/callback/storage waiter.
- Compare transport, session ID and bridge URL. Changing display metadata cannot turn the excluded session into approval.
- Apply exclusion to immediate, event, polling and timeout results. Timeout resolves null if only the excluded session remains.
- Keep fresh own-request approval and fresh peer-tab approval working.
- Preserve the cached record for recovery; do not clear transaction journals.

The optional waiter argument is additive. Existing callers that do not supply it retain their previous behavior. This repair is limited to the desktop preauth path; it does not redesign legacy cold-start handoff, mobile pairing, signing formats, error classification or uncertain transaction recovery.

## Protected behavior and evidence

`tests/staleSessionReconnect.test.ts` adds six cases: CORS-hidden stale session, readable 404, empty cache, fresh peer-tab approval with retained stale state, stale metadata replay/timeout, and healthy cached-session reuse.

The three full reconnect cases also assert that no window or deeplink opens, current-tab location stays unchanged, and dapp disconnect sends exactly one DELETE to the newly approved token-prefixed connection endpoint, with the correct origin/address/network. Local disconnect is emitted once and cached connection state clears.

The existing first-time Local Network Access abort/retry test still passes. Existing token grafting, disconnect fallback, multi-tab approval, connection settlement, mobile, message signing, transaction signing and durable recovery tests remain in the full suite.

Commands and observed results:

```sh
npm test -- tests/preauth_multitab_rc23.test.ts tests/bridge/preauth.test.ts tests/bridge/transparent_deeplink.test.ts tests/bridge/session_url_token.test.ts tests/connectionSettlement.test.ts tests/bridge.test.ts tests/client.test.ts
# Before repair: 81 passed.

npm test -- --maxWorkers=4
# After repair: 658 passed, 6 skipped; 44 files passed, 1 skipped.

npm run typecheck
# Passed.

npm run build
# ESM, CJS and declarations passed.
```

The actual local npm archive was extracted and its public ESM entrypoint checked against the earlier offline reproduction, updated to require correct behavior. CORS-hidden failure, readable 404 and clean cache all waited for fresh approval, retained the newly approved session and passed live-health simulation. See `stale-session-reconnect-results.json` for archive integrity and results. The extracted archive used existing installed dependencies: this is packed-output verification, not an independent clean-install qualification. CJS was built but this offline scenario was executed through ESM.

## Remaining qualification

No running Desk/browser session was exercised for this patch. The six skipped tests require an explicitly configured live wallet. Local fetch assertions prove the adapter sends revocation correctly; they do not prove the installed Desk UI reacts. Do not label this native-app acceptance.

Before release, manually qualify first connection in the original tab (including browser local-network consent), stale-session reconnect after Desk restart, ownership-message signing, dapp disconnect reflected in Desk, reconnect, and valid peer-tab approval. Keep wallet rejection, account/network changes and unresolved transaction recovery in the release matrix. No extra transaction should be submitted solely for connection qualification.

No NFT project source change, Desk change, package publication, commit, push, funding or blockchain transaction was performed for this repair. Existing unrelated untracked `docs/evidence/` was preserved.
