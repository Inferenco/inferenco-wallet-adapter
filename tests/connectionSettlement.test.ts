import { Account } from "@cedra-labs/ts-sdk";
import { InferClient } from "../src/InferClient";
import { InferWallet } from "../src/InferWallet";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const clients: InferClient[] = [];
const signer = Account.generate();
const account = { address: signer.accountAddress.toString(), publicKey: signer.publicKey.toUint8Array() };
function fixture() {
  const approval = deferred<typeof account>();
  const provider = { isNovaWallet: true, connect: vi.fn(() => approval.promise),
    network: vi.fn(async () => "testnet"), disconnect: vi.fn(async () => {}) };
  (window as any).inferenco = provider;
  const client = new InferClient(); clients.push(client);
  return { client, provider, approval };
}
afterEach(() => { for (const client of clients.splice(0)) client.dispose();
  delete (window as any).inferenco; window.localStorage.clear(); window.sessionStorage.clear(); vi.restoreAllMocks(); });

describe("connection operation settlement", () => {
  it("coalesces overlapping connections into one approval", async () => {
    const { client, provider, approval } = fixture();
    const one = client.connect(), two = client.connect();
    approval.resolve(account);
    expect(await one).toEqual(await two);
    expect(provider.connect).toHaveBeenCalledTimes(1);
  });
  it.each(["disconnect", "dispose"] as const)("settles a waiting connection on %s and ignores late approval", async (action) => {
    const { client, approval } = fixture();
    const waiting = client.connect();
    const rejected = expect(waiting).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    if (action === "disconnect") await client.disconnect(); else client.dispose();
    await rejected;
    approval.resolve(account); await Promise.resolve(); await Promise.resolve();
    expect(client.account).toBeNull(); expect(client.cachedNetwork).toBeNull();
  });
  it("does not publish an account when its network read fails", async () => {
    const { client, provider, approval } = fixture();
    provider.network.mockRejectedValueOnce(new Error("unavailable"));
    const waiting = client.connect(); approval.resolve(account);
    await expect(waiting).rejects.toThrow(); expect(client.account).toBeNull();
  });
  it("does not let an obsolete completion replace a new connection", async () => {
    const { client, provider, approval } = fixture();
    const old = client.connect(); const rejected = expect(old).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await client.disconnect(); await rejected;
    const replacement = Account.generate();
    const nextAccount = { address: replacement.accountAddress.toString(), publicKey: replacement.publicKey.toUint8Array() };
    provider.connect.mockResolvedValueOnce(nextAccount);
    await client.connect(); approval.resolve(account); await Promise.resolve(); await Promise.resolve();
    expect(client.account?.address.toString()).toBe(replacement.accountAddress.toString());
  });
  it("keeps pre-connect subscriptions active when connection completes", async () => {
    const { client, provider, approval } = fixture(); let onAccount!: (value: typeof account) => void;
    Object.assign(provider, { onAccountChange: vi.fn(async (callback: typeof onAccount) => { onAccount = callback; }) });
    await client.subscribe(); const observed = vi.fn(); client.on("accountChange", observed);
    const waiting = client.connect(); approval.resolve(account); await waiting;
    onAccount(account); expect(observed).toHaveBeenCalledOnce();
  });
  it("rejects a replacement while old disconnect cleanup is in progress", async () => {
    const { client, provider } = fixture(); const released = deferred<void>();
    provider.disconnect.mockImplementationOnce(() => released.promise);
    const disconnect = client.disconnect();
    await expect(client.connect()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(provider.connect).not.toHaveBeenCalled(); released.resolve(); await disconnect;
  });
  it("ignores subscribed account callbacks after disconnect", async () => {
    const { client, provider } = fixture(); let onAccount!: (value: typeof account) => void;
    Object.assign(provider, { onAccountChange: vi.fn(async (callback: typeof onAccount) => { onAccount = callback; }) });
    await client.subscribe(); const observed = vi.fn(); client.on("accountChange", observed);
    await client.disconnect(); onAccount(account);
    expect(client.account).toBeNull(); expect(observed).not.toHaveBeenCalled();
  });
});

describe("public wallet connecting flag", () => {
  it("coalesces connection callers and clears only the active operation", async () => {
    const { approval, provider } = fixture();
    const wallet = new InferWallet();
    const one = wallet.connect(), two = wallet.connect();
    expect(wallet.connecting).toBe(true); approval.resolve(account);
    expect(await one).toEqual(await two);
    expect(provider.connect).toHaveBeenCalledOnce(); expect(wallet.connecting).toBe(false);
    await wallet.disconnect();
  });
  it("cancels a connection waiting on subscription and ignores its late completion", async () => {
    const { approval, provider } = fixture(); const subscription = deferred<void>();
    Object.assign(provider, { onAccountChange: vi.fn(() => subscription.promise) });
    const wallet = new InferWallet(); const waiting = wallet.connect();
    const rejected = expect(waiting).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    approval.resolve(account);
    await vi.waitFor(() => expect((provider as any).onAccountChange).toHaveBeenCalledOnce());
    await wallet.disconnect(); await rejected;
    expect(wallet.connecting).toBe(false); expect(wallet.connected).toBe(false);
    subscription.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(wallet.connected).toBe(false);
  });
});
