import { detectProvider, nativeProviderBinding, nativeRecoveryKey } from "./provider";
import {
  canonicalAddress,
  encodeWireValue,
  requestCommitment
} from "./integrationContract";
import type {
  CedraSignAndSubmitTransactionOutput,
  CedraSignMessageOutput,
  CedraSignTransactionOutputV1_1
} from "@cedra-labs/wallet-standard";
import { BridgeHttpError, readExternalSession, readDesktopBridgeRequestOnce, readResultForSession,
  lookupDesktopInvocation,
  acknowledgeDesktopResult
} from "./bridge";
import { archivePendingDesktopBridgeRequest, clearPendingDesktopBridgeRequest, desktopBridgeOrigin, readPendingDesktopBridgeRequests, type RecoverableMethod } from "./desktopRequests";
import {
  listDurableRequests, listDurableInvocations, getDurableInvocation, findDurableRequests, saveDurableRequest, saveDurableFinal, serializeStoredFinal, transitionDurableRequest,
  updateDurableInvocation,
  saveDurableTransactionHash,
  saveDurableExternalTransactionRecovery,
  updateInjectedInvocationEvidence,
  type DurableRequest,
  type DurableInvocation,
  type StoredFinal
} from "./durableRecovery";
import {
  normalizeSignMessageOutput,
  verifySignedMessageOutput,
  deserializeSignTransactionResult,
  normalizeNetwork
} from "./conversion";
import { InferAdapterError, InferErrorCode, isValidTransactionHash } from "./errors";
import { decryptJson } from "./mobileCrypto";
import {
  decodeMobileRelayResult,
  getReadGrant,
  mintReadGrant,
  launchMobileRelayRecoveryRead,
  readMobileRelayRequestOnce,
  reconcileMobileRelayInvocationReceipt,
  relaunchMobileRelayInvocation,
  type ReadGrantDescriptor,
  type ReadGrantScope
} from "./mobileRelay";
import { archivePendingMobileRelayRequest, clearPendingMobileRelayRequest, readPendingMobileRelayRequests } from "./mobileRequests";
import { makeRecoveryArchive, type RecoveryArchive } from "./requestArchive";
import { validateExternalTransactionRecovery, type ExternalTransactionRecovery } from "./externalTransactionRecovery";
import type { InferExternalSession, InferWalletOptions } from "./types";

export interface RecoverableRequest {
  origin: string;
  requestCommitment?: string;
  /** Opaque, stable handle for this original invocation and session. */
  recoveryId: string;
  requestId: string;
  method: RecoverableMethod;
  transport: "mobile-relay" | "desktop-bridge" | "injected";
  sessionId: string;
  address: string;
  network: string;
  chainId: number;
  invocationId?: string;
}

export interface ArchivedRecoverableRequest extends RecoverableRequest, RecoveryArchive {}
export interface RecoverableInvocation {
  origin: string;
  requestCommitment?: string;
  invocationId: string;
  transport: "mobile-relay" | "desktop-bridge" | "injected";
  sessionId: string;
  address: string;
  network: string;
  chainId: number;
  method: RecoverableMethod;
  /** Prepared means dispatch may be unknown after a crash; never infer no submission. */
  state: "prepared" | "created" | "unknown" | "not-invoked";
  requestId?: string;
  failureReason?: string;
}

export function invocationDescriptor(row: DurableInvocation): RecoverableInvocation {
  return {
    invocationId: row.id,
    origin: row.origin,
    requestCommitment: row.requestCommitment, transport: row.transport, sessionId: row.sessionId,
    address: row.address, network: row.network, chainId: row.chainId,
    method: row.method, state: row.state,
    ...(row.requestId ? { requestId: row.requestId } : {}),
    ...(row.failureReason ? { failureReason: row.failureReason } : {})
  };
}

export async function listRecoverableInvocations(): Promise<RecoverableInvocation[]> {
  if (typeof window === "undefined") return [];
  return (await listDurableInvocations()).map(invocationDescriptor);
}

/** Reconcile the original mobile invocation after an interrupted POST.
 * The lookup is authenticated and read-only; it never creates or launches
 * another wallet request. A verified final is saved before return. */
export async function reconcileRecoverableInvocation(
  invocationId: string,
  options: InferWalletOptions = {}
): Promise<RecoveredInvocationOutcome> {
  if (typeof window === "undefined") {
    throw new InferAdapterError(InferErrorCode.Unsupported, "Recovery requires a browser");
  }
  const invocation = await getDurableInvocation(invocationId);
  if (!invocation) {
    throw new InferAdapterError(InferErrorCode.Unauthorized,
      "Invocation is not bound to this browser origin");
  }
  if (invocation.requestId && invocation.transport !== "injected") {
    try {
      const linked = await findDurableRequests(invocation.requestId, invocation);
      if (linked.length !== 1) throw new Error("Original invocation receipt is unavailable");
      return await readRecoverableRequest(linked[0]!.id, options);
    } catch {
      // A receipt may have been saved before the durable request was created.
    }
  }
  if (invocation.state === "not-invoked") {
    return { invocationId, status: "unknown", reason: "request_not_invoked" };
  }
  if (invocation.transport === "injected")
    return readInjectedInvocation(invocation, options);
  if (invocation.transport === "desktop-bridge") {
    const session = readExternalSession();
    if (!session || session.transport !== "desktop-bridge")
      return {
        invocationId,
        status: "unknown",
        reason: "original_scope_unavailable"
      };
    try {
      const pending = await lookupDesktopInvocation(
        invocation,
        session,
        options
      );
      if (!pending)
        return {
          invocationId,
          status: "unknown",
          reason: "invocation_identity_mismatch"
        };
      await saveDurableRequest(pending, invocation.id);
      await updateDurableInvocation(
        invocation.id,
        "created",
        pending.requestId
      );
      return await readRecoverableRequest(pending.requestId, options);
    } catch {
      return {
        invocationId,
        status: "unknown",
        reason: "invocation_reconciliation_unavailable"
      };
    }
  }
  if (invocation.transport !== "mobile-relay" || !invocation.mobileRequest) {
    return { invocationId, status: "unknown", reason: "invocation_lookup_unavailable" };
  }
  const session = readExternalSession();
  if (!session || session.transport !== "mobile-relay" ||
      session.sessionId !== invocation.sessionId ||
      session.address !== invocation.address ||
      session.network !== invocation.network ||
      session.chainId !== invocation.chainId) {
    return { invocationId, status: "unknown", reason: "original_session_unavailable" };
  }
  try {
    const { pending } = await reconcileMobileRelayInvocationReceipt(
      invocation, session, options
    );
    return await readRecoverableRequest(pending.requestId, options);
  } catch (error) {
    const reason = error instanceof BridgeHttpError && error.status === 404
      ? "invocation_lookup_unavailable"
      : error instanceof InferAdapterError && error.code === InferErrorCode.Unauthorized
        ? "invocation_identity_mismatch"
        : "invocation_reconciliation_unavailable";
    return { invocationId, status: "unknown", reason };
  }
}

/** An explicit retry control may reopen only the already reconciled pending
 * request. This never repeats creation or signs anything in the adapter. */
