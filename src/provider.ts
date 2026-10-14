import { DEFAULT_DETECT_ALIASES } from "./constants";
import type { InferProvider, InferWalletOptions, InferWindow } from "./types";
import type { IntegrationScope } from "./integrationContract";

/** Internal binding: a selected native wallet never enters ambient discovery. */
export interface NativeProviderBinding {
  provider: InferProvider;
  identity: object;
  assertCurrent(): void;
  capture(): () => void;
  assertScope(scope: IntegrationScope): Promise<void>;
}
const nativeBindings = new WeakMap<InferWalletOptions, NativeProviderBinding>();
const nativeIds = new WeakMap<object, number>();
let nextNativeId = 0;
export function bindNativeProvider(options: InferWalletOptions, binding: NativeProviderBinding): InferWalletOptions {
  const bound = { ...options };
  nativeBindings.set(bound, binding);
  return bound;
}
export function inheritNativeProvider(from: InferWalletOptions, to: InferWalletOptions): InferWalletOptions {
  const binding = nativeBindings.get(from);
  if (binding) nativeBindings.set(to, binding);
  return to;
}
export function nativeProviderBinding(options: InferWalletOptions): NativeProviderBinding | undefined {
  return nativeBindings.get(options);
}
export function nativeRecoveryKey(options: InferWalletOptions): string {
  const binding = nativeBindings.get(options);
  if (!binding) return 'ambient';
  let id = nativeIds.get(binding.identity);
  if (!id) { id = ++nextNativeId; nativeIds.set(binding.identity, id); }
  return 'selected:' + id;
}

export function isBrowser(): boolean {
  return typeof window !== "undefined";
}

/**
 * Recognise a provider as Infer-branded by either the canonical
 * `isInferWallet === true` flag or the legacy `isNovaWallet === true`
 * flag. Older Infer Desk / Nova Wallet builds (pre-0.6.0 desktop,
 * pre-rebrand mobile) only set the legacy `isNovaWallet` flag, so we
 * accept it during the transition window. The `isNovaWallet` check is
 * slated for removal in 0.4.0 once every wallet version in the wild
 * sets the new flag.
 */
function isBrandedInferProvider(provider: InferProvider | undefined): provider is InferProvider {
  return !!provider && (provider.isInferWallet === true || (provider as { isNovaWallet?: unknown }).isNovaWallet === true);
}

export function detectProvider(options: InferWalletOptions = {}): InferProvider | undefined {
  const native = nativeBindings.get(options);
  if (native) { native.assertCurrent(); return native.provider; }
  if (!isBrowser()) return undefined;

  const win = window as InferWindow;
  // Detection priority:
  //   1. window.inferenco  — primary namespace (unchanged)
  //   2. window.infer      — new rebrand namespace
  //   3. window.nova       — legacy alias (kept during transition; remove in 0.4.0)
  //   4. window.cedra/aptos if isBrandedInferProvider()
  if (win.inferenco) return win.inferenco;
  if ((win as unknown as { infer?: InferProvider }).infer) {
    return (win as unknown as { infer?: InferProvider }).infer;
  }
  if (win.nova) return win.nova;

  const detectAliases = options.detectAliases ?? DEFAULT_DETECT_ALIASES;
  if (!detectAliases) return undefined;

  if (isBrandedInferProvider(win.cedra)) return win.cedra;
  if (isBrandedInferProvider(win.aptos)) return win.aptos;

  return undefined;
}
