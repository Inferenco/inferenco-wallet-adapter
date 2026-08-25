import { DEFAULT_DETECT_ALIASES } from "./constants";
import type { InferProvider, InferWalletOptions, InferWindow } from "./types";

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
