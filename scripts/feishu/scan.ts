// Feishu "scan a QR code to connect a bot" flow (device registration) and
// the connector's local credential store.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  accountsBase,
  buildVerificationUri,
  defaultFeishuAddons,
  encodeFeishuAddons,
  normalizeRegistrationBegin,
  normalizeRegistrationPoll,
  type FeishuPlatform,
  type ScanPollResult,
} from "./registration.ts";

async function postForm(
  base: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}/oauth/v1/app/registration`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`registration endpoint returned non-JSON (HTTP ${response.status})`);
  }
  if (!(response.status >= 200 && response.status < 300)) {
    const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const message = typeof record.error === "string" ? record.error : `HTTP ${response.status}`;
    const detail = typeof record.error_description === "string" ? `: ${record.error_description}` : "";
    throw new Error(`${message}${detail}`);
  }
  return (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
}

function extractError(body: Record<string, unknown>): string | undefined {
  const message = body.error;
  if (typeof message === "string" && message) {
    const detail = typeof body.error_description === "string" ? `: ${body.error_description}` : "";
    return `${message}${detail}`;
  }
  return undefined;
}

export interface ScanOutcome {
  appId: string;
  appSecret: string;
  ownerOpenId: string;
  platform: FeishuPlatform;
}

/**
 * Run the device flow up to (not including) polling: prints the QR to the
 * terminal and returns the poll loop's parameters. Mirrors the official SDK:
 * init → begin (PersonalAgent archetype, client_secret auth) → addons on the
 * verification URL so the scanned app self-subscribes to message events.
 */
export async function beginScan(
  platform: FeishuPlatform,
): Promise<{ deviceCode: string; qrUri: string; intervalSec: number; expireInSec: number }> {
  const base = accountsBase(platform);
  const init = await postForm(base, { action: "init" });
  const initError = extractError(init);
  if (initError) throw new Error(`registration init failed: ${initError}`);
  const begin = await postForm(base, {
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  });
  const beginError = extractError(begin);
  if (beginError) throw new Error(`registration begin failed: ${beginError}`);
  const parsed = normalizeRegistrationBegin(begin);
  const addons = encodeFeishuAddons(defaultFeishuAddons());
  return {
    deviceCode: parsed.deviceCode,
    qrUri: buildVerificationUri(parsed.verificationUri, addons),
    intervalSec: parsed.intervalSec,
    expireInSec: parsed.expireInSec,
  };
}

export interface PollOutcome {
  result: ScanPollResult;
  /** When brand detection flipped the accounts host, poll again here. */
  baseOverride?: string;
}

/** One action=poll round. Lark tenants may redirect the base host once. */
export async function pollScanOnce(
  platform: FeishuPlatform,
  deviceCode: string,
): Promise<PollOutcome> {
  let base = accountsBase(platform);
  const data = await postForm(base, { action: "poll", device_code: deviceCode });
  const brand = (data.user_info as Record<string, unknown> | undefined)?.tenant_brand;
  if (typeof brand === "string" && brand.toLowerCase() === "lark" && platform === "feishu") {
    base = accountsBase("lark");
    const retry = await postForm(base, { action: "poll", device_code: deviceCode });
    return { result: normalizeRegistrationPoll(retry), baseOverride: base };
  }
  return { result: normalizeRegistrationPoll(data) };
}

// ── credential store ─────────────────────────────────────────────────────

export interface FeishuAppRecord extends FeishuAppCredentialsLike {
  bot?: string;
  addedAt?: string;
}

interface FeishuAppCredentialsLike {
  appId: string;
  appSecret: string;
  platform: FeishuPlatform;
}

export interface ConnectorConfig {
  apps: FeishuAppRecord[];
}

export function defaultConfigPath(): string {
  return join(homedir(), ".openmausbot", "feishu-connector.json");
}

export function loadConfig(path = defaultConfigPath()): ConnectorConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ConnectorConfig;
    return { apps: Array.isArray(parsed.apps) ? parsed.apps : [] };
  } catch {
    return { apps: [] };
  }
}

export function saveConfig(config: ConnectorConfig, path = defaultConfigPath()): void {
  const dir = path.replace(/[\\/][^\\/]+$/, "");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ignores POSIX modes
  }
}

export function upsertApp(config: ConnectorConfig, record: FeishuAppRecord): ConnectorConfig {
  const apps = config.apps.filter((app) => app.appId !== record.appId);
  apps.push(record);
  return { apps };
}
