import EventEmitter from "eventemitter3";
import type {
  AnyRawTransaction,
  Network,
} from "@cedra-labs/ts-sdk";
import type {
  AccountInfo,
  CedraSignAndSubmitTransactionInput,
  CedraSignAndSubmitTransactionOutput,
  CedraSignMessageInput,
  CedraSignMessageOutput,
  CedraSignTransactionInputV1_1,
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
  deserializeSignTransactionResult,
  normalizeNetwork,
  normalizeProviderAccount,
  normalizeSignMessageOutput,
  normalizeSignTransactionResult
} from "./conversion";
import { DEFAULT_SESSION_LIVENESS_INTERVAL_MS, INFER_SESSION_CLEARED_MESSAGE_TYPE } from "./constants";
import { RECOVERY_CHANNEL, pruneDurableEvidence } from "./durableRecovery";
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
  resumeMobileRelaySessionFromCallback,
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
  readRecoverableRequest
} from "./recovery";
import type {
  ArchivedRecoverableRequest,
  RecoveredRequestOutcome,
  RecoverableRequest,
  RecoverableInvocation
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
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(toJsonCompatibleValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        toJsonCompatibleValue(item)
      ])
    );
  }
  return value;
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
  transaction: AnyRawTransaction | InferTransactionPayload | CedraSignTransactionInputV1_1,
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
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
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
    this.recoveryChannel?.removeEventListener("message", this.recoveryWake);
    this.recoveryChannel?.close();
    this.recoveryChannel = null;
    this.disconnectChannel?.removeEventListener("message", this.onPeerDisconnect);
    this.disconnectChannel?.close();
    this.disconnectChannel = null;
    this.recoveredSubscribers.clear();
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

  async connect(): Promise<{ account: AccountInfo; network: NetworkInfo | null }> {
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

      const resumedMobileSession = await resumeMobileRelaySessionFromCallback(this.options);
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
          options: this.options,
        });
        if (preauth) {
          const session = await pollPreauthUntilResolved(
            preauth.requestId,
            this.options,
          );
          if (session) {
            return this.connectResultFromExternalSession(session);
          }
          throw new InferAdapterError(
            InferErrorCode.ConnectionTimeout,
            "Timed out waiting for Infer Desk to approve the pre-auth connect request.",
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
        const account = normalizeProviderAccount(unwrap(await provider.account()));
        this.accountInfo = account;
        return account;
      }

      const externalSession = await readValidatedExternalSession(this.options);
      if (externalSession) {
        const account = sessionToAccountInfo(externalSession);
        this.accountInfo = account;
        return account;
      }

      throw new InferAdapterError(InferErrorCode.NotInstalled, "Infer provider account() unavailable");
    } catch (error) {
      remapInferError(error);
    }
  }

  async disconnect(): Promise<void> {
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

      throw new InferAdapterError(InferErrorCode.NotInstalled, "Infer provider network() unavailable");
    } catch (error) {
      remapInferError(error);
    }
  }

  async signMessage(input: CedraSignMessageInput): Promise<CedraSignMessageOutput> {
    try {
      const provider = this.refreshProvider();
      if (provider?.signMessage) {
        const result = unwrap(await provider.signMessage(input)) as CedraSignMessageOutput | InferSignMessageResponse;
        return normalizeSignMessageOutput(result);
      }

      const externalSession = await readValidatedExternalSession(this.options);
      if (externalSession) {
        return externalSession.transport === "mobile-relay"
          ? signMessageViaMobileRelay(input, externalSession, this.options)
          : tryLocalBridgeSignMessage(input, externalSession, this.options);
      }

      throw new InferAdapterError(InferErrorCode.Unsupported, "Infer provider signMessage() unavailable");
    } catch (error) {
      remapInferError(error);
    }
  }

  async signMessageAndVerify(input: CedraSignMessageInput): Promise<boolean> {
    const account = await this.getAccount();
    const output = await this.signMessage(input);
    const publicKey = account.publicKey as unknown as {
      verifySignature?: (args: { message: Uint8Array; signature: unknown }) => boolean;
      verifySignatureAsync?: (args: { message: Uint8Array; signature: unknown }) => Promise<boolean>;
    };
    const message = new TextEncoder().encode(output.fullMessage || createFullMessage(input, account.address.toString()));

    if (publicKey.verifySignature) {
      return publicKey.verifySignature({ message, signature: output.signature });
    }

    if (publicKey.verifySignatureAsync) {
      return publicKey.verifySignatureAsync({ message, signature: output.signature });
    }

    return false;
  }

  async signTransaction(
    transaction: AnyRawTransaction | InferTransactionPayload | CedraSignTransactionInputV1_1,
    options?: unknown
  ): Promise<InferSignTransactionResult> {
    try {
      const provider = this.refreshProvider();
      if (provider?.signTransaction) {
        const rawInput = isSdkRawTransaction(transaction)
          ? normalizeSdkRawTransactionInput(transaction, options)
          : undefined;
        const response = await provider.signTransaction(rawInput ?? transaction, options);
        let result: unknown = response;
        if (rawInput || (response && typeof response === "object" && "status" in response)) {
          const record = snapshotProviderRecord(response, "Unreadable signing response");
          if (!record) throw new InferAdapterError(InferErrorCode.InternalError, "Malformed signing response");
          if (Object.prototype.hasOwnProperty.call(record, "status")) {
            if (record.status === "Rejected" && hasExactKeys(record, ["status"])) {
              throw new InferAdapterError(InferErrorCode.UserRejected, "User rejected the transaction request");
            }
            if (record.status !== "Approved" || !hasExactKeys(record, ["status", "args"])) {
              throw new InferAdapterError(InferErrorCode.InternalError, "Ambiguous signing response");
            }
            result = record.args;
          } else {
            result = unwrap(record);
          }
        } else {
          result = unwrap(response);
        }
        return rawInput
          ? deserializeSignTransactionResult(result, rawInput.rawTransactionBcsHex)
          : normalizeSignTransactionResult(result);
      }

      const externalSession = await readValidatedExternalSession(this.options);
      if (externalSession) {
        const externalInput = toExternalSignTransactionInput(transaction, options);
        const result = await (externalSession.transport === "mobile-relay"
          ? signTransactionViaMobileRelay(externalInput, externalSession, this.options)
          : tryLocalBridgeSignTransaction(externalInput, externalSession, this.options));
        if ("rawTransactionBcsHex" in externalInput) {
          return deserializeSignTransactionResult(result, externalInput.rawTransactionBcsHex);
        }
        return result;
      }

      throw new InferAdapterError(InferErrorCode.Unsupported, "Infer provider signTransaction() unavailable");
    } catch (error) {
      remapSignAndSubmitError(error);
    }
  }

  async signAndSubmitTransaction(
    transaction: AnyRawTransaction | InferTransactionPayload | CedraSignAndSubmitTransactionInput,
    options?: unknown
  ): Promise<CedraSignAndSubmitTransactionOutput> {
    try {
      const provider = this.refreshProvider();
      if (provider?.signAndSubmitTransaction) {
        let providerResult: unknown;
        try {
          providerResult = await provider.signAndSubmitTransaction(
            transaction as AnyRawTransaction | InferTransactionPayload,
            options
          );
        } catch (error) {
          throw new InferAdapterError(
            InferErrorCode.InternalError,
            "Infer provider signAndSubmitTransaction() failed",
            error
          );
        }
        return normalizeSignAndSubmitProviderResult(providerResult);
      }

      const externalSession = await readValidatedExternalSession(this.options);
      if (externalSession) {
        return externalSession.transport === "mobile-relay"
          ? signAndSubmitViaMobileRelay(
              transaction as CedraSignAndSubmitTransactionInput,
              externalSession,
              this.options
            )
          : tryLocalBridgeSignAndSubmit(
              transaction as CedraSignAndSubmitTransactionInput,
              externalSession,
              this.options
            );
      }

      throw new InferAdapterError(
        InferErrorCode.Unsupported,
        "Infer provider signAndSubmitTransaction() unavailable"
      );
    } catch (error) {
      remapSignAndSubmitError(error);
    }
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
        this.accountInfo = normalizeProviderAccount(account);
        this.emit("accountChange", this.accountInfo);
      });
    }

    if (provider?.onNetworkChange) {
      await provider.onNetworkChange((network) => {
        this.networkInfo = normalizeNetwork(network);
        this.emit("networkChange", this.networkInfo);
      });
    }
  }
}
