/**
 * Browser environment shims for running the adapter in vitest node mode.
 *
 * The adapter (`src/bridge.ts`, `src/NovaClient.ts`, etc.) gates on
 * `typeof window !== "undefined"` and reaches into window-scoped
 * globals: `window.localStorage`, `window.location`, `window.setTimeout`,
 * `window.dispatchEvent(new CustomEvent(...))`, `BroadcastChannel`,
 * `navigator.userAgent`, `matchMedia`. None of those exist in node.
 *
 * The shims below provide just enough surface for the adapter's connect /
 * sign / revoke paths to run unchanged. They are NOT mocks of the
 * adapter's behavior — they're shims of the browser environment so the
 * real adapter code runs as it does in a browser.
 *
 * Critically, `fetch` and `AbortController` are the *real* Node globals
 * (no polyfills, no wrappers, no signal-stripping). Real fetch, real
 * timeout enforcement, real wire format.
 */
import { EventEmitter } from "node:events";

class StorageShim {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  get length(): number {
    return this.store.size;
  }
}

class BroadcastChannelShim {
  private static registry = new Map<string, Set<BroadcastChannelShim>>();
  private emitter = new EventEmitter();
  constructor(public readonly name: string) {
    // Real browsers do not echo a BroadcastChannel message back to its
    // sender (the postMessage is delivered only to OTHER contexts in
    // the same origin). Match that here: a new instance for a name
    // disconnects and clears listeners on any earlier instance for the
    // same name, so stale listeners cannot fire and re-enter the
    // disconnect broadcast.
    const prior = BroadcastChannelShim.registry.get(name);
    if (prior) {
      for (const peer of prior) peer.close();
    }
    let set = BroadcastChannelShim.registry.get(name);
    if (!set) {
      set = new Set();
      BroadcastChannelShim.registry.set(name, set);
    }
    set.add(this);
  }
  postMessage(message: unknown): void {
    const peers = BroadcastChannelShim.registry.get(this.name);
    if (!peers) return;
    for (const peer of peers) {
      if (peer === this) continue;
      peer.emitter.emit("message", { data: message });
    }
  }
  addEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
    this.emitter.on("message", listener);
  }
  removeEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
    this.emitter.off("message", listener);
  }
  close(): void {
    BroadcastChannelShim.registry.get(this.name)?.delete(this);
    this.emitter.removeAllListeners();
  }
}

class CustomEventShim<T = unknown> {
  readonly type: string;
  readonly detail: T;
  constructor(type: string, init?: { detail?: T }) {
    this.type = type;
    this.detail = init?.detail as T;
  }
}

class WindowShim extends EventEmitter {
  readonly localStorage = new StorageShim();
  readonly sessionStorage = new StorageShim();
  readonly location: {
    pathname: string;
    origin: string;
    href: string;
    search: string;
    hash: string;
    host: string;
    hostname: string;
    port: string;
    protocol: string;
  } = {
    pathname: "/",
    origin: "http://dapp.example",
    href: "http://dapp.example/",
    search: "",
    hash: "",
    host: "dapp.example",
    hostname: "dapp.example",
    port: "",
    protocol: "http:"
  };
  readonly navigator = { userAgent: "node-test" } as Navigator;
  readonly opener: WindowShim | null = null;
  matchMedia(_query: string): MediaQueryList {
    return { matches: false, addEventListener: () => {}, removeEventListener: () => {} } as unknown as MediaQueryList;
  }
  setTimeout = setTimeout as unknown as Window["setTimeout"];
  clearTimeout = clearTimeout as unknown as Window["clearTimeout"];
  setInterval = setInterval as unknown as Window["setInterval"];
  clearInterval = clearInterval as unknown as Window["clearInterval"];
  history = { replaceState: () => {} } as unknown as History;
  close(): void {
    /* no-op in test */
  }
  // Bridge EventEmitter to the DOM EventTarget API the adapter uses
  // (`window.addEventListener("storage", ...)`, `addEventListener("message", ...)`).
  addEventListener(
    type: string,
    listener: (...args: unknown[]) => void
  ): void {
    this.on(type, listener as (...args: unknown[]) => void);
  }
  removeEventListener(
    type: string,
    listener: (...args: unknown[]) => void
  ): void {
    this.off(type, listener as (...args: unknown[]) => void);
  }
  dispatchEvent(event: { type: string }): boolean {
    return this.emit(event.type, event);
  }
}

const win = new WindowShim();
(globalThis as unknown as { window: WindowShim }).window = win;
// In Node 22+ `navigator` exists globally (undici-style). Only assign if missing.
if (typeof (globalThis as { navigator?: unknown }).navigator === "undefined") {
  (globalThis as { navigator: Navigator }).navigator = win.navigator;
}
(globalThis as unknown as { BroadcastChannel: typeof BroadcastChannelShim }).BroadcastChannel =
  BroadcastChannelShim;
(globalThis as unknown as { CustomEvent: typeof CustomEventShim }).CustomEvent = CustomEventShim;

export const browser = {
  window: win,
  setPathname(pathname: string): void {
    win.location.pathname = pathname;
  },
  setOrigin(origin: string): void {
    win.location.origin = origin;
    win.location.href = origin + "/";
  },
  reset(): void {
    win.localStorage.clear();
    win.sessionStorage.clear();
    win.location.pathname = "/";
    win.removeAllListeners();
  }
};