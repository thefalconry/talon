# Companion voice mode: the on-device neural voice

Voice mode on the Android companion reads replies aloud. By default it uses
Android's own text-to-speech engine. **Settings → Voice → Neural voice
(Kokoro)** switches replies to [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M),
an 82M-parameter neural voice run entirely on the phone by
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). Nothing is sent to a
server to synthesize speech.

Android only. Windows, macOS, Linux and iOS builds keep their existing speech
and do not include sherpa-onnx.

## How it works

- **Download.** The model is not in the APK. Turning the neural voice on
  downloads `kokoro-int8-multi-lang-v1_0.tar.bz2` (~126 MiB) from the
  sherpa-onnx `tts-models` release, checks it against a pinned SHA-256, and
  unpacks it (~181 MiB) into the app's private files. The download can be
  paused and resumes where it stopped. Settings shows progress and a
  **Delete** action. The download and install code is a generic on-device
  model manager (`lib/src/services/model_manager.dart`), built so other
  models, such as an optional speech-recognition model, can reuse it.
- **Fallback.** Until the model is installed and loaded, and after any load
  or synthesis error, replies are spoken by Android TTS. A failure part-way
  through a reply hands the rest of that reply to Android TTS.
- **Latency.** The model loads once when voice mode opens. Each reply is
  synthesized one sentence at a time and playback starts after the first
  sentence, while the next is still being generated.
- **Audio.** Playback uses the same audio attributes and focus handling as
  Android TTS (media usage, speech content), so volume, routing, barge-in
  and stop behave the same.
- **Voices.** The 28 English speakers of Kokoro v1.0 (American and British).
  The default is *Heart* (`af_heart`).

Supported devices: ARM phones, 64-bit (arm64-v8a) and 32-bit (armeabi-v7a),
on Android 6.0 or later. On older 32-bit phones synthesis may be slower than
real time, so the first sentence takes longer to start. x86/x86_64 emulators
always use Android TTS: the neural-voice library is not shipped for them.

## Licensing

sherpa-onnx statically links [espeak-ng](https://github.com/espeak-ng/espeak-ng)
(GPL-3.0) for phonemization, so the **Android companion APK is distributed
under the GPL-3.0** as a combined work. Its corresponding source is this
repository. Talon's own source files remain Apache-2.0. The Kokoro model
(Apache-2.0) is downloaded at runtime and is not bundled. See
[NOTICE](../NOTICE) for the full list of components.

Upstream plans to drop espeak-ng in sherpa-onnx 2.0
([k2-fsa/sherpa-onnx#3731](https://github.com/k2-fsa/sherpa-onnx/issues/3731)).
The TODOs in `android/app/build.gradle.kts` and `KokoroTts.kt` track this.
