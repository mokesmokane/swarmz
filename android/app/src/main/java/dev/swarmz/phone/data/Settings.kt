package dev.swarmz.phone.data

import android.content.Context
import androidx.datastore.core.handlers.ReplaceFileCorruptionHandler
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.swarmz.phone.ssh.HostKeyPins
import dev.swarmz.phone.state.TileKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.ExperimentalForInheritanceCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

@Serializable data class Paired(val host: String, val user: String, val device: String)
@Serializable data class KnownMac(val name: String, val label: String, val lastSeen: Long? = null)

val DEFAULT_NOTIFY = setOf("permission", "question", "finished")

/**
 * [p] in place of the entry for the same Mac, or at the end. Matched the way the links are ([sameMac]), so a Mac
 * paired again under its other name replaces its pairing instead of adding a second, stale one.
 */
fun List<Paired>.withPairing(p: Paired): List<Paired> =
    if (any { sameMac(it.host, p.host) }) map { if (sameMac(it.host, p.host)) p else it } else this + p

interface SettingsStore : HostKeyPins {
    /** The first pairing: the Mac this phone paired with first. */
    val paired: StateFlow<Paired?>
    /** Every paired Mac, in the order they were paired; the first is [paired]. */
    val pairings: StateFlow<List<Paired>>
    val macs: StateFlow<List<KnownMac>>
    val seen: StateFlow<Map<TileKey, Instant>>
    val dictationLanguage: StateFlow<String?>
    val backgroundWatch: StateFlow<Boolean>
    val notifyKinds: StateFlow<Set<String>>
    /** Replaces every pairing with [p] alone (or none). */
    suspend fun setPaired(p: Paired?)
    /** Adds [p], replacing a pairing with the same host and keeping the order; the first addition becomes [paired]. */
    suspend fun addPairing(p: Paired)
    suspend fun setMacs(list: List<KnownMac>)
    suspend fun markSeen(key: TileKey, at: Instant)
    suspend fun setDictationLanguage(tag: String?)
    suspend fun setBackgroundWatch(on: Boolean)
    suspend fun setNotifyKinds(kinds: Set<String>)
    suspend fun forgetPairing()

    /** The saved Macs as stored now, consistent with [paired] (the [macs] flow can trail a write). */
    suspend fun loadMacs(): List<KnownMac> = macs.value
}

class MemorySettings : SettingsStore {
    private val all = MutableStateFlow<List<Paired>>(emptyList())
    override val pairings: StateFlow<List<Paired>> = all.asStateFlow()
    /** The first pairing, a view of [pairings]; setting it directly starts the list over, as [setPaired] does. */
    override val paired: MutableStateFlow<Paired?> = FirstPairing(all)
    override val macs = MutableStateFlow<List<KnownMac>>(emptyList())
    override val seen = MutableStateFlow<Map<TileKey, Instant>>(emptyMap())
    override val dictationLanguage = MutableStateFlow<String?>(null)
    override val backgroundWatch = MutableStateFlow(true)
    override val notifyKinds = MutableStateFlow(DEFAULT_NOTIFY)
    private val pins = ConcurrentHashMap<String, String>()
    override fun get(id: String) = pins[id]
    override fun put(id: String, fingerprint: String) { pins[id] = fingerprint }
    override suspend fun setPaired(p: Paired?) { all.value = listOfNotNull(p) }
    override suspend fun addPairing(p: Paired) { all.update { it.withPairing(p) } }
    override suspend fun setMacs(list: List<KnownMac>) {
        // A discovery round that finishes after forgetPairing must not bring the Macs back.
        if (paired.value == null) return
        macs.value = list
    }
    override suspend fun markSeen(key: TileKey, at: Instant) { seen.update { it + (key to at) } }
    override suspend fun setDictationLanguage(tag: String?) { dictationLanguage.value = tag }
    override suspend fun setBackgroundWatch(on: Boolean) { backgroundWatch.value = on }
    override suspend fun setNotifyKinds(kinds: Set<String>) { notifyKinds.value = kinds }
    override suspend fun forgetPairing() {
        all.value = emptyList()
        macs.value = emptyList()
        seen.value = emptyMap()
        pins.clear()
    }
}

