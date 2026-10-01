package org.talon.companion

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import java.util.Locale
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * Native half of the companion's voice mode: on-device speech-to-text
 * (android.speech.SpeechRecognizer), text-to-speech (android.speech.tts),
 * the RECORD_AUDIO runtime permission, and the "default digital assistant"
 * role plumbing (detection + a jump into system settings + assist-gesture
 * launches).
 *
 * Hand-rolled over the pub plugins (speech_to_text / flutter_tts) on purpose:
 * this app only ships voice on Android, the two platform APIs are small, and
 * owning the channel means no third-party AGP/embedding drift in the build —
 * the same reasoning as ShizukuBridge.
 *
 * Dart ↔ native protocol (channel `talon/voice`):
 *   Dart → native: isSttAvailable, hasMicPermission, requestMicPermission,
 *     startListening{sessionId}, stopListening{sessionId},
 *     cancelListening{sessionId}, speak{text,id,rate,pitch,voice,flush},
 *     stopSpeaking, listVoices,
 *     isDefaultAssistant, openAssistantSettings, consumeAssistLaunch
 *   native → Dart (invokeMethod, fire-and-forget):
 *     stt.ready{sessionId}, stt.partial{sessionId,text},
 *     stt.final{sessionId,text}, stt.rms{sessionId,level},
 *     stt.end{sessionId}, stt.error{sessionId,code,message},
 *     tts.start{id}, tts.done{id}, tts.error{id,code}, tts.stop{id},
 *     assist.launch.
 */
