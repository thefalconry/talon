package org.talon.companion

import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.TimeUnit

/**
 * Sentence-pipelined playback for an on-device neural voice.
 *
 * Two worker threads:
 *   * the synthesis thread takes queued utterances, splits each into
 *     sentences ([SpeechSentences]) and synthesizes them one at a time;
 *   * the playback thread writes finished sentences to a [PcmSink].
 * So sentence N+1 is being synthesized while sentence N plays, and the first
 * audio of a reply arrives after one sentence of synthesis, not the whole
 * reply.
 *
 * Every utterance ends in exactly one terminal callback — [Listener.onDone],
 * [Listener.onStopped] or [Listener.onFallback] — matching the
 * `tts.done` / `tts.stop` contract the Dart voice session already relies on
 * for Android's own engine.
 *
 * When synthesis throws, the pipeline latches into a failed state: the
 * failing utterance (from the failed sentence on) and every utterance queued
 * behind it are handed to [Listener.onFallback], in order and only after the
 * audio already queued has played, so the caller can speak them with another
 * engine without the two voices overlapping.
 *
 * Pure Kotlin (no Android types) so the ordering rules are covered by plain
 * JVM unit tests with a fake synthesizer and sink.
 */
class NeuralSpeechPipeline(
    private val synthesizer: Synthesizer,
    private val sink: PcmSink,
    private val listener: Listener,
    private val splitter: (String) -> List<String> = { SpeechSentences.split(it) },
    private val log: (String) -> Unit = {},
) {
    fun interface Synthesizer {
        /** Synthesize one sentence. Throwing marks the voice as failed. */
        fun synthesize(text: String, speed: Float): FloatArray
    }

    interface PcmSink {
        /**
         * Write [samples], blocking while the device buffer is full. Returns
         * false when playback was aborted part-way ([isCurrent] went false).
         */
        fun write(samples: FloatArray, isCurrent: () -> Boolean): Boolean

        /** Play out everything written so far (blocking). */
        fun drain(isCurrent: () -> Boolean)

        /** Silence playback now. Called from any thread. */
        fun abort()

        /** Start the next write on a fresh output (after an [abort]). */
        fun reset()

        fun release()
    }

    interface Listener {
        fun onStart(id: String)
        fun onDone(id: String)
        fun onStopped(id: String, interrupted: Boolean)

        /**
         * Synthesis failed: speak [remainingText] some other way. [started]
         * is true when part of the utterance was already audible.
         */
        fun onFallback(id: String, remainingText: String, started: Boolean, error: Throwable)
    }

    private class Request(val gen: Int, val id: String, val text: String, val speed: Float)

    private sealed class Segment(val gen: Int, val id: String) {
        class Audio(
            gen: Int,
            id: String,
            val samples: FloatArray,
            val first: Boolean,
            val last: Boolean,
        ) : Segment(gen, id)

        class Fallback(gen: Int, id: String, val text: String, val error: Throwable) :
            Segment(gen, id)

        object Stop : Segment(-1, "")
    }

    private val lock = Any()
    private val requests = LinkedBlockingDeque<Request>()
    private val segments = LinkedBlockingDeque<Segment>()

    /// Utterances accepted but not yet terminated, in order.
    private val pending = LinkedHashSet<String>()
    private val started = HashSet<String>()

    @Volatile private var generation = 0
    @Volatile private var running = true
    @Volatile private var failure: Throwable? = null
    private var sinkGeneration = -1

    private val synthThread = Thread({ synthLoop() }, "talon-tts-synth").apply {
        isDaemon = true
        priority = Thread.NORM_PRIORITY + 1
    }
    private val playThread = Thread({ playLoop() }, "talon-tts-play").apply {
        isDaemon = true
        priority = Thread.MAX_PRIORITY
    }

    init {
        synthThread.start()
        playThread.start()
    }

    /** True once synthesis has failed; later utterances all fall back. */
    val failed: Boolean get() = failure != null

    /**
     * Queue [text] under utterance [id]. With [flush], anything playing or
     * queued is stopped first (its utterances report `onStopped`).
     */
    fun enqueue(id: String, text: String, speed: Float, flush: Boolean) {
        if (flush) stop()
        val gen: Int
        synchronized(lock) {
            if (!running) return
            gen = generation
            pending.add(id)
        }
        requests.put(Request(gen, id, text, speed))
    }

    /** Stop everything: silence now, report every pending utterance stopped. */
    fun stop() {
        val stopped: List<String>
        synchronized(lock) {
            generation++
            requests.clear()
            segments.clear()
            stopped = pending.toList()
            pending.clear()
            started.clear()
        }
        sink.abort()
        for (id in stopped) listener.onStopped(id, true)
    }

    /**
     * Stop and tear down. Waits (bounded) for an in-flight synthesis call to
     * return so the caller can free the native model afterwards. Returns
     * false when the synthesis thread is still busy after [timeoutMs] — the
     * model must then be leaked rather than freed under it.
     */
    fun shutdown(timeoutMs: Long = 10_000): Boolean {
        stop()
        synchronized(lock) { running = false }
        requests.put(Request(-1, "", "", 1f))
        segments.put(Segment.Stop)
        synthThread.join(timeoutMs)
        playThread.join(1_000)
        sink.release()
        return !synthThread.isAlive
    }

    private fun isCurrent(gen: Int) = running && generation == gen

    // ── Synthesis thread ────────────────────────────────────────────────────

    private fun synthLoop() {
        while (true) {
            val request = try {
                requests.take()
            } catch (_: InterruptedException) {
                return
            }
            if (!running) return
            if (!isCurrent(request.gen)) continue
            synthesize(request)
        }
    }

    private fun synthesize(request: Request) {
        val previous = failure
        if (previous != null) {
            segments.put(Segment.Fallback(request.gen, request.id, request.text, previous))
            return
        }
        val sentences = splitter(request.text)
        if (sentences.isEmpty()) {
            segments.put(Segment.Audio(request.gen, request.id, FloatArray(0), true, true))
            return
        }
        for ((index, sentence) in sentences.withIndex()) {
            if (!isCurrent(request.gen)) return
            val samples = try {
                synthesizer.synthesize(sentence, request.speed)
            } catch (t: Throwable) {
                log("neural synthesis failed: ${t.message}")
                failure = t
                val rest = sentences.drop(index).joinToString(" ")
                segments.put(Segment.Fallback(request.gen, request.id, rest, t))
                return
            }
            segments.put(
                Segment.Audio(
                    request.gen,
                    request.id,
                    samples,
                    first = index == 0,
                    last = index == sentences.lastIndex,
                ),
            )
        }
    }

    // ── Playback thread ─────────────────────────────────────────────────────

    private fun playLoop() {
        while (true) {
            val segment = try {
                segments.take()
            } catch (_: InterruptedException) {
                return
            }
            if (segment === Segment.Stop || !running) return
            if (!isCurrent(segment.gen)) continue
            if (segment.gen != sinkGeneration) {
                // First audio after a stop: the old output was aborted
                // mid-write, so start clean.
                sink.reset()
                sinkGeneration = segment.gen
            }
            val current = { isCurrent(segment.gen) }
            when (segment) {
                is Segment.Audio -> play(segment, current)
                is Segment.Fallback -> {
                    // Let what is already queued finish so the fallback voice
                    // does not talk over it.
                    sink.drain(current)
                    val wasStarted: Boolean? = synchronized(lock) {
                        if (current() && pending.remove(segment.id)) {
                            started.remove(segment.id)
                        } else {
                            null
                        }
                    }
                    if (wasStarted != null) {
                        listener.onFallback(segment.id, segment.text, wasStarted, segment.error)
                    }
                }
                Segment.Stop -> return
            }
        }
    }

    private fun play(segment: Segment.Audio, current: () -> Boolean) {
        if (segment.first) {
            val announce = synchronized(lock) {
                current() && segment.id in pending && started.add(segment.id)
            }
            if (announce) listener.onStart(segment.id)
        }
        if (segment.samples.isNotEmpty() && !sink.write(segment.samples, current)) return
        if (!segment.last) return
        // Gapless hand-off: when the next sentence is already synthesized the
        // device buffer holds at most a fraction of a second, so report done
        // now and keep writing. Otherwise wait for the audio to actually end —
        // the voice session re-opens the microphone on the last `done`.
        if (segments.peekFirst() == null) sink.drain(current)
        val finished = synchronized(lock) {
            if (current() && pending.remove(segment.id)) {
                started.remove(segment.id)
                true
            } else {
                false
            }
        }
        if (finished) listener.onDone(segment.id)
    }

    /** Test seam: wait until both queues are empty and nothing is pending. */
    internal fun awaitIdle(timeoutMs: Long): Boolean {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        while (System.nanoTime() < deadline) {
            synchronized(lock) { if (pending.isEmpty()) return true }
            Thread.sleep(5)
        }
        return false
    }
}
