import { UserResponseStatus } from "@cedra-labs/wallet-standard";
import { InferClient } from "./InferClient";
import { normalizeNetwork, normalizeProviderAccount } from "./conversion";
import { canonicalAddress, type IntegrationScope } from "./integrationContract";
import { InferAdapterError, InferErrorCode } from "./errors";
import { hasNonDispatchEvidence } from "./nonDispatchEvidence";
import { bindNativeProvider } from "./provider";
import type { InferProvider } from "./types";
import type {
  InferRecoveredOutcomesFeature,
  InferTransactionSubmissionFeature
} from "./aip62";

export type InferNativeRecoveryFeatures = Readonly<{
  canSubmit(): boolean;
  dispose(): void;
}> & InferTransactionSubmissionFeature & {
  "inferenco:recoveredOutcomes": Pick<
    InferRecoveredOutcomesFeature["inferenco:recoveredOutcomes"],
    "version" | "list" | "listInvocations" | "read" |
    "acknowledge" | "reconcileInvocation" | "subscribe"
  >;
};

type NativeMethod = (...args: unknown[]) => unknown;
type MethodFeature = { version?: unknown; [key: string]: unknown };

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Wrap the selected registered native wallet. The caller supplies its live
 * selection fence; the wrapper never discovers an ambient or external provider.
 */
