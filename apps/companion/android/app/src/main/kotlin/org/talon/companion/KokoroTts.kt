package org.talon.companion

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build
import android.os.Process
import android.util.Log
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import java.io.File

/**
 * On-device neural voice: Kokoro (82M, int8) run by sherpa-onnx.
 *
 * The model is not bundled — the Dart model manager downloads and verifies
 * it into app storage and hands us the directory. [load] builds the native
 * engine once per voice-mode session (it takes a second or two and a few
 * hundred MB), [speak] queues an utterance on a [NeuralSpeechPipeline], and
 * [release] frees it when voice mode closes.
 *
 * Licensing: sherpa-onnx statically links espeak-ng (GPL-3.0) for
 * phonemization, which makes the distributed Android APK a GPL-3.0 combined
 * work. See NOTICE and docs/companion-voice.md.
 * TODO(sherpa-onnx 2.0): upstream plans to drop espeak-ng
 * (https://github.com/k2-fsa/sherpa-onnx/issues/3731); revisit the APK
 * licence note once Talon moves to a release without it.
 */
class KokoroTts private constructor(
    private val tts: OfflineTts,
    val modelDir: String,
    private val speakerCount: Int,
    attributes: AudioAttributes,
    listener: NeuralSpeechPipeline.Listener,
) {
    companion object {
        private const val TAG = "TalonKokoro"

        /// Files the engine reads; checked before the native load because a
        /// missing file can abort inside sherpa-onnx instead of throwing.
        val REQUIRED_FILES = listOf(
            "model.int8.onnx",
            "voices.bin",
            "tokens.txt",
            "lexicon-us-en.txt",
            "lexicon-zh.txt",
            "espeak-ng-data/phontab",
        )

        /// Whether this device can run the engine at all. The native library
        /// ships for arm64-v8a only (see build.gradle.kts: 32-bit phones and
        /// x86 emulators fall back to Android TTS), and the float AudioTrack
        /// builder needs API 23.
        val deviceSupported: Boolean
            get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
                Process.is64Bit() &&
                Build.SUPPORTED_64_BIT_ABIS.contains("arm64-v8a")

        /// Big cores do the work; past four threads the int8 matmuls stop
        /// scaling on phone SoCs and only steal time from the UI.
        fun defaultThreads(cores: Int = Runtime.getRuntime().availableProcessors()): Int =
            (cores / 2).coerceIn(1, 4)

        /** Missing files under [dir], empty when the model is complete. */
        fun missingFiles(dir: String): List<String> =
            REQUIRED_FILES.filter { name ->
                val file = File(dir, name)
                !file.isFile || file.length() == 0L
            }

        /**
         * Build the engine. Blocking (seconds) — call off the main thread.
         * Throws with a readable message on any failure.
         */
        fun load(
            dir: String,
            threads: Int,
            attributes: AudioAttributes,
            listener: NeuralSpeechPipeline.Listener,
        ): KokoroTts {
            check(deviceSupported) { "Neural voice is not supported on this device" }
            val missing = missingFiles(dir)
            check(missing.isEmpty()) { "Model incomplete, missing: ${missing.joinToString()}" }
            val config = OfflineTtsConfig(
                model = OfflineTtsModelConfig(
                    kokoro = OfflineTtsKokoroModelConfig(
                        model = "$dir/model.int8.onnx",
                        voices = "$dir/voices.bin",
                        tokens = "$dir/tokens.txt",
                        dataDir = "$dir/espeak-ng-data",
                        lexicon = "$dir/lexicon-us-en.txt,$dir/lexicon-zh.txt",
                    ),
                    numThreads = threads,
                    debug = false,
                    provider = "cpu",
                ),
                // One sentence per native call; the pipeline already feeds it
                // sentence by sentence.
                maxNumSentences = 1,
            )
            val started = System.nanoTime()
            val tts = OfflineTts(assetManager = null, config = config)
            val speakers = tts.numSpeakers()
            Log.i(
                TAG,
                "loaded in ${(System.nanoTime() - started) / 1_000_000}ms " +
                    "threads=$threads speakers=$speakers rate=${tts.sampleRate()}",
            )
            return KokoroTts(tts, dir, speakers, attributes, listener)
        }
    }

    @Volatile private var speaker = 0

    private val sink = AudioTrackSink(tts.sampleRate(), attributes)

    private val pipeline = NeuralSpeechPipeline(
        synthesizer = { text, speed ->
            val audio = tts.generate(text = text, sid = speaker, speed = speed)
            check(audio.samples.isNotEmpty() || text.none { it.isLetterOrDigit() }) {
                "Kokoro produced no audio"
            }
            audio.samples
        },
        sink = sink,
        listener = listener,
        log = { Log.w(TAG, it) },
    )

    /// True once synthesis has failed: remaining speech went to the fallback.
    val failed: Boolean get() = pipeline.failed

    fun speak(id: String, text: String, speakerId: Int, speed: Float, flush: Boolean) {
        // The speaker is engine-wide; switching mid-reply only affects
        // sentences synthesized afterwards, which is what a settings change
        // during playback should do anyway.
        speaker = speakerId.coerceIn(0, (speakerCount - 1).coerceAtLeast(0))
        pipeline.enqueue(id, text, speed.coerceIn(0.5f, 2.0f), flush)
    }

    fun stop() = pipeline.stop()

    /** Blocking (waits for an in-flight synthesis) — call off the main thread. */
    fun release() {
        if (pipeline.shutdown()) {
            tts.free()
        } else {
            // A native call is still running on the synthesis thread; freeing
            // the model under it would crash. Leak it instead — the process
            // reclaims it, and this only happens on a wedged engine.
            Log.w(TAG, "synthesis still busy at release; leaking native engine")
        }
    }
}

