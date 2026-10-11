import {
  canonicalAddress,
  encodeWireValue,
  legacySubmitInput,
  normalizeSubmitInput,
  requestCommitment,
  validateMessageInput,
  MESSAGE_PROFILE,
  type CanonicalTransactionInput
} from "./integrationContract";
import { notInvokedError } from "./nonDispatchEvidence";
import {
  prepareDurableInvocation,
  updateDurableInvocation,
  updateInjectedInvocationEvidence,
  serializeStoredFinal,
  type DurableInvocation
} from "./durableRecovery";
import { invocationDescriptor } from "./recovery";
import { EventEmitter } from "eventemitter3";
import type { AnyRawTransaction, Network } from "@cedra-labs/ts-sdk";
import type {
  AccountInfo,
  CedraSignAndSubmitTransactionInput,
  CedraSignAndSubmitTransactionOutput,
  CedraSignMessageInput,
  CedraSignMessageOutput,
  CedraSignTransactionInputV1_1,
  CedraSignTransactionOutputV1_1,
  NetworkInfo
} from "@cedra-labs/wallet-standard";
import {
  bridgePollIntervalMs,
  bridgePollTimeoutMs,
  buildDesktopOrMobileConnectUrlWithRequest,
  clearPendingMobilePairing,
  clearExternalSession,
  checkExternalConnectionHealth,
  consumeExternalCallbackIfPresent,
  installExternalSessionResumeListeners,
  isMobileBrowser,
  launchDesktopOrMobileConnect,
  notifyExternalDisconnect,
  parseDisconnectPayload,
  pollPreauthConnect,
  readExternalSession,
  readCallbackMarker,
  readPendingMobilePairing,
  renderCallbackCompletionFallback,
  readValidatedExternalSession,
  revokeExternalSession,
  sessionToAccountInfo,
  startPreauthConnect,
  storeCallbackSession,
  storeExternalSession,
  tryLocalBridgeConnect,
  tryLocalBridgeSignAndSubmit,
  tryLocalBridgeSignMessage,
  tryLocalBridgeSignTransaction,
  waitForExternalSession
} from "./bridge";
import {
  createFullMessage,
  assertSignedMessageBinding,
  deserializeSignTransactionResult,
  normalizeNetwork,
  normalizeProviderAccount,
  normalizeSignMessageOutput,
  verifySignedMessageOutput,
  normalizeSignTransactionResult
} from "./conversion";
import { DEFAULT_SESSION_LIVENESS_INTERVAL_MS, INFER_SESSION_CLEARED_MESSAGE_TYPE } from "./constants";
import { RECOVERY_CHANNEL, pruneDurableEvidence } from "./durableRecovery";
import { hasLiveOriginalMobileTab, installMobileReturnOwnerResponder } from "./mobileReturnCoordinator";
import {
  isValidTransactionHash,
  InferAdapterError,
  InferErrorCode,
  remapInferError,
  remapSignAndSubmitError
} from "./errors";
import { buildDeeplinkUrl } from "./deeplink";
import {
  connectViaMobileRelay,
  resumeMobileRelaySession,
  signAndSubmitViaMobileRelay,
  signMessageViaMobileRelay,
  signTransactionViaMobileRelay
} from "./mobileRelay";
import {
  acknowledgeRecoverableRequest,
  archiveRecoverableRequest,
  listArchivedRecoverableRequests,
  listRecoverableInvocations,
  listRecoverableRequests,
  readRecoverableRequest,
  reconcileRecoverableInvocation,
  relaunchRecoverableInvocation
} from "./recovery";
import type {
  ArchivedRecoverableRequest,
  RecoveredRequestOutcome,
  RecoverableRequest,
  RecoverableInvocation,
  RecoveredInvocationOutcome
} from "./recovery";
import { detectProvider } from "./provider";
import type {
  InferExternalAccountInput,
  InferExternalSignTransactionInput,
  InferSignMessageResponse,
  InferExternalSession,
  InferConnectionHealth,
  InferProvider,
  InferRawTransactionSignInput,
  InferSignTransactionResult,
  InferTransactionPayload,
  InferWalletOptions
} from "./types";

type InferClientEvents = {
  accountChange: [AccountInfo];
  networkChange: [NetworkInfo];
  /**
   * v0.2.0-rc.8 (Phase 5 UX): fires when the adapter loses its
   * session — either because the dapp itself called `disconnect()`,
   * a peer tab cleared the localStorage entry, the wallet revoked
   * the session from its dashboard (detected via opt-in heartbeat
   * or the next user-initiated `connect()`), or the embedded
   * provider was pushed a disconnect via `__inferDeskHostUpdate`.
   *
   * Subscribers should drop any cached account/network state and
   * route the user back through the connect flow.
   */
  disconnect: [];
  connectionHealth: [InferConnectionHealth];
};

function isWalletStandardSignTransactionInput(
  transaction: unknown
): transaction is CedraSignTransactionInputV1_1 {
  return (
    !!transaction &&
    typeof transaction === "object" &&
    "payload" in transaction &&
    !("rawTransaction" in transaction) &&
    !("data" in transaction)
  );
}

function isSdkRawTransaction(transaction: unknown): transaction is AnyRawTransaction {
  return (
    !!transaction &&
    typeof transaction === "object" &&
    "rawTransaction" in transaction &&
    typeof (transaction as { toString?: unknown }).toString === "function"
  );
}

function addressToString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "address" in value) {
    return addressToString((value as { address?: unknown }).address);
  }
  if (
    typeof value === "object" &&
    "toString" in value &&
    typeof (value as { toString?: unknown }).toString === "function"
  ) {
    const text = (value as { toString: () => string }).toString();
    return text && text !== "[object Object]" ? text : undefined;
  }
  return undefined;
}

function publicKeyToString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    "toString" in value &&
    typeof (value as { toString?: unknown }).toString === "function"
  ) {
    const text = (value as { toString: () => string }).toString();
    return text && text !== "[object Object]" ? text : undefined;
  }
  return undefined;
}

function normalizeExternalAccountInput(input: unknown): InferExternalAccountInput | undefined {
  const address = addressToString(input);
  if (!address) return undefined;

  const publicKey =
    input && typeof input === "object" && "publicKey" in input
      ? publicKeyToString((input as { publicKey?: unknown }).publicKey)
      : undefined;

  return publicKey ? { address, publicKey } : { address };
}

function toJsonCompatibleValue(value: unknown): unknown {
  return encodeWireValue(value);
}

function normalizeWalletStandardSignTransactionInput(
  transaction: CedraSignTransactionInputV1_1,
  options?: unknown
): InferExternalSignTransactionInput {
  const input: Record<string, unknown> = { ...transaction };
  const sender = normalizeExternalAccountInput(transaction.sender);
  const signerAddress = addressToString(transaction.signerAddress);
  const feePayer = normalizeExternalAccountInput(transaction.feePayer);
  const secondarySigners = transaction.secondarySigners
    ?.map(normalizeExternalAccountInput)
    .filter((account): account is InferExternalAccountInput => !!account);

  if (sender) input.sender = sender.address;
  if (signerAddress) input.signerAddress = signerAddress;
  if (feePayer) {
    input.feePayer = feePayer;
    input.feePayerAddress = feePayer.address;
  }
  if (secondarySigners?.length) {
    input.secondarySigners = secondarySigners;
    input.secondarySignerAddresses = secondarySigners.map((account) => account.address);
  }
  if (options !== undefined) input.options = options;

  return toJsonCompatibleValue(input) as InferExternalSignTransactionInput;
}

