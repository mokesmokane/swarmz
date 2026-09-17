# Releasing swarmz

A release is a signed, notarised macOS app plus the Android APK, published from a GitHub
Actions run that a tag starts. Nothing is built locally.

## Cutting one

```bash
npm run version -- 0.2.0        # package.json, src-tauri/tauri.conf.json, android/app/build.gradle.kts
git add package.json src-tauri/tauri.conf.json android/app/build.gradle.kts
git commit -m "chore: v0.2.0"
git push
git tag v0.2.0
git push origin v0.2.0
```

`npm run version` is the only thing that sets a version. It writes the same
`MAJOR.MINOR.PATCH` into all three files and derives the Android `versionCode` as
`major * 10000 + minor * 100 + patch` (so `0.2.0` is `200`, `1.0.0` is `10000`). Minor and patch
must stay under 100 or that number stops increasing; the script refuses anything else, as it
refuses pre-release suffixes. A test in `scripts/version.test.mjs` fails if the three files ever
drift apart, so CI catches a hand-edited version.

Both release jobs refuse to start if `${GITHUB_REF_NAME#v}` is not exactly the version in
`src-tauri/tauri.conf.json`, because a mismatch would publish a release whose `latest.json` still
names the old version: nobody would update and nothing would error.

The tag push starts `.github/workflows/release.yml`. When it finishes there is a **draft**
release: write the notes and press Publish. **Publishing is what ships the update** — the app's
updater reads `releases/latest/download/latest.json`, and a draft is never "latest", so a draft
release is invisible to everyone's updater.

## What CI does

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `checks.yml` | called by the other two | `npm ci`, `npm run typecheck`, `npm test`, `cargo test -p swarmz-tool`. The `swarmz` app crate links WebKit and the macOS frameworks, so it is only ever compiled on the macOS runner. |
| `ci.yml` | every push to `main` and every PR | `checks`, plus the Android unit tests. No secrets, no signing. |
| `release.yml` | a tag matching `v*` | `checks`, then `macos` and `android`. |

`release.yml`'s `macos` job (on `macos-14`, so **Apple Silicon only** — see Limitations) imports
the Developer ID certificate into a throwaway keychain, writes the App Store Connect key to
`$RUNNER_TEMP/private_keys/AuthKey_<id>.p8` (mode 600), runs `tauri-apps/tauri-action@v1`, and
deletes both in a final `always()` step that recomputes the keychain path rather than trusting a
variable an aborted import may never have exported. The action signs, notarises and staples the app,
and — because `bundle.createUpdaterArtifacts` is true — also produces `swarmz.app.tar.gz` and its
minisign `.sig`, generates `latest.json` and attaches all of it, with the DMG, to the draft
release.

**The holder binary is signed before it is bundled.** `bundle.macOS.files` copies
`src-tauri/target/release/swarmz-tool` into the app as `Contents/MacOS/swarmz-tool`, and Tauri
signs the app and its own executable but not that one. Every Mach-O inside a notarised app needs a
Developer ID signature, a secure timestamp and the hardened runtime, so `npm run build:tool`
(`scripts/build-tool.mjs`, which `beforeBuildCommand` runs) signs it itself when
`APPLE_SIGNING_IDENTITY` is set, and verifies the result with `codesign -dv --verbose=4`, failing
the build if any of the three is missing. It has to happen there: signing the inner binary after
Tauri has signed the `.app` would invalidate the outer signature. **Local builds are unchanged** —
with no `APPLE_SIGNING_IDENTITY` the script just builds and says so.

**Notarisation uses an App Store Connect API key, not an Apple ID.** Apple ID authentication
returns 401 on this account. `tauri-bundler` tries `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID`
*first* and only falls through to the key when that triple is incomplete — and an empty-but-set
`APPLE_ID` counts as set — so those two variables must not appear in the workflow at all. They do
not. Note that the bundler's `APPLE_API_KEY` variable holds the key **ID**; the key itself is the
file named by `APPLE_API_KEY_PATH`.

