# Adapter native transaction recovery — work package B

## Scope and source alignment

Adapter workspace: /home/james/nova-plugin-wallet-adapter.
Branch: fix/infer-connect-0.2.2-rc.1.
Base: 3824bc3e10edaa776eb5d7088a412544e37b2a99.
Package version remains 0.2.2-rc.1. These changes extend PR #20 and do not
constitute a new published release.

Aligned with the completed local wallet's
/home/james/nova-wallet/docs/NATIVE_TRANSACTION_RECOVERY_CONTRACT.md and its
actual provider template/generated codec on fix/native-transaction-recovery.
Wallet source was read-only during adapter implementation. No wallet or
ecosystem changes, installations, hosted changes or chain writes were performed.

## Public factory and compatibility

Both the package root and /aip62 export:

```ts
createInferNativeRecoveryFeatures(
  selectedWallet: unknown,
  options: Readonly<{ isCurrent(): boolean }>
): InferNativeRecoveryFeatures | null
```

The selected registered object must expose integrationContractVersion:1,
durableInvocationLookup:true, callable raw readInvocation and
acknowledgeInvocation, and compatible cedra account/network and change-listener
features version1.0.0. Unsupported objects return null. No wallet-name inference,
ambient provider discovery or external transport fallback occurs.

The isCurrent predicate is application-owned. It must verify the exact selected
wallet and the captured authoritative application wallet-session revision.
It must not be a constant true callback or merely consult an old React snapshot.
The adapter additionally fences method/feature/capability identity, origin,
disposal, account/network values and account/network event generations.

New submissions additionally require durableInvocationSubmission:true,
transactionRestrictions:true and callable raw signAndSubmitTransaction.
canSubmit() performs the current synchronous capability check. It does not mean
that an application action is eligible. Incapable runtimes retain compatible
read-only lookup; a new submission fails before invocation preparation/dispatch.

The existing wallet-standard methods are unchanged. The wrapper exposes:
- inferenco:transactionSubmission version1.0.0, contractVersion1.
- inferenco:recoveredOutcomes version1.0.0, limited to list, listInvocations,
  read, reconcileInvocation, acknowledge and subscribe.
- canSubmit() and dispose().

Native recovery does not expose relaunch/archive controls. Internal provider
binding helpers are absent from package exports.

## Submission preparation and exact commitment

Use normalizeSubmitInput from the package root to construct the existing
CanonicalTransactionInput. Sender, chain, sequence, absolute expiry and gas
restrictions are preserved; unknown fields remain rejected.

The adapter durably prepares an invocation before calling the awaited
onInvocationPrepared hook. The descriptor includes:
invocationId, requestCommitment, origin, transport:'injected', sessionId, address,
network, chainId, method:'signAndSubmitTransaction', state:'prepared'.

The commitment is lowercase SHA-256 over the agreed canonical representation of:
{contractVersion:1, method, scope:{origin,accountAddress,network,chainId}, payload}.
Tests compare this with the exact compacted transaction sent by the real wallet
provider codec. Invocation ID is not the payload digest. The interface version
is supplied by the feature, not invented from a saved incident report.

The application must await protected persistence and verification of this
descriptor, original transaction constraints and its exact action/generation.
A failed callback prevents dispatch. Scope/generation changes after persistence
also prevent dispatch. Only submission.isNotInvoked(error, exactDescriptor)
proves a pre-dispatch stop for that descriptor. Copying an error or inspecting
its public code alone does not create that proof.

After dispatch, wallet exceptions remain uncertainty. A valid transactionHash
attached to an uncertain native error is retained as exact execution identity;
arbitrary native error text/payloads are not forwarded by the new native path.

## Recovery outcome and acknowledgement

Recovery uses the exact handle 'invocation:' + invocationId; reconcileInvocation
also accepts the invocationId. Foreign/external handles are rejected.

Outcomes retain the existing adapter status/output shape:
- approved: output:{hash}.
- pending/unknown: transactionHash when the wallet has retained one.
- rejected: a verified unmixed decline, without execution evidence.

Native outcomes can additionally carry separately validated
submissionAcceptance:'unknown'|'accepted',
chainStatus:'unknown'|'pending'|'confirmed'|'aborted', and canonical u64
chainVersion for committed observations. Acceptance is not application success.
The wallet supplies transactionHash, not top-level hash, for unresolved execution.

Reads are non-consuming. Exact selected-provider reads are coalesced, with every
consumer independently checking its current scope/generation. Even a locally
cached terminal receipt requires a fresh authenticated native lookup before it
is published, because cached JS account/network fields do not prove that the
wallet's current origin grant is valid. Lookup or validation failure remains
unknown; a prior valid hash may remain available for application reconciliation.

No signing, approval, relaunch or submission occurs during recovery.

Application ordering:
1. Read the exact bound invocation.
2. Verify and durably persist its recovered evidence in the protected journal.
3. Reconcile the exact transaction as required for the action.
4. Explicitly acknowledge terminal evidence only after that persistence.
5. Successfully refresh Casino state before unlocking the action.

For a lost-response wallet record, status may remain unknown while exact chain
evidence is confirmed or aborted. Explicit acknowledgement rereads that evidence,
requires the exact known hash and committed chain status, then asks the wallet
to durably promote/acknowledge its accepted receipt. A committed abort is still
an application failure. Hash-only, pending or unavailable evidence cannot be
acknowledged as terminal.

