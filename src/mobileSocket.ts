import type { NovaWalletOptions } from "./types";
import {
  DEFAULT_MOBILE_SOCKET_TIMEOUT_MS
} from "./constants";

interface RelayEvent {
  type: string;
  id: string;
  status: string;
  timestamp: string;
  requestId?: string;
  sessionId?: string;
}

interface RelaySocketOptions {
  websocketUrl: string;
  role: "dapp" | "wallet";
  token: string;
  target: {
    kind: "pairing" | "session";
    id: string;
  };
  options?: NovaWalletOptions;
  onEvent?: (event: RelayEvent) => void;
}

export interface RelaySocketHandle {
  close(): void;
}

export function watchRelaySocket({
  websocketUrl,
  role,
  token,
  target,
  options,
  onEvent
}: RelaySocketOptions): RelaySocketHandle {
  if (typeof WebSocket === "undefined") {
    return { close() {} };
  }

  const socket = new WebSocket(websocketUrl);
  const timeoutMs = options?.mobileSocketTimeoutMs ?? DEFAULT_MOBILE_SOCKET_TIMEOUT_MS;
  const timeoutId = window.setTimeout(() => {
    if (socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }, timeoutMs);

  socket.addEventListener("open", () => {
    window.clearTimeout(timeoutId);
    socket.send(
      JSON.stringify({
        type: "hello",
        role,
        token,
        target
      })
    );
  });

  socket.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(String(event.data)) as RelayEvent;
      onEvent?.(payload);
    } catch {
      // Ignore malformed relay frames.
    }
  });

  return {
    close() {
      window.clearTimeout(timeoutId);
      socket.close();
    }
  };
}