class VoiceBridge(
    private val channel: MethodChannel,
    private val activity: Activity,
) {
    companion object {
        const val CHANNEL = "talon/voice"
        private const val TAG = "TalonVoice"
        private const val PERMISSION_REQUEST = 7431
        private const val GOOGLE_TTS = "com.google.android.tts"

        /// How long focus is kept after an utterance ends, so the next queued
        /// chunk inherits the same hold instead of re-ducking the mix.
        private const val FOCUS_RELEASE_GRACE_MS = 700L
    }

    private val context: Context get() = activity.applicationContext
    private val main = Handler(Looper.getMainLooper())

    private var recognizer: SpeechRecognizer? = null
    private var sttSessionId: String? = null
    private var speechEnded = false

    private var tts: TextToSpeech? = null
    private var ttsReady = false
    /// Best voice for this device, resolved once per engine instance.
    /// Recomputing it per utterance meant walking the engine's whole voice set
    /// (hundreds of Voice objects) on the way into every chunk of speech.
    private var autoVoice: Voice? = null
    private var autoVoiceResolved = false
    private var appliedVoiceName: String? = null
    private var voiceApplied = false
    private var appliedRate = Float.NaN
    private var appliedPitch = Float.NaN
    private var triedFallbackEngine = false
    private val pendingTtsInit = mutableListOf<(Boolean) -> Unit>()
    private var activeTtsId: String? = null
    private val audioManager =
        context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var ttsFocusRequest: AudioFocusRequest? = null
    private var focusRelease: Runnable? = null
    private var disposed = false

    private var pendingPermission: MethodChannel.Result? = null

    /// Set when the activity was (re)launched by the system assist gesture;
    /// cleared when Dart consumes it. The warm path additionally pushes an
    /// `assist.launch` event, so a running UI reacts immediately while a
    /// cold-started one still finds the flag when it boots.
    @Volatile private var assistPending = false

    /// Rate-limit for stt.rms events (onRmsChanged fires ~every 40ms and the
    /// UI only needs ~20fps of level data).
    private var lastRmsAt = 0L

    init {
        channel.setMethodCallHandler { call, result -> onCall(call, result) }
    }

    // ── Channel dispatch ────────────────────────────────────────────────────

    private fun onCall(call: MethodCall, result: MethodChannel.Result) {
        try {
            when (call.method) {
                "isSttAvailable" ->
                    result.success(SpeechRecognizer.isRecognitionAvailable(context))
                "hasMicPermission" -> result.success(hasMicPermission())
                "requestMicPermission" -> requestMicPermission(result)
                "startListening" -> startListening(
                    call.argument<String>("sessionId") ?: "",
                    result,
                )
                "stopListening" -> stopListening(
                    call.argument<String>("sessionId") ?: "",
                    result,
                )
                "cancelListening" -> cancelListening(
                    call.argument<String>("sessionId") ?: "",
                    result,
                )
                "speak" -> speak(
                    call.argument<String>("text") ?: "",
                    call.argument<String>("id") ?: "utt",
                    (call.argument<Number>("rate") ?: 1.0).toFloat(),
                    (call.argument<Number>("pitch") ?: 1.0).toFloat(),
                    call.argument<String>("voice"),
                    call.argument<Boolean>("flush") ?: true,
                    result,
                )
                "stopSpeaking" -> {
                    activeTtsId = null
                    tts?.stop()
                    abandonTtsAudioFocus()
                    result.success(true)
                }
                "listVoices" -> listVoices(result)
                "isDefaultAssistant" -> result.success(isDefaultAssistant())
                "openAssistantSettings" -> result.success(openAssistantSettings())
                "consumeAssistLaunch" -> {
                    val was = assistPending
                    assistPending = false
                    result.success(was)
                }
                else -> result.notImplemented()
            }
        } catch (e: Exception) {
            result.error("voice_error", e.message, null)
        }
    }

    // ── Mic permission ──────────────────────────────────────────────────────

    private fun hasMicPermission(): Boolean =
        context.checkPermission(
            Manifest.permission.RECORD_AUDIO,
            android.os.Process.myPid(),
            android.os.Process.myUid(),
        ) == PackageManager.PERMISSION_GRANTED

    private fun requestMicPermission(result: MethodChannel.Result) {
        if (hasMicPermission()) {
            result.success(true)
            return
        }
        if (Build.VERSION.SDK_INT < 23) {
            // Pre-M permissions are install-time; not granted means never.
            result.success(false)
            return
        }
        // One in-flight request at a time; a duplicate resolves as denied
        // rather than leaking the earlier Result.
        pendingPermission?.success(false)
        pendingPermission = result
        activity.requestPermissions(
            arrayOf(Manifest.permission.RECORD_AUDIO),
            PERMISSION_REQUEST,
        )
    }

    /** Routed from MainActivity. Returns true when the callback was ours. */
    fun onRequestPermissionsResult(
        requestCode: Int,
        grantResults: IntArray,
    ): Boolean {
        if (requestCode != PERMISSION_REQUEST) return false
        pendingPermission?.success(
            grantResults.isNotEmpty() &&
                grantResults[0] == PackageManager.PERMISSION_GRANTED,
        )
        pendingPermission = null
        return true
    }

    // ── Speech to text ──────────────────────────────────────────────────────

    private fun startListening(
        sessionId: String,
        result: MethodChannel.Result,
    ) {
        if (sessionId.isBlank()) {
            result.error("invalid_session", "Missing recognition session ID", null)
            return
        }
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            result.error("stt_unavailable", "No speech recognition service", null)
            return
        }
        if (!hasMicPermission()) {
            result.error("no_permission", "RECORD_AUDIO not granted", null)
            return
        }
        // Invalidate the previous generation before touching it. Some OEM
        // recognizers deliver a terminal callback during cancel/destroy; the
        // per-generation listener below drops it instead of poisoning the new
        // session.
        destroyRecognizer(cancel = true)
        val r = SpeechRecognizer.createSpeechRecognizer(context)
        r.setRecognitionListener(recognitionListener(sessionId, r))
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(
                RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
            )
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
        }
        recognizer = r
        sttSessionId = sessionId
        speechEnded = false
        lastRmsAt = 0L
        try {
            r.startListening(intent)
            Log.i(TAG, "stt start $sessionId")
            result.success(true)
        } catch (e: Exception) {
            completeRecognizer(sessionId, r)
            result.error("stt_start_failed", e.message, null)
        }
    }

    private fun stopListening(
        sessionId: String,
        result: MethodChannel.Result,
    ) {
        val r = recognizer
        if (r == null || sttSessionId != sessionId) {
            result.success(false)
            return
        }
        // Once Android has called onEndOfSpeech it is already finalizing.
        // Calling stopListening again can itself produce ERROR_CLIENT.
        if (!speechEnded) {
            try {
                r.stopListening()
            } catch (e: Exception) {
                result.error("stt_stop_failed", e.message, null)
                return
            }
        }
        result.success(true)
    }

    private fun cancelListening(
        sessionId: String,
        result: MethodChannel.Result,
    ) {
        if (sttSessionId != sessionId) {
            result.success(false)
            return
        }
        destroyRecognizer(cancel = true)
        result.success(true)
    }

    private fun destroyRecognizer(cancel: Boolean) {
        val old = recognizer
        recognizer = null
        sttSessionId = null
        speechEnded = false
        old?.let {
            try {
                if (cancel) it.cancel()
            } catch (_: Exception) {
                // Already terminal.
            }
            try {
                it.destroy()
            } catch (_: Exception) {
                // Already dead — nothing to release.
            }
        }
    }

    private fun isCurrent(sessionId: String, r: SpeechRecognizer): Boolean =
        sttSessionId == sessionId && recognizer === r

    private fun completeRecognizer(sessionId: String, r: SpeechRecognizer) {
        if (!isCurrent(sessionId, r)) return
        recognizer = null
        sttSessionId = null
        speechEnded = false
        try {
            // The recognition session is already terminal. destroy() releases
            // the service connection; an explicit cancel here causes spurious
            // client/audio errors on several OEM recognizers.
            r.destroy()
        } catch (_: Exception) {
            // Already released.
        }
    }

    private fun recognitionListener(
        sessionId: String,
        r: SpeechRecognizer,
    ) = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {
            if (isCurrent(sessionId, r)) {
                emit("stt.ready", mapOf("sessionId" to sessionId))
            }
        }

        override fun onBeginningOfSpeech() {}
        override fun onBufferReceived(buffer: ByteArray?) {}

        override fun onRmsChanged(rmsdB: Float) {
            if (!isCurrent(sessionId, r)) return
            val now = System.currentTimeMillis()
            if (now - lastRmsAt < 50) return
            lastRmsAt = now
            // Empirically SpeechRecognizer reports roughly -2..10 dB.
            val level = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f)
            emit(
                "stt.rms",
                mapOf("sessionId" to sessionId, "level" to level.toDouble()),
            )
        }

        override fun onEndOfSpeech() {
            if (!isCurrent(sessionId, r)) return
            speechEnded = true
            emit("stt.end", mapOf("sessionId" to sessionId))
        }

        override fun onPartialResults(partialResults: Bundle?) {
            if (!isCurrent(sessionId, r)) return
            val text = partialResults
                ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                ?.firstOrNull() ?: return
            if (text.isNotBlank()) {
                emit(
                    "stt.partial",
                    mapOf("sessionId" to sessionId, "text" to text),
                )
            }
        }

        override fun onResults(results: Bundle?) {
            if (!isCurrent(sessionId, r)) return
            val text = results
                ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                ?.firstOrNull()
                .orEmpty()
            completeRecognizer(sessionId, r)
            if (text.isBlank()) {
                // Recognizer finished with nothing usable — surface as the
                // standard no-match code so Dart's retry logic has one path.
                emit(
                    "stt.error",
                    mapOf(
                        "sessionId" to sessionId,
                        "code" to SpeechRecognizer.ERROR_NO_MATCH,
                        "message" to "No speech recognized",
                    ),
                )
            } else {
                emit(
                    "stt.final",
                    mapOf("sessionId" to sessionId, "text" to text),
                )
            }
        }

        override fun onError(error: Int) {
            Log.i(TAG, "stt error $error (${sttErrorMessage(error)})")
            if (!isCurrent(sessionId, r)) return
            completeRecognizer(sessionId, r)
            emit(
                "stt.error",
                mapOf(
                    "sessionId" to sessionId,
                    "code" to error,
                    "message" to sttErrorMessage(error),
                ),
            )
        }

        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    private fun sttErrorMessage(code: Int): String = when (code) {
        SpeechRecognizer.ERROR_AUDIO -> "Audio recording error"
        SpeechRecognizer.ERROR_CLIENT -> "Client error"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Missing permission"
        SpeechRecognizer.ERROR_NETWORK -> "Network error"
        SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Network timeout"
        SpeechRecognizer.ERROR_NO_MATCH -> "No speech recognized"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Recognizer busy"
        SpeechRecognizer.ERROR_SERVER -> "Recognition server error"
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "No speech heard"
        SpeechRecognizer.ERROR_TOO_MANY_REQUESTS -> "Recognition temporarily throttled"
        SpeechRecognizer.ERROR_SERVER_DISCONNECTED -> "Recognition service disconnected"
        SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED -> "Speech language not supported"
        SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> "Speech language unavailable"
        else -> "Speech recognition error $code"
    }

    // ── Text to speech ──────────────────────────────────────────────────────

    private fun ensureTts(onReady: (Boolean) -> Unit) {
        if (disposed) {
            onReady(false)
            return
        }
        if (ttsReady) {
            onReady(true)
            return
        }
        pendingTtsInit.add(onReady)
        if (tts != null) return // init already in flight
        tts = createTts(engine = null)
    }

    /// Build a TextToSpeech bound to [engine] (null = the user's system
    /// default) and settle the pending `ensureTts` callbacks when it reports.
    ///
    /// If the default engine fails to initialize we retry once against Google's
    /// engine when it is installed: a broken or voice-less default engine is
    /// the single most common cause of "voice mode sounds terrible / says
    /// nothing" reports, and the fallback is strictly better than silence. A
    /// working default engine is never overridden — the user's choice wins.
    private fun createTts(engine: String?): TextToSpeech {
        lateinit var instance: TextToSpeech
        instance = TextToSpeech(context, { status ->
            main.post {
                if (disposed) {
                    instance.shutdown()
                    if (tts === instance) tts = null
                    settleTtsInit(false)
                    return@post
                }
                val ok = status == TextToSpeech.SUCCESS
                if (!ok && !triedFallbackEngine) {
                    val fallback = installedFallbackEngine()
                    if (fallback != null && fallback != engine) {
                        triedFallbackEngine = true
                        instance.shutdown()
                        tts = createTts(fallback)
                        return@post
                    }
                }
                Log.i(
                    TAG,
                    "tts init ${if (ok) "ok" else "failed"} " +
                        "engine=${engine ?: "default"}",
                )
                ttsReady = ok
                if (ok) {
                    resetVoiceCache()
                    instance.setOnUtteranceProgressListener(utteranceListener)
                    instance.setAudioAttributes(speechAudioAttributes())
                }
                settleTtsInit(ok)
            }
        }, engine)
        return instance
    }

    private fun settleTtsInit(ready: Boolean) {
        val waiting = pendingTtsInit.toList()
        pendingTtsInit.clear()
        for (cb in waiting) cb(ready)
    }

    private fun resetVoiceCache() {
        autoVoice = null
        autoVoiceResolved = false
        appliedVoiceName = null
        voiceApplied = false
        appliedRate = Float.NaN
        appliedPitch = Float.NaN
    }

    private fun installedFallbackEngine(): String? =
        GOOGLE_TTS.takeIf {
            runCatching {
                context.packageManager.getPackageInfo(it, 0)
            }.isSuccess
        }

    /// The engine's best voice for this device, or null to keep whatever the
    /// engine defaults to.
    ///
    /// Rank by engine-reported quality first: the old order put country ahead
    /// of quality, so a low-quality en-IE/en-GB variant could beat a very-high
    /// en-US one, and Google's engine reports equal quality for most variants
    /// so ties fell through to "lowest latency" — the smallest, most robotic
    /// model. Among equal-quality voices, prefer the voice the user picked in
    /// system TTS settings (`defaultVoice`), then a matching country, then
    /// locally synthesized over network-only (a network voice stalls or
    /// silently downgrades on a poor connection), then latency.
    private fun bestVoice(engine: TextToSpeech): Voice? {
        if (autoVoiceResolved) return autoVoice
        autoVoiceResolved = true
        val target = Locale.getDefault()
        val systemDefault = runCatching { engine.defaultVoice }.getOrNull()
        val usable = engine.voices.orEmpty().filter { voice ->
            !voice.features.orEmpty()
                .contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) &&
                voice.locale.language.equals(target.language, ignoreCase = true)
        }
        autoVoice = usable.maxWithOrNull(
            compareBy<Voice>(
                { it.quality },
                { if (it.name == systemDefault?.name) 1 else 0 },
                { if (it.locale.country.equals(target.country, true)) 1 else 0 },
                { if (it.isNetworkConnectionRequired) 0 else 1 },
                { -it.latency },
            ),
        ) ?: systemDefault
        Log.i(
            TAG,
            "tts voices=${usable.size} systemDefault=${systemDefault?.name} " +
                "picked=${autoVoice?.name} q=${autoVoice?.quality} " +
                "net=${autoVoice?.isNetworkConnectionRequired}",
        )
        return autoVoice
    }

    private val utteranceListener = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) {
            Log.i(TAG, "tts audio start ${utteranceId ?: ""}")
            emit("tts.start", mapOf("id" to (utteranceId ?: "")))
        }

        override fun onDone(utteranceId: String?) =
            finishTts("tts.done", utteranceId)

        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String?) =
            finishTts("tts.error", utteranceId, TextToSpeech.ERROR)

        override fun onError(utteranceId: String?, errorCode: Int) {
            Log.w(TAG, "tts error $errorCode for ${utteranceId ?: ""}")
            finishTts("tts.error", utteranceId, errorCode)
        }

        override fun onStop(utteranceId: String?, interrupted: Boolean) =
            finishTts(
                "tts.stop",
                utteranceId,
                extra = mapOf("interrupted" to interrupted),
            )
    }

    private fun speak(
        text: String,
        id: String,
        rate: Float,
        pitch: Float,
        voiceName: String?,
        flush: Boolean,
        result: MethodChannel.Result,
    ) {
        if (text.isBlank()) {
            result.success(false)
            return
        }
        ensureTts { ok ->
            if (!ok) {
                result.error("tts_unavailable", "Text-to-speech failed to initialize", null)
                return@ensureTts
            }
            val engine = tts ?: run {
                result.error("tts_unavailable", "Text-to-speech disposed", null)
                return@ensureTts
            }
            val wanted = voiceName?.takeIf { it.isNotBlank() }
            // Voice/rate/pitch are engine-wide state, so only touch them when
            // something actually changed: re-applying them per chunk is what
            // made queued utterances hiccup between sentences. `voiceApplied`
            // (not a null comparison on the name) tracks that, so the very
            // first utterance still resolves a voice when none is pinned.
            //
            // Voice selection NEVER fails the utterance: a stale pinned name,
            // a voice that vanished with an engine update, or an engine that
            // refuses setVoice all fall back to speaking with whatever is
            // already active. Speaking in the wrong voice beats silence.
            if (!voiceApplied || wanted != appliedVoiceName) {
                val requested = wanted?.let { name ->
                    engine.voices.orEmpty().firstOrNull { it.name == name }
                }
                val voice = requested ?: bestVoice(engine)
                if (voice != null) {
                    val applied = engine.setVoice(voice) == TextToSpeech.SUCCESS
                    if (!applied) {
                        Log.w(TAG, "setVoice rejected ${voice.name}")
                    }
                }
                appliedVoiceName = wanted
                voiceApplied = true
            }
            val clampedRate = rate.coerceIn(0.4f, 2.0f)
            if (clampedRate != appliedRate) {
                engine.setSpeechRate(clampedRate)
                appliedRate = clampedRate
            }
            val clampedPitch = pitch.coerceIn(0.5f, 2.0f)
            if (clampedPitch != appliedPitch) {
                engine.setPitch(clampedPitch)
                appliedPitch = clampedPitch
            }
            Log.i(
                TAG,
                "speak id=$id chars=${text.length} flush=$flush " +
                    "voice=${appliedVoiceName ?: autoVoice?.name ?: "engine-default"}",
            )
            requestTtsAudioFocus()
            activeTtsId = id
            val params = Bundle().apply {
                // Engines default to the stream volume they were last handed;
                // pin speech at full scale and let the media stream's own
                // volume do the attenuating.
                putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1.0f)
                putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, id)
            }
            val queued = engine.speak(
                text,
                if (flush) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD,
                params,
                id,
            )
            if (queued != TextToSpeech.SUCCESS) {
                Log.w(TAG, "speak refused for $id")
                if (activeTtsId == id) activeTtsId = null
                releaseTtsAudioFocusSoon()
            }
            result.success(queued == TextToSpeech.SUCCESS)
        }
    }

    private fun listVoices(result: MethodChannel.Result) {
        ensureTts { ok ->
            if (!ok) {
                result.error("tts_unavailable", "Text-to-speech failed to initialize", null)
                return@ensureTts
            }
            val engine = tts ?: run {
                result.error("tts_unavailable", "Text-to-speech disposed", null)
                return@ensureTts
            }
            val defaultName = engine.defaultVoice?.name
            val voices = engine.voices
                .orEmpty()
                .map { voice ->
                    mapOf(
                        "name" to voice.name,
                        "locale" to voice.locale.toLanguageTag(),
                        "quality" to voice.quality,
                        "latency" to voice.latency,
                        "networkRequired" to voice.isNetworkConnectionRequired,
                        "isDefault" to (voice.name == defaultName),
                    )
                }
                .sortedWith(
                    compareBy<Map<String, Any?>>(
                        { it["locale"] as String },
                        { -(it["quality"] as Int) },
                        { it["name"] as String },
                    ),
                )
            result.success(voices)
        }
    }

    private fun speechAudioAttributes(): AudioAttributes =
        AudioAttributes.Builder()
            // USAGE_MEDIA, not USAGE_ASSISTANT: the assistant usage routes
            // through its own strategy/stream (AUDIO_STREAM_ASSISTANT, with a
            // separate, often low volume curve and OEM speech processing),
            // which made replies sound thin and quiet next to any other
            // audio. Media is the full-band music path at the user's media
            // volume. Voice mode is half-duplex (the recognizer is stopped
            // while we speak), so no echo cancellation is needed and
            // USAGE_VOICE_COMMUNICATION — narrowband telephony processing —
            // would only make it worse.
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        if (
            change == AudioManager.AUDIOFOCUS_LOSS ||
            change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT
        ) {
            tts?.stop()
        }
    }

    /// Focus is held for a whole spoken run, not per utterance: dropping and
    /// re-taking it between queued chunks made other audio duck in and out
    /// (and, on some devices, clipped the first syllable of each chunk).
    @Suppress("DEPRECATION")
    private fun requestTtsAudioFocus() {
        focusRelease?.let(main::removeCallbacks)
        focusRelease = null
        if (ttsFocusRequest != null) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(speechAudioAttributes())
                .setOnAudioFocusChangeListener(focusListener)
                .build()
            ttsFocusRequest = request
            audioManager.requestAudioFocus(request)
        } else {
            audioManager.requestAudioFocus(
                focusListener,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT,
            )
        }
    }

    /// Give the next queued utterance a moment to start before handing focus
    /// back, so a chunked reply is one continuous hold.
    private fun releaseTtsAudioFocusSoon() {
        focusRelease?.let(main::removeCallbacks)
        val task = Runnable {
            focusRelease = null
            if (activeTtsId == null) abandonTtsAudioFocus()
        }
        focusRelease = task
        main.postDelayed(task, FOCUS_RELEASE_GRACE_MS)
    }

    @Suppress("DEPRECATION")
    private fun abandonTtsAudioFocus() {
        focusRelease?.let(main::removeCallbacks)
        focusRelease = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ttsFocusRequest?.let(audioManager::abandonAudioFocusRequest)
            ttsFocusRequest = null
        } else {
            audioManager.abandonAudioFocus(focusListener)
        }
    }

    private fun finishTts(
        method: String,
        utteranceId: String?,
        errorCode: Int? = null,
        extra: Map<String, Any?> = emptyMap(),
    ) {
        main.post {
            val id = utteranceId ?: ""
            if (activeTtsId == id) {
                activeTtsId = null
                releaseTtsAudioFocusSoon()
            }
            val args = mutableMapOf<String, Any?>("id" to id)
            if (errorCode != null) {
                args["code"] = errorCode
                args["message"] = "Text-to-speech error $errorCode"
            }
            args.putAll(extra)
            invokeChannel(method, args)
        }
    }

    // ── Default-assistant role ──────────────────────────────────────────────

    /// Whether this app currently holds the system "digital assistant" role.
    /// Settings.Secure `assistant` stores the flattened ComponentName of the
    /// chosen assist component (or empty/none). Reading it needs no
    /// permission; only writing is privileged.
    private fun isDefaultAssistant(): Boolean {
        val flat = Settings.Secure.getString(context.contentResolver, "assistant")
        if (flat.isNullOrEmpty()) return false
        val cn = ComponentName.unflattenFromString(flat)
        return (cn?.packageName ?: flat) == context.packageName
    }

    /// The assistant role can't be requested via RoleManager dialogs — the
    /// user must pick it in system settings. Deep-link as close as the device
    /// allows: the voice-input picker, else default-apps, else settings root.
    private fun openAssistantSettings(): Boolean {
        val candidates = listOf(
            Intent(Settings.ACTION_VOICE_INPUT_SETTINGS),
            Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS),
            Intent(Settings.ACTION_SETTINGS),
        )
        for (intent in candidates) {
            if (intent.resolveActivity(context.packageManager) == null) continue
            return try {
                activity.startActivity(intent)
                true
            } catch (_: Exception) {
                continue
            }
        }
        return false
    }

    /** Called by MainActivity when an assist-gesture intent arrives. */
    fun onAssistLaunch(warm: Boolean) {
        assistPending = true
        if (warm) emit("assist.launch", null)
    }

    // ── Plumbing ────────────────────────────────────────────────────────────

    /// All native → Dart traffic goes through the main thread (TTS progress
    /// callbacks arrive on a binder thread; channel calls must not).
    private fun emit(method: String, args: Map<String, Any?>?) {
        main.post {
            invokeChannel(method, args)
        }
    }

    private fun invokeChannel(method: String, args: Map<String, Any?>?) {
        if (disposed) return
        try {
            channel.invokeMethod(method, args)
        } catch (_: Exception) {
            // Engine tearing down — drop the event.
        }
    }

    fun dispose() {
        disposed = true
        destroyRecognizer(cancel = true)
        tts?.stop()
        tts?.shutdown()
        tts = null
        ttsReady = false
        resetVoiceCache()
        activeTtsId = null
        abandonTtsAudioFocus()
        pendingTtsInit.clear()
        pendingPermission = null
        channel.setMethodCallHandler(null)
    }
}
