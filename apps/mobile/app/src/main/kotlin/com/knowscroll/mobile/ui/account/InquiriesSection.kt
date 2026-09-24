package com.knowscroll.mobile.ui.account

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.R
import com.knowscroll.mobile.data.INQUIRY_DAILY_LIMIT_MAX
import com.knowscroll.mobile.data.Inquiry
import com.knowscroll.mobile.data.InquiryConsent
import com.knowscroll.mobile.ui.keep.humanDate
import com.knowscroll.mobile.ui.theme.Cosmos

/** The controls [InquiriesSection] offers; every decision is [InquiriesViewModel]'s. */
data class InquiryActions(
    val onRetryLoad: () -> Unit,
    val onRefresh: () -> Unit,
    val onSetEnabled: (Boolean) -> Unit,
    val onSetDailyLimit: (Int) -> Unit,
    val onRetryChange: () -> Unit,
)

/**
 * #132 (ADR-0038) on the Privacy & account screen: the "Look for connections between my places"
 * switch, its daily limit, what it costs and does, an honest line when this deployment runs nothing,
 * and what KnowScroll looked for -- each inquiry's pairs and a plain status line, with a found
 * bridge's sentence and the claims it rests on (#161: never their sources). Rendering only.
 */
@Composable
fun InquiriesSection(state: InquiriesState, change: ConsentChangeState, recordingPaused: Boolean, actions: InquiryActions) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(
            stringResource(R.string.inquiry_heading), style = MaterialTheme.typography.titleLarge, color = Cosmos.Cream,
            modifier = Modifier.semantics { heading() },
        )
        when (state) {
            is InquiriesState.Loading -> Text(stringResource(R.string.inquiry_loading), color = Cosmos.MutedOnDark)
            is InquiriesState.Unavailable -> {
                Text(state.message, color = Cosmos.Coral)
                val retryDescription = stringResource(R.string.inquiry_retry_load_description)
                OutlinedButton(
                    onClick = actions.onRetryLoad, colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
                    modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = retryDescription },
                ) { Text(stringResource(R.string.action_retry)) }
            }
            is InquiriesState.Loaded -> LoadedInquiries(state, change, recordingPaused, actions)
        }
    }
}

@Composable
private fun LoadedInquiries(state: InquiriesState.Loaded, change: ConsentChangeState, recordingPaused: Boolean, actions: InquiryActions) {
    val consent = state.response.consent
    val working = change is ConsentChangeState.Working
    ConsentSwitch(consent.enabled, enabled = !working, onChange = actions.onSetEnabled)
    Text(stringResource(R.string.inquiry_body), color = Cosmos.MutedOnDark)
    if (!consent.available) Text(stringResource(R.string.inquiry_unavailable), color = Cosmos.Yellow)
    if (consent.enabled && recordingPaused) Text(stringResource(R.string.inquiry_paused), color = Cosmos.Yellow)
    if (consent.enabled) DailyLimit(consent, enabled = !working, onSet = actions.onSetDailyLimit)
    when (change) {
        is ConsentChangeState.Working -> Text(stringResource(R.string.privacy_working), color = Cosmos.MutedOnDark)
        is ConsentChangeState.Failed -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(change.message, color = Cosmos.Coral)
            if (change.canRetry) {
                val retryDescription = stringResource(R.string.inquiry_retry_change_description)
                OutlinedButton(
                    onClick = actions.onRetryChange, colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
                    modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = retryDescription },
                ) { Text(stringResource(R.string.action_retry)) }
            }
        }
        ConsentChangeState.Idle -> Unit
    }
    LookedFor(state, consent, actions.onRefresh)
}

