package com.knowscroll.mobile.ui.account

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.R
import com.knowscroll.mobile.ui.common.CosmosBackground
import com.knowscroll.mobile.ui.theme.Cosmos

/**
 * #135 (ADR-0026): shown whenever this device has no usable credential, or a signed-in session
 * just died (401). Email -> `POST /v1/auth/magic-link` always answers with the same fixed
 * "check your email" message (no account-existence leak); a pasted link is parsed purely
 * ([parseSignInToken]) before it ever reaches the network.
 */
@Composable
fun SignInScreen(
    linkRequest: LinkRequestState,
    tokenSubmit: TokenSubmitState,
    reason: SignedOutReason?,
    onRequestLink: (String) -> Unit,
    onSubmitLink: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var email by rememberSaveable { mutableStateOf("") }
    var pasted by rememberSaveable { mutableStateOf("") }
    Box(modifier = modifier.fillMaxSize()) {
        CosmosBackground()
        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 32.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(stringResource(R.string.sign_in_kicker), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
            Text(
                stringResource(R.string.sign_in_heading), style = MaterialTheme.typography.displayLarge,
                color = Cosmos.InkOnDark, modifier = Modifier.semantics { heading() },
            )
            Text(stringResource(R.string.sign_in_subtitle), style = MaterialTheme.typography.bodyLarge, color = Cosmos.MutedOnDark)
            signedOutReasonMessage(reason)?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = Cosmos.Yellow)
            }
            OutlinedTextField(
                value = email,
                onValueChange = { email = it },
                label = { Text(stringResource(R.string.sign_in_email_label)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Email" },
            )
            Button(
                onClick = { onRequestLink(email) },
                enabled = email.isNotBlank() && linkRequest !is LinkRequestState.Sending,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics {
                    contentDescription = "Send sign-in link"
                },
            ) {
                Text(
                    stringResource(
                        if (linkRequest is LinkRequestState.Sending) R.string.sign_in_sending
                        else R.string.sign_in_send_link
                    )
                )
            }
            when (linkRequest) {
                is LinkRequestState.Sent -> Text(
                    stringResource(R.string.sign_in_link_sent),
                    style = MaterialTheme.typography.bodyMedium, color = Cosmos.Teal,
                )
                is LinkRequestState.Failed -> Text(
                    linkRequest.message, style = MaterialTheme.typography.bodyMedium, color = Cosmos.Coral,
                )
                else -> Unit
            }
            HorizontalDivider(color = Cosmos.Sea2)
            Text(stringResource(R.string.sign_in_paste_heading), style = MaterialTheme.typography.titleMedium, color = Cosmos.Cream)
            OutlinedTextField(
                value = pasted,
                onValueChange = { pasted = it },
                label = { Text(stringResource(R.string.sign_in_paste_label)) },
                singleLine = false,
                modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Paste your sign-in link" },
            )
            Button(
                onClick = { onSubmitLink(pasted) },
                enabled = pasted.isNotBlank() && tokenSubmit !is TokenSubmitState.Submitting,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics {
                    contentDescription = "Sign in with this link"
                },
            ) {
                Text(
                    stringResource(
                        if (tokenSubmit is TokenSubmitState.Submitting) R.string.sign_in_submitting
                        else R.string.sign_in_paste_action
                    )
                )
            }
            when (tokenSubmit) {
                is TokenSubmitState.InvalidLink -> Text(tokenSubmit.message, style = MaterialTheme.typography.bodyMedium, color = Cosmos.Coral)
                is TokenSubmitState.Failed -> Text(tokenSubmit.message, style = MaterialTheme.typography.bodyMedium, color = Cosmos.Coral)
                else -> Unit
            }
        }
    }
}

@Composable
private fun signedOutReasonMessage(reason: SignedOutReason?): String? = when (reason) {
    SignedOutReason.SESSION_EXPIRED -> stringResource(R.string.sign_in_reason_session_expired)
    SignedOutReason.RESET -> stringResource(R.string.sign_in_reason_reset)
    SignedOutReason.ACCOUNT_DELETED -> stringResource(R.string.sign_in_reason_account_deleted)
    SignedOutReason.SIGNED_OUT -> stringResource(R.string.sign_out_done_title)
    SignedOutReason.SESSION_ENDED_BEFORE_DELETE -> stringResource(R.string.sign_in_reason_ended_before_delete)
    SignedOutReason.SESSION_ENDED_BEFORE_RESET -> stringResource(R.string.sign_in_reason_ended_before_reset)
    null -> null
}
