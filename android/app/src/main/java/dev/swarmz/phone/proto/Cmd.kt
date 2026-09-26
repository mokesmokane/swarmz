package dev.swarmz.phone.proto

enum class Key(val word: String) { Esc("esc"), CtrlC("ctrl-c"), Tab("tab"), ShiftTab("shift-tab"), Up("up"), Down("down"), Enter("enter") }

private val TILE = Regex("^[A-Za-z0-9-]{1,64}$")
private val DEVICE = Regex("^[A-Za-z0-9._-]+( [A-Za-z0-9._-]+)*$")

/** Spec §7.2: letters, digits, `.`, `_`, `-`, single inner spaces, up to 40 characters. */
fun validDevice(name: String): Boolean = name.length in 1..40 && DEVICE.matches(name)

/** `phone add` and `phone revoke` fan out to every other Mac (about 15 s each, in parallel), so they get longer. */
const val PHONE_KEY_EXEC_MS = 60_000L

/** The tool's command lines (spec §4.1). Phone keys go through the ssh gate, which splits with POSIX rules. */
object Cmd {
    const val TOOL = "swarmz"
    const val TOOL_PATH = "~/.swarmz/bin/swarmz"

    fun quote(s: String): String = "'" + s.replace("'", "'\\''") + "'"

    fun validTile(id: String): Boolean = TILE.matches(id)

    private fun tile(id: String): String {
        require(validTile(id)) { "invalid tile id" }
        return id
    }

    private fun of(vararg words: String): String = (listOf(TOOL) + words.map(::quote)).joinToString(" ")

    fun version() = of("version")
    fun ls() = of("ls")
    fun watch() = of("watch")
    fun machines() = of("machines")
    fun folders(path: String?) = if (path == null) of("folders") else of("folders", path)

    fun transcript(tile: String, before: String? = null, after: String? = null, limit: Int = 50, follow: Boolean = false): String {
        val words = mutableListOf("transcript", tile(tile), "--limit", limit.toString())
        if (before != null) words += listOf("--before", before)
        if (after != null) words += listOf("--after", after)
        if (follow) words += "--follow"
        return of(*words.toTypedArray())
    }

    fun image(tile: String, imageId: String) = of("image", tile(tile), imageId)

    fun output(tile: String, lines: Int = 200, follow: Boolean = false): String {
        val words = mutableListOf("output", tile(tile), "--lines", lines.toString())
        if (follow) words += "--follow"
        return of(*words.toTypedArray())
    }

    fun send(tile: String, text: String) = of("send", tile(tile), "--", text)
    fun key(tile: String, name: Key) = of("key", tile(tile), name.word)
    fun pending(tile: String) = of("pending", tile(tile))
    fun answer(tile: String, choice: String, summary: String) = of("answer", tile(tile), choice, "--summary", summary)

    fun newTile(folder: String, skipPermissions: Boolean, name: String? = null, agent: Agent = Agent.Claude): String {
        val words = mutableListOf("new", "--folder", folder)
        // Claude is the tool's default, so only Codex is named (an older tool knows no `--agent`).
        if (agent == Agent.Codex) words += listOf("--agent", agent.arg)
        if (skipPermissions) words += "--skip-permissions"
        if (name != null) words += listOf("--name", name)
        return of(*words.toTypedArray())
    }

    /** Sets a title the user typed (`--user`); an empty title hands it back (spec §3.1, §6). */
    fun cardTitle(tile: String, title: String) = of("card", "--tile", tile(tile), "--title", title, "--user")
    /** Reads `size` bytes from stdin into the Mac's paste folder (phone attachments spec §3.1). */
    fun upload(name: String, size: Long) = of("upload", "--name", name, "--size", size.toString())
    fun restart(tile: String) = of("restart", tile(tile))
    fun close(tile: String) = of("close", tile(tile))
    /** Approves a claim, or makes [tile] the conductor (conductor spec §7); a phone key may. */
    fun conductorSet(tile: String) = of("conductor", "--set", tile(tile))
    fun conductorDeny() = of("conductor", "--deny")
    fun phoneLs() = of("phone", "ls")
    fun phoneRevoke(device: String) = of("phone", "revoke", device)

    /** Runs in the one-off password session, where no gate applies: the remote shell expands `~`. */
    fun phoneAdd(device: String, publicKey: String): String =
        (listOf(TOOL_PATH) + listOf("phone", "add", "--name", device, "--key", publicKey).map(::quote)).joinToString(" ")
}
