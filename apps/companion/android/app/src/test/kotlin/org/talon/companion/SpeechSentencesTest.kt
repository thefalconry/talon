package org.talon.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechSentencesTest {
    @Test
    fun splitsOnSentenceTerminators() {
        assertEquals(
            listOf("Hello there.", "How are you?", "Great!"),
            SpeechSentences.split("Hello there. How are you? Great!"),
        )
    }

    @Test
    fun emptyAndBlankInputYieldNothing() {
        assertEquals(emptyList<String>(), SpeechSentences.split(""))
        assertEquals(emptyList<String>(), SpeechSentences.split("   \n\t "))
    }

    @Test
    fun keepsTextWithoutTerminatorAsOneSentence() {
        assertEquals(listOf("no punctuation here"), SpeechSentences.split("no punctuation here"))
    }

    @Test
    fun collapsesWhitespaceAndNewlines() {
        assertEquals(
            listOf("One line.", "Two lines."),
            SpeechSentences.split("One\n   line.\n\nTwo   lines."),
        )
    }

    @Test
    fun doesNotSplitAbbreviationsInitialsOrDecimals() {
        assertEquals(
            listOf("Dr. Smith paid 3.5 dollars, e.g. a coffee.", "J. R. R. Tolkien agreed."),
            SpeechSentences.split("Dr. Smith paid 3.5 dollars, e.g. a coffee. J. R. R. Tolkien agreed."),
        )
    }

    @Test
    fun keepsClosingQuotesWithTheirSentence() {
        assertEquals(
            listOf("He said \"stop.\"", "Then he left."),
            SpeechSentences.split("He said \"stop.\" Then he left."),
        )
    }

    @Test
    fun foldsListMarkersIntoTheFollowingSentence() {
        assertEquals(
            listOf("1. Buy milk.", "2. Walk the dog."),
            SpeechSentences.split("1. Buy milk. 2. Walk the dog."),
        )
    }

    @Test
    fun splitsChinesePunctuationWithoutSpaces() {
        assertEquals(listOf("你好。", "今天怎么样？"), SpeechSentences.split("你好。今天怎么样？"))
    }

    @Test
    fun hardWrapsOverlongSentencesAtClausesThenWords() {
        val clause = "word ".repeat(30).trim()
        val long = "$clause, $clause, $clause."
        val pieces = SpeechSentences.split(long, maxChars = 200)
        assertTrue(pieces.size >= 2)
        pieces.forEach { assertTrue("too long: ${it.length}", it.length <= 200) }
        assertEquals(long.replace(" ", ""), pieces.joinToString("").replace(" ", ""))

        val noBreaks = "x".repeat(450)
        val forced = SpeechSentences.split(noBreaks, maxChars = 200)
        assertEquals(listOf(200, 200, 50), forced.map { it.length })
    }
}
