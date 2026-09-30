#!/usr/bin/env -S node --experimental-strip-types
// Feishu connector — turn Feishu/Lark chats into OpenMausBot bot surfaces.
//
//   scan   Scan a QR code with the Feishu/Lark app; the open platform creates
//          a PersonalAgent app, auto-subscribes im.message.receive_v1 and
//          returns client_id/client_secret, which land in the connector config.
//   start  Open one WebSocket long connection per saved app and bridge chats
//          to bot threads over the local OpenMausBot API.
//
// No public callback URL is needed at any point: events arrive over the long
// connection, so a laptop behind NAT works. Server discovery and
// authentication reuse scripts/mcp-server.ts (OPENMAUSBOT_URL / OMB_PORT /
// OPENMAUSBOT_TOKEN).

import { parseArgs } from "node:util";

import QRCode from "qrcode-terminal";

import { FeishuBotBridge, shouldRespond, type IncomingFeishuMessage } from "./feishu/bridge.ts";
import { connectApp, sendChatText, type FeishuAppCredentials, type FeishuConnection } from "./feishu/runtime.ts";
import {
  beginScan,
  defaultConfigPath,
  loadConfig,
  pollScanOnce,
  saveConfig,
  upsertApp,
  type ConnectorConfig,
  type FeishuAppRecord,
} from "./feishu/scan.ts";
import { request } from "./mcp-server.ts";
import type { FeishuPlatform } from "./feishu/registration.ts";

