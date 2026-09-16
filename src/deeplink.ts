import { DEFAULT_DEEPLINK_BASE_URL } from "./constants";
import type { InferWalletOptions } from "./types";

export function buildCallbackUrl(): string {
  if (typeof window === "undefined") return "";
  return window.location.href;
}

export function buildDeeplinkUrl(options: InferWalletOptions = {}, callbackUrl = buildCallbackUrl()): string {
  const base = options.deeplinkBaseUrl ?? DEFAULT_DEEPLINK_BASE_URL;
  return `${base}${encodeURIComponent(callbackUrl)}`;
}
