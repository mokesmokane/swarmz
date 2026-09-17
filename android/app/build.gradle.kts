plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "dev.swarmz.phone"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.swarmz.phone"
        minSdk = 31
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
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
    implementation(libs.material3.adaptive)
    implementation(libs.material3.adaptive.layout)
    implementation(libs.material3.adaptive.navigation)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.serialization.json)
    implementation(libs.coroutines.android)
    implementation(libs.datastore.preferences)
    implementation(libs.sshj)
    implementation(libs.bcprov)
    implementation(libs.bcpkix)
    implementation(libs.coil.compose)
    implementation(libs.markdown.m3)

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
