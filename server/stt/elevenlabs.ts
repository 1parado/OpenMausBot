// Cloud speech-to-text on the harness, same trust shape as TTS: the key
// never leaves the server, the renderer posts audio bytes and gets a
// transcript. One provider for now (ElevenLabs Scribe — the account many
// voice users already have), reached through the same base-URL seam TTS uses
// (the person's own key hits ElevenLabs itself; OMB_ELEVENLABS_API overrides
// it for dev and tests).
import { elevenLabsProviderApi } from "../included-services.ts";

const MODEL = "scribe_v1";
// Dictation utterances are short; a ceiling keeps a stray local request from
// uploading an unbounded file.
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export class NoSpeechConfigured extends Error {}

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function message(status: number, body: any): string {
  const theirs =
    (typeof body?.detail === "string" && body.detail.trim()) ||
    (typeof body?.detail?.message === "string" && body.detail.message.trim()) ||
    "";
  if (status === 401 || status === 403) {
    return "ElevenLabs rejected that key for speech-to-text — paste an unrestricted key in App Settings.";
  }
  if (status === 429) return theirs || "ElevenLabs is rate-limiting this account — wait a moment and try again.";
  if (status === 402) return theirs || "ElevenLabs says this account is out of credit.";
  return theirs ? `Transcription failed: ${theirs}` : `Transcription failed (${status})`;
}

/** Transcribe one recording. Returns the transcript text, "" for silence. */
export async function transcribe(
  audio: Uint8Array,
  mime: string,
  key: string,
  api: string = elevenLabsProviderApi(),
): Promise<string> {
  const form = new FormData();
  const extension = mime.includes("webm") ? "weba" : mime.includes("ogg") ? "ogg" : "mp3";
  form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), `audio.${extension}`);
  form.append("model_id", MODEL);
  const res = await fetch(`${api}/speech-to-text`, {
    method: "POST",
    headers: { "xi-api-key": key },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  const body = await safeJson(res);
  if (!res.ok) throw new Error(message(res.status, body));
  return typeof body?.text === "string" ? body.text : "";
}
