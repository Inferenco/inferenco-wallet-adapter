import { Account, Network } from "@cedra-labs/ts-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InferClient } from "../src/InferClient";
import { normalizeNetwork } from "../src/conversion";
import { normalizeSubmitInput } from "../src/integrationContract";
const signer = Account.generate();
afterEach(() => {
  delete (window as any).inferenco;
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
describe("approved network scope", () => {
  it.each([
    "banana",
    {},
    { name: "testnet" },
    { chainId: 2 },
    { name: "testnet", chainId: 256 },
    { name: "testnet", chainId: -1 },
    { name: "testnet", chainId: 2.5 },
    {
      get name() {
        throw new Error("getter");
      },
      chainId: 2
    }
  ])("rejects malformed report before submit", async (network) => {
    const dispatch = vi.fn();
    (window as any).inferenco = {
      isInferWallet: true,
      integrationContractVersion: 1,
      capabilities: { transactionRestrictions: true },
      account: async () => ({
        address: signer.accountAddress.toString(),
        publicKey: signer.publicKey.toUint8Array()
      }),
      network: async () => network,
      signAndSubmitTransaction: dispatch
    };
    await expect(
      new InferClient({
        networkOverride: Network.DEVNET
      }).signAndSubmitTransactionWithRestrictions(
        normalizeSubmitInput({
          data: {
            function: "0x1::fixture::run",
            typeArguments: [],
            functionArguments: []
          }
        })
      )
    ).rejects.toMatchObject({ code: "INVALID_NETWORK" });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("preserves explicit custom network/chain reports without relabeling", () => {
    expect(
      normalizeNetwork({
        name: Network.CUSTOM,
        chainId: 42,
        url: "http://127.0.0.1:8080"
      })
    ).toEqual({
      name: Network.CUSTOM,
      chainId: 42,
      url: "http://127.0.0.1:8080"
    });
  });
});