Both Android jobs pin the SDK packages they install (`platform-tools`, `platforms;android-36`,
`build-tools;36.0.0` — the same ones `android/README.md` tells a developer to install). The
`setup-android` action's default list includes the long-removed `tools` package, which makes
`sdkmanager` exit 1 before Gradle starts; keep the list explicit, and keep it in step with
`compileSdk` in `android/app/build.gradle.kts`.

The `android` job waits for that release to exist, writes the keystore from `ANDROID_KEYSTORE` to
a temporary file, runs `./gradlew :app:testDebugUnitTest :app:assembleRelease` with the passwords
in environment variables, and attaches the APK as `swarmz-<version>.apk`.

Both release jobs are guarded with `if: github.repository == 'mokesmokane/swarmz'`, so a fork
never tries to use secrets it does not have.

## How the app updates itself

`src-tauri/tauri.conf.json` holds the updater's **public** key and the endpoint. On launch the app
checks once in the background (`checkForUpdates` in `src/store.ts`, called from `App.tsx`), and the
sidebar shows an unobtrusive notice offering **Update and restart**. The session holders keep every
shell and agent running across the restart, so nothing is lost. The sidebar footer has a
**Check for updates** button for asking by hand. Every failure — an unreachable endpoint, a
refused download, a relaunch that will not happen — is logged and left in the notice; none of it
blocks the app.

## Where the keys live, and backing them up

Two directories on the release Mac, both outside the repo and both **not backed up by anything
automatic**. Copy them somewhere safe (an encrypted disk image, a password manager attachment):

| Path | What | Matching secret |
| --- | --- | --- |
| `~/.swarmz-release/updater.key` | minisign private key that signs updates | `TAURI_SIGNING_PRIVATE_KEY` |
| `~/.swarmz-release/updater-key-password.txt` | its password | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` |
| `~/.swarmz-release/updater.key.pub` | the public half, in `tauri.conf.json` | — (public) |
| `~/.swarmz-release/developer-id.p12` | Apple Developer ID Application certificate | `APPLE_CERTIFICATE` (base64) |
| `~/.swarmz-release/p12-password.txt` | its password | `APPLE_CERTIFICATE_PASSWORD` |
| the App Store Connect `AuthKey_DR2GC9B77Q.p8` | notarisation key — **Apple lets you download it once** | `APPLE_API_KEY` (the PEM text, not base64) |
| `~/.swarmz-android/release.jks` | Android upload/release keystore | `ANDROID_KEYSTORE` (base64) |
| `~/.swarmz-android/signing.properties` | its passwords and alias, for local builds | `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` |

The rest are plain strings: `APPLE_SIGNING_IDENTITY`
(`Developer ID Application: Martin O'Kane (SQUJL7DXG8)`), `APPLE_TEAM_ID` (`SQUJL7DXG8`),
`APPLE_API_KEY_ID` (`DR2GC9B77Q`) and `APPLE_API_ISSUER`
(`e563a705-53db-4312-a469-996efab75c4e`). There is no `APPLE_ID` or `APPLE_PASSWORD`; they were
deleted when notarisation moved to the API key.

`APPLE_API_KEY` is stored as the `.p8`'s text, newlines and all, not base64. The workflow writes it
with `printf '%s\n' "${VAR%$'\n'}"`, which reproduces the original file byte for byte whether or
not it was pasted with a trailing blank line; base64 would buy nothing. To re-set it:
`pbcopy < AuthKey_DR2GC9B77Q.p8`.

**Losing the updater private key means no installed copy of swarmz can ever be updated again** —
every install only trusts the one public key compiled into it. Losing the Android keystore means
no installed copy of the phone app can be upgraded in place either; both are unrecoverable.

Base64 for the two binary secrets, when re-uploading them:

```bash
base64 -i ~/.swarmz-release/developer-id.p12 | pbcopy
base64 -i ~/.swarmz-android/release.jks | pbcopy
```

## Rotating them

- **Updater key.** `npm run tauri signer generate -- -w ~/.swarmz-release/updater.key`, then put
  the new `updater.key.pub` contents in `plugins.updater.pubkey` and the private key and password
  in the two repository secrets. Everyone on an older build must install the next release by hand
  (download the DMG): their copy will not accept anything signed by the new key. Keep the old key
  until every machine has moved.
