// Feishu / Lark app registration device flow — pure logic.
// The "scan a QR code to connect a bot" flow talks to the accounts host used
// by the official SDKs (accounts.feishu.cn / accounts.larksuite.com):
//   action=init   → establishes the registration session
//   action=begin  → returns device_code + verification_uri_complete (the QR)
//   action=poll   → pending / slow_down / denied / expired / completed
// On completion the platform hands back client_id + client_secret, i.e. a
// ready-to-use app identity. Mounting "addons" on the QR URL makes the open
// platform auto-subscribe im.message.receive_v1 and request im:message, so a
// scanned bot works over the WebSocket long connection with no manual event
// configuration and no public callback URL.

import { gzipSync } from "node:zlib";

export type FeishuPlatform = "feishu" | "lark";

export interface ScanBeginResult {
  deviceCode: string;
  verificationUri: string;
  intervalSec: number;
  expireInSec: number;
}

export type ScanPollResult =
  | { status: "pending"; slowDown?: boolean; platform: FeishuPlatform }
  | { status: "scanned"; platform: FeishuPlatform }
  | {
      status: "completed";
      appId: string;
      appSecret: string;
      ownerOpenId: string;
      platform: FeishuPlatform;
    }
  | { status: "denied" | "expired"; error: string; platform: FeishuPlatform }
  | { status: "error"; error: string; platform: FeishuPlatform };

export function accountsBase(platform: FeishuPlatform): string {
  return platform === "lark" ? "https://accounts.larksuite.com" : "https://accounts.feishu.cn";
}

export function openApiBase(platform: FeishuPlatform): string {
  return platform === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
}

/** Scopes and events the scanned bot should get automatically. */
export function defaultFeishuAddons(): Record<string, unknown> {
  return {
    scopes: { tenant: ["im:message"] },
    events: { items: { tenant: ["im.message.receive_v1"] } },
  };
}

/**
 * Encode addons the way the official SDK does (scene/registration/addons.go):
 * base64url without padding over gzip(JSON). The open platform rejects the
 * QR when the encoding differs, so this must stay byte-exact.
 */
export function encodeFeishuAddons(addons: Record<string, unknown>): string {
  const json = Buffer.from(JSON.stringify(addons), "utf8");
  return gzipSync(json).toString("base64url");
}

/** Append one query parameter regardless of whether the URL already has ?. */
export function appendQueryParam(rawUrl: string, key: string, value: string): string {
  const sep = rawUrl.includes("?") ? "&" : "?";
  return `${rawUrl}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

/** Build the exact URL the QR code should encode for a begin result. */
export function buildVerificationUri(
  verificationUriComplete: string,
  addonsParam: string,
): string {
  let uri = appendQueryParam(verificationUriComplete, "addons", addonsParam);
  uri = appendQueryParam(uri, "from", "sdk");
  uri = appendQueryParam(uri, "tp", "sdk");
  return uri;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Normalize one action=poll response body. Brand detection may redirect the
 * base host (a Feishu code scanned by a Lark tenant or vice versa); the
 * caller re-posts against the returned platform's accounts host.
 */
export function normalizeRegistrationPoll(body: unknown): ScanPollResult {
  const data = asRecord(body);
  const user = asRecord(data.user_info);
  const brand = str(user.tenant_brand).toLowerCase();
  const platform: FeishuPlatform = brand === "lark" ? "lark" : "feishu";
  const appId = str(data.client_id);
  const appSecret = str(data.client_secret);
  if (appId && appSecret) {
    return {
      status: "completed",
      appId,
      appSecret,
      ownerOpenId: str(user.open_id),
      platform,
    };
  }
  const errorCode = str(data.error);
  switch (errorCode) {
    case "":
    case "authorization_pending":
      return { status: "pending", platform };
    case "slow_down":
      return { status: "pending", slowDown: true, platform };
    case "access_denied":
      return { status: "denied", error: "authorization was denied", platform };
    case "expired_token":
      return { status: "expired", error: "the QR code has expired", platform };
    default:
      return { status: "error", error: errorCode || "unknown poll error", platform };
  }
}

/** Parse an action=begin response into a QR-ready descriptor. */
export function normalizeRegistrationBegin(body: unknown): ScanBeginResult {
  const data = asRecord(body);
  const deviceCode = str(data.device_code);
  const verificationUri = str(data.verification_uri_complete);
  if (!deviceCode || !verificationUri) {
    throw new Error("registration response is missing the QR code fields");
  }
  const num = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return {
    deviceCode,
    verificationUri,
    intervalSec: Math.max(1, Math.round(num(data.interval, 5))),
    expireInSec: Math.max(30, Math.round(num(data.expire_in, 600))),
  };
}
