package dev.swarmz.phone.ui.tile

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.text.input.TextFieldValue
import dev.swarmz.phone.data.Repository
import dev.swarmz.phone.state.TileKey
import kotlinx.coroutines.CoroutineScope
import java.time.Instant

class TileController(
    val key: TileKey,
    private val repo: Repository,
    private val parent: CoroutineScope,
    private val now: () -> Instant,
) {
    val draft: MutableState<TextFieldValue> = mutableStateOf(TextFieldValue(""))
    val listState = LazyListState()

    fun close() {}
}
