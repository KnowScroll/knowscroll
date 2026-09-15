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
import com.knowscroll.mobile.ui.scroll.ScrollScreen
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import com.knowscroll.mobile.ui.universe.UniverseScreen

@Composable
fun KnowScrollApp(viewModel: AppViewModel = viewModel()) {
    KnowScrollTheme {
        val screen by viewModel.screen.collectAsStateWithLifecycle()
        val universe by viewModel.universe.collectAsStateWithLifecycle()
        val scroll by viewModel.scroll.collectAsStateWithLifecycle()
        val toast by viewModel.toast.collectAsStateWithLifecycle()
        val context = LocalContext.current

        LaunchedEffect(toast) {
            val t = toast
            if (t != null) {
                Toast.makeText(context, t, Toast.LENGTH_SHORT).show()
                viewModel.consumeToast()
            }
        }

        BackHandler(enabled = screen is Screen.Scroll) { viewModel.returnToUniverse() }
        val lifecycle = LocalLifecycleOwner.current.lifecycle
        val reading = scroll as? ScrollState.Reading
        LaunchedEffect(screen, reading?.item?.assetId, lifecycle) {
            val assetId = reading?.item?.assetId
            if (screen is Screen.Scroll && assetId != null) lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
                withFrameNanos { }; withFrameNanos { }
                viewModel.onVisible(assetId)
                awaitCancellation()
            }
        }
        Box(Modifier.fillMaxSize().safeDrawingPadding()) {
        when (screen) {
            is Screen.Universe -> UniverseScreen(
                state = universe,
                onEnterScroll = viewModel::enterScroll,
                onRetry = viewModel::retryUniverse
            )
            is Screen.Scroll -> ScrollScreen(
                state = scroll,
                onKeep = viewModel::keep,
                onReturn = viewModel::returnToUniverse,
                onNext = viewModel::nextScroll,
                onRetry = viewModel::retryScrollLoad
            )
        }
        }
    }
}
