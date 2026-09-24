package com.knowscroll.mobile

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.activity.viewModels
import android.graphics.Color
import com.knowscroll.mobile.data.receivedSignInLink
import com.knowscroll.mobile.ui.KnowScrollApp
import com.knowscroll.mobile.ui.account.AccountViewModel

class MainActivity : ComponentActivity() {
    private val account: AccountViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT), navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT))
        // #168: an App Link's sign-in link (release builds declare the filter; ADR-0047). A recreated
        // activity handed its link over already, and the view model kept it.
        if (savedInstanceState == null) {
            val fromRecents = (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0
            receivedSignInLink(intent.dataString, BuildConfig.KS_APP_LINKS_HOST, fromRecents)?.let(account::receiveSignInLink)
        }
        setContent { KnowScrollApp(account) }
    }
}