export async function relaunchRecoverableInvocation(
  invocationId: string,
  options: InferWalletOptions = {}
): Promise<void> {
  const invocation = await getDurableInvocation(invocationId);
  if (!invocation || invocation.transport !== "mobile-relay" || !invocation.requestId) {
    throw new InferAdapterError(InferErrorCode.Unauthorized,
      "Reconcile the original mobile request before relaunch");
  }
  const session = readExternalSession();
  if (!session || session.transport !== "mobile-relay") {
    throw new InferAdapterError(InferErrorCode.Unauthorized,
      "Original mobile relay session is unavailable");
  }
  const outcome = await readRecoverableRequest(invocation.requestId, options);
  if (outcome.status !== "pending") {
    throw new InferAdapterError(InferErrorCode.InvalidParams,
      "Only a pending original request can reopen its wallet approval");
  }
  await relaunchMobileRelayInvocation(invocation, session, options);
}


export type RecoveredInvocationOutcome =
  | RecoveredRequestOutcome
  | { invocationId: string; status: "unknown"; reason: string };

export type RecoveryReadOptions = Readonly<{
  /** Explicit user action only; background reads never open the wallet. */
  allowMobileRecoveryHandoff?: boolean;
}>;

export type NativeExecutionEvidence = Readonly<{
  submissionDisposition?: "not-submitted";
  failureCode?: "EXECUTION_FAILED_BEFORE_BROADCAST";
  submissionAcceptance?: "unknown" | "accepted";
  chainStatus?: "unknown" | "pending" | "confirmed" | "aborted";
  chainVersion?: string;
}>;
export type RecoveredRequestOutcome = (
  | (RecoverableRequest & { status: "pending"; transactionHash?: string })
  | (RecoverableRequest & { status: "approved"; output:
        | CedraSignMessageOutput
        | CedraSignTransactionOutputV1_1
        | CedraSignAndSubmitTransactionOutput;
    })
  | (RecoverableRequest & { status: "rejected" })
  | (RecoverableRequest & { status: "unknown"; reason: string; transactionHash?: string })
) & NativeExecutionEvidence;

const inFlight = new Map<string, Promise<RecoveredRequestOutcome>>();

function descriptor(row: DurableRequest): RecoverableRequest {
  return {
    recoveryId: row.id,
    origin: row.origin,
    requestCommitment: row.requestCommitment, requestId: row.requestId, method: row.method,
    transport: row.transport, sessionId: row.sessionId, address: row.address,
    network: row.network, chainId: row.chainId,
    ...(row.invocationId ? { invocationId: row.invocationId } : {})
  };
}

/** Returns true iff the current session can authenticate an
 * authenticated remote read of the row via the original session's
 * token. Distinct from the broader "same scope" check used below for
 * the authorized-read path: matchingSession requires the sessionId to
 * match the original sessionId. */
function matchingSession(row: DurableRequest, session: InferExternalSession | null, options: InferWalletOptions = {}): session is InferExternalSession {
  if (!session || session.transport !== row.transport || session.sessionId !== row.sessionId ||
      session.address !== row.address || session.network !== row.network ||
      session.chainId !== row.chainId) return false;
  if (row.transport === "mobile-relay") {
    return (
      row.endpoint === session.relayBaseUrl &&
      typeof session.dappSessionToken === "string" && typeof session.sharedSecret === "string"
    );
  }
  try {
    return desktopBridgeOrigin(session, options) === row.endpoint;
  } catch {
    return false;
  }
}

/** Returns true iff the current session has matching (origin,
 * transport, accountAddress, network, chainId) for the row's stored
 * scope — i.e. the SAME wallet identity is alive on a NEW sessionId.
 * This is the precondition for the v0.2.0-rc.22 authorized-read
 * recovery path (A1): the dapp may mint a read-grant over the OLD
 * request, the wallet (W2) re-wraps the ciphertext under the NEW
 * sharedSecret, and the dapp decrypts with the current sharedSecret.
 *
 * Does NOT require the original `sessionId` to be alive.
 */
function sameScope(row: DurableRequest, session: InferExternalSession | null): session is InferExternalSession {
  if (!session) return false;
  if (session.transport !== row.transport) return false;
  if (session.address.toLowerCase() !== row.address.toLowerCase()) return false;
  if (session.network !== row.network) return false;
  if (session.chainId !== row.chainId) return false;
  return window.location.origin === row.origin;
}

async function migrateCurrentTab(session: InferExternalSession | null, options: InferWalletOptions): Promise<void> {
  if (!session) return;
  let legacy: Array<DurableRequest["pending"]>;
  try {
    legacy = session.transport === "mobile-relay"
      ? readPendingMobileRelayRequests(session)
      : readPendingDesktopBridgeRequests(session, options);
  } catch (error) {
    // Existing durable records remain usable if old tab storage is unavailable.
    if (error instanceof InferAdapterError) return;
    throw error;
  }
  for (const pending of legacy) {
    await saveDurableRequest({ ...pending, origin: window.location.origin }, pending.invocationId);
  }
}

async function records(options: InferWalletOptions): Promise<DurableRequest[]> {
  if (typeof window === "undefined") return [];
  await migrateCurrentTab(readExternalSession(), options);
  return listDurableRequests();
}

async function exactRecord(id: string, options: InferWalletOptions): Promise<DurableRequest> {
  await migrateCurrentTab(readExternalSession(), options);
  return findExact(await findDurableRequests(id), id);
}