/** The first entry of [all], as a flow that can be set: a write replaces every pairing, as `setPaired` does. */
@OptIn(ExperimentalForInheritanceCoroutinesApi::class, ExperimentalCoroutinesApi::class)
private class FirstPairing(private val all: MutableStateFlow<List<Paired>>) : MutableStateFlow<Paired?> {
    override var value: Paired?
        get() = all.value.firstOrNull()
        set(p) { all.value = listOfNotNull(p) }
    override val replayCache: List<Paired?> get() = listOf(value)
    override val subscriptionCount: StateFlow<Int> get() = all.subscriptionCount
    override suspend fun collect(collector: FlowCollector<Paired?>): Nothing {
        all.map { it.firstOrNull() }.distinctUntilChanged().collect(collector)
        error("a state flow never completes")
    }
    override suspend fun emit(value: Paired?) { this.value = value }
    override fun tryEmit(value: Paired?): Boolean {
        this.value = value
        return true
    }
    override fun compareAndSet(expect: Paired?, update: Paired?): Boolean {
        while (true) {
            val current = all.value
            if (current.firstOrNull() != expect) return false
            if (all.compareAndSet(current, listOfNotNull(update))) return true
        }
    }
    override fun resetReplayCache() = throw UnsupportedOperationException("a state flow keeps its value")
}

/** A settings file that no longer parses starts over empty (the phone then asks to pair again) rather than failing every read. */
internal val SETTINGS_CORRUPTION_HANDLER = ReplaceFileCorruptionHandler { emptyPreferences() }

internal val Context.swarmzStore by preferencesDataStore(name = "swarmz_settings", corruptionHandler = SETTINGS_CORRUPTION_HANDLER)

internal object K {
    val paired = stringPreferencesKey("paired")
    val pairings = stringPreferencesKey("pairings")
    val macs = stringPreferencesKey("macs")
    val seen = stringPreferencesKey("seen")
    val pins = stringPreferencesKey("pins")
    val language = stringPreferencesKey("dictation_language")
    val background = booleanPreferencesKey("background_watch")
    val notify = stringSetPreferencesKey("notify_kinds")
}

private fun seenKey(key: TileKey) = "${key.mac}|${key.id}"

/** Null for a key that is not `mac|id`. */
private fun parseSeenKey(s: String): TileKey? {
    val parts = s.split('|')
    if (parts.size != 2 || parts[0].isEmpty() || parts[1].isEmpty()) return null
    return TileKey(parts[0], parts[1])
}

class DataStoreSettings(context: Context, private val scope: CoroutineScope) : SettingsStore {
    private val store = context.applicationContext.swarmzStore
    private val json = Json { ignoreUnknownKeys = true }
    private val pinCache = ConcurrentHashMap<String, String>()
    private val pinWrites = Mutex()

    /** The store as it was when this was created. Every field starts from it, so none reads as unset while loading. */
    private val loaded: Preferences = runBlocking { store.data.first() }

    init {
        val saved = loaded[K.pins]
        if (saved != null) runCatching { json.decodeFromString<Map<String, String>>(saved) }.getOrNull()?.let(pinCache::putAll)
    }

    /** Writes a single stored pairing (from before the list) into the list; done once the job completes. */
    internal val migrated: Job = scope.launch {
        if (loaded[K.pairings] != null) return@launch
        store.edit { p -> if (p[K.pairings] == null && readPairings(p).isNotEmpty()) p[K.pairings] = json.encodeToString(readPairings(p)) }
    }

    private fun <T> field(read: (Preferences) -> T): StateFlow<T> =
        store.data.map(read).stateIn(scope, SharingStarted.Eagerly, read(loaded))

