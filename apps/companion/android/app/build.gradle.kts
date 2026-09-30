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
}

flutter {
    source = "../.."
}
