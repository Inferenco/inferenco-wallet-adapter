import { expectTypeOf, it } from "vitest";
import type { AnyRawTransaction, SimpleTransaction, MultiAgentTransaction } from "@cedra-labs/ts-sdk";
import type { CedraSignAndSubmitTransactionInput } from "@cedra-labs/wallet-standard";
import type { InferClient, InferWallet, InferWalletAdapterLike } from "../src/index";

type ClientSubmit = Parameters<InferClient["signAndSubmitTransaction"]>[0];
type ClientAlias = Parameters<InferClient["signAndSubmitBCSTransaction"]>[0];
type WalletSubmit = Parameters<InferWallet["signAndSubmitTransaction"]>[0];
type WalletAlias = Parameters<InferWallet["signAndSubmitBCSTransaction"]>[0];
type PluginSubmit = Parameters<InferWalletAdapterLike["signAndSubmitTransaction"]>[0];
type PluginAlias = Parameters<InferWalletAdapterLike["signAndSubmitBCSTransaction"]>[0];

it("does not advertise SDK raw transactions for payload submission", () => {
  // These assertions are checked by tsc, not just the runtime test runner.
  expectTypeOf<SimpleTransaction>().not.toMatchTypeOf<ClientSubmit>();
  expectTypeOf<MultiAgentTransaction>().not.toMatchTypeOf<ClientSubmit>();
  expectTypeOf<AnyRawTransaction>().not.toMatchTypeOf<ClientAlias>();
  expectTypeOf<AnyRawTransaction>().not.toMatchTypeOf<WalletSubmit>();
  expectTypeOf<AnyRawTransaction>().not.toMatchTypeOf<WalletAlias>();
  expectTypeOf<AnyRawTransaction>().not.toMatchTypeOf<PluginSubmit>();
  expectTypeOf<AnyRawTransaction>().not.toMatchTypeOf<PluginAlias>();
});

it("retains entry-function submission and exact prebuilt sign-only inputs", () => {
  type Entry = { function: "0x1::chips::claim_free_chips"; functionArguments: []; typeArguments: [] };
  type Wrapped = { data: Entry; options: { maxGasAmount: number } };
  expectTypeOf<Entry>().toMatchTypeOf<ClientSubmit>();
  expectTypeOf<Wrapped>().toMatchTypeOf<ClientSubmit>();
  expectTypeOf<Entry>().toMatchTypeOf<ClientAlias>();
  expectTypeOf<Wrapped>().toMatchTypeOf<WalletSubmit>();
  expectTypeOf<CedraSignAndSubmitTransactionInput>().toMatchTypeOf<ClientSubmit>();
  expectTypeOf<AnyRawTransaction>().toMatchTypeOf<Parameters<InferClient["signTransaction"]>[0]>();
  expectTypeOf<AnyRawTransaction>().toMatchTypeOf<Parameters<InferWallet["signTransaction"]>[0]>();
});
