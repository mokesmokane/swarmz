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

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PermissionCard(pending: Pending, horizontal: Boolean, onAnswer: (Opt) -> Unit) {
    SwCard(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), highlighted = true) {
        Badge("permission", color = Sw.NeedsYou)
        Text(
            buildAnnotatedString {
                append("Run ")
                withStyle(SpanStyle(fontFamily = Mono, color = Sw.Code)) { append(pending.summary) }
                append("?")
            },
            style = MaterialTheme.typography.bodyLarge,
        )
        val buttons: @Composable (Modifier) -> Unit = { m ->
            pending.options.forEachIndexed { i, opt ->
                if (i == 0) PrimaryButton(opt.label, { onAnswer(opt) }, m)
                else QuietButton(opt.label, { onAnswer(opt) }, m, color = if (opt.label.startsWith("No")) Sw.ErrorLine else Sw.Body)
            }
        }
        if (horizontal) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) { buttons(Modifier) }
        }
        else Column(verticalArrangement = Arrangement.spacedBy(6.dp)) { buttons(Modifier.fillMaxWidth()) }
    }
}
