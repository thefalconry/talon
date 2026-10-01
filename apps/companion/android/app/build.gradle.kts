import java.net.URI
import java.security.MessageDigest

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "org.talon.companion"
    // Pinned to 36 (not flutter.compileSdkVersion, currently 34) because
    // file_picker's transitive flutter_plugin_android_lifecycle requires
    // compiling against API 36+. compileSdk only governs which APIs are
    // available at compile time; minSdk/targetSdk are unchanged.
    compileSdk = 36
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // flutter_local_notifications compiles against java.time (used for
        // scheduled/zoned notifications) and publishes AAR metadata that fails
        // the build unless the consuming app desugars those APIs. Required for
        // minSdk < 26; harmless above it.
        isCoreLibraryDesugaringEnabled = true
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "org.talon.companion"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // Stable release signing so an APK from one release installs OVER the
    // previous one. CI decodes the ANDROID_KEYSTORE_BASE64 secret and points
    // these env vars at it; without them (local dev, forks without the
    // secret) the build falls back to debug signing, where every machine's
    // throwaway key makes upgrades require an uninstall.
    //
    // A release pipeline sets TALON_ANDROID_REQUIRE_RELEASE_SIGNING=1, which
    // turns the debug fallback into a hard error so a published APK can never
    // silently carry the debug key. A keystore path that is set but missing
    // is always an error: someone asked for release signing and didn't get it.
    val keystorePath = System.getenv("TALON_ANDROID_KEYSTORE_FILE")?.takeIf { it.isNotBlank() }
    val releaseKeystore = keystorePath?.let { file(it) }?.takeIf { it.exists() }
    if (keystorePath != null && releaseKeystore == null) {
        throw GradleException("TALON_ANDROID_KEYSTORE_FILE points at a missing file: $keystorePath")
    }
    if (releaseKeystore == null && System.getenv("TALON_ANDROID_REQUIRE_RELEASE_SIGNING") == "1") {
        throw GradleException(
            "TALON_ANDROID_REQUIRE_RELEASE_SIGNING=1 but no release keystore is configured " +
                "(TALON_ANDROID_KEYSTORE_FILE) — refusing to fall back to debug signing.",
        )
    }
    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = releaseKeystore
                storeType = "PKCS12"
                storePassword = System.getenv("TALON_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("TALON_ANDROID_KEY_ALIAS") ?: "talon"
                keyPassword = System.getenv("TALON_ANDROID_KEYSTORE_PASSWORD")
            }
        }
    }

    // The sherpa-onnx AAR ships its JNI library for four ABIs; the two ARM
    // ones (arm64-v8a, armeabi-v7a) are kept so 32-bit phones get the neural
    // voice too. x86/x86_64 are emulators only: dropped to save size, and on
    // those the native load fails cleanly and voice mode stays on Android TTS
    // (KokoroTts.deviceSupported).
    packaging {
        jniLibs {
            excludes += setOf(
                "lib/x86/libsherpa-onnx-jni.so",
                "lib/x86/libonnxruntime.so",
                "lib/x86_64/libsherpa-onnx-jni.so",
            )
        }
    }

    testOptions {
        // JVM unit tests (src/test) cover pure-Kotlin logic only; any stray
        // android.* call returns a default instead of throwing.
        unitTests.isReturnDefaultValues = true
    }

    buildTypes {
        release {
            signingConfig = if (releaseKeystore != null) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
            // AGP 9 shrinks release builds with R8. Shizuku's `newProcess` is
            // reached only via reflection (a runtime string), which R8 can't
            // see — so it strips/renames the method and elevated exec fails
            // with NoSuchMethodException, silently downgrading to app UID.
            // proguard-rules.pro keeps the Shizuku surface so that path works.
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

// ── sherpa-onnx (on-device neural voice) ────────────────────────────────────
//
// Kokoro TTS runs on sherpa-onnx. The AAR is the upstream GitHub release
// artifact, pinned by version AND SHA-256 and fetched once into the Gradle
// user home (which CI caches), rather than a JitPack build or an unpinned
// Maven coordinate. Android only: no other platform's build references it.
//
// Licensing: this AAR statically links espeak-ng (GPL-3.0), so the APK it is
// built into is distributed under GPL-3.0 as a combined work. See NOTICE.
// TODO(sherpa-onnx 2.0): upstream plans to drop espeak-ng
// (https://github.com/k2-fsa/sherpa-onnx/issues/3731). Re-pin then and revisit
// the APK licence note in NOTICE and docs/companion-voice.md.
val sherpaOnnxVersion = "1.13.8"
val sherpaOnnxSha256 = "b22c3fc1b6a45666d28892bb2f7694beeb77a8362d7ebd77c1a5431ec9435471"

fun sha256Hex(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
        val buffer = ByteArray(1 shl 16)
        while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            digest.update(buffer, 0, n)
        }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
}

// Static-onnxruntime variant: one .so per ABI instead of two, ~12 MB smaller.
val sherpaOnnxAar: File = run {
    val name = "sherpa-onnx-static-link-onnxruntime-$sherpaOnnxVersion.aar"
    val dir = File(gradle.gradleUserHomeDir, "caches/talon-pinned/sherpa-onnx")
    val aar = File(dir, name)
    if (aar.isFile && sha256Hex(aar) == sherpaOnnxSha256) return@run aar
    dir.mkdirs()
    val url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v$sherpaOnnxVersion/$name"
    logger.lifecycle("Downloading $url")
    val partial = File(dir, "$name.part")
    URI(url).toURL().openStream().use { input ->
        partial.outputStream().use { output -> input.copyTo(output) }
    }
    val actual = sha256Hex(partial)
    if (actual != sherpaOnnxSha256) {
        partial.delete()
        throw GradleException(
            "sherpa-onnx AAR checksum mismatch: expected $sherpaOnnxSha256, got $actual",
        )
    }
    if (!partial.renameTo(aar)) throw GradleException("Could not move $partial to $aar")
    aar
}

dependencies {
    // Backports java.time et al. so flutter_local_notifications' AAR metadata
    // check passes (see isCoreLibraryDesugaringEnabled above).
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")

    // Shizuku (optional elevated privilege for the mesh exec channel). The
    // client binds to the Shizuku app when it's installed and running; absent
    // that, the Dart layer falls back to app-UID execution, so these deps are
    // safe to ship unconditionally. See docs/companion-shizuku.md.
    implementation("dev.rikka.shizuku:api:13.1.5")
    implementation("dev.rikka.shizuku:provider:13.1.5")

    // FileProvider, for handing a downloaded update APK to Android's package
    // installer (a file:// URI throws FileUriExposedException on N+). Already
    // on the classpath transitively via the Flutter embedding; declared so the
    // self-updater doesn't silently depend on someone else's dependency.
    implementation("androidx.core:core-ktx:1.13.1")

    // On-device neural voice (Kokoro). Pinned + hash-checked above.
    implementation(files(sherpaOnnxAar))

    // JVM unit tests for the pure-Kotlin voice pipeline (src/test).
    testImplementation("junit:junit:4.13.2")
}

flutter {
    source = "../.."
}