export function createInferNativeRecoveryFeatures(
  selectedWallet: unknown,
  options: Readonly<{ isCurrent(): boolean }>
): InferNativeRecoveryFeatures | null {
  if (!record(selectedWallet) || !record(selectedWallet.features) ||
      selectedWallet.integrationContractVersion !== 1 ||
      !record(selectedWallet.capabilities) ||
      selectedWallet.capabilities.durableInvocationLookup !== true ||
      typeof selectedWallet.readInvocation !== "function" ||
      typeof selectedWallet.acknowledgeInvocation !== "function" ||
      !options || typeof options.isCurrent !== "function" ||
      typeof window === "undefined") return null;

  const features = selectedWallet.features;
  const account = features["cedra:account"] as MethodFeature | undefined;
  const network = features["cedra:network"] as MethodFeature | undefined;
  const accountEvents = features["cedra:onAccountChange"] as MethodFeature | undefined;
  const networkEvents = features["cedra:onNetworkChange"] as MethodFeature | undefined;
  if (account?.version !== "1.0.0" || typeof account.account !== "function" ||
      network?.version !== "1.0.0" || typeof network.network !== "function" ||
      accountEvents?.version !== "1.0.0" ||
      typeof accountEvents.onAccountChange !== "function" ||
      networkEvents?.version !== "1.0.0" ||
      typeof networkEvents.onNetworkChange !== "function") return null;

  const origin = window.location.origin;
  const capabilities = selectedWallet.capabilities;
  const rawSubmit = selectedWallet.signAndSubmitTransaction;
  const rawRead = selectedWallet.readInvocation as NativeMethod;
  const rawAck = selectedWallet.acknowledgeInvocation as NativeMethod;
  const accountMethod = account.account as NativeMethod;
  const networkMethod = network.network as NativeMethod;
  const onAccount = accountEvents.onAccountChange as NativeMethod;
  const onNetwork = networkEvents.onNetworkChange as NativeMethod;
  let disposed = false;
  let generation = 0;
  const cleanup: Array<() => void> = [];

  const changed = () => { generation++; };
  const register = (feature: MethodFeature, method: NativeMethod) =>
    Promise.resolve().then(() => method.call(feature, changed)).then(off => {
      if (typeof off === "function") {
        if (disposed) off();
        else cleanup.push(off as () => void);
      }
    });
  const ready = Promise.all([
    register(accountEvents, onAccount),
    register(networkEvents, onNetwork)
  ]);
  // Each operation handles installation failure. Creating a wrapper without
  // using it must not produce an unhandled promise rejection.
  void ready.catch(() => undefined);

  const assertCurrent = () => {
    if (disposed || !options.isCurrent() || window.location.origin !== origin ||
        selectedWallet.integrationContractVersion !== 1 ||
        selectedWallet.capabilities !== capabilities ||
        capabilities.durableInvocationLookup !== true ||
        selectedWallet.readInvocation !== rawRead ||
        selectedWallet.acknowledgeInvocation !== rawAck ||
        selectedWallet.signAndSubmitTransaction !== rawSubmit ||
        selectedWallet.features !== features ||
        features["cedra:account"] !== account ||
        features["cedra:network"] !== network ||
        features["cedra:onAccountChange"] !== accountEvents ||
        features["cedra:onNetworkChange"] !== networkEvents ||
        account.version !== "1.0.0" || network.version !== "1.0.0" ||
        accountEvents.version !== "1.0.0" || networkEvents.version !== "1.0.0" ||
        account.account !== accountMethod || network.network !== networkMethod ||
        accountEvents.onAccountChange !== onAccount ||
        networkEvents.onNetworkChange !== onNetwork)
      throw new InferAdapterError(
        InferErrorCode.Unauthorized, "native-wallet-context-changed"
      );
  };
  const assertGeneration = (revision: number) => {
    assertCurrent();
    if (revision !== generation)
      throw new InferAdapterError(
        InferErrorCode.Unauthorized, "native-wallet-generation-changed"
      );
  };
  const call = async (
    method: NativeMethod, args: unknown[], receiver: object
  ): Promise<unknown> => {
    assertCurrent();
    const revision = generation;
    await ready;
    assertGeneration(revision);
    const output = await method.apply(receiver, args);
    assertGeneration(revision);
    return output;
  };

  const provider: InferProvider = {
    integrationContractVersion: 1,
    get capabilities() { return capabilities; },
    account: () => call(accountMethod, [], account) as
      ReturnType<NonNullable<InferProvider["account"]>>,
    network: () => call(networkMethod, [], network) as
      ReturnType<NonNullable<InferProvider["network"]>>,
    readInvocation: (...args) => call(rawRead, args, selectedWallet),
    acknowledgeInvocation: (...args) => call(rawAck, args, selectedWallet),
    signAndSubmitTransaction: (...args) => {
      assertCurrent();
      if (capabilities.durableInvocationSubmission !== true ||
          capabilities.transactionRestrictions !== true ||
          typeof rawSubmit !== "function")
        throw new InferAdapterError(
          InferErrorCode.Unsupported, "native-durable-submission-unavailable"
        );
      return call(rawSubmit as NativeMethod, args, selectedWallet) as
        ReturnType<NonNullable<InferProvider["signAndSubmitTransaction"]>>;
    }
  };
  const unwrap = (value: unknown) =>
    record(value) && value.status === "Approved" ? value.args : value;
  const assertScope = async (scope: IntegrationScope): Promise<void> => {
    assertCurrent();
    const revision = generation;
    const liveAccount = normalizeProviderAccount(
      unwrap(await provider.account!()) as Parameters<typeof normalizeProviderAccount>[0]
    );
    assertGeneration(revision);
    const liveNetwork = normalizeNetwork(
      unwrap(await provider.network!()) as Parameters<typeof normalizeNetwork>[0]
    );
    assertGeneration(revision);
    if (scope.origin !== origin ||
        scope.accountAddress !== canonicalAddress(liveAccount.address.toString()) ||
        scope.network !== liveNetwork.name || scope.chainId !== liveNetwork.chainId)
      throw new InferAdapterError(
        InferErrorCode.Unauthorized, "native-wallet-scope-mismatch"
      );
  };
  const client = new InferClient(bindNativeProvider({}, {
    provider, identity: selectedWallet, assertCurrent, assertScope,
    capture: () => {
      const revision = generation;
      return () => assertGeneration(revision);
    }
  }));
  const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertCurrent();
    const revision = generation;
    await ready;
    assertGeneration(revision);
    const result = await operation();
    assertGeneration(revision);
    return result;
  };
  const recovery = Object.freeze({
    version: "1.0.0" as const,
    list: () => guarded(() => client.listRecoverableRequests()),
    listInvocations: () => guarded(() => client.listRecoverableInvocations()),
    read: (id: string) => guarded(() => client.readRecoverableRequest(id)),
    acknowledge: (id: string) => guarded(() => client.acknowledgeRecoverableRequest(id)),
    reconcileInvocation: (id: string) =>
      guarded(() => client.reconcileRecoverableInvocation(id)),
    subscribe: (callback: Parameters<InferClient["subscribeRecoveredOutcomes"]>[0]) =>
      client.subscribeRecoveredOutcomes(async outcome => {
        const revision = generation;
        await assertScope({
          origin: outcome.origin, accountAddress: canonicalAddress(outcome.address),
          network: outcome.network, chainId: outcome.chainId
        });
        assertGeneration(revision);
        await callback(outcome);
      })
  });
  const canSubmit = (): boolean => {
    try {
      assertCurrent();
      return capabilities.durableInvocationSubmission === true &&
        capabilities.transactionRestrictions === true &&
        typeof rawSubmit === "function";
    } catch { return false; }
  };
  return Object.freeze({
    canSubmit,
    dispose: () => {
      disposed = true;
      generation++;
      for (const off of cleanup.splice(0)) {
        try { off(); } catch { /* Advisory listener cleanup cannot retain the client. */ }
      }
      client.dispose();
    },
    "inferenco:recoveredOutcomes": recovery,
    "inferenco:transactionSubmission": Object.freeze({
      version: "1.0.0" as const,
      contractVersion: 1 as const,
      isNotInvoked: hasNonDispatchEvidence,
      signAndSubmitTransaction: async (input, callOptions) => {
        assertCurrent();
        if (!canSubmit())
          throw new InferAdapterError(
            InferErrorCode.Unsupported, "native-durable-submission-unavailable"
          );
        try {
          return {
            status: UserResponseStatus.APPROVED,
            args: await client.signAndSubmitTransactionWithRestrictions(input, callOptions)
          };
        } catch (error) {
          if (error instanceof InferAdapterError &&
              error.code === InferErrorCode.UserRejected)
            return { status: UserResponseStatus.REJECTED };
          throw error;
        }
      }
    } satisfies InferTransactionSubmissionFeature["inferenco:transactionSubmission"])
  });
}
