import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Release signing: locally from ~/.swarmz-android/signing.properties (outside the repo), in CI
// from environment variables the workflow fills from repository secrets. The local file always
// wins when it has the value, so nothing about a developer machine changes.
val signingFile = File(System.getProperty("user.home"), ".swarmz-android/signing.properties")
val signing = Properties().apply { if (signingFile.exists()) signingFile.inputStream().use(::load) }

fun signingValue(key: String, env: String): String? =
    (signing.getProperty(key) ?: System.getenv(env))?.takeIf { it.isNotBlank() }

val storeFilePath = signingValue("storeFile", "ANDROID_KEYSTORE_FILE")
val storePasswordValue = signingValue("storePassword", "ANDROID_KEYSTORE_PASSWORD")
val keyAliasValue = signingValue("keyAlias", "ANDROID_KEY_ALIAS")
val keyPasswordValue = signingValue("keyPassword", "ANDROID_KEY_PASSWORD")
// Without all four the release build stays unsigned rather than failing: `assembleDebug` and the
// unit tests must keep working on a machine that has no key at all.
val canSignRelease =
    storeFilePath != null && storePasswordValue != null && keyAliasValue != null && keyPasswordValue != null

android {
    namespace = "dev.swarmz.phone"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.swarmz.phone"
        minSdk = 31
        targetSdk = 35
        versionCode = 702
        versionName = "0.7.2"
    }

    signingConfigs {
        if (canSignRelease) {
            create("release") {
                storeFile = File(storeFilePath!!)
                storePassword = storePasswordValue
                keyAlias = keyAliasValue
                keyPassword = keyPasswordValue
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            isReturnDefaultValues = true
        }
    }

    packaging {
        resources {
            excludes += setOf("META-INF/versions/9/OSGI-INF/MANIFEST.MF", "META-INF/DEPENDENCIES", "META-INF/LICENSE*", "META-INF/NOTICE*", "META-INF/INDEX.LIST")
        }
    }
}

kotlin {
    jvmToolchain(21)
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.icons)
    implementation(libs.compose.ui.tooling.preview)
    debugImplementation(libs.compose.ui.tooling)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.serialization.json)
    implementation(libs.coroutines.android)
    implementation(libs.datastore.preferences)
    implementation(libs.sshj)
    implementation(libs.bcprov)
    implementation(libs.bcpkix)
    implementation(libs.markdown.m3)
    implementation(libs.camera.core)
    implementation(libs.camera.camera2)
    implementation(libs.camera.lifecycle)
    implementation(libs.camera.compose)
    implementation(libs.zxing.core)

    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    debugImplementation(libs.compose.ui.test.manifest)
    testImplementation(libs.sshd.core)
    testImplementation(libs.eddsa)
    testImplementation(libs.slf4j.nop)
}
