export enum NovaErrorCode {
  UserRejected = "USER_REJECTED",
  Unauthorized = "UNAUTHORIZED",
  Unsupported = "UNSUPPORTED",
  NotInstalled = "NOT_INSTALLED",
  ConnectionTimeout = "CONNECTION_TIMEOUT",
  InvalidParams = "INVALID_PARAMS",
  InvalidNetwork = "INVALID_NETWORK",
  InternalError = "INTERNAL_ERROR"
}

export class NovaAdapterError extends Error {
  constructor(
    public readonly code: NovaErrorCode,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "NovaAdapterError";
  }
}

function extractStatus(error: unknown): string | number | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("status" in error) return (error as { status?: string | number }).status;
  if ("code" in error) return (error as { code?: string | number }).code;
  return undefined;
}

export function remapNovaError(error: unknown): never {
  if (error instanceof NovaAdapterError) {
    throw error;
  }

  const status = extractStatus(error);
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown Nova wallet error";

  if (status === "Rejected" || status === 401 || /reject/i.test(message)) {
    throw new NovaAdapterError(NovaErrorCode.UserRejected, message, error);
  }
  if (status === "Unsupported" || status === 4200 || /unsupported/i.test(message)) {
    throw new NovaAdapterError(NovaErrorCode.Unsupported, message, error);
  }
  if (status === "InvalidParams" || status === 400 || /invalid/i.test(message)) {
    throw new NovaAdapterError(NovaErrorCode.InvalidParams, message, error);
  }
  if (status === "Timeout" || /timed out waiting for nova desk/i.test(message)) {
    throw new NovaAdapterError(NovaErrorCode.ConnectionTimeout, message, error);
  }
  if (/not installed|no provider|missing provider/i.test(message)) {
    throw new NovaAdapterError(NovaErrorCode.NotInstalled, message, error);
  }

  throw new NovaAdapterError(NovaErrorCode.InternalError, message, error);
}
