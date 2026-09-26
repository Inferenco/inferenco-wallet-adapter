import type {
  CedraSignAndSubmitTransactionOutput,
  CedraSignMessageOutput,
  CedraSignTransactionOutputV1_1
} from "@cedra-labs/wallet-standard";
import { BridgeHttpError, readExternalSession, readDesktopBridgeRequestOnce, readResultForSession } from "./bridge";
import { archivePendingDesktopBridgeRequest, clearPendingDesktopBridgeRequest, desktopBridgeOrigin, readPendingDesktopBridgeRequests, type RecoverableMethod } from "./desktopRequests";
import {
  listDurableRequests, listDurableInvocations, saveDurableRequest, saveDurableFinal, serializeStoredFinal, transitionDurableRequest,
  type DurableRequest, type DurableInvocation, type StoredFinal
} from "./durableRecovery";
import { deserializeSignTransactionResult } from "./conversion";
import { InferAdapterError, InferErrorCode, isValidTransactionHash } from "./errors";
import { decryptJson } from "./mobileCrypto";
import {
  decodeMobileRelayResult,
  getReadGrant,
  mintReadGrant,
  readMobileRelayRequestOnce,
  reconcileMobileRelayInvocationReceipt,
  relaunchMobileRelayInvocation,
  type ReadGrantDescriptor,
  type ReadGrantScope
} from "./mobileRelay";
import { archivePendingMobileRelayRequest, clearPendingMobileRelayRequest, readPendingMobileRelayRequests } from "./mobileRequests";
import { makeRecoveryArchive, type RecoveryArchive } from "./requestArchive";
import type { InferExternalSession, InferWalletOptions } from "./types";

export interface RecoverableRequest {
  /** Opaque, stable handle for this original invocation and session. */
  recoveryId: string;
  requestId: string;
  method: RecoverableMethod;
  transport: "mobile-relay" | "desktop-bridge";
  sessionId: string;
  address: string;
  network: string;
  chainId: number;
  invocationId?: string;
}

