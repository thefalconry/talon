package org.talon.companion

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NeuralSpeechPipelineTest {
    private val events = Collections.synchronizedList(mutableListOf<String>())
    private val synthesized = Collections.synchronizedList(mutableListOf<String>())
    private val written = Collections.synchronizedList(mutableListOf<Int>())

    /// Sentences whose synthesis throws.
    private val failOn = Collections.synchronizedSet(mutableSetOf<String>())

    /// When set, synthesis blocks on it (to hold the pipeline mid-utterance).
    @Volatile private var synthGate: CountDownLatch? = null

    private val synth = NeuralSpeechPipeline.Synthesizer { text, _ ->
        synthGate?.await(5, TimeUnit.SECONDS)
        if (text in failOn) throw IllegalStateException("boom")
        synthesized.add(text)
        FloatArray(text.length)
    }

    private val sink = object : NeuralSpeechPipeline.PcmSink {
        override fun write(samples: FloatArray, isCurrent: () -> Boolean): Boolean {
            if (!isCurrent()) return false
            written.add(samples.size)
            return true
        }

        override fun drain(isCurrent: () -> Boolean) {}
        override fun abort() { events.add("abort") }
        override fun reset() {}
        override fun release() {}
    }

    private val listener = object : NeuralSpeechPipeline.Listener {
        override fun onStart(id: String) { events.add("start:$id") }
        override fun onDone(id: String) { events.add("done:$id") }
        override fun onStopped(id: String, interrupted: Boolean) { events.add("stop:$id") }
        override fun onFallback(id: String, remainingText: String, started: Boolean, error: Throwable) {
            events.add("fallback:$id:$started:$remainingText")
        }
    }

    private val pipeline = NeuralSpeechPipeline(synth, sink, listener)

    @After
    fun tearDown() {
        synthGate?.countDown()
        pipeline.shutdown(2_000)
    }

    private fun terminal(id: String) = events.any {
        it == "done:$id" || it == "stop:$id" || it.startsWith("fallback:$id:")
    }

    private fun awaitTerminal(vararg ids: String) {
        val deadline = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < deadline) {
            if (ids.all { terminal(it) }) return
            Thread.sleep(5)
        }
        throw AssertionError("timed out waiting for $ids; events=$events")
    }

    @Test
    fun synthesizesSentenceBySentenceAndReportsInOrder() {
        pipeline.enqueue("a", "First one. Second one.", 1f, flush = true)
        pipeline.enqueue("b", "Third.", 1f, flush = false)
        awaitTerminal("a", "b")

        assertEquals(listOf("First one.", "Second one.", "Third."), synthesized)
        assertEquals(listOf(10, 11, 6), written)
        assertEquals(listOf("start:a", "done:a", "start:b", "done:b"), events.filter { it != "abort" })
    }

    @Test
    fun emptyUtteranceCompletesImmediately() {
        pipeline.enqueue("a", "   ", 1f, flush = true)
        awaitTerminal("a")
        assertEquals(listOf("start:a", "done:a"), events.filter { it != "abort" })
    }

    @Test
    fun flushStopsEverythingQueuedExactlyOnce() {
        val gate = CountDownLatch(1)
        synthGate = gate
        pipeline.enqueue("a", "Held sentence.", 1f, flush = true)
        pipeline.enqueue("b", "Queued behind.", 1f, flush = false)
        pipeline.enqueue("c", "Barge in.", 1f, flush = true)
        synthGate = null
        gate.countDown()
        awaitTerminal("a", "b", "c")

        assertEquals(1, events.count { it == "stop:a" })
        assertEquals(1, events.count { it == "stop:b" })
        assertFalse(events.any { it == "done:a" || it == "done:b" || it == "start:b" })
        assertTrue(events.contains("done:c"))
        assertFalse("stale audio was written", synthesized.contains("Queued behind."))
    }

    @Test
    fun stopReportsPendingAndIgnoresLateAudio() {
        val gate = CountDownLatch(1)
        synthGate = gate
        pipeline.enqueue("a", "Never heard.", 1f, flush = true)
        pipeline.stop()
        gate.countDown()
        assertTrue(pipeline.awaitIdle(2_000))
        Thread.sleep(50)

        assertEquals(listOf("stop:a"), events.filter { it != "abort" })
        assertTrue(written.isEmpty())
    }

    @Test
    fun synthesisFailureFallsBackWithTheRemainingTextInOrder() {
        failOn.add("Broken here.")
        pipeline.enqueue("a", "Fine first. Broken here. And after.", 1f, flush = true)
        pipeline.enqueue("b", "Next utterance.", 1f, flush = false)
        awaitTerminal("a", "b")

        assertTrue(pipeline.failed)
        assertEquals(
            listOf(
                "start:a",
                "fallback:a:true:Broken here. And after.",
                "fallback:b:false:Next utterance.",
            ),
            events.filter { it != "abort" },
        )
        assertEquals(listOf("Fine first."), synthesized)
    }

    @Test
    fun failureOnFirstSentenceIsNotMarkedStarted() {
        failOn.add("Bad.")
        pipeline.enqueue("a", "Bad.", 1f, flush = true)
        awaitTerminal("a")
        assertEquals(listOf("fallback:a:false:Bad."), events.filter { it != "abort" })
    }

    @Test
    fun shutdownStopsPendingAndJoinsWorkers() {
        val gate = CountDownLatch(1)
        synthGate = gate
        pipeline.enqueue("a", "Pending.", 1f, flush = true)
        gate.countDown()
        synthGate = null
        assertTrue(pipeline.shutdown(2_000))
        pipeline.enqueue("late", "Ignored.", 1f, flush = false)
        assertFalse(events.any { it.endsWith(":late") })
    }
}
