package com.knowscroll.mobile.ui

import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.withFrameNanos
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.awaitCancellation
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.ui.Modifier
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.knowscroll.mobile.ui.keep.KeepScreen
import com.knowscroll.mobile.ui.scroll.ScrollScreen
import com.knowscroll.mobile.ui.system.SystemScreen
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import com.knowscroll.mobile.ui.universe.UniverseScreen

@Composable
fun KnowScrollApp(viewModel: AppViewModel = viewModel()) {
    KnowScrollTheme {
        val screen by viewModel.screen.collectAsStateWithLifecycle()
        val universe by viewModel.universe.collectAsStateWithLifecycle()
        val scroll by viewModel.scroll.collectAsStateWithLifecycle()
        val historyClear by viewModel.historyClear.collectAsStateWithLifecycle()
        val signOut by viewModel.signOut.collectAsStateWithLifecycle()
        val system by viewModel.system.collectAsStateWithLifecycle()
        val toast by viewModel.toast.collectAsStateWithLifecycle()
        val context = LocalContext.current

        LaunchedEffect(toast) {
            val t = toast
            if (t != null) {
                Toast.makeText(context, t, Toast.LENGTH_SHORT).show()
                viewModel.consumeToast()
            }
        }

        BackHandler(enabled = screen is Screen.Scroll || screen is Screen.TraceRevisit || screen is Screen.Keep) { viewModel.returnToUniverse() }
        BackHandler(enabled = screen is Screen.System) { viewModel.returnFromSystem() }
        val lifecycle = LocalLifecycleOwner.current.lifecycle
        LaunchedEffect(lifecycle) {
            lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                viewModel.onForeground()
                awaitCancellation()
            }
        }
        val reading = scroll as? ScrollState.Reading
        LaunchedEffect(screen, reading?.item?.assetId, lifecycle) {
            val assetId = reading?.item?.assetId
            if ((screen is Screen.Scroll || screen is Screen.TraceRevisit) && assetId != null) lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
                withFrameNanos { }; withFrameNanos { }
                viewModel.onVisible(assetId)
                awaitCancellation()
            }
        }
        Box(Modifier.fillMaxSize().safeDrawingPadding()) {
        if (signOut is SignOutState.SignedOut) {
            SignedOutScreen()
        } else when (screen) {
            is Screen.Universe -> UniverseScreen(
                state = universe,
                historyClear = historyClear,
                signOut = signOut,
                onEnterScroll = viewModel::enterScroll,
                onOpenTrace = viewModel::openTrace,
                onEnterSystem = viewModel::enterSystem,
                onRetry = viewModel::retryUniverse,
                onRequestHistoryClear = viewModel::requestHistoryClearConfirmation,
                onCancelHistoryClear = viewModel::cancelHistoryClear,
                onConfirmHistoryClear = viewModel::confirmHistoryClear,
                onRetryHistoryClear = viewModel::retryHistoryClear,
                onRequestSignOut = viewModel::requestSignOutConfirmation,
                onCancelSignOut = viewModel::cancelSignOutConfirmation,
                onConfirmSignOut = viewModel::confirmSignOut,
                onRetrySignOut = viewModel::retrySignOut,
                onOpenKeep = viewModel::openKeep
            )
            is Screen.Scroll, is Screen.TraceRevisit -> ScrollScreen(
                state = scroll,
                onKeep = viewModel::keep,
                onReturn = viewModel::returnToUniverse,
                onNext = viewModel::nextScroll,
                onRetry = viewModel::retryScrollLoad,
                onReadingPosition = viewModel::updateReadingPosition,
                onOpenKeep = viewModel::openKeep
            )
            is Screen.Keep -> KeepScreen(
                state = universe,
                onOpenTrace = viewModel::openTrace,
                onSelectAtlas = viewModel::returnToUniverse,
                onSelectCable = viewModel::enterScroll
            )
            is Screen.System -> SystemScreen(
                state = system,
                onReturn = viewModel::returnFromSystem,
                onRetry = viewModel::retrySystem,
                onEnterScroll = viewModel::enterScroll,
                onOpenKeep = viewModel::openKeep
            )
        }
        }
    }
}
