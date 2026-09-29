export enum InferErrorCode {
  UserRejected = "USER_REJECTED",
  Unauthorized = "UNAUTHORIZED",
  Unsupported = "UNSUPPORTED",
  NotInstalled = "NOT_INSTALLED",
  ConnectionTimeout = "CONNECTION_TIMEOUT",
  InvalidParams = "INVALID_PARAMS",
  RequestNotInvoked = "REQUEST_NOT_INVOKED",
  RequestOutcomeUnknown = "REQUEST_OUTCOME_UNKNOWN",
  ConnectionUnavailable = "CONNECTION_UNAVAILABLE",
  InvalidNetwork = "INVALID_NETWORK",
  InternalError = "INTERNAL_ERROR",
  /**
   * NEW in 0.2.0-rc.18 (P-04 HTTPS connect reload):
   * the preauth-connect fetch threw `TypeError`, indicating the
   * browser blocked the cross-origin request to the local wallet
   * bridge. The most common cause is Chrome ≥142's Local Network
   * Access (LNA) enforcement, which blocks public HTTPS origins
   * from reaching loopback/private addresses without explicit
   * user permission.
   *
   * DApps SHOULD match on this error code and surface an
   * actionable message such as:
   *   "Your browser blocked access to the local wallet bridge —
   *    allow local network access for this site."
   *
   * Older Chrome (<142) and other browsers fall through to
   * `startPreauthConnect`'s generic error path.
   */
  BridgePrivateNetworkBlocked = "BRIDGE_PRIVATE_NETWORK_BLOCKED"
}

export class InferAdapterError extends Error {
  constructor(
    public readonly code: InferErrorCode,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "InferAdapterError";
  }
}

/** Exact invocation evidence for an ambiguous or definitely unissued wallet request. */
export class InferRequestError extends InferAdapterError {
  readonly dispatch: "not-invoked" | "unknown";
  readonly status?: number;

  constructor(
    code: InferErrorCode,
    message: string,
    public readonly invocationId: string | null,
    public readonly requestId: string | null,
    cause?: unknown
  ) {
    super(code, message, cause);
    this.name = "InferRequestError";
    this.dispatch = code === InferErrorCode.RequestNotInvoked ? "not-invoked" : "unknown";
    if (cause && typeof cause === "object" && "status" in cause &&
        typeof cause.status === "number") this.status = cause.status;
  }
}

export function unresolvedRequestError(
  message: string,
  invocationId: string,
  requestId: string | null,
  cause: unknown
): InferRequestError {
  // Once dispatch or delivery may have occurred, a nested transport error
  // cannot prove a clean wallet rejection or a safe-to-retry failure.
  return new InferRequestError(InferErrorCode.RequestOutcomeUnknown,
    message, invocationId, requestId, cause);
}

function extractStatus(error: unknown): string | number | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("status" in error) return (error as { status?: string | number }).status;
  if ("code" in error) return (error as { code?: string | number }).code;
  return undefined;
}

export function isValidTransactionHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "Unknown Infer wallet error";
}

export function remapInferError(error: unknown): never {
  if (error instanceof InferAdapterError) {
    throw error;
  }

  const status = extractStatus(error);
  const message = errorMessage(error);

  if (status === "Rejected" || status === 401 || /reject/i.test(message)) {
    throw new InferAdapterError(InferErrorCode.UserRejected, message, error);
  }
  if (status === "Unsupported" || status === 4200 || /unsupported/i.test(message)) {
    throw new InferAdapterError(InferErrorCode.Unsupported, message, error);
  }
  if (status === "InvalidParams" || status === 400 || /invalid/i.test(message)) {
    throw new InferAdapterError(InferErrorCode.InvalidParams, message, error);
  }
  if (status === "Timeout" || /timed out waiting for (?:nova|infer) desk/i.test(message)) {
    throw new InferAdapterError(InferErrorCode.ConnectionTimeout, message, error);
  }
  if (/not installed|no provider|missing provider/i.test(message)) {
    throw new InferAdapterError(InferErrorCode.NotInstalled, message, error);
  }

  throw new InferAdapterError(InferErrorCode.InternalError, message, error);
}

/**
 * Strict normalizer for sign-and-submit. Only adapter errors that have already
 * passed transport-specific validation retain their code. HTTP status codes,
 * provider-shaped thrown values, and human-readable text are never proof of a
 * user rejection.
 */
export function remapSignAndSubmitError(error: unknown): never {
  if (error instanceof InferAdapterError) {
    throw error;
  }

  throw new InferAdapterError(InferErrorCode.InternalError, errorMessage(error), error);
}

/**
 * Thrown by `tryResumeInferWalletConnection` when the dapp passes an
 * `expectedOrigin` option and the callback URL's `window.location.origin`
 * does not match. Indicates the deeplink flow was redirected to a
 * different origin than the dapp that initiated it — likely a phishing
 * attempt.
 */
export class CallbackOriginMismatch extends Error {
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super(
      `Callback origin mismatch: expected ${expected}, got ${actual}. ` +
        `Refusing to consume a session whose origin does not match the dapp's. ` +
        `This usually indicates a phishing attempt or a misconfigured deeplink.`
    );
    this.name = "CallbackOriginMismatch";
    this.expected = expected;
    this.actual = actual;
    Object.setPrototypeOf(this, CallbackOriginMismatch.prototype);
  }
}
