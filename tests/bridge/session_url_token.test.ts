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

describe("sessionBridgeBaseUrl — 0.2.0-rc.17 token graft", () => {
  it("grafts_token_from_session_bridgeUrl_when_options_bridgeBaseUrl_is_bare", () => {
    // Production infer-ecosystem case: dApp passes bare
    // `http://127.0.0.1:21984`, session.bridgeUrl carries the token.
    // Pre-rc.17, the token was stripped.
    const session = {
      sessionId: "sess-bare-1",
      bridgeUrl: `http://127.0.0.1:21984/${SAMPLE_TOKEN}`
    };
    const options = { bridgeBaseUrl: "http://127.0.0.1:21984" };
    const url = _sessionEndpointUrlInternal(session, options);
    expect(url).toBe(
      `http://127.0.0.1:21984/${SAMPLE_TOKEN}/session/${session.sessionId}`
    );
  });

  it("connectionEndpointUrl_grafts_token_when_options_bridgeBaseUrl_is_bare", () => {
    const session = {
      address: "0xabc",
      network: "testnet",
      bridgeUrl: `http://127.0.0.1:21984/${SAMPLE_TOKEN}`
    };
    const options = { bridgeBaseUrl: "http://127.0.0.1:21984" };
    const url = _connectionEndpointUrlInternal(session, options);
    expect(url).toContain(`/${SAMPLE_TOKEN}/connection`);
    expect(url).toContain("origin=");
    expect(url).toContain("address=0xabc");
    expect(url).toContain("network=testnet");
  });

  it("does_not_double_graft_when_options_bridgeBaseUrl_already_has_token", () => {
    // Pre-rc.17 behaviour must be preserved when dApp already passes token.
    const session = {
      sessionId: "sess-dup-1",
      bridgeUrl: `http://127.0.0.1:21984/${SAMPLE_TOKEN}`
    };
    const options = {
      bridgeBaseUrl: `http://localhost:9999/${SAMPLE_TOKEN}`
    };
    const url = _sessionEndpointUrlInternal(session, options);
    expect(url).toBe(
      `http://localhost:9999/${SAMPLE_TOKEN}/session/${session.sessionId}`
    );
  });

  it("falls_through_when_session_bridgeUrl_has_no_token", () => {
    // Mobile-relay sessions: no token to graft.
    const session = {
      sessionId: "sess-no-tok",
      bridgeUrl: "http://127.0.0.1:21984"
    };
    const options = { bridgeBaseUrl: "http://127.0.0.1:21984" };
    const url = _sessionEndpointUrlInternal(session, options);
    expect(url).toBe(
      `http://127.0.0.1:21984/session/${session.sessionId}`
    );
  });

  it("does_not_graft_attacker_token_onto_trusted_host_ND_WEB_001", () => {
    // ND-WEB-001 invariant: an attacker who controls session.bridgeUrl
    // (via callback substitution) must NOT be able to redirect traffic
    // to their own host. The HOST stays from options.bridgeBaseUrl.
    const session = {
      sessionId: "sess-atk-1",
      bridgeUrl: `https://attacker.example/${SAMPLE_TOKEN}`
    };
    const options = { bridgeBaseUrl: "https://dapp.example/bridge" };
    const url = _sessionEndpointUrlInternal(session, options);
    expect(url).not.toContain("attacker.example");
    expect(url).toContain("dapp.example");
  });
});