/**
 * Streams float PCM to an [AudioTrack] with the same attributes Android TTS
 * speech uses (USAGE_MEDIA + CONTENT_TYPE_SPEECH), so routing, volume and
 * audio focus behave identically across the two engines.
 *
 * Owned by the pipeline's playback thread; only [abort] is called from other
 * threads (pause + flush, which also interrupts a blocking write).
 */
private class AudioTrackSink(
    private val sampleRate: Int,
    private val attributes: AudioAttributes,
) : NeuralSpeechPipeline.PcmSink {
    private val lock = Any()
    private var track: AudioTrack? = null
    private var framesWritten = 0L
    private var bufferFrames = 0
    private var priorityRaised = false

    private fun ensureTrack(): AudioTrack {
        synchronized(lock) { track?.let { return it } }
        if (!priorityRaised) {
            Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
            priorityRaised = true
        }
        val format = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
            .setSampleRate(sampleRate)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build()
        val minBytes = AudioTrack.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_FLOAT,
        )
        // ~250ms of headroom: enough to ride out scheduling hiccups between
        // sentences, small enough that stop/barge-in feels immediate.
        val bytes = maxOf(minBytes * 2, sampleRate / 4 * 4)
        val created = AudioTrack.Builder()
            .setAudioAttributes(attributes)
            .setAudioFormat(format)
            .setBufferSizeInBytes(bytes)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        bufferFrames = created.bufferSizeInFrames
        framesWritten = 0
        created.play()
        synchronized(lock) { track = created }
        return created
    }

    override fun write(samples: FloatArray, isCurrent: () -> Boolean): Boolean {
        val out = ensureTrack()
        var offset = 0
        while (offset < samples.size) {
            if (!isCurrent()) return false
            val n = out.write(samples, offset, samples.size - offset, AudioTrack.WRITE_BLOCKING)
            if (n < 0) {
                Log.w("TalonKokoro", "AudioTrack write failed: $n")
                return false
            }
            offset += n
            framesWritten += n
        }
        return isCurrent()
    }

    override fun drain(isCurrent: () -> Boolean) {
        val out = synchronized(lock) { track } ?: return
        if (framesWritten == 0L) return
        // A streaming track only starts once its buffer has filled, so a
        // short tail could sit unplayed: push a buffer of silence behind it.
        val target = framesWritten
        val silence = FloatArray(bufferFrames.coerceAtLeast(sampleRate / 10))
        write(silence, isCurrent)
        val deadline = System.currentTimeMillis() + 2_000 +
            (target * 1000 / sampleRate)
        while (isCurrent() && System.currentTimeMillis() < deadline) {
            val head = out.playbackHeadPosition.toLong() and 0xffffffffL
            if (head >= target) return
            Thread.sleep(15)
        }
    }

    override fun abort() {
        synchronized(lock) {
            track?.let {
                runCatching {
                    it.pause()
                    it.flush()
                }
            }
        }
    }

    override fun reset() {
        val old = synchronized(lock) { track.also { track = null } }
        old?.let { runCatching { it.release() } }
        framesWritten = 0
    }

    override fun release() = reset()
}
