import { describe, expect, it } from "vitest";

import {
  collectReply,
  feishuTextContent,
  FeishuBotBridge,
  shouldRespond,
  stripMentionPlaceholders,
  type BridgeMessage,
  type IncomingFeishuMessage,
} from "./bridge.ts";

function message(overrides: Partial<IncomingFeishuMessage> = {}): IncomingFeishuMessage {
  return {
    messageId: "om_1",
    chatId: "oc_chat",
    chatType: "p2p",
    senderOpenId: "ou_sender",
    text: "hello",
    mentioned: false,
    ...overrides,
  };
}

describe("feishu bridge", () => {
  it("strips @_user_N mention placeholders", () => {
    expect(stripMentionPlaceholders("@_user_1 run the tests")).toBe("run the tests");
    expect(stripMentionPlaceholders("@_user_1 @_user_2 hello")).toBe("hello");
  });

  it("parses text content JSON and falls back to the raw payload", () => {
    expect(feishuTextContent('{"text":"hi there"}')).toBe("hi there");
    expect(feishuTextContent("not json")).toBe("not json");
  });

  it("answers p2p always and groups only on mention", () => {
    expect(shouldRespond(message({ chatType: "p2p", mentioned: false }))).toBe(true);
    expect(shouldRespond(message({ chatType: "group", mentioned: false }))).toBe(false);
    expect(shouldRespond(message({ chatType: "group", mentioned: true }))).toBe(true);
  });

  it("collects the bot reply that follows the last user message", () => {
    const page: BridgeMessage[] = [
      { role: "user", kind: "text", text: "earlier" },
      { role: "bot", kind: "text", text: "earlier answer" },
      { role: "user", kind: "text", text: "run it" },
      { role: "bot", kind: "activity", tool: { name: "shell", ok: true } },
      { role: "bot", kind: "text", text: "done: 3 tests passed" },
    ];
    expect(collectReply(page)).toEqual({ reply: "done: 3 tests passed", needsInput: false });
  });

  it("flags approval cards waiting for input", () => {
    const page: BridgeMessage[] = [
      { role: "user", kind: "text", text: "deploy" },
      {
        role: "bot",
        kind: "text",
        text: "",
        card: { requestId: "req_1", answered: false, dismissed: false, expired: false },
      },
    ];
    expect(collectReply(page)).toEqual({ reply: "", needsInput: true });
  });

  it("resolves bots by id and by exact name", async () => {
    const calls: string[] = [];
    const bridge = new FeishuBotBridge(async (path: string) => {
      calls.push(path);
      return {
        bots: [
          { id: "bot_1", name: "Ops" },
          { id: "bot_2", name: "Writer" },
        ],
      };
    });
    expect(await bridge.resolveBot("Writer")).toEqual({ id: "bot_2", name: "Writer" });
    expect(await bridge.resolveBot("bot_1")).toEqual({ id: "bot_1", name: "Ops" });
    await expect(bridge.resolveBot("Missing")).rejects.toThrow(/Bot not found/);
    expect(calls.every((path) => path === "/api/bots?messages=0")).toBe(true);
  });

  it("creates one thread per chat and routes turns through it", async () => {
    const posts: Array<{ path: string; body?: unknown }> = [];
    let created = 0;
    const bridge = new FeishuBotBridge(
      async (path: string, options?: RequestInit) => {
        posts.push({ path, body: options?.body });
        if (path === "/api/bots?messages=0") {
          return {
            bots: [{ id: "bot_1", name: "Ops", threadId: created ? "thread_new" : "thread_old" }],
          };
        }
        if (path === "/api/bots/bot_1/tasks") {
          created += 1;
          return { thread: { id: "thread_new" } };
        }
        if (path.startsWith("/api/threads/thread_new/messages")) {
          return {
            messages: [
              { role: "user", kind: "text", text: "hello" },
              { role: "bot", kind: "text", text: "hi from the bot" },
            ],
          };
        }
        return {};
      },
      { pollIntervalMs: 1 },
    );

    const outcome = await bridge.turn(message(), { id: "bot_1" }, "hello");
    expect(outcome).toEqual({ status: "replied", reply: "hi from the bot" });
    expect(posts.some((post) => post.path === "/api/bots/bot_1/tasks")).toBe(true);
    expect(posts.some((post) => post.path === "/api/bots/bot_1/messages")).toBe(true);

    // Second turn on the same chat reuses the thread — no second create.
    posts.length = 0;
    await bridge.turn(message({ messageId: "om_2" }), { id: "bot_1" }, "again");
    expect(posts.some((post) => post.path === "/api/bots/bot_1/tasks")).toBe(false);
  });

  it("reports a timeout instead of hanging forever", async () => {
    const bridge = new FeishuBotBridge(
      async (path: string) => {
        if (path === "/api/bots?messages=0") {
          return { bots: [{ id: "bot_1", name: "Ops", threadId: "thread_1" }] };
        }
        if (path.startsWith("/api/threads/")) {
          return { messages: [{ role: "user", kind: "text", text: "hello" }] };
        }
        return {};
      },
      { pollIntervalMs: 1, turnTimeoutMs: 30 },
    );
    const outcome = await bridge.turn(message(), { id: "bot_1" }, "hello");
    expect(outcome.status).toBe("timeout");
  });
});
