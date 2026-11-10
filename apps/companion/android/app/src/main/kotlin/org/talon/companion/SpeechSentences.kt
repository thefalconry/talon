package org.talon.companion

/**
 * Sentence splitter for the on-device neural voice.
 *
 * Kokoro synthesizes a whole input before returning a single sample, so the
 * time to first audio is the time to synthesize the first piece of text.
 * Splitting each utterance into sentences and playing sentence one while
 * sentence two is still being synthesized keeps that latency to roughly one
 * short sentence, whatever the length of the reply.
 *
 * Pure Kotlin (no Android types) so it runs as a plain JVM unit test.
 */
object SpeechSentences {
    /// Upper bound for one synthesis call. Kokoro's context is ~510 phoneme
    /// tokens; 280 characters of English stays comfortably under that, and a
    /// longer run would also delay the first audio.
    const val DEFAULT_MAX_CHARS = 280

    /// Words that end in a full stop without ending the sentence. Lower-case,
    /// without the trailing dot.
    private val ABBREVIATIONS = setOf(
        "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "mt", "vs", "etc",
        "e.g", "i.e", "approx", "no", "fig", "inc", "ltd", "co", "dept", "est",
        "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct",
        "nov", "dec",
    )

    private val WHITESPACE = Regex("\\s+")

    /// Sentence terminators, optionally followed by closing quotes/brackets.
    private val BOUNDARY = Regex("[.!?…]+[\"'”’)\\]]*(?=\\s)|[。！？]+")

    fun split(text: String, maxChars: Int = DEFAULT_MAX_CHARS): List<String> {
        val normalized = text.replace(WHITESPACE, " ").trim()
        if (normalized.isEmpty()) return emptyList()

        val raw = mutableListOf<String>()
        var start = 0
        for (match in BOUNDARY.findAll(normalized)) {
            val end = match.range.last + 1
            val candidate = normalized.substring(start, end).trim()
            if (candidate.isEmpty() || isFalseBoundary(candidate)) continue
            raw.add(candidate)
            start = end
        }
        val tail = normalized.substring(start).trim()
        if (tail.isNotEmpty()) raw.add(tail)

        // A piece with fewer than two letters or digits ("1.", "-", "…") is a
        // list marker or stray punctuation, not something worth a synthesis
        // call of its own: fold it into the sentence that follows.
        val merged = mutableListOf<String>()
        var carry = ""
        for (piece in raw) {
            val joined = if (carry.isEmpty()) piece else "$carry $piece"
            if (joined.count { it.isLetterOrDigit() } < 2) {
                carry = joined
            } else {
                merged.add(joined)
                carry = ""
            }
        }
        if (carry.isNotEmpty()) {
            if (merged.isEmpty()) merged.add(carry) else merged[merged.lastIndex] += " $carry"
        }

        return merged.flatMap { hardWrap(it, maxChars) }
    }

    /// The candidate ends in "Dr." / "e.g." / an initial ("J.") rather than at
    /// a real sentence end.
    private fun isFalseBoundary(candidate: String): Boolean {
        if (!candidate.endsWith('.')) return false
        val lastWord = candidate.trimEnd('.').substringAfterLast(' ')
        if (lastWord.length == 1 && lastWord[0].isLetter()) return true
        return lastWord.lowercase() in ABBREVIATIONS
    }

    /// Break an over-long sentence at clause punctuation, then at a word
    /// boundary, so no synthesis call exceeds [maxChars].
    internal fun hardWrap(sentence: String, maxChars: Int): List<String> {
        if (sentence.length <= maxChars) return listOf(sentence)
        val out = mutableListOf<String>()
        var rest = sentence
        while (rest.length > maxChars) {
            val window = rest.substring(0, maxChars)
            var cut = maxOf(
                window.lastIndexOf(", "),
                window.lastIndexOf("; "),
                window.lastIndexOf(": "),
            )
            if (cut < maxChars / 3) cut = window.lastIndexOf(' ')
            if (cut <= 0) cut = maxChars - 1
            out.add(rest.substring(0, cut + 1).trim())
            rest = rest.substring(cut + 1).trim()
        }
        if (rest.isNotEmpty()) out.add(rest)
        return out
    }
}
