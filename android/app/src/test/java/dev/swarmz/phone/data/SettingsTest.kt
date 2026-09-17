package dev.swarmz.phone.data

import androidx.datastore.preferences.core.edit
import androidx.test.core.app.ApplicationProvider
import dev.swarmz.phone.state.TileKey
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SettingsTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun aCorruptStoreIsReplacedWithAnEmptyOne() = runBlocking {
        val file = tmp.root.resolve("bad.preferences_pb").apply { writeBytes(byteArrayOf(0x7F, 0x01, 0x02, 0x03)) }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val store = androidx.datastore.preferences.core.PreferenceDataStoreFactory.create(
            corruptionHandler = SETTINGS_CORRUPTION_HANDLER,
            scope = scope,
            produceFile = { file },
        )
        assertEquals(androidx.datastore.preferences.core.emptyPreferences(), store.data.first())
        store.edit { it[K.language] = "en-GB" }
        assertEquals("en-GB", store.data.first()[K.language])
        scope.cancel()
    }

    @Test
    fun valuesPersistAcrossInstances() = runBlocking {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val scope1 = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val a = DataStoreSettings(ctx, scope1)
        a.setPaired(Paired("mini", "me", "Fold"))
        a.markSeen(TileKey("mini", "t1"), Instant.ofEpochSecond(100))
        a.put("mini:22", "SHA256:abc")
        a.setDictationLanguage("en-GB")
        a.setBackgroundWatch(false)
        a.flushPins()
        scope1.cancel()
        val scope2 = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val b = DataStoreSettings(ctx, scope2)
        // Loaded before the first frame, even when the scope has not run yet: no pairing screen flashes for a paired phone.
        val idle = CoroutineScope(SupervisorJob() + kotlinx.coroutines.test.StandardTestDispatcher())
        val early = DataStoreSettings(ctx, idle)
        assertEquals(Paired("mini", "me", "Fold"), early.paired.value)
        assertEquals("en-GB", early.dictationLanguage.value)
        assertEquals(false, early.backgroundWatch.value)
        idle.cancel()
        assertEquals(Paired("mini", "me", "Fold"), b.paired.first { it != null })
        assertEquals(Instant.ofEpochSecond(100), b.seen.first { it.isNotEmpty() }[TileKey("mini", "t1")])
        assertEquals("SHA256:abc", b.get("mini:22"))
        assertEquals("en-GB", b.dictationLanguage.first { it != null })
        assertEquals(false, b.backgroundWatch.first { !it })
        b.forgetPairing()
        assertNull(b.paired.first { it == null })
        assertNull(b.get("mini:22"))
        scope2.cancel()
    }
    @Test
    fun corruptValuesReadAsDefaults() = runBlocking {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        ctx.swarmzStore.edit {
            it.clear()
            it[K.paired] = "{not json"
            it[K.macs] = "[1,"
            it[K.pins] = "garbage"
            it[K.seen] = """{"nobar":1,"a|b|c":2,"|x":3,"mini|t1":4000}"""
        }
        val failures = java.util.Collections.synchronizedList(mutableListOf<Throwable>())
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO + CoroutineExceptionHandler { _, e -> failures += e })
        val s = DataStoreSettings(ctx, scope)
        assertEquals(mapOf(TileKey("mini", "t1") to Instant.ofEpochMilli(4000)), s.seen.first { it.isNotEmpty() })
        assertNull(s.paired.value)
        assertEquals(emptyList<KnownMac>(), s.macs.value)
        assertNull(s.get("mini:22"))
        // Writes still work on top of the bad values.
        s.markSeen(TileKey("mini", "t2"), Instant.ofEpochMilli(5000))
        s.put("mini:22", "SHA256:x")
        s.flushPins()
        assertEquals(Instant.ofEpochMilli(5000), s.seen.first { it.size == 2 }[TileKey("mini", "t2")])
        assertEquals("SHA256:x", DataStoreSettings(ctx, scope).get("mini:22"))
        assertEquals(emptyList<Throwable>(), failures.toList())
        scope.cancel()
    }

    @Test
    fun macsAreIgnoredWhenUnpaired() = runBlocking {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        ctx.swarmzStore.edit { it.clear() }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val s = DataStoreSettings(ctx, scope)
        s.setMacs(listOf(KnownMac("mini", "Mini")))
        assertNull(ctx.swarmzStore.data.first()[K.macs])
        s.setPaired(Paired("mini", "me", "Fold"))
        s.setMacs(listOf(KnownMac("mini", "Mini")))
        assertEquals(listOf(KnownMac("mini", "Mini")), s.macs.first { it.isNotEmpty() })
        s.forgetPairing()
        s.setMacs(listOf(KnownMac("mini", "Mini")))
        assertNull(ctx.swarmzStore.data.first()[K.macs])
        scope.cancel()
    }

    @Test
    fun aSinglePairingIsMigratedIntoTheList() = runBlocking {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        ctx.swarmzStore.edit {
            it.clear()
            it[K.paired] = """{"host":"mini","user":"me","device":"Fold"}"""
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val s = DataStoreSettings(ctx, scope)
        assertEquals(listOf(Paired("mini", "me", "Fold")), s.pairings.value)
        assertEquals(Paired("mini", "me", "Fold"), s.paired.value)
        // The list is written back, so later versions find it stored.
        s.migrated.join()
        assertEquals(listOf(Paired("mini", "me", "Fold")), kotlinx.serialization.json.Json.decodeFromString<List<Paired>>(ctx.swarmzStore.data.first()[K.pairings]!!))
        scope.cancel()
    }

    @Test
    fun addingAPairingKeepsOrderAndReplacesTheSameHost() = runBlocking {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        ctx.swarmzStore.edit { it.clear() }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val s = DataStoreSettings(ctx, scope)
        // With nothing paired, the first addition is the first pairing.
        s.addPairing(Paired("mini", "me", "Fold"))
        s.addPairing(Paired("studio", "ann", "Fold"))
        s.addPairing(Paired("air", "me", "Fold"))
        s.addPairing(Paired("studio", "bob", "Fold"))
        // The same Mac under its full MagicDNS name is the same pairing, not a second one.
        s.addPairing(Paired("studio.tail.ts.net", "kim", "Fold"))
        val want = listOf(Paired("mini", "me", "Fold"), Paired("studio.tail.ts.net", "kim", "Fold"), Paired("air", "me", "Fold"))
        assertEquals(want, withTimeout(5_000) { s.pairings.first { it == want } })
        assertEquals(Paired("mini", "me", "Fold"), s.paired.value)
        // Another instance reads the same list.
        assertEquals(want, DataStoreSettings(ctx, scope).pairings.value)
        // setPaired starts over with one pairing; forgetting clears them all.
        s.setPaired(Paired("other", "me", "Fold"))
        assertEquals(listOf(Paired("other", "me", "Fold")), withTimeout(5_000) { s.pairings.first { it.size == 1 } })
        s.forgetPairing()
        assertEquals(emptyList<Paired>(), withTimeout(5_000) { s.pairings.first { it.isEmpty() } })
        assertNull(s.paired.first { it == null })
        scope.cancel()
    }

    @Test
    fun memorySettingsMirrorThePairingList() = runBlocking {
        val s = MemorySettings()
        assertEquals(emptyList<Paired>(), s.pairings.value)
        // The first pairing is derived from the list, whichever way the list is written.
        s.setPaired(Paired("mini", "me", "Fold"))
        assertEquals(listOf(Paired("mini", "me", "Fold")), s.pairings.value)
        s.addPairing(Paired("studio", "ann", "Fold"))
        s.addPairing(Paired("air", "me", "Fold"))
        s.addPairing(Paired("studio", "bob", "Fold"))
        s.addPairing(Paired("mini.tail.ts.net", "root", "Fold"))
        assertEquals(
            listOf(Paired("mini.tail.ts.net", "root", "Fold"), Paired("studio", "bob", "Fold"), Paired("air", "me", "Fold")),
            s.pairings.value,
        )
        assertEquals(Paired("mini.tail.ts.net", "root", "Fold"), s.paired.value)
        // Both flows emit, not just their values.
        assertEquals(3, s.pairings.first().size)
        assertEquals(Paired("mini.tail.ts.net", "root", "Fold"), s.paired.first())
        s.forgetPairing()
        assertEquals(emptyList<Paired>(), s.pairings.value)
        assertNull(s.paired.value)
    }
}
