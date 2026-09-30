// Bridge between one Feishu chat and one OpenMausBot bot thread.
//
// Pure, injected-fetcher logic: the transport (Feishu WebSocket events in,
// Feishu REST messages out) lives in runtime.ts; this module knows only the
// OpenMausBot API surface shared with scripts/mcp-server.ts:
//   GET  /api/bots?messages=0
//   POST /api/bots/:id/tasks          (create + activate a thread)
//   POST /api/bots/:id/messages       { text, threadId }
//   GET  /api/threads/:id/messages    { messages: [...] }

export interface IncomingFeishuMessage {
  /** Stable Feishu message id — used for dedup of redelivered events. */
  messageId: string;
  chatId: string;
  /** "p2p" for direct messages, "group" for chats. */
  chatType: string;
  senderOpenId: string;
  /** Message text with mention placeholders already stripped. */
  text: string;
  /** True when the bot was @-mentioned (group messages). */
  mentioned: boolean;
}

export interface BridgeMessage {
  id?: unknown;
  role?: unknown;
  kind?: unknown;
  text?: unknown;
  card?: unknown;
}

export interface BridgeTurnResult {
  status: "replied" | "timeout" | "needs-input";
  reply: string;
}

export function stripMentionPlaceholders(text: string): string {
  // Feishu encodes @mentions in text content as @_user_N tokens; the readable
  // names live in event.mentions. A connector bot only needs the remainder.
  return text.replace(/@_user_\d+/g, "").trim();
}

/** Feishu event content (msg_type=text) is JSON: {"text":"..."}. */
export function feishuTextContent(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object" && typeof (parsed as { text?: unknown }).text === "string") {
      return (parsed as { text: string }).text;
    }
  } catch {
    // fall through to the raw content
  }
  return content;
}

/** Direct messages always answer; group messages only when the bot is @-mentioned. */
export function shouldRespond(message: Pick<IncomingFeishuMessage, "chatType" | "mentioned">): boolean {
  if (message.chatType === "p2p") return true;
  return message.mentioned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function messageNeedsInput(message: BridgeMessage): boolean {
  const card = isRecord(message.card) ? message.card : undefined;
  return Boolean(
    card &&
    typeof card.requestId === "string" &&
    card.answered !== true &&
    card.dismissed !== true &&
    card.expired !== true,
  );
}

/**
 * Extract the assistant's reply to the most recent user message. Messages
 * arrive oldest → newest within a page, mirroring mcp-server's own
 * dispatchFailedAfterLatestUser heuristic: only a bot text message after the
 * last user message counts as the reply.
 */
export function collectReply(messages: BridgeMessage[]): { reply: string; needsInput: boolean } {
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  const turn = lastUser >= 0 ? messages.slice(lastUser + 1) : messages;
  const parts: string[] = [];
  let needsInput = false;
  for (const message of turn) {
    if (messageNeedsInput(message)) needsInput = true;
    if (message.role === "bot" && message.kind === "text" && typeof message.text === "string" && message.text.trim()) {
      parts.push(message.text.trim());
    }
  }
  return { reply: parts.join("\n\n"), needsInput };
}

export type Fetcher = (path: string, options?: RequestInit) => Promise<any>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BridgeOptions {
  /** Poll interval for turn completion, ms. */
  pollIntervalMs?: number;
  /** Total wait for one turn before giving up, ms. */
  turnTimeoutMs?: number;
  /** Called with progress notes (already dispatched, waiting, …). */
  onNote?: (note: string) => void;
}

/**
 * One connector instance owns one bot. Feishu chats map 1:1 onto fresh bot
 * threads ("Feishu <chatId>"), so each chat gets an isolated conversation and
 * the bot's own sidebar thread stays untouched.
 */
export class FeishuBotBridge {
  private readonly threads = new Map<string, string>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly fetcher: Fetcher,
    private readonly options: BridgeOptions = {},
  ) {}

  /** Resolve a bot by id first, then by exact display name. */
  async resolveBot(botIdOrName: string): Promise<{ id: string; name: string }> {
    const res = await this.fetcher("/api/bots?messages=0");
    const bots: Array<Record<string, unknown>> = Array.isArray(res?.bots) ? res.bots : [];
    const found = bots.find((bot) => bot.id === botIdOrName) ??
      bots.find((bot) => bot.name === botIdOrName);
    if (!found || typeof found.id !== "string") {
      throw new Error(`Bot not found: ${botIdOrName}`);
    }
    return { id: found.id, name: typeof found.name === "string" ? found.name : String(found.id) };
  }

  private async threadForChat(botId: string, chatId: string): Promise<string> {
    const existing = this.threads.get(chatId);
    if (existing) return existing;
    await this.fetcher(`/api/bots/${encodeURIComponent(botId)}/tasks`, {
      method: "POST",
      body: JSON.stringify({ title: `Feishu ${chatId}` }),
    });
    // create_task activates the new thread, so the fleet listing reflects it.
    const res = await this.fetcher("/api/bots?messages=0");
    const bots: Array<Record<string, unknown>> = Array.isArray(res?.bots) ? res.bots : [];
    const bot = bots.find((candidate) => candidate.id === botId);
    const threadId = typeof bot?.threadId === "string" ? bot.threadId : undefined;
    if (!threadId) throw new Error(`could not resolve the new thread for chat ${chatId}`);
    this.threads.set(chatId, threadId);
    return threadId;
  }

  private async messages(botId: string, threadId: string): Promise<BridgeMessage[]> {
    const page = await this.fetcher(
      `/api/threads/${encodeURIComponent(threadId)}/messages?limit=30`,
    );
    return Array.isArray(page?.messages) ? (page.messages as BridgeMessage[]) : [];
  }

  /**
   * Run one turn: send the text, poll until the bot produces a reply, needs
   * input, or the timeout elapses. Serialized per chat so two rapid Feishu
   * messages cannot interleave turns.
   */
  async turn(message: IncomingFeishuMessage, bot: { id: string }, text: string): Promise<BridgeTurnResult> {
    const previous = this.queues.get(message.chatId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.runTurn(message, bot, text));
    this.queues.set(message.chatId, run);
    return run;
  }

  private async runTurn(
    message: IncomingFeishuMessage,
    bot: { id: string },
    text: string,
  ): Promise<BridgeTurnResult> {
    const pollIntervalMs = this.options.pollIntervalMs ?? 3_000;
    const turnTimeoutMs = this.options.turnTimeoutMs ?? 600_000;
    const threadId = await this.threadForChat(bot.id, message.chatId);
    this.options.onNote?.(`thread ${threadId}: dispatching`);
    await this.fetcher(`/api/bots/${encodeURIComponent(bot.id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, threadId }),
    });
    const deadline = Date.now() + turnTimeoutMs;
    let sawInput = false;
    while (Date.now() < deadline) {
      await sleep(pollIntervalMs);
      const found = collectReply(await this.messages(bot.id, threadId));
      if (found.reply) return { status: "replied", reply: found.reply };
      if (found.needsInput) sawInput = true;
    }
    if (sawInput) {
      return {
        status: "needs-input",
        reply: "The bot is waiting for an approval or an answer inside OpenMausBot. Please check the app, then message here again.",
      };
    }
    return {
      status: "timeout",
      reply: "The bot is still working after the wait limit. It keeps running in OpenMausBot; send another message later.",
    };
  }
}
