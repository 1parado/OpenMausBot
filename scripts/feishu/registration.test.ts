import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  accountsBase,
  appendQueryParam,
  buildVerificationUri,
  defaultFeishuAddons,
  encodeFeishuAddons,
  normalizeRegistrationBegin,
  normalizeRegistrationPoll,
  openApiBase,
} from "./registration.ts";

describe("feishu registration", () => {
  it("encodes addons as unpadded base64url over gzip(JSON), matching the official SDK", () => {
    const addons = defaultFeishuAddons();
    const encoded = encodeFeishuAddons(addons);
    expect(encoded).not.toMatch(/[=]/);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = JSON.parse(gunzipSync(Buffer.from(encoded, "base64url")).toString("utf8"));
    expect(decoded).toEqual(addons);
  });

  it("mounts addons and sdk params on the verification URL", () => {
    const uri = buildVerificationUri(
      "https://accounts.feishu.cn/open/qr_connect?device_code=abc",
      "gzipPayload",
    );
    expect(uri).toContain("device_code=abc");
    expect(uri).toContain("addons=gzipPayload");
    expect(uri).toContain("from=sdk");
    expect(uri).toContain("tp=sdk");
  });

  it("appends query parameters to URLs with and without an existing query", () => {
    expect(appendQueryParam("https://x.test/a", "k", "v v")).toBe("https://x.test/a?k=v%20v");
    expect(appendQueryParam("https://x.test/a?b=1", "k", "v")).toBe("https://x.test/a?b=1&k=v");
  });

  it("normalizes a completed poll and reports the detected brand", () => {
    const result = normalizeRegistrationPoll({
      client_id: "cli_a1",
      client_secret: "s3cret",
      user_info: { open_id: "ou_1", tenant_brand: "Feishu" },
    });
    expect(result).toEqual({
      status: "completed",
      appId: "cli_a1",
      appSecret: "s3cret",
      ownerOpenId: "ou_1",
      platform: "feishu",
    });
  });

  it("maps pending, slow_down, denied and expired poll responses", () => {
    expect(normalizeRegistrationPoll({})).toEqual({ status: "pending", platform: "feishu" });
    expect(normalizeRegistrationPoll({ error: "authorization_pending" })).toEqual({
      status: "pending",
      platform: "feishu",
    });
    expect(normalizeRegistrationPoll({ error: "slow_down" })).toEqual({
      status: "pending",
      slowDown: true,
      platform: "feishu",
    });
    expect(normalizeRegistrationPoll({ error: "access_denied" }).status).toBe("denied");
    expect(normalizeRegistrationPoll({ error: "expired_token" }).status).toBe("expired");
    expect(normalizeRegistrationPoll({ error: "boom" })).toMatchObject({ status: "error", error: "boom" });
  });

  it("treats a lark tenant brand as the lark platform", () => {
    expect(
      normalizeRegistrationPoll({
        client_id: "cli_x",
        client_secret: "s",
        user_info: { open_id: "ou", tenant_brand: "lark" },
      }),
    ).toMatchObject({ platform: "lark" });
  });

  it("parses begin responses with sane interval fallbacks", () => {
    expect(
      normalizeRegistrationBegin({
        device_code: "dc",
        verification_uri_complete: "https://accounts.feishu.cn/open/qr_connect?device_code=dc",
        interval: 3,
        expire_in: 120,
      }),
    ).toEqual({
      deviceCode: "dc",
      verificationUri: "https://accounts.feishu.cn/open/qr_connect?device_code=dc",
      intervalSec: 3,
      expireInSec: 120,
    });
    expect(() => normalizeRegistrationBegin({ device_code: "dc" })).toThrow(/QR code fields/);
  });

  it("picks the right hosts per platform", () => {
    expect(accountsBase("feishu")).toBe("https://accounts.feishu.cn");
    expect(accountsBase("lark")).toBe("https://accounts.larksuite.com");
    expect(openApiBase("feishu")).toBe("https://open.feishu.cn");
    expect(openApiBase("lark")).toBe("https://open.larksuite.com");
  });
});
