// Feishu transport: WebSocket long connection in, REST messages out.
//
// Uses @larksuiteoapi/node-sdk. The SDK is imported lazily so unit tests of
// the pure modules never load it. Long connection means events are pushed to
// this process — no public callback URL, no encrypt_key, no verification
// token, exactly like the official Go SDK's larkws client.

import type { IncomingFeishuMessage } from "./bridge.ts";
import { feishuTextContent, stripMentionPlaceholders } from "./bridge.ts";
import { openApiBase, type FeishuPlatform } from "./registration.ts";

export interface FeishuAppCredentials {
  appId: string;
  appSecret: string;
  platform: FeishuPlatform;
}

type FeishuSdkModule = Record<string, any>;

let sdkModule: FeishuSdkModule | undefined;

async function loadSdk(): Promise<FeishuSdkModule> {
  if (!sdkModule) sdkModule = await import("@larksuiteoapi/node-sdk");
  return sdkModule;
}

/** Strip SDK noise down to the fields the bridge needs; never throws. */
export function eventToIncoming(event: unknown): IncomingFeishuMessage | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const data = (event as { event?: unknown }).event;
  if (typeof data !== "object" || data === null) return undefined;
  const payload = data as Record<string, unknown>;

  const sender = payload.sender as Record<string, unknown> | undefined;
  const senderType = typeof sender?.sender_type === "string" ? sender.sender_type : "";
  if (senderType === "bot" || senderType === "app") return undefined;

  const message = payload.message as Record<string, unknown> | undefined;
  if (!message) return undefined;
  const messageType = typeof message.message_type === "string" ? message.message_type : "";
  if (messageType !== "text") return undefined;
  const messageId = typeof message.message_id === "string" ? message.message_id : "";
  const chatId = typeof message.chat_id === "string" ? message.chat_id : "";
  if (!messageId || !chatId) return undefined;

  const rawContent = typeof message.content === "string" ? message.content : "{}";
  const text = stripMentionPlaceholders(feishuTextContent(rawContent)).trim();
  if (!text) return undefined;

  const senderId = (sender?.sender_id ?? {}) as Record<string, unknown>;
  const senderOpenId =
    typeof senderId.open_id === "string" ? senderId.open_id :
    typeof senderId.user_id === "string" ? senderId.user_id : "";

  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  return {
    messageId,
    chatId,
    chatType: typeof message.chat_type === "string" && message.chat_type ? message.chat_type : "p2p",
    senderOpenId,
    text,
    mentioned: mentions.length > 0,
  };
}

export interface FeishuConnection {
  close(): void;
}

export interface ConnectionHandlers {
  onMessage(message: IncomingFeishuMessage): void;
  onError(error: unknown): void;
}

export async function connectApp(
  credentials: FeishuAppCredentials,
  handlers: ConnectionHandlers,
): Promise<FeishuConnection> {
  const Lark = await loadSdk();
  const seen = new Set<string>();
  const eventDispatcher = new Lark.EventDispatcher({});
  eventDispatcher.register({
    "im.message.receive_v1": (event: unknown) => {
      try {
        const message = eventToIncoming(event);
        if (!message) return;
        // Feishu redelivers events after reconnects; dedup on message id.
        if (seen.has(message.messageId)) return;
        seen.add(message.messageId);
        if (seen.size > 1_000) {
          for (const first of seen) {
            seen.delete(first);
            break;
          }
        }
        handlers.onMessage(message);
      } catch (error) {
        handlers.onError(error);
      }
    },
  });
  const wsClient = new Lark.WSClient({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    domain: openApiBase(credentials.platform),
    loggerLevel: Number(Lark.LogLevel?.warn ?? 2),
  });
  // start() keeps the long connection alive (auto-reconnect inside the SDK).
  void wsClient.start({ eventDispatcher }).catch((error: unknown) => handlers.onError(error));
  return {
    close() {
      try {
        wsClient.close?.();
      } catch {
        // already closed
      }
    },
  };
}

/** Send one text message into a chat. Returns the Feishu message id. */
export async function sendChatText(
  credentials: FeishuAppCredentials,
  chatId: string,
  text: string,
): Promise<string> {
  const Lark = await loadSdk();
  const client = new Lark.Client({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    domain: openApiBase(credentials.platform),
  });
  // Feishu caps text message content at ~150KB of UTF-8; stay far below and
  // keep the tail (answers usually matter most at the end).
  const trimmed = text.length > 12_000 ? `…${text.slice(-12_000)}` : text;
  const res = await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text: trimmed }),
    },
  });
  const messageId = (res as { data?: { message_id?: unknown } })?.data?.message_id;
  return typeof messageId === "string" ? messageId : "";
}
