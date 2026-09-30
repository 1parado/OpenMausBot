// STT facade next to server/tts: one place that decides which credential
// transcribes and what "not set up" means. The route stays thin.
import type { AppConfig } from "../config.ts";
import { voiceCredential } from "../included-services.ts";
import * as elevenlabs from "./elevenlabs.ts";

export { MAX_AUDIO_BYTES, NoSpeechConfigured } from "./elevenlabs.ts";

/** The ElevenLabs credential in use — the same one voice playback uses, so
 * a person who configured speech once gets dictation for free. */
const elevenLabs = (cfg: AppConfig) => voiceCredential(cfg.tts?.key);

/** True when cloud dictation has a credential to work with. Surfaced as a
 * configured-or-not boolean; never the key itself. */
export function sttConfigured(cfg: AppConfig): boolean {
  return Boolean(elevenLabs(cfg));
}

/** Transcribe one recording. Throws NoSpeechConfigured when no key is on
 * file, which the route turns into a 409 that points at App Settings. */
export function transcribe(cfg: AppConfig, audio: Uint8Array, mime: string) {
  const credential = elevenLabs(cfg);
  if (!credential) {
    throw new elevenlabs.NoSpeechConfigured(
      "Add an ElevenLabs key in Settings on the computer to turn on dictation.",
    );
  }
  return elevenlabs.transcribe(audio, mime, credential.token, credential.api);
}
