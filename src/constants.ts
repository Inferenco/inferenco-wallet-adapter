import { Buffer } from "node:buffer";

export const NOVA_WALLET_NAME = "Nova Wallet";
export const DEFAULT_WEBSITE_URL = "https://inferenco.com";
export const DEFAULT_DEEPLINK_BASE_URL = "inferenco://connect?callback=";
export const DEFAULT_DETECT_ALIASES = true;
export const DEFAULT_REGISTER_FORCE = false;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#0a3d91"/><path d="M32 12 40 28 56 32 40 36 32 52 24 36 8 32 24 28Z" fill="#66d9ff"/></svg>`;

export const NOVA_WALLET_ICON = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` as const;
