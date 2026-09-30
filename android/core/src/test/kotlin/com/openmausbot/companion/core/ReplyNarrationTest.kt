package com.openmausbot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ReplyNarrationTest {

    private fun message(
        id: String,
        role: Message.Role,
        kind: Message.Kind = Message.Kind.TEXT,
        text: String? = "body",
    ): Message = Message(id = id, at = 0.0, role = role, kind = kind, text = text)

    @Test
    fun `speaks the newest bot text`() {
        val messages = listOf(
            message("u1", Message.Role.USER),
            message("b1", Message.Role.BOT, text = "first"),
            message("b2", Message.Role.BOT, text = "second"),
        )
        assertEquals(ReplyNarration.Speakable("b2", "second"), ReplyNarration.nextSpeakable(messages, "b1"))
    }

    @Test
    fun `stays quiet when nothing new arrived`() {
        val messages = listOf(message("u1", Message.Role.USER), message("b1", Message.Role.BOT, text = "first"))
        assertNull(ReplyNarration.nextSpeakable(messages, "b1"))
    }

    @Test
    fun `never replays history older than the spoken marker`() {
        val messages = listOf(
            message("b1", Message.Role.BOT, text = "old"),
            message("u1", Message.Role.USER),
            message("u2", Message.Role.USER, text = "hi"),
        )
        assertNull(ReplyNarration.nextSpeakable(messages, "b1"))
    }

    @Test
    fun `skips blank bot messages`() {
        val messages = listOf(
            message("u1", Message.Role.USER),
            message("b1", Message.Role.BOT, text = "   "),
        )
        assertNull(ReplyNarration.nextSpeakable(messages, null))
    }

    @Test
    fun `ignores user messages activity and cards`() {
        val messages = listOf(
            message("u1", Message.Role.USER, text = "question"),
            message("a1", Message.Role.BOT, kind = Message.Kind.ACTIVITY, text = null),
            message("c1", Message.Role.BOT, kind = Message.Kind.OPTIONS, text = null),
        )
        assertNull(ReplyNarration.nextSpeakable(messages, null))
    }
}
