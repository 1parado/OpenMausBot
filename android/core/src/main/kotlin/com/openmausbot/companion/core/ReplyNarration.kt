package com.openmausbot.companion.core

/**
 * Which transcript item a reply reader should speak next. Pure logic so the
 * selection rule is unit-testable without an Android device.
 *
 * Deliberately backlog-free: turning the reader on speaks only messages that
 * arrive after it was enabled (the caller seeds [lastSpokenId] with the id of
 * the newest row at toggle time), mirroring desktop's rule that a call must
 * not open by reciting the backlog.
 */
object ReplyNarration {

    /** One speakable reply: a finished bot text message and what to say. */
    data class Speakable(val messageId: String, val text: String)

    /**
     * The newest bot text message in [messages] that has not been spoken yet,
     * or null when there is nothing new. Activity chips, cards, and digests
     * are never spoken — only prose a person would have read.
     */
    fun nextSpeakable(messages: List<Message>, lastSpokenId: String?): Speakable? {
        val lastBotText = messages.lastOrNull { it.role == Message.Role.BOT && it.kind == Message.Kind.TEXT }
            ?.takeIf { !it.text.isNullOrBlank() } ?: return null
        if (lastBotText.id == lastSpokenId) return null
        // Never speak something older than what was already read: a page load
        // or pagination insert must not replay history.
        if (lastSpokenId != null) {
            val spokenIndex = messages.indexOfFirst { it.id == lastSpokenId }
            val speakIndex = messages.indexOfFirst { it.id == lastBotText.id }
            if (speakIndex <= spokenIndex) return null
        }
        return Speakable(messageId = lastBotText.id, text = lastBotText.text!!.trim())
    }
}
