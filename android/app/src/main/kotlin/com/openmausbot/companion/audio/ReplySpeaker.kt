package com.openmausbot.companion.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.speech.tts.TextToSpeech
import java.util.Locale
import java.util.concurrent.atomic.AtomicInteger

/**
 * Reads bot replies aloud — the Android shape of "bots that talk back".
 *
 * Composer dictation ([com.openmausbot.companion.dictation.SpeechDictation])
 * is the other half of the loop: talk into the mic, hear the answer. One
 * engine, no voice picker, no server call — the platform TextToSpeech with
 * the system default voice, the same trade desktop makes for local voices.
 *
 * A new reply FLUSHES the queue rather than joining it: the newest answer is
 * the one a person wants, and a long queue over a fast conversation turns
 * into a newscast of everything the bot ever said. Utterances are chunked
 * because TextToSpeech silently truncates long strings on several engines
 * (getMaxSpeechInputLength is the documented bound, checked at runtime).
 */
class ReplySpeaker(context: Context) {

    private val appContext = context.applicationContext
    private val audioManager = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val utteranceCounter = AtomicInteger(0)

    private var engine: TextToSpeech? = null
    private var initStatus: Int? = null
    private var focusRequest: AudioFocusRequest? = null

    /** True once the engine init callback reported success. */
    val ready: Boolean
        get() = initStatus == TextToSpeech.SUCCESS

    private fun ensureEngine(onReady: (Boolean) -> Unit) {
        val current = engine
        if (current != null) {
            onReady(initStatus == TextToSpeech.SUCCESS)
            return
        }
        engine = TextToSpeech(appContext) { status ->
            initStatus = status
            if (status == TextToSpeech.SUCCESS) {
                // The device locale first; the engine falls back to its own
                // default when that language is not installed.
                runCatching { engine?.language = Locale.getDefault() }
            }
            onReady(status == TextToSpeech.SUCCESS)
        }
    }

    /** Speak one reply, interrupting whatever is still being read. */
    fun speak(text: String) {
        if (text.isBlank()) return
        ensureEngine { ok ->
            if (!ok) return@ensureEngine
            if (!requestFocus()) return@ensureEngine
            val tts = engine ?: return@ensureEngine
            for (chunk in chunked(text)) {
                val id = "omaus-reply-${utteranceCounter.incrementAndGet()}"
                tts.speak(chunk, TextToSpeech.QUEUE_FLUSH, null, id)
            }
        }
    }

    /** Stop playback and release the mic-adjacent audio focus. */
    fun stop() {
        runCatching { engine?.stop() }
        abandonFocus()
    }

    /** Shut the engine down. The speaker is unusable after this. */
    fun release() {
        stop()
        runCatching { engine?.shutdown() }
        engine = null
        initStatus = null
    }

    private fun chunked(text: String): List<String> {
        val max = runCatching { TextToSpeech.getMaxSpeechInputLength() }
            .getOrDefault(DEFAULT_MAX_INPUT_LENGTH)
        if (text.length <= max) return listOf(text)
        return text.chunked(max)
    }

    private fun requestFocus(): Boolean {
        val request = focusRequest ?: AudioFocusRequest.Builder(
            AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK,
        )
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .build()
            .also { focusRequest = it }
        return audioManager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    private fun abandonFocus() {
        val request = focusRequest ?: return
        audioManager.abandonAudioFocusRequest(request)
        focusRequest = null
    }

    companion object {
        private const val DEFAULT_MAX_INPUT_LENGTH = 3_900
    }
}
