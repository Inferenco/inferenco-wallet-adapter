import { InferErrorCode, InferRequestError } from "./errors";
import type { RecoverableInvocation } from "./recovery";
// This factory is internal, absent from package exports. Public error fields are advisory.
const proofs = new WeakMap<
  object,
  { invocationId: string; requestCommitment: string }
>();
export function notInvokedError(
  message: string,
  invocation: Pick<RecoverableInvocation, "invocationId" | "requestCommitment">,
  cause?: unknown
): InferRequestError {
  const error = new InferRequestError(
    InferErrorCode.RequestNotInvoked,
    message,
    invocation.invocationId,
    null,
    cause
  );
  if (invocation.requestCommitment)
    proofs.set(error, {
      invocationId: invocation.invocationId,
      requestCommitment: invocation.requestCommitment
    });
  return error;
}
export function hasNonDispatchEvidence(
  error: unknown,
  invocation: Pick<RecoverableInvocation, "invocationId" | "requestCommitment">
): boolean {
  if (!error || typeof error !== "object" || !invocation.requestCommitment)
    return false;
  const proof = proofs.get(error);
  return (
    proof?.invocationId === invocation.invocationId &&
    proof.requestCommitment === invocation.requestCommitment
  );
}
