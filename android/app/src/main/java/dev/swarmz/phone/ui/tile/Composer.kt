package dev.swarmz.phone.ui.tile

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import dev.swarmz.phone.ui.theme.Sw

@Composable
fun Composer(
    state: MutableState<androidx.compose.ui.text.input.TextFieldValue>,
    placeholder: String,
    enabled: Boolean,
    onSend: () -> Unit,
    onAttach: (() -> Unit)? = null,
) {
    Row(
        Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 10.dp),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // An agent tile (Claude or Codex) takes files (phone attachments spec §4.3): the path lands in the draft.
        if (onAttach != null) {
            IconButton(onClick = onAttach, enabled = enabled, modifier = Modifier.size(52.dp).testTag("attach")) {
                Icon(Icons.Filled.AttachFile, contentDescription = "Attach", tint = Sw.Title)
            }
        }
        OutlinedTextField(
            value = state.value,
            onValueChange = { state.value = it },
            enabled = enabled,
            placeholder = { Text(placeholder, color = Sw.Muted) },
            maxLines = 6,
            modifier = Modifier.weight(1f).testTag("composer"),
            shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp),
            colors = OutlinedTextFieldDefaults.colors(unfocusedBorderColor = Sw.Border3, focusedBorderColor = Sw.Border4, unfocusedContainerColor = Sw.Card, focusedContainerColor = Sw.Card),
            trailingIcon = if (state.value.text.isNotBlank() && enabled) {
                { IconButton(onClick = onSend) { Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send", tint = Sw.Title) } }
            } else null,
        )
    }
}
