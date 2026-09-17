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
}