function normalizeSdkRawTransactionInput(
  transaction: AnyRawTransaction,
  options?: unknown
): InferRawTransactionSignInput {
  const rawTransactionBcsHex = transaction.toString();
  const input: InferRawTransactionSignInput = {
    rawTransactionBcsHex,
    bcsHex: rawTransactionBcsHex
  };
  const rawTransaction = (transaction as { rawTransaction?: { sender?: unknown } }).rawTransaction;
  const sender = addressToString(rawTransaction?.sender);
  const secondarySignerAddresses = (transaction as { secondarySignerAddresses?: unknown[] })
    .secondarySignerAddresses
    ?.map(addressToString)
    .filter((address): address is string => !!address);
  const feePayerAddress = addressToString(
    (transaction as { feePayerAddress?: unknown }).feePayerAddress
  );

  if (sender) input.sender = sender;
  if (secondarySignerAddresses?.length) input.secondarySignerAddresses = secondarySignerAddresses;
  if (feePayerAddress) input.feePayerAddress = feePayerAddress;
  if (options !== undefined) input.options = options;

  return input;
}

function toExternalSignTransactionInput(
  transaction:
    | AnyRawTransaction | InferTransactionPayload | CedraSignTransactionInputV1_1,
  options?: unknown
): InferExternalSignTransactionInput {
  if (isWalletStandardSignTransactionInput(transaction)) {
    return normalizeWalletStandardSignTransactionInput(transaction, options);
  }

  if (isSdkRawTransaction(transaction)) {
    return normalizeSdkRawTransactionInput(transaction, options);
  }

  throw new InferAdapterError(
    InferErrorCode.Unsupported,
    "Infer external signTransaction requires a wallet-standard v1.1 payload or prebuilt SDK transaction"
  );
}

