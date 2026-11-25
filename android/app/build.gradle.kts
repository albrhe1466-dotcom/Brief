plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val keystorePath: String = System.getenv("BRIEF_KEYSTORE_PATH") ?: ""
val keystorePass: String = System.getenv("BRIEF_KEYSTORE_PASS") ?: ""
val keystoreAlias: String = System.getenv("BRIEF_KEY_ALIAS") ?: "brief"
val keystoreKeyPass: String = System.getenv("BRIEF_KEY_PASS") ?: keystorePass

android {
    namespace = "com.brief.desktop"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.brief.desktop"
        minSdk = 26
        targetSdk = 34
        versionCode = 207
        versionName = "2.0.5"
    }

    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }

    if (keystorePath.isNotEmpty() && file(keystorePath).exists()) {
        signingConfigs {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = keystorePass
                keyAlias = keystoreAlias
                keyPassword = keystoreKeyPass
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            if (keystorePath.isNotEmpty() && file(keystorePath).exists()) {
                signingConfig = signingConfigs.getByName("release")
            } else {
                signingConfig = signingConfigs.getByName("debug")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        debug {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
