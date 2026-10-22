/** Native inputs must reach the real codec, never a pre-stringified fixture. */
export const nativeValues = () => ({
  function: "0x1::fixture::run", typeArguments: [],
  functionArguments: [new Uint8Array([0, 1, 127, 128, 255]), 18446744073709551615n,
    [new Uint8Array([2, 3]), 9007199254740993n]]
});