- **Developer ID certificate.** Create a new one in the Apple Developer portal, export it as a
  `.p12`, replace `~/.swarmz-release/developer-id.p12` and the `APPLE_CERTIFICATE` /
  `APPLE_CERTIFICATE_PASSWORD` secrets, and update `APPLE_SIGNING_IDENTITY` if the name changed.
  This one is safe to rotate: notarisation, not the certificate, is what Gatekeeper checks.
- **App Store Connect key.** In App Store Connect → Users and Access → Integrations → App Store
  Connect API, revoke the old key and generate a new one with the **Developer** role. The `.p8`
  can only be downloaded once, so save it before leaving the page. Update `APPLE_API_KEY` (its
  text) and `APPLE_API_KEY_ID`; `APPLE_API_ISSUER` only changes if the team does. Nothing that is
  already released is affected — the key authenticates the notarisation request, and tickets
  already stapled stay valid. Check it before relying on it:
  `xcrun notarytool history --key AuthKey_<id>.p8 --key-id <id> --issuer <issuer>`.
- **Android keystore.** There is no rotation: a new key means a new `applicationId`, or every
  phone uninstalling and reinstalling. Treat `~/.swarmz-android/release.jks` as permanent.

## Limitations

- The macOS build is **arm64 only**. `bundle.macOS.files` copies `swarmz-tool` from
  `src-tauri/target/release/`, which is only where `npm run build:tool` puts it for the host
  target; building `--target universal-apple-darwin` would need `build:tool` to follow the same
  triple first.
- The first release has to be published by hand before any updater can see it, and `latest.json`
  only ever points at the most recent **published** release.
- **Check `latest.json` after the first publish.** The action writes the download URLs while the
  release is still a draft, and a draft has no tag page, so they can come out as
  `/releases/download/untagged-<hash>/…` instead of `/releases/download/v<version>/…`. An
  `untagged-` URL stops working the moment the release is published and every updater 404s. Open
  the attached `latest.json` and look before announcing anything; if it is wrong, fix the URLs and
  re-upload that one file.
- **A failed `android` job leaves a draft with no APK.** The desktop half is complete and
  publishable, but phones get nothing. Either re-run the job or attach the APK by hand
  (`gh release upload v<version> swarmz-<version>.apk`) before publishing.
- **A failed `macos` job can leave an empty draft release behind**, because `tauri-action` creates
  the release before it finishes building. Delete that draft before re-tagging, or the next run
  attaches its artifacts alongside the stale ones.
- **Anything new inside the bundle must be signed too.** Today `bundle.macOS.files` has exactly
  one entry and there is no `externalBin` or `resources`, so `swarmz-tool` is the only extra
  Mach-O. Adding another executable means signing it in `scripts/build-tool.mjs` alongside the
  tool, or notarisation will reject the release the same way it rejected v0.2.0.
- **Pre-release tags are not supported.** `v0.3.0-rc1` matches the workflow's `v*` trigger, but
  `npm run version` refuses a pre-release suffix (the Android `versionCode` has nowhere to put it,
  and the updater compares plain versions), so the tag/version guard fails the run and the command
  it suggests would fail too. Ship pre-releases, if they are ever needed, as ordinary patch
  versions from a branch — or teach `scripts/version.mjs` and the Android `versionCode` about
  suffixes first.
- **Re-running a tag reuses the draft, and mostly does the right thing.** `tauri-action` finds an
  existing *draft* by tag and uploads into it, deleting any asset whose name it is about to
  re-upload, and it does **not** touch a draft's name or body (it only updates those on a
  *published* release), so notes written in the draft survive a re-run. Two things do not:
  `latest.json`'s `platforms` map is seeded from the copy already attached, so an entry from an
  earlier run for a platform the new run does not build stays behind; and if the release for that
  tag has already been **published**, the action refuses outright with "Found release with tag …
  but it's NOT a draft!". Cleanest is to delete the draft before re-running.
- **Deleting the draft does not delete the tag.** To re-run a release, delete the draft on GitHub,
  then `git push --delete origin v<version>` and push the tag again; a tag push is what triggers
  the workflow, and `concurrency` queues a second run rather than cancelling the first.
