package com.knowscroll.mobile.ui

import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.knowscroll.mobile.ui.keep.KeepScreen
import com.knowscroll.mobile.ui.scroll.ScrollScreen
import com.knowscroll.mobile.ui.system.SystemScreen
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import com.knowscroll.mobile.ui.universe.UniverseScreen
import kotlinx.coroutines.awaitCancellation

@Composable
fun KnowScrollApp(viewModel: AppViewModel = viewModel()) {
    KnowScrollTheme {
        val authorityReady by viewModel.authorityReady.collectAsStateWithLifecycle()
        val cableMode by viewModel.cableMode.collectAsStateWithLifecycle()
        var atlasPreview by rememberSaveable { mutableStateOf(false) }
        var previewOpen by rememberSaveable { mutableStateOf(false) }
        val screen by viewModel.screen.collectAsStateWithLifecycle()
        val universe by viewModel.universe.collectAsStateWithLifecycle()
        val scroll by viewModel.scroll.collectAsStateWithLifecycle()
        val historyClear by viewModel.historyClear.collectAsStateWithLifecycle()
        val signOut by viewModel.signOut.collectAsStateWithLifecycle()
        val system by viewModel.system.collectAsStateWithLifecycle()
        val toast by viewModel.toast.collectAsStateWithLifecycle()
        val context = LocalContext.current
        val atlasStates = rememberSaveableStateHolder()
        var scopeKey by rememberSaveable { mutableStateOf("") }
        var savedReelKey by rememberSaveable { mutableStateOf<String?>(null) }
        val confirmed = (universe as? UniverseState.Loaded)?.universe
        LaunchedEffect(confirmed?.universeId, confirmed?.privacyEpoch) {
            if (confirmed != null) {
                val next = "${confirmed.universeId}:${confirmed.privacyEpoch}"
                if (scopeKey != next) {
                    atlasStates.removeState("preview:$scopeKey")
                    atlasStates.removeState("atlas-preview:$scopeKey")
                    atlasStates.removeState("system:$scopeKey")
                    atlasStates.removeState("universe:$scopeKey")
                    savedReelKey?.let(atlasStates::removeState)
                    savedReelKey = null
                    previewOpen = false
                    atlasPreview = false
                    scopeKey = next
                }
            }
        }

        LaunchedEffect(signOut is SignOutState.SignedOut, universe is UniverseState.Unavailable) {
            if (signOut is SignOutState.SignedOut || universe is UniverseState.Unavailable) {
                previewOpen = false
                atlasPreview = false
                atlasStates.removeState("preview:$scopeKey")
                atlasStates.removeState("atlas-preview:$scopeKey")
                atlasStates.removeState("system:$scopeKey")
                atlasStates.removeState("universe:$scopeKey")
                savedReelKey?.let(atlasStates::removeState)
                savedReelKey = null
            }
        }

        LaunchedEffect(toast) {
            val t = toast
            if (t != null) {
                Toast.makeText(context, t, Toast.LENGTH_SHORT).show()
                viewModel.consumeToast()
            }
        }

        BackHandler(
            enabled =
                screen is Screen.Scroll || screen is Screen.TraceRevisit || screen is Screen.Keep
        ) {
            viewModel.returnFromReader()
        }
        BackHandler(enabled = screen is Screen.System) { viewModel.returnFromSystem() }
        val lifecycle = LocalLifecycleOwner.current.lifecycle
        LaunchedEffect(lifecycle) {
            lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                viewModel.onForeground()
                awaitCancellation()
            }
        }
        val reading = scroll as? ScrollState.Reading
        val activeReelKey =
            reading
                ?.takeIf { it.item.kind == "Reel" }
                ?.let { "reel:$scopeKey:${it.item.assetId}@${it.item.revision}" }
        LaunchedEffect(activeReelKey) {
            if (activeReelKey != null && activeReelKey != savedReelKey) {
                savedReelKey?.let(atlasStates::removeState)
                savedReelKey = activeReelKey
            }
        }

        LaunchedEffect(screen, reading?.item?.assetId, lifecycle, previewOpen) {
            val assetId = reading?.item?.assetId
            if (
                !previewOpen &&
                    (screen is Screen.Scroll || screen is Screen.TraceRevisit) &&
                    assetId != null &&
                    reading.item.kind == "Scroll"
            )
                lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
                    withFrameNanos {}
                    withFrameNanos {}
                    viewModel.onVisible(assetId)
                    awaitCancellation()
                }
        }
        Box(Modifier.fillMaxSize().safeDrawingPadding()) {
            if (signOut is SignOutState.SignedOut) {
                SignedOutScreen()
            } else if (!previewOpen)
                when (screen) {
                    is Screen.Universe ->
                        atlasStates.SaveableStateProvider("universe:$scopeKey") {
                            UniverseScreen(
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
                                onOpenKeep = viewModel::openKeep,
                                onAuthoredAtlas =
                                    if (
                                        com.knowscroll.mobile.BuildConfig.DEBUG &&
                                            context.packageName.endsWith(".journey")
                                    )
                                        ({
                                            atlasPreview = true
                                            previewOpen = true
                                        })
                                    else null,
                            )
                        }
                    is Screen.Scroll,
                    is Screen.TraceRevisit ->
                        Column(Modifier.fillMaxSize()) {
                            if (screen is Screen.Scroll)
                                CableControls(
                                    cableMode,
                                    viewModel::selectCableMode,
                                    if (
                                        com.knowscroll.mobile.BuildConfig.DEBUG &&
                                            context.packageName.endsWith(".journey")
                                    )
                                        ({ previewOpen = true })
                                    else null,
                                )
                            Box(Modifier.weight(1f)) {
                                if (reading?.item?.kind == "Reel") {
                                    atlasStates.SaveableStateProvider(
                                        requireNotNull(activeReelKey)
                                    ) {
                                        com.knowscroll.mobile.ui.reel.ReelScreen(
                                            reading,
                                            viewModel::keep,
                                            viewModel::returnFromReader,
                                            viewModel::nextScroll,
                                            viewModel::openKeep,
                                            { viewModel.onVisible(reading.item.assetId) },
                                            viewModel::onMediaAuthorityFailure,
                                            viewModel::updateReadingPosition,
                                        )
                                    }
                                } else
                                    ScrollScreen(
                                        state = scroll,
                                        onKeep = viewModel::keep,
                                        onReturn = viewModel::returnFromReader,
                                        onNext = viewModel::nextScroll,
                                        onRetry = viewModel::retryScrollLoad,
                                        mode = cableMode,
                                        onReadingPosition = viewModel::updateReadingPosition,
                                        onOpenKeep = viewModel::openKeep,
                                    )
                            }
                        }
                    is Screen.Keep ->
                        KeepScreen(
                            state = universe,
                            onOpenTrace = viewModel::openTrace,
                            onSelectAtlas = viewModel::returnToUniverse,
                            onSelectCable = viewModel::enterScroll,
                        )
                    is Screen.System ->
                        atlasStates.SaveableStateProvider("system:$scopeKey") {
                            SystemScreen(
                                state = system,
                                onReturn = viewModel::returnFromSystem,
                                onRetry = viewModel::retrySystem,
                                onEnterScroll = viewModel::enterScrollFromSystem,
                                onOpenKeep = viewModel::openKeep,
                            )
                        }
                }
            if (
                previewOpen &&
                    confirmed != null &&
                    scopeKey == "${confirmed.universeId}:${confirmed.privacyEpoch}" &&
                    authorityReady &&
                    signOut !is SignOutState.SignedOut
            ) {
                atlasStates.SaveableStateProvider(
                    if (atlasPreview) "atlas-preview:$scopeKey" else "preview:$scopeKey"
                ) {
                    if (atlasPreview)
                        com.knowscroll.mobile.ui.preview.AuthoredAtlas(
                            confirmed,
                            {
                                previewOpen = false
                                atlasPreview = false
                            },
                            viewModel::onMediaAuthorityFailure,
                        )
                    else
                        com.knowscroll.mobile.ui.preview.AuthoredPreview(
                            confirmed,
                            { previewOpen = false },
                            viewModel::onMediaAuthorityFailure,
                        )
                }
            } else if (previewOpen && !authorityReady) {
                androidx.compose.material3.Surface(modifier = Modifier.fillMaxSize()) {
                    androidx.compose.material3.Text(
                        "Checking your session…",
                        Modifier.padding(24.dp),
                    )
                }
            }
        }
    }
}
