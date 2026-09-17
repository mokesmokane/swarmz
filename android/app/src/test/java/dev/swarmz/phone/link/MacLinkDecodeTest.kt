package dev.swarmz.phone.link

import android.os.Looper
import dev.swarmz.phone.ssh.Auth
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Decodes any object, recording the thread it was decoded on. */
@Serializable(with = ThreadProbe.Codec::class)
class ThreadProbe(val thread: Thread) {
    object Codec : KSerializer<ThreadProbe> {
        override val descriptor = JsonObject.serializer().descriptor
        override fun deserialize(decoder: Decoder): ThreadProbe {
            decoder.decodeSerializableValue(JsonObject.serializer())
            return ThreadProbe(Thread.currentThread())
        }
        override fun serialize(encoder: Encoder, value: ThreadProbe) = error("decode only")
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MacLinkDecodeTest {
    @Test
    fun repliesAreNotDecodedOnTheMainThread() = runBlocking {
        assertTrue("Robolectric runs tests on the main thread", Looper.getMainLooper().isCurrentThread)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val link = MacLink("mini", "mini", { Auth.Password("me", CharArray(0)) }, FakeConnector(FakeConn()), scope)
        link.start()
        link.state.first { it is LinkState.Online }
        val main = Thread.currentThread()
        assertNotEquals(main, link.call<ThreadProbe>("anything").thread)
        // Off the main thread, the reply is decoded where the caller runs.
        withContext(Dispatchers.IO) {
            val here = Thread.currentThread()
            assertEquals(here, link.call<ThreadProbe>("anything").thread)
        }
        scope.cancel()
    }
}
