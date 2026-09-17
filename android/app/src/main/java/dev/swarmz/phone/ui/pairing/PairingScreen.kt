package dev.swarmz.phone.ui.pairing

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import dev.swarmz.phone.ui.PairingUi
import dev.swarmz.phone.ui.components.PrimaryButton
import dev.swarmz.phone.ui.theme.Sw

@Composable
fun PairingScreen(ui: PairingUi, defaultDevice: String, onPair: (host: String, user: String, password: CharArray, device: String) -> Unit) {
    var host by rememberSaveable { mutableStateOf("") }
    var user by rememberSaveable { mutableStateOf("") }
    // Never saved to instance state.
    var password by remember { mutableStateOf("") }
    var device by rememberSaveable { mutableStateOf(defaultDevice) }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("swarmz", style = MaterialTheme.typography.headlineSmall)
        Text("Pair with a Mac", style = MaterialTheme.typography.titleMedium)
        Text(
            "Use the Mac's Tailscale name and your Mac login. The password is used once to add this phone's key and is not stored. Remote Login must be on, and swarmz must have run on that Mac once.",
            style = MaterialTheme.typography.bodySmall,
        )
        OutlinedTextField(host, { host = it }, label = { Text("Mac name") }, placeholder = { Text("mini") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(user, { user = it }, label = { Text("Username") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(
            password,
            { password = it },
            label = { Text("Password") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(device, { device = it }, label = { Text("This phone's name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        ui.error?.let { Text(it, color = Sw.ErrorLine, style = MaterialTheme.typography.bodyMedium) }
        if (ui.busy) {
            CircularProgressIndicator()
        } else {
            PrimaryButton(
                "Pair",
                enabled = host.isNotBlank() && user.isNotBlank() && password.isNotEmpty() && device.isNotBlank(),
                onClick = {
                    val chars = password.toCharArray()
                    password = ""
                    onPair(host, user, chars, device)
                },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/** A device name that passes validDevice: the model name with anything else turned into spaces. */
fun defaultDeviceName(model: String): String =
    model.map { if (it.isLetterOrDigit() && it.code < 128 || it in "._-") it else ' ' }
        .joinToString("")
        .split(' ')
        .filter { it.isNotEmpty() }
        .joinToString(" ")
        .take(40)
        .trim()
        .ifEmpty { "phone" }