Remote acknowledgement precedes local delivery acknowledgement. A lost reply or
failed local write remains retryable. Repeated successful acknowledgement is
idempotent. Reading never acknowledges automatically. Subscribers are advisory
and recheck the captured wallet generation immediately before invoking application
callbacks. Consumer persistence/acknowledgement remains explicit.

## Consumer example

The functions supplying current selection/context below belong to the host app,
not this package.

```ts
import { createInferNativeRecoveryFeatures } from
  "@inferenco/infer-wallet-adapter/aip62";
import { normalizeSubmitInput } from "@inferenco/infer-wallet-adapter";

const selected = getCurrentWallet();
const revision = getAuthoritativeWalletContextRevision();
const native = createInferNativeRecoveryFeatures(selected, {
  isCurrent: () => getCurrentWallet() === selected &&
    getAuthoritativeWalletContextRevision() === revision
});
if (!native || !native.canSubmit()) {
  // Show capability/update guidance before creating a new protected action.
  return;
}
const submission = native["inferenco:transactionSubmission"];
await submission.signAndSubmitTransaction(normalizeSubmitInput(input), {
  onInvocationPrepared: async descriptor => {
    await applicationJournal.persistAndVerifyBinding(action, descriptor);
  }
});

// On reload/reconnect, create a wrapper for the current authorized selection.
const recovery = native["inferenco:recoveredOutcomes"];
const outcome = await recovery.read("invocation:" + savedDescriptor.invocationId);
await applicationJournal.persistAndVerifyEvidence(action, outcome);
// The application checks terminal acceptance/chain evidence, never just a hash.
if (hasVerifiedTerminalEvidence(outcome)) {
  await recovery.acknowledge(outcome.recoveryId);
}
await reconcileExactTransactionAndRefreshCasino(action, outcome);
// Retire when the host wallet context is replaced:
native.dispose();
```

## Legacy and failure boundaries

A missing native row, unavailable capability, HTTP404, unchanged balances,
expired transaction or elapsed time never proves non-submission. Historical
records without enough identity remain unresolved. Existing external Infer
Connect recovery/submission behavior remains on its original route.

Fixed new boundary messages include native-wallet-context-changed,
native-wallet-generation-changed, native-wallet-scope-mismatch,
native-durable-submission-unavailable, native-recovery-handle-mismatch,
native-outcome-not-terminal, native-submission-uncertain and
native-result-persistence-failed. These are diagnostics, not retry authority.

The ecosystem work package A still owns protected action binding, recovered
evidence persistence, exact application-effect reconciliation, safe legacy
handling, Casino refresh and user-facing diagnostics.

## Validation

The initial13selected-native regressions failed because the factory was absent.
Focused regressions cover actual registered provider/codec integration, exact
commitment, awaited app binding, lost responses, recreated consumers,
unsupported durability with compatible lookup, stale account/network/selection,
mixed snapshots, preparation/storage failures and uncertain writes,
malformed/conflicting evidence, read coalescing and explicit acknowledgement.

The actual wallet-script tests run entirely from the adapter workspace using
INFER_WALLET_WORKSPACE=/home/james/nova-wallet. They read the existing template
and generated codec; native host responses and RPC results are fixtures.
They do not run wallet builds/tests, prove Android storage durability or submit
transactions. Full suite/typecheck/build and package-export results are recorded
in the final validation evidence next to this document.

No lint command/configuration is defined in this package. Type checking and
git diff --check are required.

No wallet installation, browser/device Casino acceptance, live-chain operation,
package publication or ecosystem dependency adoption is established here.
Those remain separate acceptance/release work. One user approval -> interrupted
response -> reopened Casino -> same outcome and no duplicate submission must
still be verified with the compatible wallet/adapter/ecosystem builds.


## Native non-submission evidence — 22 October 2026

Wallet's built-in browser can retain a proved failure before its durable signed-identity checkpoint. The native read envelope uses the existing version, invocation, commitment, method and scope, with `status: "unknown"`, `submissionDisposition: "not-submitted"`, and `failureCode: "EXECUTION_FAILED_BEFORE_BROADCAST"`. It contains no hash, payload, acceptance or chain fields. It is not a user rejection or independent chain non-inclusion proof.

The adapter strictly validates this envelope, recomputes the original payload commitment, checks the current selected wallet/account/network, and atomically retains the proof before returning it or notifying subscribers. Unknown or contradictory native results cannot clear it, fabricate an approval, or overwrite a signed identity. Cached proof alone cannot establish current native authorization; lookup and acknowledgement require the original live scope and a matching fresh read.

Consumers persist the distinct terminal outcome before explicitly acknowledging its opaque recovery handle. The adapter revalidates the proof, calls the same wallet's scoped `acknowledgeInvocation`, validates the returned envelope, and only then records local acknowledgement. Failed remote acknowledgement or local writes retain retryable debt. No optional-capability downgrade waives this requirement for a proof. A verified native failure cannot be archived as uncertainty; acknowledged delivery tombstones follow the existing retention policy. Reading and acknowledging never sign, submit, reopen a connection or launch a replacement request.

This is generic adapter behavior, separate from external mobile-relay local acknowledgement and Desktop remote-result acknowledgement. Local tests use native provider fixtures and IndexedDB; real-device acceptance remains separate. Existing Infer NFT consumers must adopt the resulting adapter build before receiving this behavior.
