/**
 * Detects whether the current page is running inside Nova Desk's
 * embedded browser (native webview).
 *
 * When a dapp is loaded inside Nova Desk's WebKit2GTK webview, the
 * wallet injects a provider shim on `window.cedra`, `window.nova`,
 * and `window.aptos` (all the same object) stamped with
 * `isNovaDesk: true`. It also sets a `__novaDeskProviderInjected`
 * sentinel. Any of those signals is sufficient and reliable:
 * external browsers never set `isNovaDesk` on `window.cedra`, so
 * there is no false-positive risk.
 *
 * Use this helper to filter "Nova Connect" out of a dapp's
 * wallet-selector modal when you are using a different wallet
 * adapter (e.g. a third-party Cedra adapter that does not know
 * about Nova Desk).
 *
 * If you are using the Nova Connect adapter itself, you do not
 * need to call this directly: `registerNovaWallet()` already
 * consults the same signals and skips `registerWallet()`
 * automatically inside Nova Desk's WebView. The escape hatch is
 * `forceRegistration: true`.
 */
export function isHostedInNovaDesk(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as {
    cedra?: { isNovaDesk?: unknown };
    nova?: { isNovaDesk?: unknown };
    aptos?: { isNovaDesk?: unknown };
    __novaDeskProviderInjected?: unknown;
  };
  if (w.cedra?.isNovaDesk === true) return true;
  if (w.nova?.isNovaDesk === true) return true;
  if (w.aptos?.isNovaDesk === true) return true;
  if (w.__novaDeskProviderInjected === true) return true;
  return false;
}
