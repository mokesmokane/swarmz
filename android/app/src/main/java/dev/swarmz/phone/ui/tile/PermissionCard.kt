package dev.swarmz.phone.ui.tile

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import dev.swarmz.phone.proto.Opt
import dev.swarmz.phone.proto.Pending
import dev.swarmz.phone.ui.components.Badge
import dev.swarmz.phone.ui.components.PrimaryButton
import dev.swarmz.phone.ui.components.QuietButton
import dev.swarmz.phone.ui.components.SwCard
import dev.swarmz.phone.ui.theme.Mono
import dev.swarmz.phone.ui.theme.Sw

/**
 * The card for what a tile is asking: a permission prompt ("Run `<summary>`?") or a question
 * Claude asks (its text, and each option with its description). A multi-select question's
 * options toggle (ticked ones show a check) and its Submit entry is a button of its own.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PermissionCard(pending: Pending, horizontal: Boolean, onAnswer: (Opt) -> Unit, onSubmit: () -> Unit = {}) {
    val question = pending.kind == "question"
    SwCard(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), highlighted = true) {
        Badge(if (question) "question" else "permission", color = Sw.NeedsYou)
        if (question) {
            Text(pending.summary, style = MaterialTheme.typography.bodyLarge)
        } else {
            Text(
                buildAnnotatedString {
                    append("Run ")
                    withStyle(SpanStyle(fontFamily = Mono, color = Sw.Code)) { append(pending.summary) }
                    append("?")
                },
                style = MaterialTheme.typography.bodyLarge,
            )
        }
        val buttons: @Composable (Modifier) -> Unit = { m ->
            pending.options.forEachIndexed { i, opt ->
                val label = if (opt.checked == true) "✔ ${opt.label}" else opt.label
                val primary = i == 0 && !pending.multi
                Column(m) {
                    if (primary) PrimaryButton(label, { onAnswer(opt) }, Modifier.fillMaxWidth())
                    else QuietButton(label, { onAnswer(opt) }, Modifier.fillMaxWidth(), color = if (!question && opt.label.startsWith("No")) Sw.ErrorLine else Sw.Body)
                    opt.description?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Sw.Secondary, modifier = Modifier.padding(horizontal = 12.dp)) }
                }
            }
            if (pending.multi && pending.submit) PrimaryButton("Submit", onSubmit, m)
        }
        if (horizontal) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) { buttons(Modifier) }
        }
        else Column(verticalArrangement = Arrangement.spacedBy(6.dp)) { buttons(Modifier.fillMaxWidth()) }
    }
}