function unwrap<T>(value: T | { data?: T; args?: T; result?: T }): T {
  if (value && typeof value === "object") {
    if ("data" in value && value.data !== undefined) return value.data;
    if ("args" in value && value.args !== undefined) return value.args;
    if ("result" in value && value.result !== undefined) return value.result;
  }
  return value as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function snapshotProviderRecord(
  value: unknown,
  malformedMessage: string
): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;

  try {
    if (Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && Object.getPrototypeOf(prototype) !== null) return null;

    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return null;
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch (error) {
    throw new InferAdapterError(InferErrorCode.InternalError, malformedMessage, error);
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length && expected.every((key) => keys.includes(key)));
}

function normalizeSignAndSubmitProviderResult(
  value: unknown
): CedraSignAndSubmitTransactionOutput {
  const record = snapshotProviderRecord(
    value,
    "Infer provider returned an unreadable transaction result"
  );
  if (!record) {
    throw new InferAdapterError(
      InferErrorCode.InternalError,
      "Infer provider returned a malformed transaction result"
    );
  }

  if (Object.prototype.hasOwnProperty.call(record, "status")) {
    if (record.status === "Rejected" && hasExactKeys(record, ["status"])) {
      throw new InferAdapterError(
        InferErrorCode.UserRejected,
        "User rejected the transaction request"
      );
    }

    if (
      record.status === "Approved" &&
      hasExactKeys(record, ["status", "args"])
    ) {
      const args = snapshotProviderRecord(
        record.args,
        "Infer provider returned unreadable approved transaction arguments"
      );
      if (args && hasExactKeys(args, ["hash"]) && isValidTransactionHash(args.hash)) {
        return { hash: args.hash };
      }
    }

    throw new InferAdapterError(
      InferErrorCode.InternalError,
      "Infer provider returned an ambiguous transaction status"
    );
  }

  if (hasExactKeys(record, ["hash"]) && isValidTransactionHash(record.hash)) {
    return { hash: record.hash };
  }

  throw new InferAdapterError(
    InferErrorCode.InternalError,
    "Infer provider returned a malformed transaction result"
  );
}

const DESKTOP_BRIDGE_RETRY_WINDOW_MS = 8_000;
const DESKTOP_BRIDGE_RETRY_DELAY_MS = 250;
const DESKTOP_BRIDGE_RETRY_CONNECT_TIMEOUT_MS = 1_000;

async function retryLocalBridgeConnectAfterDeeplink(
  options: InferWalletOptions
): Promise<AccountInfo | null> {
  const deadline = Date.now() + DESKTOP_BRIDGE_RETRY_WINDOW_MS;

  while (Date.now() < deadline) {
    const account = await tryLocalBridgeConnect({
      ...options,
      bridgeConnectTimeoutMs: DESKTOP_BRIDGE_RETRY_CONNECT_TIMEOUT_MS
    });
    if (account) {
      return account;
    }

    await new Promise((resolve) => window.setTimeout(resolve, DESKTOP_BRIDGE_RETRY_DELAY_MS));
  }

  return null;
}

/**
 * v0.3.0+ pre-auth polling loop. Calls
 * `pollPreauthConnect(requestId)` every 250 ms until the wallet
 * responds with `approved` or `rejected`, or the bridge poll
 * deadline (`DEFAULT_BRIDGE_POLL_TIMEOUT_MS = 120 s`) elapses.
 *
 * Returns the validated `InferExternalSession` on approval; null
 * on timeout or rejection. Single-shot: the dapp's tab is the
 * only consumer — the wallet invalidates the request_id after
 * the first `Approved` poll.
 *
 * v0.2.0-rc.23 (multi-tab preauth waiter): race the request_id
 * poll against `waitForExternalSession(options)` so a peer-tab
 * Approved event (delivered via the
 * `inferenco:infer-session-ready` CustomEvent that the adapter
 * already dispatches from `bridge.ts` `syncReadySession`) wakes
 * the stuck connect. The adapter's existing wake machinery
 * (`installExternalSessionResumeListeners` → `syncReadySession`
 * at `bridge.ts:771`) is upstream; the pre-auth connect path
 * simply did not register before — `waitForExternalSession` is
 * what registers it, and the pre-auth branch never called it.
 *
 * Behavioural contract:
 *  - Idempotent: each call's `waitForExternalSession`
 *    registration is scoped to this promise; cleanup is done by
 *    its internal `finish()` (bridge.ts:1160) when the waiter
 *    resolves. Two parallel `connect()` calls produce two
 *    independent registrations, each cleaned up by its own
 *    timeout.
 *  - No double-resolve: the `settled` flag is checked on every
 *    `pollPreauthConnect` return and every `waitForExternalSession`
 *    resolve; the second resolution is dropped.
 *  - Non-blocking in single-tab case: no peer dispatches the
 *    session-ready event, so `waitForExternalSession`'s own
 *    timeout (same `bridgePollTimeoutMs`) is the loser; the
 *    request_id poll wins unchanged.
 */
async function pollPreauthUntilResolved(
  requestId: string,
  options: InferWalletOptions
): Promise<InferExternalSession | null> {
  let settled = false;
  const tryFinish = (resolve: (v: InferExternalSession | null) => void) =>
    (value: InferExternalSession | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

  // Own request_id poll. Throws on poll error (preserves existing
  // behaviour). The `settled` short-circuit prevents one final
  // pollPreauthConnect call after a peer-tab wake lands.
  const pollLoop = (async (): Promise<InferExternalSession | null> => {
    const deadline = Date.now() + bridgePollTimeoutMs(options);
    while (!settled && Date.now() < deadline) {
      const result = await pollPreauthConnect({ requestId, options });
      if (settled) return null;
      if (result) {
        if (result.status === "approved" && result.session) {
          storeExternalSession(result.session);
          return result.session;
        }
        if (result.status === "rejected") {
          return null;
        }
      }
      await new Promise((resolve) =>
        window.setTimeout(resolve, bridgePollIntervalMs(options))
      );
    }
    return null;
  })();

  // Peer-tab wake. Returns null on its own timeout; in that case
  // the poll loop's null is the eventual winner.
  const externalWait = (async (): Promise<InferExternalSession | null> => {
    const session = await waitForExternalSession(options);
    if (settled || session === null) return null;
    return session;
  })();

  // First settlement wins. Rejections from the poll path propagate
  // to the outer await below (preserves the existing contract that
  // a network failure surfaces to the caller's try/catch).
  return await new Promise<InferExternalSession | null>((resolve, reject) => {
    const finish = tryFinish(resolve);
    pollLoop.then(finish, (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    externalWait.then((session) => {
      if (session !== null) finish(session);
    });
  });
}

export class InferClient extends EventEmitter<InferClientEvents> {
  private provider?: InferProvider;
  private injectedScopeRevision = 0;
  private accountInfo: AccountInfo | null = null;
  private networkInfo: NetworkInfo | null = null;
  /** v0.2.0-rc.8 (Phase 5 UX): opt-in session liveness handle. */
  private livenessHandle: ReturnType<typeof setInterval> | null = null;
  /** v0.2.0-rc.8 (Phase 5 UX): tracks whether we already cleaned up after
   * a disconnect this generation, so a duplicate `disconnect` event
   * (e.g., storage event in peer tab + direct emit) doesn't double-clear. */
  private disconnectEmitted = false;
  private healthState: InferConnectionHealth = { state: "disconnected", identity: null };
  private readonly recoveredSubscribers = new Map<
    (outcome: RecoveredRequestOutcome) => void | Promise<void>, Set<string>
  >();
  private recoveryRun: Promise<void> | null = null;
  private recoveryRescan = false;
  private recoveryChannel: BroadcastChannel | null = null;
  private disposeMobileOwnerResponder: (() => void) | null = null;
  private disconnectChannel: BroadcastChannel | null = null;
  private readonly recoveryWake = () => { this.scheduleRecovery(); };
  private readonly onSessionCleared = () => { this.handleExternalSessionCleared(); };
  private readonly onPeerDisconnect = (event: MessageEvent) => {
    if (parseDisconnectPayload(event.data)) this.handleExternalSessionCleared();
  };
  private readonly onWindowDisconnect = (event: MessageEvent) => {
    if (event.origin === window.location.origin && parseDisconnectPayload(event.data)) {
      this.handleExternalSessionCleared();
    }
  };
  private disposed = false;

  constructor(private readonly options: InferWalletOptions = {}) {
    super();
    installExternalSessionResumeListeners();
    storeCallbackSession();
    this.provider = detectProvider(options);
    const cached = readExternalSession();
    if (cached) {
      this.healthState = {
        state: "checking",
        identity: { transport: cached.transport, sessionId: cached.sessionId,
          address: cached.address, network: cached.network, chainId: cached.chainId }
      };
    }
    this.installDisconnectBridgeListeners();
    this.maybeStartSessionLiveness();
    if (options.onRecoveredOutcome) {
      this.recoveredSubscribers.set(options.onRecoveredOutcome, new Set());
    }
    if (typeof window !== "undefined") {
      this.disposeMobileOwnerResponder = installMobileReturnOwnerResponder();
      const mobileCallbackId = isMobileBrowser() ? readCallbackMarker()?.requestId : undefined;
      if (mobileCallbackId) void this.coordinateMobileCallbackTab(mobileCallbackId);
      window.addEventListener("focus", this.recoveryWake);
      window.addEventListener("pageshow", this.recoveryWake);
      window.addEventListener("storage", this.recoveryWake);
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.recoveryWake);
      if (typeof BroadcastChannel !== "undefined") {
        try {
          this.recoveryChannel = new BroadcastChannel(RECOVERY_CHANNEL);
          this.recoveryChannel.addEventListener("message", this.recoveryWake);
        } catch {
          // Reads remain available if cross-tab notification is unavailable.
        }
      }
      // Capture valid rc.20 tab receipts before any health check can clear
      // a stale signing session. Durable records then remain origin-scoped.
      const storageReady = this.listRecoverableRequests();
      void storageReady.then(() => this.scheduleRecovery()).catch(() => undefined);
      queueMicrotask(() => { void pruneDurableEvidence().catch(() => undefined); });
    }
  }

  get connectionHealth(): InferConnectionHealth {
    return this.healthState;
  }

  async checkConnectionHealth(): Promise<InferConnectionHealth> {
    const next = await checkExternalConnectionHealth(readExternalSession(), this.options);
    if (JSON.stringify(next) !== JSON.stringify(this.healthState)) {
      this.healthState = next;
      this.emit("connectionHealth", next);
    }
    if (next.state === "unreachable" || next.state === "reconnect-required") {
      this.accountInfo = null;
      this.networkInfo = null;
    }
    return next;
  }

  /** Application-facing exact-ID recovery; no request creation or wallet launch. */
  listRecoverableRequests(): Promise<RecoverableRequest[]> {
    return listRecoverableRequests(this.options);
  }

  listRecoverableInvocations(): Promise<RecoverableInvocation[]> {
    return listRecoverableInvocations();
  }

  reconcileRecoverableInvocation(invocationId: string): Promise<RecoveredInvocationOutcome> {
    return reconcileRecoverableInvocation(invocationId, this.options);
  }

  relaunchRecoverableInvocation(invocationId: string): Promise<void> {
    return relaunchRecoverableInvocation(invocationId, this.options);
  }

  listArchivedRecoverableRequests(): Promise<ArchivedRecoverableRequest[]> {
    return listArchivedRecoverableRequests(this.options);
  }

  readRecoverableRequest(requestId: string): Promise<RecoveredRequestOutcome> {
    return readRecoverableRequest(requestId, this.options);
  }

  acknowledgeRecoverableRequest(requestId: string): Promise<void> {
    return acknowledgeRecoverableRequest(requestId, this.options);
  }

  archiveRecoverableRequest(requestId: string, reconciliationReference: string): Promise<void> {
    return archiveRecoverableRequest(requestId, reconciliationReference, this.options);
  }

  /** Late subscribers receive retained final outcomes; delivery is advisory until acknowledged. */
  subscribeRecoveredOutcomes(
    callback: (outcome: RecoveredRequestOutcome) => void | Promise<void>
  ): () => void {
    this.recoveredSubscribers.set(callback, new Set());
    this.scheduleRecovery();
    return () => { this.recoveredSubscribers.delete(callback); };
  }

  /** Stop coordinator listeners when an application replaces this client. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.livenessHandle !== null) clearInterval(this.livenessHandle);
    this.livenessHandle = null;
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", this.recoveryWake);
      window.removeEventListener("pageshow", this.recoveryWake);
      window.removeEventListener("storage", this.recoveryWake);
      window.removeEventListener(INFER_SESSION_CLEARED_MESSAGE_TYPE, this.onSessionCleared);
      window.removeEventListener("message", this.onWindowDisconnect);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.recoveryWake);
    }
    this.disposeMobileOwnerResponder?.();
    this.disposeMobileOwnerResponder = null;
    this.recoveryChannel?.removeEventListener("message", this.recoveryWake);
    this.recoveryChannel?.close();
    this.recoveryChannel = null;
    this.disconnectChannel?.removeEventListener("message", this.onPeerDisconnect);
    this.disconnectChannel?.close();
    this.disconnectChannel = null;
    this.recoveredSubscribers.clear();
  }

  private async coordinateMobileCallbackTab(requestId: string): Promise<void> {
    if (window.opener && window.opener !== window) return;
    let final = false;
    try {
      const pairing = readPendingMobilePairing();
      if (pairing?.pairingId === requestId) {
        try {
          final = !!(await resumeMobileRelaySession(this.options));
        } catch (error) {
          final = error instanceof InferAdapterError &&
            (error.code === InferErrorCode.UserRejected ||
             error.code === InferErrorCode.ConnectionTimeout);
        }
      } else {
        const outcome = await this.readRecoverableRequest(requestId);
        final = outcome.status === "approved" || outcome.status === "rejected";
      }
      if (final && !this.disposed &&
        (await hasLiveOriginalMobileTab(requestId))) {
        // The original tab still owns the request. It wakes from the durable
        // record change; this callback tab never takes over gameplay.
        renderCallbackCompletionFallback();
      }
    } catch {
      // Unknown or unauthenticated callback markers cannot claim completion.
    }
  }

  private scheduleRecovery(): void {
    if (this.disposed || this.recoveredSubscribers.size === 0) return;
    if (this.recoveryRun) {
      this.recoveryRescan = true;
      return;
    }
    this.recoveryRun = (async () => {
      do {
        this.recoveryRescan = false;
        await this.reconcileRecoverableRequests();
      } while (this.recoveryRescan && !this.disposed);
    })().finally(() => { this.recoveryRun = null; });
  }

  private async reconcileRecoverableRequests(): Promise<void> {
    // Recover receipt-less mobile invocations first. This lookup is read-only
    // and may cause an original request to appear in the durable request list.
    try {
      const invocations = await this.listRecoverableInvocations();
      for (const invocation of invocations) {
        if (this.disposed) return;
        if (
          (invocation.transport === "mobile-relay" ||
            invocation.transport === "desktop-bridge") &&
            (invocation.state === "prepared" || invocation.state === "unknown") &&
            !invocation.requestId) {
          await this.reconcileRecoverableInvocation(invocation.invocationId);
        }
      }
    } catch {
      // Existing request receipts remain recoverable independently.
    }
    let pending: RecoverableRequest[];
    try {
      pending = await this.listRecoverableRequests();
    } catch {
      return;
    }
    for (const request of pending) {
      if (this.disposed || this.recoveredSubscribers.size === 0) return;
      try {
        const outcome = await this.readRecoverableRequest(request.recoveryId);
        if (outcome.status !== "approved" && outcome.status !== "rejected") continue;
        const stillActive = (await this.listRecoverableRequests()).some((item) =>
          item.recoveryId === request.recoveryId && item.method === request.method
        );
        if (!stillActive) continue;
        for (const [callback, delivered] of this.recoveredSubscribers) {
          if (delivered.has(request.recoveryId) || this.disposed) continue;
          try {
            await callback(Object.freeze(outcome));
            delivered.add(request.recoveryId);
          } catch {
            // Failed consumer persistence leaves the final outcome replayable.
          }
        }
      } catch {
        // An unreadable request remains available for a later wake or explicit read.
      }
    }
  }

  /** v0.2.0-rc.8 (Phase 5 UX): wire `bridge.ts`'s disconnect
   * dispatchers into `this.emit("disconnect")` and reset cached
   * state. Idempotent — `installExternalSessionResumeListeners`
   * is already idempotent, and the bridge listeners are installed
   * once per tab. */
  private installDisconnectBridgeListeners(): void {
    if (typeof window === "undefined") return;

    window.addEventListener(INFER_SESSION_CLEARED_MESSAGE_TYPE, this.onSessionCleared);
    if (typeof BroadcastChannel !== "undefined") {
      try {
        this.disconnectChannel = new BroadcastChannel(INFER_SESSION_CLEARED_MESSAGE_TYPE);
        this.disconnectChannel.addEventListener("message", this.onPeerDisconnect);
      } catch {
        // The same-window and storage routes remain available.
      }
    }
    window.addEventListener("message", this.onWindowDisconnect);
  }

  /** v0.2.0-rc.8 (Phase 5 UX): unified cleanup path. Clears cached
   * state, emits the event once per generation, and stops any active
   * heartbeat. Safe to call repeatedly — the second and subsequent
   * invocations are no-ops once `disconnectEmitted` is set. */
  private handleExternalSessionCleared(): void {
    if (this.disconnectEmitted) return;
    this.disconnectEmitted = true;

    if (this.livenessHandle !== null) {
      clearInterval(this.livenessHandle);
      this.livenessHandle = null;
    }

    this.accountInfo = null;
    this.networkInfo = null;
    this.healthState = { state: "disconnected", identity: null };
    this.emit("connectionHealth", this.healthState);
    this.emit("disconnect");
  }

  /** v0.2.0-rc.8 (Phase 5 UX): opt-in liveness heartbeat. When
   * `options.sessionLivenessIntervalMs > 0`, schedule a periodic
   * `readValidatedExternalSession` against the local Infer Desk
   * bridge. A 403/404 response indicates the wallet revoked our
   * session, so we emit the `disconnect` event. */
  private maybeStartSessionLiveness(): void {
    const intervalMs =
      this.options.sessionLivenessIntervalMs ?? DEFAULT_SESSION_LIVENESS_INTERVAL_MS;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    if (this.livenessHandle !== null) return;
    if (typeof window === "undefined") return;

    this.livenessHandle = setInterval(() => {
      void this.pollSessionLiveness();
    }, intervalMs);
  }

  /** v0.2.0-rc.8 (Phase 5 UX): one tick of the liveness heartbeat. */
  private async pollSessionLiveness(): Promise<void> {
    try {
      const health = await this.checkConnectionHealth();
      if (health.state === "reconnect-required") this.handleExternalSessionCleared();
    } catch {
      // A failed health check is not proof of revocation.
    }
  }

  refreshProvider(): InferProvider | undefined {
    this.provider = detectProvider(this.options);
    return this.provider;
  }

  hasProvider(): boolean {
    return !!this.refreshProvider();
  }

  hasExternalSession(): boolean {
    return !!readExternalSession();
  }

  get account(): AccountInfo | null {
    return this.accountInfo;
  }

  get cachedNetwork(): NetworkInfo | null {
    return this.networkInfo;
  }

  private connectResultFromExternalSession(
    externalSession: InferExternalSession
  ): { account: AccountInfo; network: NetworkInfo } {
    const account = sessionToAccountInfo(externalSession);
    const network = normalizeNetwork({
      name: externalSession.network as Network,
      chainId: externalSession.chainId
    });

    this.accountInfo = account;
    this.networkInfo = network;
    const identity = {
      transport: externalSession.transport, sessionId: externalSession.sessionId,
      address: externalSession.address, network: externalSession.network,
      chainId: externalSession.chainId
    };
    this.healthState = externalSession.transport === "mobile-relay"
      ? { state: "checking", identity,
          reason: "The relay has no authenticated session-health read endpoint" }
      : { state: "connected", identity };
    this.emit("connectionHealth", this.healthState);
    this.scheduleRecovery();

    return { account, network };
  }

  async connect(): Promise<{ account: AccountInfo; network: NetworkInfo | null;
  }> {
    try {
      const provider = this.refreshProvider();
      if (provider?.connect) {
        const account = normalizeProviderAccount(unwrap(await provider.connect()));
        this.accountInfo = account;

        if (provider.network) {
          this.networkInfo = normalizeNetwork(unwrap(await provider.network()));
        }

        return { account, network: this.networkInfo };
      }

      const resumedMobileSession = await resumeMobileRelaySession(this.options);
      if (resumedMobileSession) {
        return this.connectResultFromExternalSession(resumedMobileSession);
      }

      // 0.2.0-rc.7: if Infer Desk redirected us back to the dapp with
      // the callback URL params (?address=...&sessionId=...&bridgeUrl=...),
      // consume them into localStorage BEFORE trying the local-bridge
      // or deeplink paths. Without this, the page navigation that the
      // callback causes destroys the in-flight connect promise, and
      // the next user-triggered connect() invocation re-fires the
      // deeplink (asking the user to connect again), and
      // waitForExternalSession times out because nothing consumed
      // the params.
      const consumedCallback = await consumeExternalCallbackIfPresent(this.options);
      const externalSession = await readValidatedExternalSession(this.options);
      if (externalSession) {
        // v0.2.0-rc.8: a successful connect resets the disconnect
        // gate so future disconnect events can fire again.
        this.disconnectEmitted = false;
        return this.connectResultFromExternalSession(externalSession);
      }
      // If the callback was consumed but the session isn't yet
      // validated (e.g., legacy callback where the local bridge is
      // unreachable), don't fall through to the deeplink — we already
      // got the answer.
      if (consumedCallback) {
        // Wait briefly for the session to land in localStorage; if the
        // PKCE flow is in progress it'll arrive via storeCallbackSession
        // within a few ticks.
        for (let i = 0; i < 20; i += 1) {
          const pending = await readValidatedExternalSession(this.options);
          if (pending) {
            return this.connectResultFromExternalSession(pending);
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      }

if (typeof window !== "undefined" && isMobileBrowser()) {
        const mobileSession = await connectViaMobileRelay(this.options);
        return this.connectResultFromExternalSession(mobileSession);
      }

      // 0.2.0-rc.10 pre-auth flow (Infer Desk 0.6.0-rc.6+). Desktop
      // browser path: NO deeplink, NO new tab. The dapp creates a
      // connect request via `POST /preauth-connect`, then polls
      // `GET /preauth-poll/<request_id>` until the user approves
      // in Infer Desk. Infer Desk auto-shows the approval sheet
      // from the bridge queue (no `inferenco://` deeplink needed).
      //
      // v0.2.0-rc.10 removed the `window.location.href = deeplink`
      // call that rc.9 used to fire — the wallet surfaces the
      // approval sheet directly from the POST /preauth-connect
      // queue, so the browser's external-protocol handler dialog
      // (Chrome on Linux) is avoided entirely.
      if (typeof window !== "undefined" && !isMobileBrowser()) {
        const app =
          (typeof document !== "undefined" && document.title) ||
          "Infer Desk";
        const preauth = await startPreauthConnect({
          origin: window.location.origin,
          app,
          options: this.options
        });
        if (preauth) {
          const session = await pollPreauthUntilResolved(
            preauth.requestId,
            this.options
          );
          if (session) {
            return this.connectResultFromExternalSession(session);
          }
          throw new InferAdapterError(
            InferErrorCode.ConnectionTimeout,
            "Timed out waiting for Infer Desk to approve the pre-auth connect request."
          );
        }

        // Pre-auth route unavailable (older wallet build, or the
        // bridge is down). Fall through to the legacy inferenco://
        // deeplink to launch the wallet via the OS handler. This
        // keeps the adapter working against pre-0.6.0-rc.6
        // wallets and against cold-start cases where Infer Desk
        // isn't running yet.
      }

      const bridgedAccount = await tryLocalBridgeConnect(this.options);
      if (bridgedAccount) {
        this.accountInfo = bridgedAccount;
        const bridgedSession = await readValidatedExternalSession(this.options);
        this.networkInfo = bridgedSession
          ? normalizeNetwork({
              name: bridgedSession.network as Network,
              chainId: bridgedSession.chainId
            })
          : null;
        return { account: bridgedAccount, network: this.networkInfo };
      }

      if (typeof window !== "undefined") {
        launchDesktopOrMobileConnect(this.options);

        const retriedAccount = await retryLocalBridgeConnectAfterDeeplink(this.options);
        if (retriedAccount) {
          this.accountInfo = retriedAccount;
          const retriedSession = await readValidatedExternalSession(this.options);
          this.networkInfo = retriedSession
            ? normalizeNetwork({
                name: retriedSession.network as Network,
                chainId: retriedSession.chainId
              })
            : null;
          return { account: retriedAccount, network: this.networkInfo };
        }

        const handoffSession = await waitForExternalSession(this.options);
        if (handoffSession) {
          return this.connectResultFromExternalSession(handoffSession);
        }

        throw new InferAdapterError(
          InferErrorCode.ConnectionTimeout,
          "Timed out waiting for Infer Desk to complete the external connection handoff."
        );
      }

      throw new InferAdapterError(
        InferErrorCode.NotInstalled,
        `Infer provider not found. Open ${buildDeeplinkUrl(this.options)}`
      );
    } catch (error) {
      remapInferError(error);
    }
  }

  async getAccount(): Promise<AccountInfo> {
    if (this.accountInfo) return this.accountInfo;

    try {
      const provider = this.refreshProvider();
      if (provider?.account) {
        const account = normalizeProviderAccount(
          unwrap(await provider.account())
        );
        this.accountInfo = account;
        return account;
      }

      const externalSession = await readValidatedExternalSession(this.options);
      if (externalSession) {
        const account = sessionToAccountInfo(externalSession);
        this.accountInfo = account;
        return account;
      }

      throw new InferAdapterError(
        InferErrorCode.NotInstalled,
        "Infer provider account() unavailable"
      );
    } catch (error) {
      remapInferError(error);
    }
  }

  async disconnect(): Promise<void> {
    this.injectedScopeRevision++;
    const provider = this.refreshProvider();
    const externalSession = readExternalSession();
    this.disconnectEmitted = false;
    try {
      await provider?.disconnect?.();
      if (externalSession) {
        await revokeExternalSession(externalSession, this.options);
      }
    } catch (error) {
      remapInferError(error);
    } finally {
      clearExternalSession();
      clearPendingMobilePairing();
      // v0.2.0-rc.8 (Phase 5 UX): notify peer tabs (storage event in
      // other tabs will fire from the `clearExternalSession` call above,
      // but ensure same-tab listeners see the disconnect too) and emit
      // the local event so dapps register a single handler for both
      // wallet-revoked and self-initiated disconnects.
      notifyExternalDisconnect();
      this.handleExternalSessionCleared();
    }
  }

  async getNetwork(): Promise<NetworkInfo> {
    if (this.networkInfo) return this.networkInfo;

    try {
      const provider = this.refreshProvider();
      if (provider?.network) {
        const network = normalizeNetwork(unwrap(await provider.network()));
        this.networkInfo = network;
        return network;
      }

      const externalSession = await readValidatedExternalSession(this.options);
      if (externalSession) {
        const network = normalizeNetwork({
          name: externalSession.network as Network,
          chainId: externalSession.chainId
        });
        this.networkInfo = network;
        return network;
      }

      throw new InferAdapterError(
        InferErrorCode.NotInstalled,
        "Infer provider network() unavailable"
      );
    } catch (error) {
      remapInferError(error);
    }
  }

  private assertInjectedProvider(
    provider: InferProvider,
    contractVersion: InferProvider["integrationContractVersion"],
    scopeRevision: number
  ): void {
    if (this.refreshProvider() !== provider ||
        this.injectedScopeRevision !== scopeRevision ||
        provider.integrationContractVersion !== contractVersion)
      throw new InferAdapterError(InferErrorCode.Unauthorized,
        "Injected provider changed during request preparation");
  }

  /** Recheck the live provider after application persistence; caches are not a dispatch fence. */
  private async assertLiveInjectedScope(
    provider: InferProvider,
    account: AccountInfo,
    network: NetworkInfo,
    contractVersion: InferProvider["integrationContractVersion"]
  ): Promise<void> {
    const scopeRevision = this.injectedScopeRevision;
    this.assertInjectedProvider(provider, contractVersion, scopeRevision);
    if (!provider.account || !provider.network)
      throw new InferAdapterError(InferErrorCode.Unauthorized,
        "Injected provider cannot confirm the original account and network");
    const liveAccount = normalizeProviderAccount(unwrap(await provider.account()));
    const liveNetwork = normalizeNetwork(unwrap(await provider.network()));
    this.assertInjectedProvider(provider, contractVersion, scopeRevision);
    if (canonicalAddress(liveAccount.address.toString()) !== canonicalAddress(account.address.toString()) ||
        liveAccount.publicKey.toString().toLowerCase() !== account.publicKey.toString().toLowerCase() ||
        liveNetwork.name !== network.name || liveNetwork.chainId !== network.chainId)
      throw new InferAdapterError(InferErrorCode.Unauthorized,
        "Injected account or network changed during request preparation");
  }

  private async prepareInjectedSigning(
    provider: InferProvider,
    method: DurableInvocation["method"],
    payload: unknown,
    account: AccountInfo,
    network: NetworkInfo
  ) {
    const contractVersion = provider.integrationContractVersion;
    const scope = {
      origin: typeof window === "undefined" ? "" : window.location.origin,
      accountAddress: canonicalAddress(account.address.toString()),
      network: network.name,
      chainId: network.chainId
    };
    if (!scope.origin)
      throw new InferAdapterError(
        InferErrorCode.Unsupported,
        "Persistent signing requires a browser origin"
      );
    const invocation = await prepareDurableInvocation(
      {
        transport: "injected",
        sessionId: "injected:" + scope.accountAddress + ":" + scope.chainId,
        address: scope.accountAddress,
        network: scope.network,
        chainId: scope.chainId
      },
      method,
      {
        requestCommitment: requestCommitment(method, scope, payload),
        requestPayload: payload,
        endpoint: scope.origin,
        signerPublicKey: account.publicKey.toString(),
        remoteAcknowledgementRequired: contractVersion === 1 &&
          typeof provider.acknowledgeInvocation === "function"
      }
    );
    const descriptor = Object.freeze(invocationDescriptor(invocation));
    try {
      await this.options.onInvocationPrepared?.(descriptor);
      await this.assertLiveInjectedScope(provider, account, network, contractVersion);
      if (
        provider.integrationContractVersion !== undefined &&
        provider.integrationContractVersion !== 1
      ) {
        throw new InferAdapterError(
          InferErrorCode.Unsupported,
          "Unsupported provider integration contract version"
        );
      }
      if (
        this.options.networkOverride !== undefined &&
        this.options.networkOverride !== scope.network
      ) {
        throw new InferAdapterError(
          InferErrorCode.InvalidNetwork,
          "Approved network differs from networkOverride"
        );
      }
    } catch (cause) {
      await updateDurableInvocation(invocation.id, "not-invoked").catch(
        () => undefined
      );
      throw notInvokedError(
        "Signing stopped before provider invocation",
        descriptor,
        cause
      );
    }
    return {
      invocation,
      scope,
      metadata: {
        contractVersion: 1,
        invocationId: invocation.id,
        requestCommitment: invocation.requestCommitment,
        scope
      }
    };
  }

  async signMessage(
    input: CedraSignMessageInput
  ): Promise<CedraSignMessageOutput> {
    let invocation: DurableInvocation | undefined;
    try {
      const request = validateMessageInput(input);
      const provider = this.refreshProvider();
      const account = await this.getAccount();
      const network = await this.getNetwork();
      const scope = {
        origin: typeof window === "undefined" ? "" : window.location.origin,
        accountAddress: canonicalAddress(account.address.toString()),
        network: network.name,
        chainId: network.chainId
      };
      let response: unknown;
      let expectedInput: CedraSignMessageInput = request;
      let allowLegacy = false;
      if (provider?.signMessage) {
        const payload =
          provider.integrationContractVersion === 1
            ? { ...request, profile: MESSAGE_PROFILE }
            : request;
        expectedInput = payload;
        allowLegacy = provider.integrationContractVersion !== 1;
        const prepared = await this.prepareInjectedSigning(
          provider,
          "signMessage",
          payload,
          account,
          network
        );
        invocation = prepared.invocation;
        try {
          response = await provider.signMessage(
            payload,
            provider.integrationContractVersion === 1
              ? prepared.metadata
              : undefined
          );
        } catch (cause) {
          throw new InferAdapterError(
            InferErrorCode.InternalError,
            "Native message signing failed; no explicit decline was returned",
            cause
          );
        }
        const record = snapshotProviderRecord(
          response,
          "Unreadable message response"
        );
        if (!record)
          throw new InferAdapterError(
            InferErrorCode.InternalError,
            "Malformed message response"
          );
        if (record.status === "Rejected" && hasExactKeys(record, ["status"]))
          throw new InferAdapterError(
            InferErrorCode.UserRejected,
            "User rejected the message request"
          );
        if (Object.prototype.hasOwnProperty.call(record, "status")) {
          if (
            record.status !== "Approved" ||
            !hasExactKeys(record, ["status", "args"])
          )
            throw new InferAdapterError(
              InferErrorCode.InternalError,
              "Ambiguous message response"
            );
          response = record.args;
        }
      } else {
        const session = await readValidatedExternalSession(this.options);
        if (!session)
          throw new InferAdapterError(
            InferErrorCode.Unsupported,
            "Infer message signing is unavailable"
          );
        const payload =
          session.integrationContractVersion === 1
            ? { ...request, profile: MESSAGE_PROFILE }
            : request;
        expectedInput = payload;
        allowLegacy = session.integrationContractVersion !== 1;
        response = await (session.transport === "mobile-relay"
          ? signMessageViaMobileRelay(payload, session, this.options)
          : tryLocalBridgeSignMessage(payload, session, this.options));
      }
      const output = verifySignedMessageOutput(
        response,
        expectedInput,
        scope,
        account.publicKey.toString(),
        allowLegacy
      );
      if (invocation)
        await updateInjectedInvocationEvidence(invocation.id, {
          final: serializeStoredFinal("signMessage", output)
        });
      return output;
    } catch (error) {
      if (
        invocation &&
        error instanceof InferAdapterError &&
        error.code === InferErrorCode.UserRejected
      ) {
        await updateInjectedInvocationEvidence(invocation.id, {
          final: { status: "rejected" }
        });
      } else if (invocation)
        await updateDurableInvocation(invocation.id, "unknown").catch(
          () => undefined
        );
      remapSignAndSubmitError(error);
    }
  }

  async signMessageAndVerify(input: CedraSignMessageInput): Promise<boolean> {
    validateMessageInput(input);
    try {
      await this.signMessage(input);
      return true;
    } catch (error) {
      if (
        error instanceof InferAdapterError &&
        (error.code === InferErrorCode.InternalError ||
          error.code === InferErrorCode.InvalidParams)
      )
        return false;
      throw error;
    }
  }

  async signTransaction(
    transaction:
      | AnyRawTransaction
      | InferTransactionPayload
      | CedraSignTransactionInputV1_1,
    options?: unknown
  ): Promise<InferSignTransactionResult> {
    let invocation: DurableInvocation | undefined;
    try {
      const provider = this.refreshProvider();
      if (provider?.signTransaction) {
        const rawInput = isSdkRawTransaction(transaction)
          ? normalizeSdkRawTransactionInput(transaction, options)
          : undefined;
        const wire = encodeWireValue(
          rawInput ?? toExternalSignTransactionInput(transaction, options)
        ) as unknown as InferExternalSignTransactionInput;
        let metadata: unknown = options;
        if (
          provider.integrationContractVersion !== undefined &&
          provider.integrationContractVersion !== 1
        ) {
          throw new InferAdapterError(
            InferErrorCode.Unsupported,
            "Unsupported provider integration contract version"
          );
        }
        if (provider.integrationContractVersion === 1) {
          const prepared = await this.prepareInjectedSigning(
            provider,
            "signTransaction",
            wire,
            await this.getAccount(),
            await this.getNetwork()
          );
          invocation = prepared.invocation;
          metadata = prepared.metadata;
        }
        if (
          provider.integrationContractVersion !== 1 &&
          this.options.networkOverride !== undefined
        ) {
          const contractVersion = provider.integrationContractVersion;
          const scopeRevision = this.injectedScopeRevision;
          this.assertInjectedProvider(provider, contractVersion, scopeRevision);
          if (!provider.network)
            throw new InferAdapterError(InferErrorCode.InvalidNetwork,
              "Legacy provider cannot confirm the required signing network");
          const liveNetwork = normalizeNetwork(unwrap(await provider.network()));
          this.assertInjectedProvider(provider, contractVersion, scopeRevision);
          if (liveNetwork.name !== this.options.networkOverride)
            throw new InferAdapterError(
              InferErrorCode.InvalidNetwork,
              "Approved network differs from networkOverride"
            );
        }
        let response: unknown;
        try {
          response = await provider.signTransaction(wire, metadata);
        } catch (cause) {
          throw new InferAdapterError(
            InferErrorCode.InternalError,
            "Native transaction signing failed; no explicit decline was returned",
            cause
          );
        }
        let result: unknown = response;
        if (
          rawInput ||
          (response && typeof response === "object" && "status" in response)
        ) {
          const record = snapshotProviderRecord(
            response,
            "Unreadable signing response"
          );
          if (!record)
            throw new InferAdapterError(
              InferErrorCode.InternalError,
              "Malformed signing response"
            );
          if (Object.prototype.hasOwnProperty.call(record, "status")) {
            if (
              record.status === "Rejected" &&
              hasExactKeys(record, ["status"])
            ) {
              throw new InferAdapterError(
                InferErrorCode.UserRejected,
                "User rejected the transaction request"
              );
            }
            if (
              record.status !== "Approved" ||
              !hasExactKeys(record, ["status", "args"])
            ) {
              throw new InferAdapterError(
                InferErrorCode.InternalError,
                "Ambiguous signing response"
              );
            }
            result = record.args;
          } else result = unwrap(record);
        } else result = unwrap(response);
        const output =
          rawInput || invocation
            ? deserializeSignTransactionResult(
                result,
                rawInput?.rawTransactionBcsHex
              )
            : normalizeSignTransactionResult(result);
        if (invocation)
          await updateInjectedInvocationEvidence(invocation.id, {
            final: serializeStoredFinal(
              "signTransaction",
              output as CedraSignTransactionOutputV1_1
            )
          });
        return output;
      }
      const externalSession = await readValidatedExternalSession(this.options);
      if (externalSession) {
        const externalInput = toExternalSignTransactionInput(
          transaction,
          options
        );
        const result = await (externalSession.transport === "mobile-relay"
          ? signTransactionViaMobileRelay(
              externalInput,
              externalSession,
              this.options
            )
          : tryLocalBridgeSignTransaction(
              externalInput,
              externalSession,
              this.options
            ));
        if ("rawTransactionBcsHex" in externalInput)
          return deserializeSignTransactionResult(
            result,
            externalInput.rawTransactionBcsHex
          );
        return result;
      }
      throw new InferAdapterError(
        InferErrorCode.Unsupported,
        "Infer provider signTransaction() unavailable"
      );
    } catch (error) {
      if (
        invocation &&
        error instanceof InferAdapterError &&
        error.code === InferErrorCode.UserRejected
      ) {
        await updateInjectedInvocationEvidence(invocation.id, {
          final: { status: "rejected" }
        });
      } else if (invocation)
        await updateDurableInvocation(invocation.id, "unknown").catch(
          () => undefined
        );
      remapSignAndSubmitError(error);
    }
  }

  /** Documented SDK convenience; the standard feature validates its own input first. */
  async signAndSubmitTransaction(
    transaction:
      | AnyRawTransaction
      | InferTransactionPayload
      | CedraSignAndSubmitTransactionInput,
    options?: unknown
  ): Promise<CedraSignAndSubmitTransactionOutput> {
    const wire = normalizeSubmitInput(
      options === undefined ? transaction : { data: transaction, options }
    );
    const required =
      wire.options.expireTimestamp !== undefined ||
      wire.options.sequenceNumber !== undefined ||
      wire.sender !== undefined ||
      wire.chainId !== undefined;
    return this.submitNormalized(wire, {
      ...this.options,
      ...(required ? { requireContractVersion: 1 as const } : {})
    });
  }

  async signAndSubmitTransactionWithRestrictions(
    input: CanonicalTransactionInput,
    callOptions: Pick<InferWalletOptions, "onInvocationPrepared"> = {}
  ): Promise<CedraSignAndSubmitTransactionOutput> {
    const wire = normalizeSubmitInput(input);
    return this.submitNormalized(wire, {
      ...this.options,
      ...callOptions,
      requireContractVersion: 1
    });
  }

  private async submitNormalized(
    wire: CanonicalTransactionInput,
    callOptions: InferWalletOptions
  ): Promise<CedraSignAndSubmitTransactionOutput> {
    try {
      const provider = this.refreshProvider();
      if (provider?.signAndSubmitTransaction) {
        const account = await this.getAccount();
        const network = await this.getNetwork();
        const contractVersion = provider.integrationContractVersion;
        const scope = {
          origin: typeof window === "undefined" ? "" : window.location.origin,
          accountAddress: canonicalAddress(account.address.toString()),
          network: network.name,
          chainId: network.chainId
        };
        if (!scope.origin || typeof scope.network !== "string")
          throw new InferAdapterError(
            InferErrorCode.Unsupported,
            "A browser and approved network are required"
          );
        const invocation = await prepareDurableInvocation(
          {
            transport: "injected",
            sessionId: "injected:" + scope.accountAddress + ":" + scope.chainId,
            address: scope.accountAddress,
            network: scope.network,
            chainId: scope.chainId
          },
          "signAndSubmitTransaction",
          {
            requestCommitment: requestCommitment(
              "signAndSubmitTransaction",
              scope,
              wire
            ),
            requestPayload: wire,
            endpoint: scope.origin,
            remoteAcknowledgementRequired: contractVersion === 1 &&
              typeof provider.acknowledgeInvocation === "function"
          }
        );
        const descriptor = Object.freeze(invocationDescriptor(invocation));
        let providerInput: CanonicalTransactionInput | ReturnType<typeof legacySubmitInput>;
        try {
          await callOptions.onInvocationPrepared?.(descriptor);
          await this.assertLiveInjectedScope(provider, account, network, contractVersion);
          if (
            provider.integrationContractVersion !== undefined &&
            provider.integrationContractVersion !== 1
          )
            throw new InferAdapterError(
              InferErrorCode.Unsupported,
              "Unsupported provider integration contract version"
            );
          if (
            callOptions.requireContractVersion === 1 &&
            (provider.integrationContractVersion !== 1 ||
              !provider.capabilities?.transactionRestrictions)
          ) {
            throw new InferAdapterError(
              InferErrorCode.Unsupported,
              "This injected wallet does not support required transaction restrictions"
            );
          }
          this.assertSubmissionScope(
            wire,
            scope.accountAddress,
            scope.chainId,
            scope.network
          );
          providerInput = provider.integrationContractVersion === 1 ? wire : legacySubmitInput(wire);
        } catch (cause) {
          await updateDurableInvocation(invocation.id, "not-invoked").catch(
            () => undefined
          );
          throw notInvokedError(
            "Wallet submission stopped before provider invocation",
            descriptor,
            cause
          );
        }
        let providerResult: unknown;
        try {
          providerResult = await provider.signAndSubmitTransaction(
            providerInput as unknown as InferTransactionPayload,
            provider.integrationContractVersion === 1
              ? {
                  contractVersion: 1,
                  invocationId: invocation.id,
                  requestCommitment: invocation.requestCommitment,
                  scope
                }
              : undefined
          );
        } catch (cause) {
          await updateDurableInvocation(invocation.id, "unknown").catch(
            () => undefined
          );
          throw new InferAdapterError(
            InferErrorCode.RequestOutcomeUnknown,
            "Injected wallet submission outcome is unknown",
            cause
          );
        }
        let result: CedraSignAndSubmitTransactionOutput;
        try {
          result = normalizeSignAndSubmitProviderResult(providerResult);
        } catch (error) {
          if (
            error instanceof InferAdapterError &&
            error.code === InferErrorCode.UserRejected
          ) {
            await updateInjectedInvocationEvidence(invocation.id, {
              final: { status: "rejected" }
            });
          } else
            await updateDurableInvocation(invocation.id, "unknown").catch(
              () => undefined
            );
          throw error;
        }
        try {
          await updateInjectedInvocationEvidence(invocation.id, {
            final: {
              status: "approved",
              method: "signAndSubmitTransaction",
              hash: result.hash
            }
          });
        } catch (cause) {
          throw new InferAdapterError(
            InferErrorCode.RequestOutcomeUnknown,
            "Native submission returned a hash but local evidence could not be saved",
            { cause, hash: result.hash }
          );
        }
        return result;
      }
      const session = await readValidatedExternalSession(callOptions);
      if (session) {
        const scopeFailure = (() => {
          try {
            this.assertSubmissionScope(
              wire,
              session.address,
              session.chainId,
              session.network
            );
            return undefined;
          } catch (cause) {
            return cause;
          }
        })();
        // Scope errors are fenced after the awaited invocation hook, before dispatch.
        const options = scopeFailure
          ? {
              ...callOptions,
              onInvocationPrepared: async (
                invocation: Readonly<RecoverableInvocation>
              ) => {
                await callOptions.onInvocationPrepared?.(invocation);
                throw scopeFailure;
              }
            }
          : callOptions;
        return session.transport === "mobile-relay"
          ? signAndSubmitViaMobileRelay(
              wire as unknown as CedraSignAndSubmitTransactionInput,
              session,
              options
            )
          : tryLocalBridgeSignAndSubmit(
              wire as unknown as CedraSignAndSubmitTransactionInput,
              session,
              options
            );
      }
      throw new InferAdapterError(
        InferErrorCode.Unsupported,
        "Infer wallet submission is unavailable"
      );
    } catch (error) {
      remapSignAndSubmitError(error);
    }
  }

  private assertSubmissionScope(
    wire: CanonicalTransactionInput,
    address: string,
    chainId: number,
    network: string
  ): void {
    if (wire.sender !== undefined && wire.sender !== canonicalAddress(address))
      throw new InferAdapterError(
        InferErrorCode.Unauthorized,
        "Requested sender differs from the approved account"
      );
    if (wire.chainId !== undefined && wire.chainId !== chainId)
      throw new InferAdapterError(
        InferErrorCode.InvalidNetwork,
        "Requested chain differs from the approved chain"
      );
    if (
      this.options.networkOverride !== undefined &&
      this.options.networkOverride !== network
    )
      throw new InferAdapterError(
        InferErrorCode.InvalidNetwork,
        "Approved wallet network differs from networkOverride"
      );
    if (
      wire.options.expireTimestamp !== undefined &&
      BigInt(wire.options.expireTimestamp) <=
        BigInt(Math.floor(Date.now() / 1000))
    )
      throw new InferAdapterError(
        InferErrorCode.InvalidParams,
        "Approved transaction expiry has elapsed"
      );
  }

  async signAndSubmitBCSTransaction(
    transaction: AnyRawTransaction | InferTransactionPayload,
    options?: unknown
  ): Promise<CedraSignAndSubmitTransactionOutput> {
    return this.signAndSubmitTransaction(transaction, options);
  }

  async subscribe(): Promise<void> {
    const provider = this.refreshProvider();

    if (provider?.onAccountChange) {
      await provider.onAccountChange((account) => {
        this.injectedScopeRevision++;
        this.accountInfo = normalizeProviderAccount(account);
        this.emit("accountChange", this.accountInfo);
      });
    }

    if (provider?.onNetworkChange) {
      await provider.onNetworkChange((network) => {
        this.injectedScopeRevision++;
        this.networkInfo = normalizeNetwork(network);
        this.emit("networkChange", this.networkInfo);
      });
    }
  }
}
