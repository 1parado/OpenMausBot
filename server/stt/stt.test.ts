import { afterEach, describe, expect, it, vi } from "vitest";

import { NoSpeechConfigured, transcribe as elevenLabsTranscribe } from "./elevenlabs.ts";
import { sttConfigured, transcribe } from "./index.ts";

const audio = new Uint8Array([1, 2, 3]);

describe("cloud dictation (stt)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports configured only when an ElevenLabs credential is on file", () => {
    expect(sttConfigured({} as any)).toBe(false);
    expect(sttConfigured({ tts: { key: "sk-1" } } as any)).toBe(true);
  });

  it("throws NoSpeechConfigured without a key; the route maps it to 409", () => {
    expect(() => transcribe({} as any, audio, "audio/webm")).toThrow(NoSpeechConfigured);
  });

  it("sends multipart audio to the scribe model and returns the text", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const form = init?.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      expect(form.get("model_id")).toBe("scribe_v1");
      const file = form.get("file") as File;
      expect(file.size).toBe(audio.byteLength);
      return new Response(JSON.stringify({ text: "hello from the mic" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const text = await elevenLabsTranscribe(audio, "audio/webm", "sk-1", "https://api.elevenlabs.test/v1");
    expect(text).toBe("hello from the mic");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.test/v1/speech-to-text");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("sk-1");
  });

  it("surfaces provider rejections as messages, not raw statuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: { message: "quota exceeded" } }), { status: 402 })));
    await expect(elevenLabsTranscribe(audio, "audio/webm", "sk-1", "https://api.elevenlabs.test/v1"))
      .rejects.toThrow(/quota exceeded/);
  });
});
