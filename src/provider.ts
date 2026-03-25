import { DEFAULT_DETECT_ALIASES } from "./constants";
import type { NovaProvider, NovaWalletOptions, NovaWindow } from "./types";

export function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function isBrandedNovaProvider(provider: NovaProvider | undefined): provider is NovaProvider {
  return !!provider && provider.isNovaWallet === true;
}

export function detectProvider(options: NovaWalletOptions = {}): NovaProvider | undefined {
  if (!isBrowser()) return undefined;

  const win = window as NovaWindow;
  if (win.inferenco) return win.inferenco;
  if (win.nova) return win.nova;

  const detectAliases = options.detectAliases ?? DEFAULT_DETECT_ALIASES;
  if (!detectAliases) return undefined;

  if (isBrandedNovaProvider(win.cedra)) return win.cedra;
  if (isBrandedNovaProvider(win.aptos)) return win.aptos;

  return undefined;
}
