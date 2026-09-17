package dev.swarmz.phone.proto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CmdTest {
    private val t = "89dc486f-f4ef-4212-baae-66f223346526"

    @Test
    fun quoting() {
        assertEquals("'abc'", Cmd.quote("abc"))
        assertEquals("'it'\\''s'", Cmd.quote("it's"))
        assertEquals("''", Cmd.quote(""))
        assertEquals("'a\nb'", Cmd.quote("a\nb"))
    }

    @Test
    fun commands() {
        assertEquals("swarmz 'ls'", Cmd.ls())
        assertEquals("swarmz 'watch'", Cmd.watch())
        assertEquals("swarmz 'folders'", Cmd.folders(null))
        assertEquals("swarmz 'folders' '/Users/me/my dir'", Cmd.folders("/Users/me/my dir"))
        assertEquals("swarmz 'transcript' '$t' '--limit' '50'", Cmd.transcript(t))
        assertEquals("swarmz 'transcript' '$t' '--limit' '20' '--before' 'u1'", Cmd.transcript(t, before = "u1", limit = 20))
        assertEquals("swarmz 'transcript' '$t' '--limit' '50' '--after' 'a2' '--follow'", Cmd.transcript(t, after = "a2", follow = true))
        assertEquals("swarmz 'output' '$t' '--lines' '300' '--follow'", Cmd.output(t, lines = 300, follow = true))
        assertEquals("swarmz 'send' '$t' '--' '--rm it'\\''s'", Cmd.send(t, "--rm it's"))
        assertEquals("swarmz 'key' '$t' 'shift-tab'", Cmd.key(t, Key.ShiftTab))
        assertEquals("swarmz 'answer' '$t' 'yes' '--summary' '--x'", Cmd.answer(t, "yes", "--x"))
        assertEquals("swarmz 'new' '--folder' '/p' '--skip-permissions'", Cmd.newTile("/p", skipPermissions = true))
        assertEquals("swarmz 'new' '--folder' '/p' '--name' 'api'", Cmd.newTile("/p", skipPermissions = false, name = "api"))
        assertEquals("swarmz 'restart' '$t'", Cmd.restart(t))
        assertEquals("swarmz 'image' '$t' 'u2-1'", Cmd.image(t, "u2-1"))
        assertEquals("swarmz 'phone' 'revoke' 'Galaxy Fold'", Cmd.phoneRevoke("Galaxy Fold"))
        assertEquals(
            "~/.swarmz/bin/swarmz 'phone' 'add' '--name' 'Galaxy Fold' '--key' 'ssh-ed25519 AAAA'",
            Cmd.phoneAdd("Galaxy Fold", "ssh-ed25519 AAAA"),
        )
    }

    @Test(expected = IllegalArgumentException::class)
    fun badTileIdsAreRefused() {
        Cmd.pending("../x")
    }

    @Test
    fun deviceNames() {
        assertTrue(validDevice("Galaxy Z Fold 6"))
        assertTrue(validDevice("fold-7.b_c"))
        assertFalse(validDevice(" fold"))
        assertFalse(validDevice("fold "))
        assertFalse(validDevice("a  b"))
        assertFalse(validDevice("it's"))
        assertFalse(validDevice(""))
        assertFalse(validDevice("a".repeat(41)))
    }
}
