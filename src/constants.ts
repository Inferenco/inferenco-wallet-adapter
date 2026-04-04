import { Buffer } from "node:buffer";

export const NOVA_CONNECT_NAME = "Nova Connect";
export const NOVA_WALLET_NAME = "Nova Wallet";
/** @deprecated Use NOVA_CONNECT_NAME instead. */
export const NOVA_DESK_NAME = NOVA_CONNECT_NAME;
export const DEFAULT_WEBSITE_URL = "https://inferenco.com";
export const DEFAULT_DEEPLINK_BASE_URL = "inferenco://connect?callback=";
export const DEFAULT_DESKTOP_LOGIN_URL = "inferenco://login";
export const DEFAULT_DESKTOP_BRIDGE_URL = "http://127.0.0.1:21984";
export const DEFAULT_DEEPLINK_SCHEME = "inferenco";
export const DEFAULT_MOBILE_RELAY_BASE_URL = "https://nova-service-160604102004.europe-west1.run.app";
export const DEFAULT_MOBILE_WEBSOCKET_URL = "wss://nova-service-160604102004.europe-west1.run.app/v1/ws";
export const DEFAULT_MOBILE_POLL_INTERVAL_MS = 1000;
export const DEFAULT_MOBILE_REQUEST_TIMEOUT_MS = 180000;
export const DEFAULT_MOBILE_SOCKET_TIMEOUT_MS = 15000;
export const DEFAULT_DETECT_ALIASES = true;
export const DEFAULT_REGISTER_FORCE = false;
export const DEFAULT_DESKTOP_REGISTRATION = true;
export const DEFAULT_BRIDGE_CONNECT_TIMEOUT_MS = 1200;
export const DEFAULT_BRIDGE_POLL_INTERVAL_MS = 250;
export const DEFAULT_BRIDGE_POLL_TIMEOUT_MS = 120000;
export const NOVA_PROTOCOL_KEY_STORAGE_KEY = "inferenco:nova-protocol-key";
export const NOVA_EXTERNAL_SESSION_STORAGE_KEY = "inferenco:nova-session";
export const NOVA_PENDING_MOBILE_PAIRING_STORAGE_KEY = "inferenco:nova-pending-mobile-pairing";
export const NOVA_CALLBACK_MARKER_STORAGE_KEY = "inferenco:nova-callback-marker";
export const CALLBACK_ADDRESS_PARAM = "address";
export const CALLBACK_PUBLIC_KEY_PARAM = "publicKey";
export const CALLBACK_NETWORK_PARAM = "network";
export const CALLBACK_CHAIN_ID_PARAM = "chainId";
export const CALLBACK_SESSION_ID_PARAM = "sessionId";
export const CALLBACK_BRIDGE_URL_PARAM = "bridgeUrl";
export const CALLBACK_PROTOCOL_PUBLIC_KEY_PARAM = "protocolPublicKey";
export const CALLBACK_WALLET_NAME_PARAM = "walletName";
export const CALLBACK_REQUEST_ID_PARAM = "novaRequestId";
export const CALLBACK_STATUS_PARAM = "novaStatus";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#0a3d91"/><path d="M32 12 40 28 56 32 40 36 32 52 24 36 8 32 24 28Z" fill="#66d9ff"/></svg>`;

export const NOVA_WALLET_ICON = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` as const;
