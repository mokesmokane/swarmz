# swarmz phone app

Android companion app for swarmz. Drives terminal sessions on your Macs over ssh. Kotlin, Jetpack
Compose, Material 3.

## Toolchain setup

Install once, via Homebrew:

```bash
brew install openjdk@21 gradle
brew install --cask android-commandlinetools
export JAVA_HOME="$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home"
export ANDROID_HOME="$(brew --prefix)/share/android-commandlinetools"
yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" --licenses >/dev/null
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" "platform-tools" "platforms;android-36" "build-tools;36.0.0"
```

Every subsequent shell needs these two exports (put them in your `~/.zshrc` if you work on this
project often):

```bash
export JAVA_HOME="$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home"
export ANDROID_HOME="$(brew --prefix)/share/android-commandlinetools"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
```

`android/local.properties` must contain `sdk.dir=$ANDROID_HOME` (git-ignored; regenerate with
`printf 'sdk.dir=%s\n' "$ANDROID_HOME" > android/local.properties` if it goes missing).

## Building and testing

All commands run from `android/`:

```bash
cd android
./gradlew :app:testDebugUnitTest   # unit tests (Robolectric + Compose UI tests on the JVM)
./gradlew :app:assembleDebug       # produces app/build/outputs/apk/debug/app-debug.apk
```

The first build downloads Gradle, AGP, and all dependencies, so it can take several minutes.
Robolectric also downloads an `android-all` jar the first time its tests run.

## Installing on a phone over USB

Enable USB debugging on the phone first (Settings > About phone > tap Build number 7 times to
unlock Developer options, then Settings > Developer options > USB debugging). Plug the phone in,
accept the "Allow USB debugging" prompt on the phone, then:

```bash
$ANDROID_HOME/platform-tools/adb install -r app/build/outputs/apk/debug/app-debug.apk
```
