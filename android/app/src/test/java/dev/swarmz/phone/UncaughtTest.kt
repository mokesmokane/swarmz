package dev.swarmz.phone

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLog

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class UncaughtTest {
    @Test
    fun aFailingBackgroundTaskIsLoggedAndTheScopeLivesOn() = runBlocking {
        ShadowLog.clear()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default + uncaughtLogger())
        scope.launch { throw IllegalStateException("boom") }.join()
        val logs = ShadowLog.getLogsForTag(LOG_TAG)
        assertEquals(1, logs.size)
        assertEquals("swarmz", LOG_TAG)
        assertTrue(logs.single().throwable is IllegalStateException)
        assertTrue(logs.single().msg.contains("IllegalStateException"))
        assertTrue(scope.isActive)
        scope.launch { }.join()
        scope.cancel()
    }
}
