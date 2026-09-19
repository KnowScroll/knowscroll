package com.knowscroll.mobile.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.knowscroll.mobile.R
import com.knowscroll.mobile.ui.common.CosmosBackground
import com.knowscroll.mobile.ui.theme.Cosmos

/** Terminal state after a confirmed "Sign out this device" (#91). The token is
 * known-dead: there is deliberately no retry, no login form and no token entry here,
 * only an honest explanation of what did and did not happen. */
@Composable
fun SignedOutScreen(modifier: Modifier = Modifier) {
    Box(modifier = modifier.fillMaxSize()) {
        CosmosBackground()
        Column(
            modifier = Modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 32.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Text(stringResource(R.string.sign_out_heading), style = MaterialTheme.typography.labelMedium, color = Cosmos.MutedOnDark)
            Text(
                stringResource(R.string.sign_out_done_title),
                style = MaterialTheme.typography.displayLarge, color = Cosmos.InkOnDark,
                modifier = Modifier.semantics { heading() }
            )
            Text(stringResource(R.string.sign_out_done_body), style = MaterialTheme.typography.bodyLarge, color = Cosmos.MutedOnDark)
        }
    }
}
