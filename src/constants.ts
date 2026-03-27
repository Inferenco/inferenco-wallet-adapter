import { Buffer } from "node:buffer";

export const NOVA_WALLET_NAME = "Nova Wallet";
export const NOVA_DESK_NAME = "Nova Desk";
export const DEFAULT_WEBSITE_URL = "https://inferenco.com";
export const DEFAULT_DEEPLINK_BASE_URL = "inferenco://connect?callback=";
export const DEFAULT_DESKTOP_LOGIN_URL = "inferenco://login";
export const DEFAULT_DESKTOP_BRIDGE_URL = "http://127.0.0.1:21984";
export const DEFAULT_DETECT_ALIASES = true;
export const DEFAULT_REGISTER_FORCE = false;
export const DEFAULT_DESKTOP_REGISTRATION = true;
export const DEFAULT_BRIDGE_CONNECT_TIMEOUT_MS = 1200;
export const DEFAULT_BRIDGE_POLL_INTERVAL_MS = 250;
export const DEFAULT_BRIDGE_POLL_TIMEOUT_MS = 120000;
export const NOVA_PROTOCOL_KEY_STORAGE_KEY = "inferenco:nova-protocol-key";
export const NOVA_EXTERNAL_SESSION_STORAGE_KEY = "inferenco:nova-session";
export const CALLBACK_ADDRESS_PARAM = "address";
export const CALLBACK_PUBLIC_KEY_PARAM = "publicKey";
export const CALLBACK_NETWORK_PARAM = "network";
export const CALLBACK_CHAIN_ID_PARAM = "chainId";
export const CALLBACK_SESSION_ID_PARAM = "sessionId";
export const CALLBACK_BRIDGE_URL_PARAM = "bridgeUrl";
export const CALLBACK_PROTOCOL_PUBLIC_KEY_PARAM = "protocolPublicKey";
export const CALLBACK_WALLET_NAME_PARAM = "walletName";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#0a3d91"/><path d="M32 12 40 28 56 32 40 36 32 52 24 36 8 32 24 28Z" fill="#66d9ff"/></svg>`;

export const NOVA_WALLET_ICON = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` as const;
