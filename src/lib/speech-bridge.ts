// One speech-bridge contract, two engines. macOS keeps window.ogb's native
// on-device recognizer; Windows (and any future platform without a bundled
// recognizer) gets cloud dictation through /api/stt/transcribe. Components
// ask for the bridge once and never care which engine is behind it.
import type { SpeechEndInfo, SpeechTranscriptLine } from "./cloud-speech.ts";
import { cloudSpeech } from "./cloud-speech.ts";

export interface SpeechBridge {
  /** True when the engine is cloud dictation (no partial transcripts). */
  cloud: boolean;
  start(options?: { endpointMs?: number }): void;
  stop(): void;
  onTranscript(cb: (line: SpeechTranscriptLine) => void): () => void;
  onEnd(cb: (info: SpeechEndInfo) => void): () => void;
}

export function speechBridgeFor(capabilities: DesktopCapabilities): SpeechBridge | null {
  if (capabilities.dictation.engine === "cloud-speech") {
    const cloud = cloudSpeech();
    return {
      cloud: true,
      start: (options) => {
        void cloud.start(options);
      },
      stop: () => cloud.stop(),
      onTranscript: (cb) => cloud.onTranscript(cb),
      onEnd: (cb) => cloud.onEnd(cb),
    };
  }
  const ogb = typeof window !== "undefined" ? window.ogb : undefined;
  if (!ogb?.speechStart) return null;
  return {
    cloud: false,
    start: (options) => {
      void ogb.speechStart?.(options);
    },
    stop: () => {
      void ogb.speechStop?.();
    },
    onTranscript: (cb) =>
      ogb.onSpeechTranscript((line) =>
        cb({ text: typeof line.text === "string" ? line.text : "", partial: line.partial, error: Boolean(line.error) }),
      ),
    onEnd: (cb) => ogb.onSpeechEnd((info) => cb({ code: info.code ?? 0, reason: info.reason })),
  };
}
