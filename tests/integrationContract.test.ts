import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalAddress,
  canonicalJson,
  encodeWireValue,
  messagePreimage,
  normalizeSubmitInput,
  requestCommitment,
  WIRE_BOUNDS
} from "../src/integrationContract";
import { nativeValues } from "./fixtures/integration-contract/native-values";
const corpus = JSON.parse(
  readFileSync("tests/fixtures/integration-contract/v1.json", "utf8")
);
describe("shared integration contract v1 through actual adapter parser", () => {
  for (const fixture of corpus.transactions)
    it(fixture.id, () => {
      const normalized = normalizeSubmitInput(
        fixture.input,
        "convenience",
        fixture.nowSeconds
      );
      expect(normalized).toEqual(fixture.expected);
      expect(
        requestCommitment("signAndSubmitTransaction", corpus.scope, normalized)
      ).toBe(fixture.requestCommitment);
    });
  for (const fixture of corpus.messages)
    it(fixture.id, () =>
      expect(messagePreimage(fixture.input, fixture.scope)).toBe(
        fixture.fullMessage
      )
    );
  for (const fixture of corpus.negative)
    it(fixture.id, () =>
      expect(() => normalizeSubmitInput(fixture.input)).toThrow()
    );
  it("preserves actual bigint and typed bytes", () => {
    const data = encodeWireValue(nativeValues());
    expect(data).toEqual({
      function: "0x1::fixture::run",
      typeArguments: [],
      functionArguments: [
        [0, 1, 127, 128, 255],
        "18446744073709551615",
        [[2, 3], "9007199254740993"]
      ]
    });
  });
  it("rejects getter/cycle/class/unsafe number/sparse array before any transport", () => {
    let getterCalls = 0;
    const getter = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        getterCalls++;
        return 1;
      }
    });
    const cycle: Record<string, unknown> = {};
    cycle.value = cycle;
    for (const value of [
      getter,
      cycle,
      new Date(),
      Number.MAX_SAFE_INTEGER + 1,
      NaN,
      -1,
      1.5,
      new Array(1),
      { [Symbol("x")]: 1 },
      1n << 256n
    ])
      expect(() => encodeWireValue(value)).toThrow();
    expect(getterCalls).toBe(0);
  });
  it("enforces depth, value and byte bounds", () => {
    let deep: unknown = 0;
    for (let i = 0; i < 34; i++) deep = [deep];
    for (const v of [
      deep,
      Array(WIRE_BOUNDS.nodes + 1).fill(0),
      "x".repeat(WIRE_BOUNDS.utf8Bytes)
    ])
      expect(() => encodeWireValue(v)).toThrow();
  });
  it("keeps standard and SDK convenience distinct", () => {
    expect(() =>
      normalizeSubmitInput({ data: { function: "0x1::f::g" } }, "standard")
    ).toThrow();
    expect(() =>
      normalizeSubmitInput(
        { payload: { function: "0x1::f::g" }, expireTimestamp: 100 },
        "standard"
      )
    ).toThrow();
  });
  it("canonicalizes addresses and stable object key order", () => {
    expect(canonicalAddress("0xA")).toBe("0x" + "a".padStart(64, "0"));
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } })).toBe(
      '{"a":{"b":3,"y":2},"z":1}'
    );
  });
});