function findExact(rows: DurableRequest[], id: string): DurableRequest {
  const matches = rows.filter((row) => row.id === id || row.requestId === id);
  if (matches.length !== 1) {
    throw new InferAdapterError(
      matches.length > 1 ? InferErrorCode.InvalidParams : InferErrorCode.Unauthorized,
      matches.length > 1
        ? "Request ID is ambiguous across wallet sessions; use its recoveryId"
        : "Request is not bound to this browser origin"
    );
  }
  return matches[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function externalEvidenceFields(evidence: ExternalTransactionRecovery): NativeExecutionEvidence & { transactionHash?: string } {
  return {
    ...(evidence.transactionHash ? { transactionHash: evidence.transactionHash } : {}),
    ...(evidence.submissionAcceptance ? { submissionAcceptance: evidence.submissionAcceptance } : {}),
    ...(evidence.chainStatus ? { chainStatus: evidence.chainStatus } : {}),
    ...(evidence.chainVersion ? { chainVersion: evidence.chainVersion } : {}),
    ...(evidence.status === "not-submitted" ? { submissionDisposition: "not-submitted" as const, failureCode: evidence.failureCode } : {})
  };
}
function externalOutcome(row: DurableRequest): RecoveredRequestOutcome | null {
  if (!row.externalTransactionRecovery) return null;
  try {
    const evidence = validateExternalTransactionRecovery(row.externalTransactionRecovery, row);
    const fields = externalEvidenceFields(evidence);
    return evidence.status === "approved"
      ? { ...descriptor(row), ...fields, status: "approved", output: { hash: evidence.transactionHash! } }
      : { ...descriptor(row), ...fields, status: "unknown", reason: evidence.status === "not-submitted" ? "transaction_not_submitted" : "original_execution_unresolved" };
  } catch { return null; }
}
/** Cached evidence stays useful when the wallet is temporarily unavailable. */
function uncertainExecution(row: DurableRequest | DurableInvocation): NativeExecutionEvidence & { transactionHash?: string } {
  try {
    if ("pending" in row && row.externalTransactionRecovery)
      return externalEvidenceFields(validateExternalTransactionRecovery(row.externalTransactionRecovery, row));
    if (row.method === "signAndSubmitTransaction" && row.requestCommitment &&
        isValidTransactionHash(row.transactionHash) &&
        requestCommitment(row.method, {
          origin: row.origin, accountAddress: canonicalAddress(row.address),
          network: row.network, chainId: row.chainId
        }, "pending" in row ? row.pending.requestPayload : row.requestPayload) === row.requestCommitment)
      return { transactionHash: row.transactionHash };
  } catch { /* Invalid stored bindings never become execution evidence. */ }
  return {};
}

function explicitRejectedPayload(payload: unknown): boolean {
  if (payload === undefined) return true;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const fields = Object.getOwnPropertyDescriptors(payload);
  return Object.keys(fields).length === 1 && "value" in (fields.error ?? {}) &&
    fields.error!.value === "user_rejected";
}

function replay(row: DurableRequest): RecoveredRequestOutcome | null {
  const final = row.final;
  if (!final) return null;
  const base = descriptor(row);
  if (final.status === "rejected") return { ...base, status: "rejected" };
  if (final.method !== row.method) {
    return { ...base, status: "unknown", reason: "Stored result method does not match its request" };
  }
  try {
    if (final.method === "signAndSubmitTransaction") {
      if (!isValidTransactionHash(final.hash)) throw new Error("Invalid saved transaction hash");
      return { ...base, ...uncertainExecution(row), status: "approved", output: { hash: final.hash } };
    }
    if (final.method === "signMessage") {
      const output =
        row.pending.expectedMessageInput && row.pending.signerPublicKey
          ? verifySignedMessageOutput(
              final.output,
              row.pending.expectedMessageInput,
              {
                origin: row.origin,
                accountAddress: canonicalAddress(row.address),
                network: row.network,
                chainId: row.chainId
              },
              row.pending.signerPublicKey,
              (row.pending.expectedMessageInput as { profile?: string })
                .profile !== "cedra:message:v1"
            )
          : normalizeSignMessageOutput(final.output);
      return { ...base, status: "approved", output };
    }
    return { ...base, status: "approved",
      output: deserializeSignTransactionResult({
        authenticatorHex: final.authenticatorHex,
        rawTransactionBcsHex: final.rawTransactionBcsHex
      }, row.pending.expectedTransactionBcsHex) };
  } catch {
    return { ...base, status: "unknown", reason: "Stored final outcome could not be validated" };
  }
}

/* ===================================================================
 * v0.2.0-rc.22 (Phase 2 / A1): authorized original-request read.
 *
 * When the original session is gone but a fresh session with matching
 * (origin, transport, address, network, chainId) is alive, the dapp
 * can mint a one-shot read-grant over the OLD request. The wallet
 * (W2) re-wraps the original ciphertext under the NEW session's
 * sharedSecret and the dapp decrypts it with the current session's
 * sharedSecret. The verified result is persisted via `saveDurableFinal`
 * before returning — preserving the rc.21 ordering invariant.
 *
 * Fallback contract: if the relay/Desk lacks the new endpoints, the
 * behavior is byte-identical to rc.21 (returns `{status: "unknown"}`).
 * =================================================================== */

/** Bounds for the bounded poll loop that waits for W2 fulfillment.
 * Exposed as `let` so test suites can shrink the bound under fake timers
 * without changing the production default (30 s). */
export let READ_GRANT_POLL_INTERVAL_MS = 1000;
export let READ_GRANT_POLL_TIMEOUT_MS = 30_000;

/** Test-only override for the poll interval/timeout. NOT exported
 * beyond this module's tests. */
export function _setReadGrantPollConfigForTesting(
  intervalMs: number,
  timeoutMs: number
): void {
  READ_GRANT_POLL_INTERVAL_MS = intervalMs;
  READ_GRANT_POLL_TIMEOUT_MS = timeoutMs;
}

function sameRelayBaseUrl(row: DurableRequest, session: InferExternalSession | null): boolean {
  if (!session || session.transport !== "mobile-relay") return false;
  return row.endpoint === session.relayBaseUrl;
}

function sameBridgeOrigin(row: DurableRequest, session: InferExternalSession | null, options: InferWalletOptions): boolean {
  if (!session || session.transport !== "desktop-bridge") return false;
  try {
    return desktopBridgeOrigin(session, options) === row.endpoint;
  } catch {
    return false;
  }
}

/**
 * Mobile-relay authorized-read fallback. Mints a one-shot read-grant,
 * polls until the wallet fulfills it (W2), then decrypts the
 * redelivered ciphertext with the CURRENT session's sharedSecret and
 * decodes the result via the existing `decodeMobileRelayResult` path
 * — except the cipher comes from `grant.redeliveredEncryptedResult`,
 * not from the request-status endpoint.
 *
 * Returns the recovered outcome on success; returns `null` on any
 * non-success path so the caller can fall back to rc.21 behavior
 * (`{status: "unknown"}`).
 */
const mobileRecoveryReads = new Map<string, Promise<RecoveredRequestOutcome | null>>();
async function authorizedReadMobileRelay(
  row: DurableRequest,
  session: InferExternalSession,
  base: ReturnType<typeof descriptor>,
  options: InferWalletOptions = {},
  readOptions: RecoveryReadOptions = {}
): Promise<RecoveredRequestOutcome | null> {
  const key = JSON.stringify([row.id, session.sessionId, readOptions.allowMobileRecoveryHandoff === true]);
  const existing = mobileRecoveryReads.get(key);
  if (existing) return existing;
  const task = performAuthorizedMobileRead(row, session, base, options, readOptions).catch(() =>
    ({ ...base, status: "unknown" as const, ...uncertainExecution(row), reason: "authorized_recovery_unavailable" }));
  mobileRecoveryReads.set(key, task);
  try { return await task; }
  finally { mobileRecoveryReads.delete(key); }
}
async function performAuthorizedMobileRead(
  row: DurableRequest,
  session: InferExternalSession,
  base: ReturnType<typeof descriptor>,
  options: InferWalletOptions = {},
  readOptions: RecoveryReadOptions = {}
): Promise<RecoveredRequestOutcome | null> {
  if (!session.relayBaseUrl || !session.dappSessionToken || !session.sharedSecret) return null;
  // The relay's S1 endpoint REQUIRES `method` in the scope (it validates
  // the scope's method against the original request row) and accepts an
  // optional `invocationId` for idempotent re-mint matching.
  const scope: ReadGrantScope = {
    origin: window.location.origin,
    accountAddress: row.address,
    network: row.network,
    chainId: row.chainId,
    method: row.method,
    ...(row.invocationId ? { invocationId: row.invocationId } : {}),
    newSessionId: session.sessionId
  };
  const assertCurrentSession = () => {
    const current = readExternalSession();
    if (!current || !sameScope(row, current) || current.sessionId !== session.sessionId ||
        current.dappSessionToken !== session.dappSessionToken || current.sharedSecret !== session.sharedSecret ||
        !sameRelayBaseUrl(row, current)) throw new Error("Recovery authorization changed");
  };
  assertCurrentSession();
  const mint = await mintReadGrant({
    relayBaseUrl: session.relayBaseUrl,
    requestId: row.requestId,
    dappSessionToken: session.dappSessionToken,
    scope
  });
  if (!mint.ok) {
    // Older relay (pre-Phase 0 S1) returns 404 → fall back to rc.21.
    return null;
  }

  assertCurrentSession();
  const deadline = Date.now() + READ_GRANT_POLL_TIMEOUT_MS;
  let grant: ReadGrantDescriptor | null = null;
  let handoffOpened = false;
  while (Date.now() < deadline) {
    const poll = await getReadGrant({
      relayBaseUrl: session.relayBaseUrl,
      requestId: row.requestId,
      dappSessionToken: session.dappSessionToken
    });
    assertCurrentSession();
    if (!poll.ok) return null;
    grant = poll.grant;
    if (grant.grantId !== mint.grantId || grant.requestId !== row.requestId ||
        grant.scope.origin !== row.origin || canonicalAddress(grant.scope.accountAddress) !== canonicalAddress(row.address) ||
        grant.scope.network !== row.network || grant.scope.chainId !== row.chainId || grant.scope.method !== row.method ||
        (grant.scope.invocationId ?? null) !== (row.invocationId ?? null))
      return { ...base, status: "unknown", ...uncertainExecution(row), reason: "read_grant_binding_changed" };
    if (grant.status === "fulfilled") break;
    if (!handoffOpened && readOptions.allowMobileRecoveryHandoff === true &&
        session.capabilities?.durableExternalSubmissionRecovery === true &&
        row.method === "signAndSubmitTransaction" && grant.status === "pending_fulfillment") {
      launchMobileRelayRecoveryRead(grant, row.sessionId, session, options);
      handoffOpened = true;
    }
    // Terminal grant states ("expired" / "denied" — the relay's enum)
    // cannot become fulfilled; fall back to rc.21 behavior. The relay
    // usually signals these via HTTP 410, which lands in the
    // `!poll.ok` branch above.
    if (grant.status === "expired" || grant.status === "denied") {
      return null;
    }
    if (session.capabilities?.durableExternalSubmissionRecovery === true && !readOptions.allowMobileRecoveryHandoff)
      return { ...base, status: "unknown", ...uncertainExecution(row), reason: "wallet_read_required" };
    await new Promise((resolve) => window.setTimeout(resolve, READ_GRANT_POLL_INTERVAL_MS));
  }
  if (!grant || grant.status !== "fulfilled" || !grant.redeliveredEncryptedResult) {
    return { ...base, status: "unknown", ...uncertainExecution(row), reason: "grant_pending_timeout" };
  }

  // The wallet (W2) sealed the original result under the NEW session's
  // sharedSecret. We cannot reuse `decodeMobileRelayResult` directly
  // because its identity check requires `pending.sessionId ===
  // session.sessionId` — and the row's pending carries the OLD
  // sessionId (which is exactly the situation we're recovering from).
  // Validate the decoded payload ourselves using the row's stored
  // pending (method/address/network/chainId/requestId) plus the
  // NEW session's sharedSecret for decryption.
  let decoded: unknown;
  try {
    decoded = decryptJson<unknown>(grant.redeliveredEncryptedResult, session.sharedSecret);
  } catch {
    return { ...base, status: "unknown", ...uncertainExecution(row), reason: "decrypt_failed" };
  }

  if (isRecord(decoded) && "recoverySchema" in decoded) {
    try {
      assertCurrentSession();
      validateExternalTransactionRecovery(decoded, row);
      const saved = await saveDurableExternalTransactionRecovery(row.id, decoded);
      assertCurrentSession();
      return externalOutcome(saved);
    } catch { return { ...base, status: "unknown", ...uncertainExecution(row), reason: "external_recovery_evidence_invalid_or_unavailable" }; }
  }
  let output:
    | CedraSignMessageOutput | CedraSignTransactionOutputV1_1 | CedraSignAndSubmitTransactionOutput;
  try {
    if (row.method === "signAndSubmitTransaction") {
      if (!isRecord(decoded) || Object.keys(decoded).length !== 1 ||
          !isValidTransactionHash(decoded.hash)) {
        throw new InferAdapterError(InferErrorCode.InternalError,
          "Infer Connect returned an approved transaction without a valid hash");
      }
      output = { hash: decoded.hash };
    } else if (row.method === "signMessage") {
      output =
        row.pending.expectedMessageInput && row.pending.signerPublicKey
          ? verifySignedMessageOutput(
              decoded,
              row.pending.expectedMessageInput,
              {
                origin: row.origin,
                accountAddress: canonicalAddress(row.address),
                network: row.network,
                chainId: row.chainId
              },
              row.pending.signerPublicKey,
              (row.pending.expectedMessageInput as { profile?: string })
                .profile !== "cedra:message:v1"
            )
          : normalizeSignMessageOutput(decoded);
    } else {
      // signTransaction: the original `expectedTransactionBcsHex` is
      // preserved on the row's pending.
      output = deserializeSignTransactionResult(
        decoded as { authenticatorHex: unknown; rawTransactionBcsHex: unknown },
        row.pending.expectedTransactionBcsHex
      );
    }
  } catch (cause) {
    if (cause instanceof InferAdapterError && cause.code === InferErrorCode.UserRejected) {
      return { ...base, status: "rejected" };
    }
    return { ...base, status: "unknown",
      reason: cause instanceof Error ? cause.message : "Decoded read-grant result failed validation" };
  }

  // Persist the verified result BEFORE returning — preserve the rc.21
  // ordering invariant so a follow-up read locally replays without
  // re-querying the relay.
  try {
    assertCurrentSession();
    await saveDurableFinal(row.id, serializeStoredFinal(row.method, output));
    assertCurrentSession();
  } catch {
    return { ...base, status: "unknown", reason: "Verified outcome could not be saved durably" };
  }
  return { ...base, status: "approved", output };
}

/**
 * Desktop-bridge authorized-read fallback. Calls the new
 * `readResultForSession` endpoint (D2 contract) which returns the
 * durable result from Infer Desk's redb store directly — Desk is the
 * durable authority on this path so no re-encryption is needed.
 *
 * Returns the recovered outcome on success; returns `null` on any
 * non-success path so the caller can fall back to rc.21 behavior.
 */
async function authorizedReadDesktopBridge(
  row: DurableRequest,
  session: InferExternalSession,
  options: InferWalletOptions,
  base: ReturnType<typeof descriptor>
): Promise<RecoveredRequestOutcome | null> {
  const result = await readResultForSession({
    invocationId: row.invocationId,
    requestCommitment: row.requestCommitment,
    bridgeOrigin: row.endpoint,
    requestId: row.requestId,
    newSessionId: session.sessionId,
    scope: {
      origin: row.origin, transport: "desktop-bridge", accountAddress: row.address,
      network: row.network, chainId: row.chainId, method: row.method
    },
    session, options
  });
  if (!result.ok) return null;
  try {
    if (result.status === "pending" || result.status === "unknown") {
      if (result.transactionHash) {
        await saveDurableTransactionHash(row.id, result.transactionHash);
        row.transactionHash = result.transactionHash;
      }
      return result.status === "pending"
        ? { ...base, status: "pending", ...uncertainExecution(row) }
        : { ...base, status: "unknown", reason: result.reason ?? "original_execution_unresolved", ...uncertainExecution(row) };
    }
    if (result.status === "rejected") {
      if (!explicitRejectedPayload(result.payload) || result.hash !== undefined)
        throw new Error("Ambiguous recovered rejection");
      await saveDurableFinal(row.id, { status: "rejected" });
      return { ...base, status: "rejected" };
    }
    if (result.status !== "approved") throw new Error("Unsupported recovered outcome");
    const output = validateInjectedApproval({
      method: row.method, origin: row.origin, address: row.address,
      network: row.network, chainId: row.chainId,
      requestPayload: row.pending.expectedMessageInput ?? row.pending.requestPayload,
      signerPublicKey: row.pending.signerPublicKey,
      expectedTransactionBcsHex: row.pending.expectedTransactionBcsHex
    }, result.payload);
    if (result.hash !== undefined &&
        (row.method !== "signAndSubmitTransaction" ||
          (output as CedraSignAndSubmitTransactionOutput).hash.toLowerCase() !== result.hash.toLowerCase()))
      throw new Error("Recovered transaction identities differ");
    await saveDurableFinal(row.id, serializeStoredFinal(row.method, output));
    return { ...base, status: "approved", output };
  } catch (cause) {
    return { ...base, status: "unknown", ...uncertainExecution(row),
      reason: cause instanceof Error ? cause.message : "Recovered result could not be validated or saved" };
  }
}

function injectedDescriptor(row: DurableInvocation): RecoverableRequest {
  return {
    recoveryId: "invocation:" + row.id,
    requestId: row.id,
    invocationId: row.id,
    requestCommitment: row.requestCommitment,
    origin: row.origin,
    transport: "injected",
    sessionId: row.sessionId,
    address: row.address,
    network: row.network,
    chainId: row.chainId,
    method: row.method
  };
}
function validateInjectedApproval(
  row: Pick<DurableInvocation, "method" | "origin" | "address" | "network" | "chainId" | "requestPayload" | "signerPublicKey"> &
    { expectedTransactionBcsHex?: string },
  payload: unknown
) {
  const scope = {
    origin: row.origin,
    accountAddress: canonicalAddress(row.address),
    network: row.network,
    chainId: row.chainId
  };
  if (row.method === "signAndSubmitTransaction") {
    const fields = encodeWireValue(payload);
    if (
      !fields ||
      Array.isArray(fields) ||
      typeof fields !== "object" ||
      Object.keys(fields).length !== 1 ||
      !isValidTransactionHash(fields.hash)
    )
      throw new Error("Incomplete submitted result");
    return { hash: fields.hash };
  }
  if (row.method === "signMessage") {
    if (!row.signerPublicKey || !row.requestPayload)
      throw new Error("Original signer or message is unavailable");
    return verifySignedMessageOutput(
      payload,
      row.requestPayload as Parameters<typeof verifySignedMessageOutput>[1],
      scope,
      row.signerPublicKey,
      (row.requestPayload as { profile?: string }).profile !==
        "cedra:message:v1"
    );
  }
  const expected =
    row.requestPayload && typeof row.requestPayload === "object"
      ? (row.requestPayload as { rawTransactionBcsHex?: string })
          .rawTransactionBcsHex
      : undefined;
  return deserializeSignTransactionResult(payload, row.expectedTransactionBcsHex ?? expected);
}
function replayInjected(
  row: DurableInvocation
): RecoveredRequestOutcome | null {
  const base = injectedDescriptor(row);
  if (!row.final) return null;
  if (row.final.status === "rejected") return { ...base, status: "rejected" };
  if (row.final.method !== row.method)
    return { ...base, status: "unknown", reason: "stored_method_mismatch" };
  try {
    const payload =
      row.final.method === "signMessage"
        ? row.final.output
        : row.final.method === "signAndSubmitTransaction"
          ? { hash: row.final.hash }
          : row.final;
    return {
      ...base,
      status: "approved",
      output: validateInjectedApproval(row, payload)
    };
  } catch {
    return { ...base, status: "unknown", reason: "stored_result_incomplete" };
  }
}
function nativeExecutionEvidence(result: Record<string, unknown>, method: string): NativeExecutionEvidence {
  const evidence: {submissionAcceptance?: "unknown" | "accepted"; chainStatus?: "unknown" | "pending" | "confirmed" | "aborted"; chainVersion?: string} = {};
  if (result.submissionAcceptance !== undefined) {
    if (method !== "signAndSubmitTransaction" || typeof result.submissionAcceptance !== "string" ||
        !["unknown", "accepted"].includes(result.submissionAcceptance))
      throw new Error("Invalid native acceptance evidence");
    evidence.submissionAcceptance = result.submissionAcceptance as "unknown" | "accepted";
  }
  if (result.chainStatus !== undefined) {
    if (method !== "signAndSubmitTransaction" || typeof result.chainStatus !== "string" ||
        !["unknown", "pending", "confirmed", "aborted"].includes(result.chainStatus))
      throw new Error("Invalid native chain evidence");
    evidence.chainStatus = result.chainStatus as NativeExecutionEvidence["chainStatus"];
  }
  if (result.chainVersion !== undefined) {
    if (typeof result.chainVersion !== "string" || !/^(0|[1-9]\d{0,19})$/.test(result.chainVersion) ||
        BigInt(result.chainVersion) > (1n << 64n) - 1n ||
        !["confirmed", "aborted"].includes(String(evidence.chainStatus)))
      throw new Error("Invalid native chain version");
    evidence.chainVersion = result.chainVersion;
  }
  if ((evidence.chainStatus === "confirmed" || evidence.chainStatus === "aborted") &&
      evidence.chainVersion === undefined) throw new Error("Missing native chain version");
  if (result.status === "approved" && evidence.submissionAcceptance === "unknown")
    throw new Error("Contradictory native acceptance evidence");
  if (result.status === "pending" && ["confirmed", "aborted"].includes(String(evidence.chainStatus)))
    throw new Error("Conflicting native pending evidence");
  return evidence;
}
async function readInjectedInvocation(
  row: DurableInvocation,
  options: InferWalletOptions
): Promise<RecoveredRequestOutcome> {
  const id = "invocation:" + row.id + ":" + nativeRecoveryKey(options);
  const binding = nativeProviderBinding(options);
  const scope = {origin:row.origin,accountAddress:canonicalAddress(row.address),network:row.network,chainId:row.chainId};
  await binding?.assertScope(scope);
  const existing = inFlight.get(id);
  if (existing) {
    const result = await existing;
    await binding?.assertScope(scope);
    return result;
  }
  const task = readInjectedInvocationOnce(row, options);
  inFlight.set(id, task);
  try {
    const result = await task;
    await binding?.assertScope(scope);
    return result;
  } finally {
    if (inFlight.get(id) === task) inFlight.delete(id);
  }
}
async function readInjectedInvocationOnce(
  row: DurableInvocation,
  options: InferWalletOptions
): Promise<RecoveredRequestOutcome> {
  const base = injectedDescriptor(row);
  const scope = {
    origin: row.origin,
    accountAddress: canonicalAddress(row.address),
    network: row.network,
    chainId: row.chainId
  };
  try {
    if (
      !row.requestCommitment ||
      requestCommitment(row.method, scope, row.requestPayload) !==
        row.requestCommitment
    )
      return {
        ...base,
        status: "unknown", ...uncertainExecution(row),
        reason: "invocation_commitment_mismatch"
      };
    // A selected native consumer must still hold the exact live scope before
    // a cached final can be published.
    await nativeProviderBinding(options)?.assertScope(scope);
    const final = replayInjected(row);
    // The selected wallet's raw read authenticates the current native grant.
    // JS account/network caches alone cannot authorize terminal publication.
    if (final && !nativeProviderBinding(options)) return final;
    const provider = detectProvider(options);
    if (
      !provider?.readInvocation ||
      provider.integrationContractVersion !== 1 ||
      !provider.capabilities?.durableInvocationLookup ||
      !provider.account ||
      !provider.network
    )
      return {
        ...base,
        status: "unknown", ...uncertainExecution(row),
        reason: "invocation_lookup_unavailable"
      };
    const unwrap = (value: unknown): unknown => {
      if (value && typeof value === "object" && "status" in value) {
        const fields = value as { status?: unknown; args?: unknown };
        return fields.status === "Approved" && Object.keys(fields).length === 2
          ? fields.args
          : null;
      }
      return value;
    };
    const account = unwrap(await provider.account()) as {
      address?: unknown;
    } | null;
    const networkValue = unwrap(await provider.network());
    if (
      typeof networkValue !== "string" &&
      typeof networkValue !== "number" &&
      (!networkValue ||
        typeof networkValue !== "object" ||
        !("name" in networkValue) ||
        !("chainId" in networkValue))
    )
      return {
        ...base,
        status: "unknown", ...uncertainExecution(row),
        reason: "current_provider_scope_mismatch"
      };
    const network = normalizeNetwork(
      networkValue as Parameters<typeof normalizeNetwork>[0]
    );
    if (
      !account ||
      canonicalAddress(String(account.address)) !== scope.accountAddress ||
      network.name !== scope.network ||
      network.chainId !== scope.chainId
    )
      return {
        ...base,
        status: "unknown", ...uncertainExecution(row),
        reason: "current_provider_scope_mismatch"
      };
    const result = encodeWireValue(
      await provider.readInvocation(row.id, row.requestCommitment)
    ) as Record<string, unknown>;
    await nativeProviderBinding(options)?.assertScope(scope);
    const returned = result.scope as Record<string, unknown> | undefined;
    if (
      result.contractVersion !== 1 ||
      result.invocationId !== row.id ||
      result.requestCommitment !== row.requestCommitment ||
      result.method !== row.method ||
      !returned ||
      returned.origin !== scope.origin ||
      returned.accountAddress !== scope.accountAddress ||
      returned.network !== scope.network ||
      returned.chainId !== scope.chainId
    )
      return {
        ...base,
        status: "unknown", ...uncertainExecution(row),
        reason: "native_invocation_scope_mismatch"
      };
    const evidence = nativeExecutionEvidence(result, row.method);
    const recoveredHash = result.transactionHash ?? result.hash;
    if (result.transactionHash !== undefined && result.hash !== undefined &&
        result.transactionHash !== result.hash) throw new Error("Conflicting native identity");
    if (result.status === "pending" || result.status === "unknown") {
      if (result.payload !== undefined) throw new Error("Unexpected unresolved payload");
      if (recoveredHash !== undefined) {
        if (row.method !== "signAndSubmitTransaction" || !isValidTransactionHash(recoveredHash))
          throw new Error("Invalid recovered execution identity");
        await saveDurableTransactionHash(row.id, recoveredHash, true);
        await nativeProviderBinding(options)?.assertScope(scope);
        row.transactionHash = recoveredHash.toLowerCase();
      } else if (evidence.chainStatus === "confirmed" || evidence.chainStatus === "aborted" ||
                 evidence.submissionAcceptance === "accepted") {
        throw new Error("Native execution evidence lacks identity");
      }
      return result.status === "pending"
        ? { ...base, status: "pending", ...uncertainExecution(row), ...evidence }
        : { ...base, status: "unknown", reason: "original_execution_unresolved", ...uncertainExecution(row), ...evidence };
    }
    if (result.status === "rejected" && explicitRejectedPayload(result.payload) &&
        recoveredHash === undefined && Object.keys(evidence).length === 0) {
      if (!row.final) await updateInjectedInvocationEvidence(row.id, { final: { status: "rejected" } });
      else if (row.final.status !== "rejected") throw new Error("Conflicting native decline");
      await nativeProviderBinding(options)?.assertScope(scope);
      return { ...base, status: "rejected" };
    }
    if (result.status !== "approved")
      return { ...base, status: "unknown", ...uncertainExecution(row), reason: "native_outcome_unavailable" };
    const output = validateInjectedApproval(row, result.payload);
    if (recoveredHash !== undefined &&
        (row.method !== "signAndSubmitTransaction" || !isValidTransactionHash(recoveredHash) ||
         !("hash" in output) || output.hash.toLowerCase() !== recoveredHash.toLowerCase()))
      throw new Error("Conflicting native approval identity");
    const retainedFinal = serializeStoredFinal(row.method, output);
    if (!row.final) await updateInjectedInvocationEvidence(row.id, {final: retainedFinal});
    else if (JSON.stringify(row.final) !== JSON.stringify(retainedFinal))
      throw new Error("Conflicting native terminal outcome");
    await nativeProviderBinding(options)?.assertScope(scope);
    return { ...base, status: "approved", output, ...evidence };
  } catch {
    return {
      ...base,
      status: "unknown", ...uncertainExecution(row),
      reason: "native_invocation_read_unavailable"
    };
  }
}

/** List all active same-origin receipts, including those from an older wallet session. */
export async function listRecoverableRequests(options: InferWalletOptions = {}): Promise<RecoverableRequest[]> {
  const external = (await records(options)).filter((row) => row.state === "active").map(descriptor);
  const injected = (await listDurableInvocations())
    .filter(
      (row) =>
        row.transport === "injected" &&
        row.state !== "not-invoked" &&
        (!row.deliveryState || row.deliveryState === "active")
    )
    .map(injectedDescriptor);
  return [...external, ...injected];
}

export async function listArchivedRecoverableRequests(
  options: InferWalletOptions = {}
): Promise<ArchivedRecoverableRequest[]> {
  const external = (await records(options)).flatMap((row) =>
    row.state === "archived" && row.archive ? [{ ...descriptor(row), ...row.archive }] : []);
  const injected = (await listDurableInvocations()).flatMap((row) =>
    row.transport === "injected" &&
    row.deliveryState === "archived" &&
    row.archive
      ? [{ ...injectedDescriptor(row), ...row.archive }]
      : []
  );
  return [...external, ...injected];
}

/** Read only the original request. A locally verified final result replays without network access. */
export async function readRecoverableRequest(
  requestIdOrRecoveryId: string,
  options: InferWalletOptions = {},
  readOptions: RecoveryReadOptions = {}
): Promise<RecoveredRequestOutcome> {
  if (typeof window === "undefined") {
    throw new InferAdapterError(InferErrorCode.Unsupported, "Recovery requires a browser"
    );
  }
  if (requestIdOrRecoveryId.startsWith("invocation:")) {
    const invocation = await getDurableInvocation(requestIdOrRecoveryId.slice(11));
    if (!invocation || invocation.transport !== "injected")
      throw new InferAdapterError(
        InferErrorCode.Unauthorized,
        "Unknown injected invocation handle"
      );
    return readInjectedInvocation(invocation, options);
  }
  const row = await exactRecord(requestIdOrRecoveryId, options);
  const locallyVerified = replay(row);
  if (locallyVerified) return locallyVerified;
  const cached = externalOutcome(row);
  if (cached?.submissionDisposition === "not-submitted") return cached;
  const base = descriptor(row);
  const session = readExternalSession();
  const readKey = JSON.stringify([row.id, readOptions.allowMobileRecoveryHandoff === true]);
  if (row.transport === "desktop-bridge" && row.requestCommitment && row.invocationId &&
      session?.integrationContractVersion === 1 && session.capabilities?.durableInvocationLookup &&
      sameScope(row, session) && sameBridgeOrigin(row, session, options)) {
    const existing = inFlight.get(readKey);
    if (existing) return existing;
    const task = (async (): Promise<RecoveredRequestOutcome> => {
      const authorized = await authorizedReadDesktopBridge(row, session, options, base);
      return authorized ?? { ...base, status: "unknown", ...uncertainExecution(row), reason: "durable_result_unavailable" };
    })();
    inFlight.set(readKey, task);
    try { return await task; }
    finally { inFlight.delete(readKey); }
  }
  if (!matchingSession(row, session, options)) {
    // v0.2.0-rc.22 (A1): if no verified local final is available and the
    // original session is gone, attempt the authorized-read fallback
    // path when (a) a fresh session with matching scope exists and
    // (b) the row's endpoint matches the current session's transport
    // endpoint. This closes the protocol dependency where a new
    // session could not read an old unverified result.
    //
    // Fallback contract: if the new client endpoints are missing
    // (404 from mintReadGrant / readResultForSession) or the polling
    // times out, the result is byte-identical to current rc.21 —
    // i.e. the adapter returns `{ status: "unknown" }` with the
    // legacy reason. This guarantees the spec acceptance criterion
    // that older relay/Desk deployments see no behavior change.
    if (sameScope(row, session)) {
      if (row.transport === "mobile-relay" && sameRelayBaseUrl(row, session)) {
        const authorized = await authorizedReadMobileRelay(row, session!, base, options, readOptions);
        if (authorized) return authorized;
      } else if (row.transport === "desktop-bridge" && sameBridgeOrigin(row, session, options)) {
        const authorized = await authorizedReadDesktopBridge(row, session!, options, base);
        if (authorized) return authorized;
      }
    }
    return { ...base, status: "unknown", ...uncertainExecution(row),
      reason: "Original wallet session cannot authenticate a remote read; reconnect or reconcile externally" };
  }
  const existing = inFlight.get(readKey);
  if (existing) return existing;
  const task = (async (): Promise<RecoveredRequestOutcome> => {
    let outcome: RecoveredRequestOutcome;
    try {
      if (row.transport === "mobile-relay") {
        const { pending, status } = await readMobileRelayRequestOnce(
          row.requestId, session, options, row.pending as Extract<DurableRequest["pending"], { version: 1 }>
        );
        if (status.status !== "approved" && (status.status !== "rejected" || status.errorCode === "EXECUTION_FAILED_BEFORE_BROADCAST") &&
            row.method === "signAndSubmitTransaction" && row.requestCommitment &&
            session.capabilities?.durableExternalSubmissionRecovery === true) {
          const recovered = await authorizedReadMobileRelay(row, session, base, options, readOptions);
          if (recovered) return recovered;
        }
        if (status.status === "pending") return cached ?? { ...base, status: "pending", ...uncertainExecution(row) };
        if (status.status !== "approved" && status.status !== "rejected") {
          return { ...base, status: "unknown", ...uncertainExecution(row), reason: "Relay returned " + status.status };
        }
        outcome = { ...base, status: "approved",
          output: decodeMobileRelayResult(status, pending, session) };
      } else {
        const result = await readDesktopBridgeRequestOnce(
          row.requestId, session, options, row.pending as Extract<DurableRequest["pending"], { version: 2 }>
        );
        if (result.status === "pending") return { ...base, status: "pending", ...uncertainExecution(row) };
        if (!result.output) return { ...base, status: "unknown", ...uncertainExecution(row), reason: "Missing approved output" };
        outcome = { ...base, status: "approved", output: result.output };
      }
    } catch (error) {
      if (error instanceof InferAdapterError && error.code === InferErrorCode.UserRejected) {
        outcome = { ...base, status: "rejected" };
      } else {
        return { ...base, status: "unknown", ...uncertainExecution(row), reason:
          error instanceof Error ? error.message : "Result could not be validated" };
      }
    }
    try {
      await saveDurableFinal(row.id, outcome.status === "rejected"
        ? { status: "rejected" }
        : serializeStoredFinal(row.method, outcome.output));
      return outcome;
    } catch {
      return { ...base, status: "unknown", ...uncertainExecution(row), reason: "Verified outcome could not be saved durably" };
    }
  })();
  inFlight.set(readKey, task);
  try { return await task; }
  finally { inFlight.delete(readKey); }
}

/** Check optional native retention support without weakening original scope. */
async function acknowledgeNativeResult(row: DurableInvocation, options: InferWalletOptions): Promise<void> {
  const scope = { origin: row.origin, accountAddress: canonicalAddress(row.address), network: row.network, chainId: row.chainId };
  await nativeProviderBinding(options)?.assertScope(scope);
  const final = replayInjected(row);
  let reconciledHash: string | undefined;
  if (!final || (final.status !== "approved" && final.status !== "rejected")) {
    // Wallet C can prove an originally uncertain broadcast using exact committed
    // chain evidence. Explicit acknowledgement may then retain acceptance,
    // including a committed abort; neither is an application-success decision.
    if (!isValidTransactionHash(row.transactionHash))
      throw new InferAdapterError(InferErrorCode.InternalError, "native-outcome-not-terminal");
    const observed = await readInjectedInvocation(row, options);
    if (row.method !== "signAndSubmitTransaction" || observed.status !== "unknown" ||
        !isValidTransactionHash(observed.transactionHash) ||
        (observed.chainStatus !== "confirmed" && observed.chainStatus !== "aborted"))
      throw new InferAdapterError(InferErrorCode.InternalError, "native-outcome-not-terminal");
    reconciledHash = observed.transactionHash;
  }
  if (row.deliveryState === "acknowledged") return;
  // Explicit false is admission-time evidence of an incapable peer, not a later downgrade.
  if (row.remoteAcknowledgementRequired === false) return;
  const provider = detectProvider(options);
  if (!provider ||
      (row.remoteAcknowledgementRequired === true &&
       (provider.integrationContractVersion !== 1 || !provider.acknowledgeInvocation)))
    throw new InferAdapterError(InferErrorCode.Unauthorized,
      "Reconnect the original acknowledgement-capable wallet to retain a retryable acknowledgement");
  if (!row.requestCommitment ||
      requestCommitment(row.method, scope, row.requestPayload) !== row.requestCommitment ||
      !provider.account || !provider.network)
    throw new InferAdapterError(InferErrorCode.Unauthorized, "Native acknowledgement requires the original invocation binding");
  const unwrap = (value: unknown): unknown => {
    if (value && typeof value === "object" && "status" in value) {
      const fields = value as { status?: unknown; args?: unknown };
      return fields.status === "Approved" && Object.keys(fields).length === 2 ? fields.args : null;
    }
    return value;
  };
  const account = unwrap(await provider.account()) as { address?: unknown } | null;
  const network = normalizeNetwork(unwrap(await provider.network()) as Parameters<typeof normalizeNetwork>[0]);
  if (!account || canonicalAddress(String(account.address)) !== scope.accountAddress ||
      network.name !== scope.network || network.chainId !== scope.chainId)
    throw new InferAdapterError(InferErrorCode.Unauthorized, "Current native scope differs from the original request");
  if (detectProvider(options) !== provider)
    throw new InferAdapterError(InferErrorCode.Unauthorized, "Native provider changed before acknowledgement");
  // Historical rows lack a capability marker. A present, scope-checked mobile/legacy
  // provider without this optional API is known incapable; absence alone is not proof.
  if (!provider.acknowledgeInvocation) return;
  if (provider.integrationContractVersion !== 1)
    throw new InferAdapterError(InferErrorCode.Unauthorized, "Native acknowledgement requires contract v1");
  const result = encodeWireValue(await provider.acknowledgeInvocation(row.id, row.requestCommitment));
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new InferAdapterError(InferErrorCode.InternalError, "Malformed native acknowledgement");
  const returned = result.scope;
  if (result.status !== "acknowledged" || result.contractVersion !== 1 ||
      result.invocationId !== row.id || result.requestCommitment !== row.requestCommitment ||
      result.method !== row.method || typeof result.requestId !== "string" || !result.requestId ||
      (row.requestId !== undefined && result.requestId !== row.requestId) ||
      !returned || typeof returned !== "object" || Array.isArray(returned) ||
      returned.origin !== scope.origin || returned.accountAddress !== scope.accountAddress ||
      returned.network !== scope.network || returned.chainId !== scope.chainId)
    throw new InferAdapterError(InferErrorCode.Unauthorized, "Native acknowledgement differs from the original request");
  await nativeProviderBinding(options)?.assertScope(scope);
  if (reconciledHash) {
    await updateInjectedInvocationEvidence(row.id, {
      final: {status:"approved",method:"signAndSubmitTransaction",hash:reconciledHash}
    });
    await nativeProviderBinding(options)?.assertScope(scope);
  }
}

/** Remote retention acknowledgement precedes the local delivery CAS so failures remain retryable. */
export async function acknowledgeRecoverableRequest(
  requestIdOrRecoveryId: string,
  options: InferWalletOptions = {}
): Promise<void> {
  if (requestIdOrRecoveryId.startsWith("invocation:")) {
    const row = await getDurableInvocation(requestIdOrRecoveryId.slice(11));
    if (!row || row.transport !== "injected") throw new InferAdapterError(InferErrorCode.Unauthorized, "Unknown native invocation");
    await acknowledgeNativeResult(row, options);
    await nativeProviderBinding(options)?.assertScope({origin:row.origin,accountAddress:canonicalAddress(row.address),network:row.network,chainId:row.chainId});
    await updateInjectedInvocationEvidence(row.id, { deliveryState: "acknowledged" });
    await nativeProviderBinding(options)?.assertScope({origin:row.origin,accountAddress:canonicalAddress(row.address),network:row.network,chainId:row.chainId});
    return;
  }
  const row = await exactRecord(requestIdOrRecoveryId, options);
  const final = replay(row);
  if (!final || (final.status !== "approved" && final.status !== "rejected"))
    throw new InferAdapterError(InferErrorCode.InternalError, "Read a verified final outcome before acknowledging this request");
  if (row.state === "acknowledged") return;
  const session = readExternalSession();
  // Missing historical metadata is not proof of a legacy peer: retain possible
  // Desktop v1 debt until its original result is remotely acknowledged.
  if (row.transport === "desktop-bridge" && row.remoteAcknowledgementRequired !== false &&
      (row.remoteAcknowledgementRequired === true || (row.requestCommitment && row.invocationId))) {
    if (!row.requestCommitment || !row.invocationId ||
        session?.integrationContractVersion !== 1 || !session.capabilities?.durableInvocationLookup ||
        !sameScope(row, session) || !sameBridgeOrigin(row, session, options))
      throw new InferAdapterError(InferErrorCode.Unauthorized, "Reconnect the original account and network to acknowledge its retained result");
    await acknowledgeDesktopResult({
      invocationId: row.invocationId, requestCommitment: row.requestCommitment,
      bridgeOrigin: row.endpoint, requestId: row.requestId, newSessionId: session.sessionId,
      scope: { origin: row.origin, transport: "desktop-bridge", accountAddress: row.address,
        network: row.network, chainId: row.chainId, method: row.method },
      session, options
    });
  }
  await transitionDurableRequest(row.id, "acknowledge");
  if (matchingSession(row, session, options)) {
    try {
      if (row.transport === "mobile-relay") clearPendingMobileRelayRequest(row.requestId);
      else clearPendingDesktopBridgeRequest(row.requestId);
    } catch { /* The committed IDB tombstone is authoritative. */ }
  }
}

/** Archive only after independent reconciliation; this never proves non-submission. */
export async function archiveRecoverableRequest(
  requestIdOrRecoveryId: string,
  reconciliationReference: string,
  options: InferWalletOptions = {}
): Promise<void> {
  if (requestIdOrRecoveryId.startsWith("invocation:")) {
    await updateInjectedInvocationEvidence(requestIdOrRecoveryId.slice(11), {
      deliveryState: "archived",
      archive: makeRecoveryArchive(reconciliationReference)
    });
    return;
  }
  const row = await exactRecord(requestIdOrRecoveryId, options);
  if (row.state !== "active") {
    throw new InferAdapterError(InferErrorCode.Unauthorized,
      "Request is not active in this browser origin");
  }
  if (row.final) {
    throw new InferAdapterError(InferErrorCode.InvalidParams,
      "Verified final outcomes must be acknowledged after durable acceptance");
  }
  const archive = makeRecoveryArchive(reconciliationReference);
  await transitionDurableRequest(row.id, "archive", archive);
  try {
    const session = readExternalSession()!;
    if (row.transport === "mobile-relay") {
      archivePendingMobileRelayRequest(row.requestId, session, archive);
    } else {
      archivePendingDesktopBridgeRequest(row.requestId, session, archive, options);
    }
  } catch {
    // The committed IndexedDB archive remains authoritative.
  }
}
