/**
 * Detects whether the current page is running inside Infer Desk's
 * embedded browser (native webview).
 *
 * When a dapp is loaded inside Infer Desk's WebKit2GTK webview, the
 * wallet injects a provider shim on `window.cedra`, `window.nova`,
 * and `window.aptos` (all the same object) stamped with
 * `isInferDesk: true`. It also sets a `__inferDeskProviderInjected`
 * sentinel. Any of those signals is sufficient and reliable:
 * external browsers never set `isInferDesk` on `window.cedra`, so
 * there is no false-positive risk.
 *
 * Legacy alias detection: older Infer Desk builds (and all wallets
 * branded as "Infer Desk" before the 0.6.0 rebrand) injected the
 * legacy flags `isNovaDesk: true` and `__novaDeskProviderInjected`,
 * so this helper also accepts those for back-compat. The legacy
 * aliases will be removed in 0.4.0.
 *
 * Use this helper to filter "Infer Connect" out of a dapp's
 * wallet-selector modal when you are using a different wallet
 * adapter (e.g. a third-party Cedra adapter that does not know
 * about Infer Desk).
 *
 * If you are using the Infer Connect adapter itself, you do not
 * need to call this directly: `registerInferWallet()` already
 * consults the same signals and skips `registerWallet()`
 * automatically inside Infer Desk's WebView. The escape hatch is
 * `forceRegistration: true`.
 */
export function isHostedInInferDesk(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as {
    cedra?: { isInferDesk?: unknown; isNovaDesk?: unknown };
    infer?: { isInferDesk?: unknown };
    nova?: { isInferDesk?: unknown; isNovaDesk?: unknown };
    aptos?: { isInferDesk?: unknown; isNovaDesk?: unknown };
    __inferDeskProviderInjected?: unknown;
    __novaDeskProviderInjected?: unknown;
  };
  if (w.cedra?.isInferDesk === true) return true;
  if (w.cedra?.isNovaDesk === true) return true; // legacy alias
  if (w.infer?.isInferDesk === true) return true;
  if (w.aptos?.isInferDesk === true) return true;
  if (w.aptos?.isNovaDesk === true) return true; // legacy alias
  if (w.nova?.isInferDesk === true) return true; // legacy desktop bridge
  if (w.nova?.isNovaDesk === true) return true; // legacy alias
  if (w.__inferDeskProviderInjected === true) return true;
  if (w.__novaDeskProviderInjected === true) return true; // legacy alias
  return false;
}
