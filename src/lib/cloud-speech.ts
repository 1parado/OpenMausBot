// Cloud dictation — the speech bridge for platforms without a bundled
// on-device recognizer (Windows today). Same event contract as the native
// macOS bridge in window.ogb, different capture path:
//
//   getUserMedia → MediaRecorder (+ RMS silence endpointing for calls)
//     → POST /api/stt/transcribe → final transcript → end(0)
//
// Deliberately not streaming: one recording, one transcript, one end event.
// Composer dictation stops when the mic button is pressed again; call mode
// passes endpointMs and the adapter finalizes after that much silence.

export interface SpeechTranscriptLine {
  text: string;
  /** Absent/true = partial; exactly false = final. Cloud dictation only
   * ever emits one final line. */
  partial?: boolean;
  error?: boolean;
}

export interface SpeechEndInfo {
  code: number;
  reason?: string;
}

type TranscriptCb = (line: SpeechTranscriptLine) => void;
type EndCb = (info: SpeechEndInfo) => void;

const RMS_THRESHOLD = 0.012;
const RMS_TICK_MS = 100;

function recorderMime(): string {
  for (const candidate of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return "";
}

async function transcribe(blob: Blob, mime: string): Promise<string> {
  const res = await fetch("/api/stt/transcribe", {
    method: "POST",
    headers: { "content-type": mime },
    body: blob,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const detail = typeof body?.error === "string" ? `: ${body.error}` : "";
    throw new Error(`transcribe failed (${res.status})${detail}`);
  }
  const data = (await res.json()) as { text?: unknown };
  return typeof data.text === "string" ? data.text : "";
}

class CloudSpeechController {
  private transcriptSubs = new Set<TranscriptCb>();
  private endSubs = new Set<EndCb>();
  private session: { cancel(): void } | null = null;

  onTranscript(cb: TranscriptCb): () => void {
    this.transcriptSubs.add(cb);
    return () => this.transcriptSubs.delete(cb);
  }

  onEnd(cb: EndCb): () => void {
    this.endSubs.add(cb);
    return () => this.endSubs.delete(cb);
  }

  private emitTranscript(line: SpeechTranscriptLine): void {
    for (const cb of this.transcriptSubs) cb(line);
  }

  private emitEnd(info: SpeechEndInfo): void {
    for (const cb of this.endSubs) cb(info);
  }

  async start(options?: { endpointMs?: number }): Promise<void> {
    this.stop();
    const endpointMs = Number(options?.endpointMs) > 0 ? Number(options?.endpointMs) : 0;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      this.emitEnd({ code: 1, reason: "microphone-unavailable" });
      return;
    }
    const mime = recorderMime();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      this.emitEnd({ code: 1, reason: "recorder-unavailable" });
      return;
    }
    const actualMime = recorder.mimeType || mime || "audio/webm";
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };

    let cancelled = false;
    const tracks = stream.getTracks();

    // Silence endpointing (call mode): once speech has been heard, this much
    // continuous quiet ends the turn — the same contract the Apple helper
    // implements with SFSpeechRecognizer's endpoint timeout.
    let timer: ReturnType<typeof setInterval> | undefined;
    let audioContext: AudioContext | undefined;
    const clearEndpointing = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      void audioContext?.close().catch(() => undefined);
      audioContext = undefined;
    };
    if (endpointMs > 0) {
      try {
        audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const buffer = new Float32Array(analyser.fftSize);
        let heardSpeech = false;
        let quietFor = 0;
        timer = setInterval(() => {
          analyser.getFloatTimeDomainData(buffer);
          let sum = 0;
          for (const sample of buffer) sum += sample * sample;
          const rms = Math.sqrt(sum / buffer.length);
          if (rms > RMS_THRESHOLD) {
            heardSpeech = true;
            quietFor = 0;
            return;
          }
          if (!heardSpeech) return;
          quietFor += RMS_TICK_MS;
          if (quietFor >= endpointMs) {
            clearEndpointing();
            this.stop();
          }
        }, RMS_TICK_MS);
      } catch {
        clearEndpointing();
      }
    }

    const finished = new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: actualMime }));
    });
    this.session = {
      cancel: () => {
        cancelled = true;
        clearEndpointing();
        try {
          if (recorder.state !== "inactive") recorder.stop();
        } catch {
          // already stopped
        }
        tracks.forEach((track) => track.stop());
      },
    };
    recorder.start();

    void finished
      .then(async (blob) => {
        clearEndpointing();
        tracks.forEach((track) => track.stop());
        this.session = null;
        if (cancelled) return;
        try {
          const text = blob.size ? await transcribe(blob, actualMime) : "";
          this.emitTranscript({ text, partial: false });
          this.emitEnd({ code: 0 });
        } catch {
          this.emitEnd({ code: 1, reason: "transcription-failed" });
        }
      })
      .catch(() => this.emitEnd({ code: 1, reason: "transcription-failed" }));
  }

  stop(): void {
    this.session?.cancel();
    this.session = null;
  }
}

let controller: CloudSpeechController | undefined;

/** The shared controller — Composer and CallView can both subscribe without
 * fighting over one MediaRecorder. */
export function cloudSpeech(): CloudSpeechController {
  if (!controller) controller = new CloudSpeechController();
  return controller;
}
