import { describe, expect, it } from "vitest";

import {
  _connectionEndpointUrlInternal,
  _sessionEndpointUrlInternal
} from "../../src/bridge.js";

const SAMPLE_TOKEN =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SAMPLE_SESSION = {
  sessionId: "sess-abc-123",
  bridgeUrl: `http://127.0.0.1:21984/${SAMPLE_TOKEN}`
};

describe("sessionEndpointUrl (0.2.0-rc.7 token preservation)", () => {
  it("preserves_token_segment_from_session_bridgeUrl", () => {
    const url = _sessionEndpointUrlInternal(SAMPLE_SESSION, {});
    expect(url).toBe(
      `http://127.0.0.1:21984/${SAMPLE_TOKEN}/session/${SAMPLE_SESSION.sessionId}`
    );
  });

  it("uses_unprefixed_base_when_no_token_in_url", () => {
    const session = { sessionId: "no-token", bridgeUrl: "http://127.0.0.1:21984" };
    const url = _sessionEndpointUrlInternal(session, {});
    expect(url).toBe(`http://127.0.0.1:21984/session/${session.sessionId}`);
  });

  it("respects_configured_options_bridgeBaseUrl_when_token_present", () => {
    const options = { bridgeBaseUrl: `http://localhost:9999/${SAMPLE_TOKEN}` };
    const url = _sessionEndpointUrlInternal(SAMPLE_SESSION, options);
    expect(url).toBe(
      `http://localhost:9999/${SAMPLE_TOKEN}/session/${SAMPLE_SESSION.sessionId}`
    );
  });

  it("encodes_sessionId", () => {
    const session = {
      sessionId: "abc/def?",
      bridgeUrl: `http://127.0.0.1:21984/${SAMPLE_TOKEN}`
    };
    const url = _sessionEndpointUrlInternal(session, {});
    expect(url).toContain(`/session/abc%2Fdef%3F`);
  });
});

describe("connectionEndpointUrl (0.2.0-rc.7 token preservation)", () => {
  it("preserves_token_segment", () => {
    const session = {
      address: "0xabc",
      network: "testnet",
      bridgeUrl: `http://127.0.0.1:21984/${SAMPLE_TOKEN}`
    };
    const url = _connectionEndpointUrlInternal(session, {});
    expect(url).toContain(`/${SAMPLE_TOKEN}/connection?`);
    expect(url).toContain("origin=");
    expect(url).toContain("address=0xabc");
    expect(url).toContain("network=testnet");
  });
});