function log(message: string): void {
  process.stderr.write(`[feishu-connector] ${message}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp(): void {
  process.stdout.write(`feishu-connector — connect Feishu/Lark chats to OpenMausBot bots

  scan [--lark] [--bot NAME] [--config PATH]
      Print a QR code; scan it with the Feishu (or Lark, with --lark) app to
      create the bot app. Credentials are saved to the connector config.
      --bot binds the app to one OpenMausBot bot name up front.

  list [--config PATH]
      Show saved apps.

  remove --app APP_ID [--config PATH]
      Forget one saved app.

  start [--bot NAME] [--app APP_ID] [--config PATH]
      Open the long connection(s) and bridge Feishu chats to bot threads.
      Server: OPENMAUSBOT_URL or OMB_PORT (default http://127.0.0.1:8799),
      optional OPENMAUSBOT_TOKEN for paired/remote servers.
`);
}

interface ScanArgs {
  lark?: boolean;
  bot?: string;
  config?: string;
}

async function runScan(args: ScanArgs): Promise<void> {
  const platform: FeishuPlatform = args.lark ? "lark" : "feishu";
  process.stdout.write(`Generating a ${platform === "lark" ? "Lark" : "Feishu"} bot QR code…\n`);
  const begin = await beginScan(platform);
  process.stdout.write(
    `Scan with the ${platform === "lark" ? "Lark" : "Feishu"} mobile app (creates a personal agent bot,\n` +
    `subscribes message events automatically). Expires in ${Math.round(begin.expireInSec / 60)} minutes.\n\n`,
  );
  QRCode.generate(begin.qrUri, { small: true });
  process.stdout.write("\nWaiting for the scan to complete…\n");

  const deadline = Date.now() + begin.expireInSec * 1_000;
  let intervalMs = begin.intervalSec * 1_000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const { result } = await pollScanOnce(platform, begin.deviceCode);
    if (result.status === "completed") {
      const config = upsertApp(loadConfig(args.config), {
        appId: result.appId,
        appSecret: result.appSecret,
        platform: result.platform,
        ...(args.bot ? { bot: args.bot } : {}),
        addedAt: new Date().toISOString(),
      });
      saveConfig(config, args.config);
      process.stdout.write(
        `\nConnected as app ${result.appId} (${result.platform}).` +
        `\nSaved to ${args.config ?? defaultConfigPath()}.` +
        `\nRun "pnpm feishu start${args.bot ? ` --bot ${args.bot}` : ""}" to bridge chats to OpenMausBot.\n`,
      );
      return;
    }
    if (result.status === "scanned") {
      process.stdout.write("QR scanned — confirm on your phone…\n");
      continue;
    }
    if (result.status === "pending") {
      if (result.slowDown) intervalMs = Math.round(intervalMs * 1.5);
      continue;
    }
    throw new Error(`scan failed: ${result.status}${"error" in result ? ` (${result.error})` : ""}`);
  }
  throw new Error("the QR code expired before the scan was confirmed — run scan again");
}

function printApps(config: ConnectorConfig, path: string): void {
  if (!config.apps.length) {
    process.stdout.write(`No apps saved in ${path}. Run "pnpm feishu scan" first.\n`);
    return;
  }
  for (const app of config.apps) {
    process.stdout.write(
      `${app.appId}  ${app.platform}${app.bot ? `  → bot ${app.bot}` : "  → bot: set at start with --bot"}\n`,
    );
  }
}

async function startApp(app: FeishuAppRecord, botName: string | undefined): Promise<void> {
  const credentials: FeishuAppCredentials = {
    appId: app.appId,
    appSecret: app.appSecret,
    platform: app.platform,
  };
  const bridge = new FeishuBotBridge(request, {
    onNote: (note) => log(`${app.appId}: ${note}`),
  });
  const bot = await bridge.resolveBot(app.bot ?? botName ?? "");
  log(`${app.appId} (${app.platform}) → bot "${bot.name}"; opening long connection…`);
  let connection: FeishuConnection | undefined;
  connection = await connectApp(credentials, {
    onMessage: (message: IncomingFeishuMessage) => {
      if (!shouldRespond(message)) return;
      log(`${app.appId}: chat ${message.chatId}: ${message.text.slice(0, 80)}`);
      void (async () => {
        try {
          const outcome = await bridge.turn(message, bot, message.text);
          await sendChatText(credentials, message.chatId, outcome.reply);
        } catch (error) {
          log(`${app.appId}: turn failed: ${error instanceof Error ? error.message : String(error)}`);
          await sendChatText(
            credentials,
            message.chatId,
            `The bot could not answer just now: ${error instanceof Error ? error.message : String(error)}`,
          ).catch(() => undefined);
        }
      })();
    },
    onError: (error) => log(`${app.appId}: ${error instanceof Error ? error.message : String(error)}`),
  });
  return Promise.resolve(connection).then(() => undefined);
}

async function runStart(options: { bot?: string; app?: string; config?: string }): Promise<void> {
  const config = loadConfig(options.config);
  const apps = config.apps.filter((app) => !options.app || app.appId === options.app);
  if (!apps.length) throw new Error("no saved app matches — run \"pnpm feishu scan\" first");
  await Promise.all(apps.map((app) => startApp(app, options.bot)));
  log("running — press Ctrl-C to stop");
  // The SDK socket keeps the loop alive; the interval is a belt-and-braces
  // guarantee the process survives a silent reconnect.
  setInterval(() => undefined, 1 << 30).unref?.();
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      lark: { type: "boolean", default: false },
      bot: { type: "string" },
      app: { type: "string" },
      config: { type: "string" },
    },
  });
  const [command] = positionals;
  try {
    switch (command) {
      case "scan":
        await runScan(values as ScanArgs);
        return 0;
      case "list": {
        const path = values.config ?? defaultConfigPath();
        printApps(loadConfig(path), path);
        return 0;
      }
      case "remove": {
        if (!values.app) throw new Error("remove needs --app APP_ID");
        const path = values.config ?? defaultConfigPath();
        const config = loadConfig(path);
        saveConfig({ apps: config.apps.filter((app) => app.appId !== values.app) }, path);
        process.stdout.write(`Removed ${values.app}.\n`);
        return 0;
      }
      case "start":
        await runStart({ bot: values.bot, app: values.app, config: values.config });
        return 0;
      default:
        printHelp();
        return command ? 1 : 0;
    }
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith("feishu-connector.ts")) {
  main().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