/** The whole row is the 48dp target (a Switch alone is smaller), announced as a switch. */
@Composable
private fun ConsentSwitch(checked: Boolean, enabled: Boolean, onChange: (Boolean) -> Unit) {
    val label = stringResource(R.string.inquiry_switch_label)
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp)
            .toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onChange)
            .semantics { contentDescription = label },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(label, color = Cosmos.InkOnDark, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        Switch(
            checked = checked, onCheckedChange = null, enabled = enabled,
            colors = SwitchDefaults.colors(checkedTrackColor = Cosmos.Teal, checkedThumbColor = Cosmos.Dark),
        )
    }
}

@Composable
private fun DailyLimit(consent: InquiryConsent, enabled: Boolean, onSet: (Int) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(stringResource(R.string.inquiry_limit_label), color = Cosmos.Cream)
        StepButton(stringResource(R.string.inquiry_limit_lower), stringResource(R.string.inquiry_limit_lower_description),
            enabled && consent.dailyLimit > 1) { onSet(consent.dailyLimit - 1) }
        StepButton(stringResource(R.string.inquiry_limit_raise), stringResource(R.string.inquiry_limit_raise_description),
            enabled && consent.dailyLimit < INQUIRY_DAILY_LIMIT_MAX) { onSet(consent.dailyLimit + 1) }
    }
    Text(stringResource(R.string.inquiry_limit_value, consent.dailyLimit, consent.usedToday), color = Cosmos.MutedOnDark)
}

@Composable
private fun StepButton(label: String, description: String, enabled: Boolean, onClick: () -> Unit) {
    OutlinedButton(
        onClick = onClick, enabled = enabled, contentPadding = PaddingValues(0.dp),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
        modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).semantics { contentDescription = description },
    ) { Text(label, style = MaterialTheme.typography.titleLarge) }
}

@Composable
private fun LookedFor(state: InquiriesState.Loaded, consent: InquiryConsent, onRefresh: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
        Text(
            stringResource(R.string.inquiry_list_heading), style = MaterialTheme.typography.titleMedium, color = Cosmos.Cream,
            modifier = Modifier.weight(1f).semantics { heading() },
        )
        val refreshDescription = stringResource(R.string.inquiry_refresh_description)
        OutlinedButton(
            onClick = onRefresh, enabled = !state.refreshing,
            colors = ButtonDefaults.outlinedButtonColors(contentColor = Cosmos.Cream),
            modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = refreshDescription },
        ) { Text(stringResource(if (state.refreshing) R.string.inquiry_refreshing else R.string.inquiry_refresh)) }
    }
    state.refreshFailed?.let { Text(it, color = Cosmos.Coral) }
    val inquiries = state.response.inquiries
    if (inquiries.isEmpty()) Text(stringResource(R.string.inquiry_list_empty), color = Cosmos.MutedOnDark)
    else inquiries.forEach { InquiryCard(it, consent) }
}

@Composable
private fun InquiryCard(inquiry: Inquiry, consent: InquiryConsent) {
    val context = LocalContext.current
    Surface(color = Cosmos.Sea2, contentColor = Cosmos.InkOnDark, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(inquiryPairsTitle(inquiry.pairs, context), style = MaterialTheme.typography.titleSmall, color = Cosmos.Cream)
            Text(stringResource(R.string.inquiry_asked_on, humanDate(inquiry.requestedAt)), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
            Text(inquiryStatusLine(inquiry, consent, context), style = MaterialTheme.typography.bodyMedium)
            inquiry.found?.let { found ->
                Text(found.sentence, style = MaterialTheme.typography.bodyLarge, color = Cosmos.Cream)
                when (found.bridgeStatus) {
                    "revoked" -> Text(stringResource(R.string.inquiry_found_revoked), color = Cosmos.Yellow)
                    "superseded" -> Text(stringResource(R.string.inquiry_found_superseded), color = Cosmos.Yellow)
                }
                Text(stringResource(R.string.connection_evidence_heading), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
                // One claim can support several roles; show each once.
                found.evidence.distinctBy { it.statement }.forEach { Text(it.statement, style = MaterialTheme.typography.bodyMedium) }
            }
        }
    }
}