export interface ArchivedRecoverableRequest extends RecoverableRequest, RecoveryArchive {}
export interface RecoverableInvocation {
  invocationId: string;
  transport: "mobile-relay" | "desktop-bridge";
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
    invocationId: row.id, transport: row.transport, sessionId: row.sessionId,
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
  const invocation = (await listDurableInvocations()).find((row) => row.id === invocationId);
  if (!invocation) {
    throw new InferAdapterError(InferErrorCode.Unauthorized,
      "Invocation is not bound to this browser origin");
  }
  if (invocation.requestId) {
    try {
      return await readRecoverableRequest(invocation.requestId, options);
    } catch {
      // A receipt may have been saved before the durable request was created.
    }
  }
  if (invocation.state === "not-invoked") {
    return { invocationId, status: "unknown", reason: "request_not_invoked" };
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
  const invocation = (await listDurableInvocations()).find((row) => row.id === invocationId);
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

export type RecoveredRequestOutcome =
  | (RecoverableRequest & { status: "pending" })
  | (RecoverableRequest & { status: "approved"; output:
      CedraSignMessageOutput | CedraSignTransactionOutputV1_1 | CedraSignAndSubmitTransactionOutput })
  | (RecoverableRequest & { status: "rejected" })
  | (RecoverableRequest & { status: "unknown"; reason: string });

const inFlight = new Map<string, Promise<RecoveredRequestOutcome>>();

function descriptor(row: DurableRequest): RecoverableRequest {
  return {
    recoveryId: row.id, requestId: row.requestId, method: row.method,
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
    return row.endpoint === session.relayBaseUrl &&
      typeof session.dappSessionToken === "string" && typeof session.sharedSecret === "string";
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
      return { ...base, status: "approved", output: { hash: final.hash } };
    }
    if (final.method === "signMessage") {
      if (typeof final.output.address !== "string" ||
          typeof final.output.signature !== "string" ||
          typeof final.output.fullMessage !== "string" ||
          typeof final.output.message !== "string") throw new Error("Invalid saved signed message");
      return { ...base, status: "approved",
        output: final.output as unknown as CedraSignMessageOutput };
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
async function authorizedReadMobileRelay(
  row: DurableRequest,
  session: InferExternalSession,
  base: ReturnType<typeof descriptor>
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

  const deadline = Date.now() + READ_GRANT_POLL_TIMEOUT_MS;
  let grant: ReadGrantDescriptor | null = null;
  while (Date.now() < deadline) {
    const poll = await getReadGrant({
      relayBaseUrl: session.relayBaseUrl,
      requestId: row.requestId,
      dappSessionToken: session.dappSessionToken
    });
    if (!poll.ok) return null;
    grant = poll.grant;
    if (grant.status === "fulfilled") break;
    // Terminal grant states ("expired" / "denied" — the relay's enum)
    // cannot become fulfilled; fall back to rc.21 behavior. The relay
    // usually signals these via HTTP 410, which lands in the
    // `!poll.ok` branch above.
    if (grant.status === "expired" || grant.status === "denied") {
      return null;
    }
    await new Promise((resolve) => window.setTimeout(resolve, READ_GRANT_POLL_INTERVAL_MS));
  }
  if (!grant || grant.status !== "fulfilled" || !grant.redeliveredEncryptedResult) {
    return { ...base, status: "unknown", reason: "grant_pending_timeout" };
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
    return { ...base, status: "unknown", reason: "decrypt_failed" };
  }

  let output: CedraSignMessageOutput | CedraSignTransactionOutputV1_1 | CedraSignAndSubmitTransactionOutput;
  try {
    if (row.method === "signAndSubmitTransaction") {
      if (!isRecord(decoded) || Object.keys(decoded).length !== 1 ||
          !isValidTransactionHash(decoded.hash)) {
        throw new InferAdapterError(InferErrorCode.InternalError,
          "Infer Connect returned an approved transaction without a valid hash");
      }
      output = { hash: decoded.hash };
    } else if (row.method === "signMessage") {
      if (!isRecord(decoded) || typeof decoded.address !== "string" ||
          decoded.address.toLowerCase() !== row.address.toLowerCase() ||
          typeof decoded.signature !== "string" ||
          typeof decoded.fullMessage !== "string" || typeof decoded.message !== "string" ||
          typeof decoded.nonce !== "string" || typeof decoded.prefix !== "string") {
        throw new InferAdapterError(InferErrorCode.InternalError,
          "Infer Connect returned an invalid signed message");
      }
      output = decoded as unknown as CedraSignMessageOutput;
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
    await saveDurableFinal(row.id, serializeStoredFinal(row.method, output));
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
  // The IPC bridge authenticates per-session URL token. The token is
  // stored in sessionStorage by the postMessage flow; if it's not
  // present, the endpoint cannot be reached → fall back to rc.21.
  const result = await readResultForSession({
    bridgeOrigin: row.endpoint,
    requestId: row.requestId,
    newSessionId: session.sessionId,
    scope: {
      origin: row.origin,
      transport: "desktop-bridge",
      accountAddress: row.address,
      network: row.network,
      chainId: row.chainId,
      method: row.method
    },
    options
  });
  if (!result.ok) return null;
  if (result.status === "rejected") {
    try {
      await saveDurableFinal(row.id, { status: "rejected" });
    } catch {
      return { ...base, status: "unknown", reason: "Verified outcome could not be saved durably" };
    }
    return { ...base, status: "rejected" };
  }
  try {
    await saveDurableFinal(row.id, serializeStoredFinal(row.method, result.payload));
  } catch {
    return { ...base, status: "unknown", reason: "Verified outcome could not be saved durably" };
  }
  return { ...base, status: "approved", output: result.payload };
}

/** List all active same-origin receipts, including those from an older wallet session. */
export async function listRecoverableRequests(options: InferWalletOptions = {}): Promise<RecoverableRequest[]> {
  return (await records(options)).filter((row) => row.state === "active").map(descriptor);
}

export async function listArchivedRecoverableRequests(
  options: InferWalletOptions = {}
): Promise<ArchivedRecoverableRequest[]> {
  return (await records(options)).flatMap((row) =>
    row.state === "archived" && row.archive ? [{ ...descriptor(row), ...row.archive }] : []);
}

/** Read only the original request. A locally verified final result replays without network access. */
export async function readRecoverableRequest(
  requestIdOrRecoveryId: string,
  options: InferWalletOptions = {}
): Promise<RecoveredRequestOutcome> {
  if (typeof window === "undefined") {
    throw new InferAdapterError(InferErrorCode.Unsupported, "Recovery requires a browser");
  }
  const row = findExact(await records(options), requestIdOrRecoveryId);
  const locallyVerified = replay(row);
  if (locallyVerified) return locallyVerified;
  const base = descriptor(row);
  const session = readExternalSession();
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
        const authorized = await authorizedReadMobileRelay(row, session!, base);
        if (authorized) return authorized;
      } else if (row.transport === "desktop-bridge" && sameBridgeOrigin(row, session, options)) {
        const authorized = await authorizedReadDesktopBridge(row, session!, options, base);
        if (authorized) return authorized;
      }
    }
    return { ...base, status: "unknown",
      reason: "Original wallet session cannot authenticate a remote read; reconnect or reconcile externally" };
  }
  const existing = inFlight.get(row.id);
  if (existing) return existing;
  const task = (async (): Promise<RecoveredRequestOutcome> => {
    let outcome: RecoveredRequestOutcome;
    try {
      if (row.transport === "mobile-relay") {
        const { pending, status } = await readMobileRelayRequestOnce(
          row.requestId, session, options, row.pending as Extract<DurableRequest["pending"], { version: 1 }>
        );
        if (status.status === "pending") return { ...base, status: "pending" };
        if (status.status !== "approved" && status.status !== "rejected") {
          return { ...base, status: "unknown", reason: "Relay returned " + status.status };
        }
        outcome = { ...base, status: "approved",
          output: decodeMobileRelayResult(status, pending, session) };
      } else {
        const result = await readDesktopBridgeRequestOnce(
          row.requestId, session, options, row.pending as Extract<DurableRequest["pending"], { version: 2 }>
        );
        if (result.status === "pending") return { ...base, status: "pending" };
        if (!result.output) return { ...base, status: "unknown", reason: "Missing approved output" };
        outcome = { ...base, status: "approved", output: result.output };
      }
    } catch (error) {
      if (error instanceof InferAdapterError && error.code === InferErrorCode.UserRejected) {
        outcome = { ...base, status: "rejected" };
      } else {
        return { ...base, status: "unknown", reason:
          error instanceof Error ? error.message : "Result could not be validated" };
      }
    }
    try {
      await saveDurableFinal(row.id, outcome.status === "rejected"
        ? { status: "rejected" }
        : serializeStoredFinal(row.method, outcome.output));
      return outcome;
    } catch {
      return { ...base, status: "unknown", reason: "Verified outcome could not be saved durably" };
    }
  })();
  inFlight.set(row.id, task);
  try { return await task; }
  finally { inFlight.delete(row.id); }
}

/** Acknowledgement is an awaitable exact-record CAS after durable app acceptance. */
export async function acknowledgeRecoverableRequest(
  requestIdOrRecoveryId: string,
  options: InferWalletOptions = {}
): Promise<void> {
  const row = findExact(await records(options), requestIdOrRecoveryId);
  if (!row.final) {
    throw new InferAdapterError(InferErrorCode.InternalError,
      "Read a verified final outcome before acknowledging this request");
  }
  await transitionDurableRequest(row.id, "acknowledge");
  if (matchingSession(row, readExternalSession(), options)) {
    try {
      if (row.transport === "mobile-relay") clearPendingMobileRelayRequest(row.requestId);
      else clearPendingDesktopBridgeRequest(row.requestId);
    } catch {
      // The committed IDB tombstone is authoritative.
    }
  }
}

/** Archive only after independent reconciliation; this never proves non-submission. */
export async function archiveRecoverableRequest(
  requestIdOrRecoveryId: string,
  reconciliationReference: string,
  options: InferWalletOptions = {}
): Promise<void> {
  const row = findExact(await records(options), requestIdOrRecoveryId);
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
