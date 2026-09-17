package dev.swarmz.phone.ui.pairing

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import dev.swarmz.phone.data.sameMac
import dev.swarmz.phone.pairing.CameraQrScanner
import dev.swarmz.phone.pairing.QrScanSheet
import dev.swarmz.phone.pairing.parsePairQr
import dev.swarmz.phone.ssh.HostKeyChanged
import dev.swarmz.phone.ssh.HostKeyPins
import dev.swarmz.phone.ssh.pinScannedKeys
import dev.swarmz.phone.ui.PairingUi
import dev.swarmz.phone.ui.components.PrimaryButton
import dev.swarmz.phone.ui.components.QuietButton
import dev.swarmz.phone.ui.theme.Sw

/**
 * The first pairing, and, with [onCancel] given, adding another Mac: that mode starts from the Mac's name and the
 * first pairing's user, and asks for no device name, since the phone keeps the one it is already known by.
 *
 * Scan QR opens [scanSheet] over the form: a code shown by a Mac fills in its name and username and pins the host
 * keys it carries through [pins], so the first connection is checked rather than trusted blindly. The password is
 * still typed by hand, which is why the field is left focused afterwards.
 */
@Composable
fun PairingScreen(
    ui: PairingUi,
    defaultDevice: String,
    onPair: (host: String, user: String, password: CharArray, device: String) -> Unit,
    title: String = "Pair with a Mac",
    initialHost: String = "",
    initialUser: String = "",
    askDevice: Boolean = true,
    onCancel: (() -> Unit)? = null,
    /** Where a scanned code's host keys are pinned. */
    pins: HostKeyPins,
    scanSheet: QrScanSheet = { onResult, onScanCancel -> CameraQrScanner(onResult, onScanCancel) },
) {
    var host by rememberSaveable(initialHost) { mutableStateOf(initialHost) }
    var user by rememberSaveable(initialUser) { mutableStateOf(initialUser) }
    // Never saved to instance state.
    var password by remember { mutableStateOf("") }
    var device by rememberSaveable { mutableStateOf(defaultDevice) }
    var scanning by rememberSaveable { mutableStateOf(false) }
    var scanError by rememberSaveable { mutableStateOf<String?>(null) }
    // Bumped by each code that reads, so the password field takes focus again every time.
    var scanned by rememberSaveable { mutableIntStateOf(0) }
    val passwordField = remember { FocusRequester() }

    LaunchedEffect(scanned) {
        // Nothing has been scanned yet on the first pass, and the field is only there to focus
        // once the form is back in front.
        if (scanned > 0 && !scanning) runCatching { passwordField.requestFocus() }
    }

    Box(Modifier.fillMaxSize()) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (onCancel == null) {
                Text("swarmz", style = MaterialTheme.typography.headlineSmall)
                Text(title, style = MaterialTheme.typography.titleMedium)
            } else {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onCancel) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Cancel", tint = Sw.Title) }
                    Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 8.dp))
                }
            }
            Text(
                "Use the Mac's Tailscale name and your Mac login. The password is used once to add this phone's key and is not stored. Remote Login must be on, and swarmz must have run on that Mac once.",
                style = MaterialTheme.typography.bodySmall,
            )
            QuietButton("Scan QR", { scanError = null; scanning = true }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(host, { host = it }, label = { Text("Mac name") }, placeholder = { Text("mini") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(user, { user = it }, label = { Text("Username") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(
                password,
                { password = it },
                label = { Text("Password") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                modifier = Modifier.fillMaxWidth().focusRequester(passwordField),
            )
            if (askDevice) {
                OutlinedTextField(device, { device = it }, label = { Text("This phone's name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            }
            scanError?.let { Text(it, color = Sw.ErrorLine, style = MaterialTheme.typography.bodyMedium) }
            ui.error?.let { Text(it, color = Sw.ErrorLine, style = MaterialTheme.typography.bodyMedium) }
            if (ui.busy) {
                CircularProgressIndicator()
            } else {
                PrimaryButton(
                    "Pair",
                    enabled = host.isNotBlank() && user.isNotBlank() && password.isNotEmpty() && (!askDevice || device.isNotBlank()),
                    onClick = {
                        val chars = password.toCharArray()
                        password = ""
                        onPair(host, user, chars, device)
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        if (scanning) {
            // Over the form rather than in place of it, so what has been typed so far survives a scan.
            Box(Modifier.fillMaxSize().background(Sw.Background)) {
                scanSheet(
                    { text ->
                        val code = parsePairQr(text)
                        // Add mode names the Mac being paired: a code for a different one is said
                        // out loud rather than quietly swapping which Mac this screen is about.
                        val wrongMac = code != null && initialHost.isNotBlank() && !sameMac(initialHost, code.host)
                        when {
                            code == null -> scanError = "That isn't a swarmz pairing code"
                            wrongMac -> scanError = "That code is for ${code.host}, not $initialHost."
                            else -> {
                                host = code.host
                                user = code.user
                                scanError = try {
                                    pinScannedKeys(pins, code.host, code.fingerprints)
                                    null
                                } catch (_: HostKeyChanged) {
                                    "${code.host} showed a different host key than the one this phone trusts. Pair it again only if you know why it changed."
                                }
                                scanned++
                            }
                        }
                        scanning = false
                    },
                    { scanning = false },
                )
            }
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
