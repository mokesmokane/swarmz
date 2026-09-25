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
./gradlew :app:assembleRelease     # produces the signed release APK (see below)
```

Run a single test class or package with `--tests`, e.g.
`./gradlew :app:testDebugUnitTest --tests 'dev.swarmz.phone.state.*'`.

The first build downloads Gradle, AGP, and all dependencies, so it can take several minutes.
Robolectric also downloads an `android-all` jar the first time its tests run. Tests are JVM-only:
there is no emulator or device involved, ssh tests run against an embedded Apache MINA `sshd` on
`127.0.0.1`, and nothing touches a real `~/.swarmz`, `~/.ssh` or host.

## Release signing

`app/build.gradle.kts` signs the `release` build type from
`~/.swarmz-android/signing.properties` (outside the repo and git-ignored everywhere), read as:

```properties
storeFile=/Users/you/.swarmz-android/release.jks
storePassword=...
keyAlias=swarmz
keyPassword=...
```

Create the keystore once, on the Mac that will publish builds:

```bash
mkdir -p ~/.swarmz-android && chmod 700 ~/.swarmz-android
PW=$(openssl rand -base64 24)
keytool -genkeypair -v -keystore ~/.swarmz-android/release.jks -alias swarmz -keyalg RSA -keysize 4096 -validity 10000 \
  -storepass "$PW" -keypass "$PW" -dname "CN=swarmz phone"
cat > ~/.swarmz-android/signing.properties <<EOF
storeFile=$HOME/.swarmz-android/release.jks
storePassword=$PW
keyAlias=swarmz
keyPassword=$PW
EOF
chmod 600 ~/.swarmz-android/signing.properties ~/.swarmz-android/release.jks
```

**Back this up.** `~/.swarmz-android/release.jks` is not in the repo and has no other copy. An APK
signed with a different key cannot update one already installed on a phone — Android refuses the
install until the old app is uninstalled first, which loses its local settings and pairing key.
Losing the keystore means every phone needs a fresh install and a fresh pairing.

When `~/.swarmz-android/signing.properties` is missing, `assembleRelease` still produces an
unsigned APK (the `release` signing config is simply absent); `assembleDebug` always uses the
Android debug key and needs no setup.

## Installing on a phone over USB

Enable USB debugging on the phone first (Settings > About phone > tap Build number 7 times to
unlock Developer options, then Settings > Developer options > USB debugging). Plug the phone in,
accept the "Allow USB debugging" prompt on the phone, then:

```bash
adb devices   # confirm the phone is listed and authorized
adb install -r app/build/outputs/apk/release/app-release.apk
```

(`adb` is on `PATH` once `ANDROID_HOME/platform-tools` is added, above; the debug APK installs the
same way from `app/build/outputs/apk/debug/app-debug.apk`.)

## Pairing with a Mac

Pairing needs, on the Mac side: the Tailscale app connected (the phone reaches Macs over the
tailnet by MagicDNS name), Remote Login turned on (System Settings > General > Sharing), and
swarmz run at least once (it installs the `swarmz` tool to `~/.swarmz/bin/swarmz`). On first
launch the app generates its own Ed25519 key (sealed by an Android Keystore key, never leaves the
phone), and the pairing screen shown on first launch asks for one Mac's name plus your Mac
username and password, once. The name must resolve to a Tailscale address (use the Mac's
Tailscale name, for example `mini` or `mini.tailnet.ts.net`); the password is never sent anywhere
else. The phone runs `swarmz phone add` there and it fans out to every other Mac it can already
reach.

**Scan QR** fills the name and username in instead of typing them. In swarmz on the Mac, open the
Phones panel and press **Link a device**: the code it shows carries that Mac's Tailscale name, its
login user and the `SHA256:` fingerprints of its ssh host keys. Nothing in the code is secret — host
keys are public — so a photograph of it gives nobody access, and the Mac's password is still needed
once. Scanning pins those host keys before the phone ever connects, so its first connection to that
Mac is checked rather than trusting whichever key answers. A code for a Mac this phone already
trusts a different key for is reported as a host key change and pins nothing. Scanning asks for the
camera the first time; refusing it only means typing the name and username by hand. The scanner is
ZXing, decoding frames from CameraX on the phone, so it needs no network and no Google Play
services.

## What each screen does

- **Home** (folded width): what needs you first — permission questions and finished turns as
  cards with reply/allow/deny actions — then a row of pills for every other running tile, and a
  New session button.
- **Tile list** (unfolded width, beside the open tile): every tile grouped by Mac, NEEDS YOU
  first, with online/offline state per Mac. The list can be dragged wider or
  narrower (220-480 dp, 260 dp by default) and hidden with the chevron in its header, which leaves the
  open tile the whole width until you bring it back.
- **Tile screen**: the tile's live terminal, Claude and shell alike, with 3000 lines of coloured
  scrollback, the permission or question card when Claude asks, a quick-key row for each kind, and a
  composer that types into the tile (use the keyboard's own voice typing to dictate). Any `http(s)`
  URL on the screen is tappable, offering Open and Copy, which is how the `/login` flow is completed
  from the phone.
- **New session**: pick an online Mac, browse or pick a recent folder, optionally skip
  permissions, and start.
- **Settings**: paired and discovered Macs, and this phone's key (revoke it
  here, which removes it from every reachable Mac).

## Installing updates

Releases are published on GitHub (`mokesmokane/swarmz`), with the APK attached as
`swarmz-<version>.apk` and signed by the same key every time. The easy way to keep a phone current
is [Obtainium](https://github.com/ImranR98/Obtainium): add the app from
`https://github.com/mokesmokane/swarmz`, and it watches the releases and offers each new APK as an
in-place upgrade. `docs/RELEASING.md` covers how those releases are made.

## Out of scope for this build

Background alerts and notifications (a foreground watcher service, permission/question/finished
notification channels) are not implemented yet — they land with sub-project 4. The Settings
screen's background-watching and notification-kind toggles are stored but have no effect until
then.
