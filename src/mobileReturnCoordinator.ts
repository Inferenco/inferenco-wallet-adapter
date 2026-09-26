import { readPendingMobilePairing, readExternalSession } from "./bridge";
import { readPendingMobileRelayRequests } from "./mobileRequests";

const CHANNEL = "inferenco:infer-mobile-return-owner";
const OWNED_PAIRING_KEY = "inferenco:infer-owned-pairing";
const TAB_INSTANCE_ID = globalThis.crypto.randomUUID();

type OwnerMessage =
  | { type: "probe"; requestId: string; nonce: string; tabInstanceId: string }
  | { type: "owner"; requestId: string; nonce: string; tabInstanceId: string };

export function rememberOwnedMobilePairing(pairingId: string): void {
  try {
    window.sessionStorage.setItem(OWNED_PAIRING_KEY, pairingId);
  } catch {
    // Pairing recovery uses localStorage and authenticated relay reads; the
    // callback-tab ownership hint is optional.
  }
}

function ownsInThisTab(requestId: string): boolean {
  const pairing = readPendingMobilePairing();
  const session = readExternalSession();
  if (window.sessionStorage.getItem(OWNED_PAIRING_KEY) === requestId &&
      (pairing?.pairingId === requestId || session?.transport === "mobile-relay")) return true;
  return !!session && session.transport === "mobile-relay" &&
    readPendingMobileRelayRequests(session).some((request) => request.requestId === requestId);
}

/** Each tab answers only for request IDs retained in its own sessionStorage.
 * Messages contain IDs and random probes only, never relay credentials. */
export function installMobileReturnOwnerResponder(): () => void {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch {
    return () => undefined;
  }
  const handle = (event: MessageEvent<OwnerMessage>) => {
    const payload = event.data;
    if (!payload || payload.type !== "probe" ||
        typeof payload.requestId !== "string" ||
        typeof payload.nonce !== "string" ||
        typeof payload.tabInstanceId !== "string" ||
        payload.tabInstanceId === TAB_INSTANCE_ID) return;
    try {
      if (ownsInThisTab(payload.requestId)) {
        channel.postMessage({
          type: "owner", requestId: payload.requestId, nonce: payload.nonce,
          tabInstanceId: TAB_INSTANCE_ID
        } satisfies OwnerMessage);
      }
    } catch {
      // A storage failure cannot transfer ownership to another tab.
    }
  };
  channel.addEventListener("message", handle);
  return () => {
    channel.removeEventListener("message", handle);
    channel.close();
  };
}

export async function hasLiveOriginalMobileTab(
  requestId: string,
  waitMs = 1200
): Promise<boolean> {
  if (typeof BroadcastChannel === "undefined") return false;
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch {
    return false;
  }
  const nonce = globalThis.crypto.randomUUID();
  return new Promise((resolve) => {
    let finished = false;
    const finish = (owned: boolean) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      channel.removeEventListener("message", handle);
      channel.close();
      resolve(owned);
    };
    const handle = (event: MessageEvent<OwnerMessage>) => {
      const payload = event.data;
      if (payload?.type === "owner" &&
          payload.requestId === requestId && payload.nonce === nonce &&
          payload.tabInstanceId !== TAB_INSTANCE_ID) {
        finish(true);
      }
    };
    const timer = window.setTimeout(() => finish(false), waitMs);
    channel.addEventListener("message", handle);
    channel.postMessage({
      type: "probe", requestId, nonce, tabInstanceId: TAB_INSTANCE_ID
    } satisfies OwnerMessage);
  });
}