    // A stored value that no longer decodes reads as unset rather than failing the flow.
    private inline fun <reified T> decodeOrNull(text: String?): T? =
        text?.let { runCatching { json.decodeFromString<T>(it) }.getOrNull() }

    private fun seenTimes(p: Preferences): Map<String, Long> = decodeOrNull<Map<String, Long>>(p[K.seen]) ?: emptyMap()

    private fun readMacs(p: Preferences): List<KnownMac> = decodeOrNull<List<KnownMac>>(p[K.macs]) ?: emptyList()

    /** The stored list; before it existed, the single stored pairing. */
    private fun readPairings(p: Preferences): List<Paired> =
        decodeOrNull<List<Paired>>(p[K.pairings])?.takeIf { it.isNotEmpty() }
            ?: listOfNotNull(decodeOrNull<Paired>(p[K.paired]))

    override val pairings = field(::readPairings)
    override val paired = field { p -> readPairings(p).firstOrNull() }
    override val macs = field(::readMacs)
    override val seen = field { p ->
        seenTimes(p).entries.mapNotNull { (k, v) -> parseSeenKey(k)?.let { it to Instant.ofEpochMilli(v) } }.toMap()
    }
    override val dictationLanguage = field { p -> p[K.language] }
    override val backgroundWatch = field { p -> p[K.background] ?: true }
    override val notifyKinds = field { p -> p[K.notify] ?: DEFAULT_NOTIFY }

    override suspend fun loadMacs(): List<KnownMac> = readMacs(store.data.first())

    override fun get(id: String): String? = pinCache[id]

    override fun put(id: String, fingerprint: String) {
        pinCache[id] = fingerprint
        scope.launch { flushPins() }
    }

    suspend fun flushPins() {
        pinWrites.withLock {
            val snapshot = json.encodeToString(pinCache.toMap())
            store.edit { it[K.pins] = snapshot }
        }
    }

    override suspend fun setPaired(p: Paired?) {
        store.edit { writePairings(it, listOfNotNull(p)) }
    }

    override suspend fun addPairing(p: Paired) {
        store.edit { writePairings(it, readPairings(it).withPairing(p)) }
    }

    /** Stores [list], with its first entry also under the single key (which [setMacs] checks). */
    private fun writePairings(prefs: MutablePreferences, list: List<Paired>) {
        if (list.isEmpty()) {
            prefs.remove(K.paired)
            prefs.remove(K.pairings)
        } else {
            prefs[K.paired] = json.encodeToString(list.first())
            prefs[K.pairings] = json.encodeToString(list)
        }
    }

    override suspend fun setMacs(list: List<KnownMac>) {
        // Checked in the same edit: a discovery round that finishes after forgetPairing must not bring the Macs back.
        store.edit { if (it[K.paired] != null) it[K.macs] = json.encodeToString(list) }
    }

    override suspend fun markSeen(key: TileKey, at: Instant) {
        store.edit { p ->
            val current = seenTimes(p)
            p[K.seen] = json.encodeToString(current + (seenKey(key) to at.toEpochMilli()))
        }
    }

    override suspend fun setDictationLanguage(tag: String?) {
        store.edit { if (tag == null) it.remove(K.language) else it[K.language] = tag }
    }

    override suspend fun setBackgroundWatch(on: Boolean) {
        store.edit { it[K.background] = on }
    }

    override suspend fun setNotifyKinds(kinds: Set<String>) {
        store.edit { it[K.notify] = kinds }
    }

    override suspend fun forgetPairing() {
        // Under the pin lock, so a flush that already took its snapshot cannot write the old pins back afterwards.
        pinWrites.withLock {
            pinCache.clear()
            store.edit {
                it.remove(K.paired)
                it.remove(K.pairings)
                it.remove(K.macs)
                it.remove(K.seen)
                it.remove(K.pins)
            }
        }
    }
}
