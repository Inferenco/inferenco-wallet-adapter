# Recovery status and connection settlement (point 7)

## Scope

Adapter-only local implementation on `fix/infer-connect-0.2.2-rc.1`. No version,
dependency, lockfile, wire format or relay changes. Ecosystem artifact adoption is
point 8; building this repository does not update its pinned dependency.

## Recovery evidence contract

The public recovery fields remain compatible. Consumers must interpret them separately:

| Evidence | Meaning |
| --- | --- |
| `status: pending`, no transaction hash | The original wallet request is pending; there is no known transaction identity. |
| A valid `transactionHash` with absent/unknown `chainStatus` | The exact transaction is known; its current chain outcome is unproven. |
| `chainStatus: pending` with exact identity | An authenticated current read explicitly observed the transaction pending at the node. |
| `chainStatus: confirmed`, exact identity and `chainVersion` | A committed successful transaction was observed. |
| `chainStatus: aborted`, exact identity and `chainVersion` | A committed failed transaction was observed. |
| `submissionDisposition: not-submitted` | Authenticated evidence proves this invocation failed before broadcast. |

`status: approved` and `submissionAcceptance: accepted` do not alone prove chain
success. Native reads reject a claimed node-pending status without an exact hash.
Saved hashes, accepted submissions and committed results remain retained. Node
pending is transient: cached external evidence projects it as unknown, and a new
unknown observation cannot inherit an earlier pending observation.

## Connection ownership

- One pending `InferClient.connect()` operation per client; overlapping callers
  share it and cannot create duplicate approvals.
- Disconnect/disposal cancel the local waiter. Late provider, network and mobile
  pairing completions cannot reactivate its account cache. A pending disconnect
  rejects a new connect until its cleanup finishes.
- Native account/network publication is atomic after both reads complete.
- Provider callbacks are fenced by subscription lifetime and provider identity.
- `InferWallet.connecting` belongs to its active operation, including subscription
  setup; a cancelled operation cannot clear or repopulate a replacement.
- A delayed mobile pairing approval must still own the exact pending pairing and
  token before session storage changes. An obsolete reply cannot erase a newer
  pending pairing.
- HTTP pairing recovery remains independent of WebSocket readiness.

No new approval timeout is introduced. A native provider that never resolves
still needs explicit disconnect/disposal; the adapter can settle its own waiter
and fence the late result but cannot cancel an unsupported remote native request.
Existing mobile polling deadlines remain unchanged. Recovery does not submit,
re-sign or reopen a wallet by default.

## Local validation

Regressions were observed before the corresponding repairs: duplicate connection
approvals, unresolved cancelled waits, partially published account state, stale
account callbacks, and stale pending chain claims. Coverage also includes late
pairing ownership loss/replacement, pre-connect subscriptions, conflicting cleanup,
public connecting flags, all five recovery evidence cases and HTTP progress while
a socket never opens.

Local suites, TypeScript and package build are recorded in the completion report.
No physical-device, hosted relay, published artifact or live-chain acceptance is
claimed. Changes are left uncommitted and unpushed.
