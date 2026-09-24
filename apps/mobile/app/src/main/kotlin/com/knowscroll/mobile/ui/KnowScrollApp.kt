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
import com.knowscroll.mobile.ui.account.AccountViewModel
import com.knowscroll.mobile.ui.account.AuthState
import com.knowscroll.mobile.ui.account.InquiriesSection
import com.knowscroll.mobile.ui.account.InquiriesViewModel
import com.knowscroll.mobile.ui.account.InquiryActions
import com.knowscroll.mobile.ui.account.PrivacyActions
import com.knowscroll.mobile.ui.account.PrivacyScreen
import com.knowscroll.mobile.ui.account.SignInScreen
import com.knowscroll.mobile.ui.keep.ConnectionActions
import com.knowscroll.mobile.ui.keep.KeepScreen
import com.knowscroll.mobile.ui.keep.RelicControls
import com.knowscroll.mobile.ui.keep.ReturnViewModel
import com.knowscroll.mobile.ui.system.AwayControls
import com.knowscroll.mobile.ui.scroll.ScrollScreen
import com.knowscroll.mobile.ui.system.SystemScreen
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import com.knowscroll.mobile.ui.universe.UniverseScreen
import kotlinx.coroutines.awaitCancellation

/**
 * #135: the app's outermost gate. A device with no usable credential (never signed in, or its
 * session just died) sees only [SignInScreen]; the Privacy screen and the reader are mutually
 * exclusive top-level destinations sharing the one [AccountViewModel], parallel to how the old
 * dev-token-era `SignOutState.SignedOut` already replaced this whole tree in place (see the
 * `authState`/`privacyOpen` branches below).
 */
@Composable
fun KnowScrollApp(accountViewModel: AccountViewModel = viewModel()) {
    val authState by accountViewModel.authState.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            // A sign-in/out from any screen, or the reader's own session dying, becomes visible
            // here on the next foreground -- see AccountViewModel.refresh().
            accountViewModel.refresh()
            awaitCancellation()
        }
    }
    if (authState is AuthState.SignedOut) {
        KnowScrollTheme {
            Box(Modifier.fillMaxSize().safeDrawingPadding()) {
                val linkRequest by accountViewModel.linkRequest.collectAsStateWithLifecycle()
                val tokenSubmit by accountViewModel.tokenSubmit.collectAsStateWithLifecycle()
                val reason by accountViewModel.signedOutReason.collectAsStateWithLifecycle()
                SignInScreen(
                    linkRequest = linkRequest,
                    tokenSubmit = tokenSubmit,
                    reason = reason,
                    onRequestLink = accountViewModel::requestLink,
                    onSubmitLink = accountViewModel::submitPastedLink,
                )
            }
        }
        return
    }
    var privacyOpen by rememberSaveable { mutableStateOf(false) }
    if (privacyOpen) {
        KnowScrollTheme {
            Box(Modifier.fillMaxSize().safeDrawingPadding()) {
                // #132 (ADR-0038): the connections section has its own small view model.
                val inquiriesViewModel: InquiriesViewModel = viewModel()
                LaunchedEffect(Unit) {
                    accountViewModel.openPrivacy()
                    inquiriesViewModel.open()
                }
                val inquiries by inquiriesViewModel.state.collectAsStateWithLifecycle()
                val inquiryChange by inquiriesViewModel.change.collectAsStateWithLifecycle()
                val privacy by accountViewModel.privacy.collectAsStateWithLifecycle()
                val pause by accountViewModel.pause.collectAsStateWithLifecycle()
                val resume by accountViewModel.resume.collectAsStateWithLifecycle()
                val export by accountViewModel.export.collectAsStateWithLifecycle()
                val reset by accountViewModel.reset.collectAsStateWithLifecycle()
                val delete by accountViewModel.delete.collectAsStateWithLifecycle()
                val accountSignOut by accountViewModel.accountSignOut.collectAsStateWithLifecycle()
                PrivacyScreen(
                    privacy = privacy, pause = pause, resume = resume, export = export,
                    reset = reset, delete = delete, signOut = accountSignOut,
                    actions = PrivacyActions(
                        onBack = { privacyOpen = false },
                        onRetryLoad = accountViewModel::retryPrivacyLoad,
                        onRequestPause = accountViewModel::requestPause,
                        onRetryPause = accountViewModel::retryPause,
                        onRequestResume = accountViewModel::requestResume,
                        onRetryResume = accountViewModel::retryResume,
                        onRequestExport = accountViewModel::requestExport,
                        onRetryExport = accountViewModel::retryExport,
                        onExportSaved = accountViewModel::consumeExport,
                        onRequestResetConfirmation = accountViewModel::requestResetConfirmation,
                        onCancelReset = accountViewModel::cancelReset,
                        onConfirmReset = accountViewModel::confirmReset,
                        onRetryReset = accountViewModel::retryReset,
                        onRequestDeleteConfirmation = accountViewModel::requestDeleteConfirmation,
                        onCancelDelete = accountViewModel::cancelDelete,
                        onConfirmDelete = accountViewModel::confirmDelete,
                        onRetryDelete = accountViewModel::retryDelete,
                        onRequestSignOutConfirmation = accountViewModel::requestSignOutConfirmation,
                        onCancelSignOut = accountViewModel::cancelAccountSignOut,
                        onConfirmSignOut = accountViewModel::confirmAccountSignOut,
                        onRetrySignOut = accountViewModel::retryAccountSignOut,
                    ),
                    inquiries = { recordingPaused ->
                        InquiriesSection(
                            state = inquiries, change = inquiryChange, recordingPaused = recordingPaused,
                            actions = InquiryActions(
                                onRetryLoad = inquiriesViewModel::retryLoad,
                                onRefresh = inquiriesViewModel::refresh,
                                onSetEnabled = inquiriesViewModel::setEnabled,
                                onSetDailyLimit = inquiriesViewModel::setDailyLimit,
                                onRetryChange = inquiriesViewModel::retryChange,
                            ),
                        )
                    },
                )
            }
        }
        return
    }
    AuthenticatedApp(onOpenPrivacy = { privacyOpen = true }, onSignedOut = accountViewModel::onReaderSignedOut)
}

@Composable
private fun AuthenticatedApp(viewModel: AppViewModel = viewModel(), onOpenPrivacy: () -> Unit, onSignedOut: () -> Unit) {
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
        val atlas by viewModel.atlas.collectAsStateWithLifecycle()
        val placeReject by viewModel.placeReject.collectAsStateWithLifecycle()
        val atlasEvidence by viewModel.atlasEvidence.collectAsStateWithLifecycle()
        val toast by viewModel.toast.collectAsStateWithLifecycle()
        val branches by viewModel.branches.collectAsStateWithLifecycle()
        val why by viewModel.why.collectAsStateWithLifecycle()
        val ask by viewModel.ask.collectAsStateWithLifecycle()
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

        // #135: the reader's own "Sign out this device" ended the session and cleared the vault;
        // the sign-in screen, not SignedOutScreen's dead end, is where this device goes now.
        LaunchedEffect(signOut is SignOutState.SignedOut) {
            if (signOut is SignOutState.SignedOut) onSignedOut()
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
        // #134 (ADR-0039): the return and Relics share one small view model, one per universe and
        // epoch (so nothing of another account or a cleared history carries over), read afresh
        // each time the reader opens the Atlas or Keep and each time the app comes back to it.
        val returnViewModel: ReturnViewModel = viewModel(key = "return:$scopeKey")
        val away by returnViewModel.away.collectAsStateWithLifecycle()
        val relics by returnViewModel.relics.collectAsStateWithLifecycle()
        val acknowledge by returnViewModel.acknowledge.collectAsStateWithLifecycle()
        val connections by returnViewModel.connections.collectAsStateWithLifecycle()
        val releases by returnViewModel.releases.collectAsStateWithLifecycle()
        val onAtlas = screen is Screen.System
        val onKeep = screen is Screen.Keep
        LaunchedEffect(onAtlas, onKeep, returnViewModel, lifecycle) {
            if (onAtlas || onKeep)
                lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                    if (onAtlas) returnViewModel.openAtlas() else returnViewModel.openKeep()
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
                                onOpenPrivacy = onOpenPrivacy,
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
                                            mediaToken = viewModel.credentialProvider.currentToken(),
                                        )
                                    }
                                } else
                                    ScrollScreen(
                                        state = scroll,
                                        onKeep = viewModel::keep,
                                        onReturn = viewModel::leaveReader,
                                        onBack = viewModel::returnFromReader,
                                        branches = branches,
                                        onOpenBranch = viewModel::openBranch,
                                        onRetryBranches = viewModel::retryBranches,
                                        onObjectConnection = viewModel::objectToConnection,
                                        why = com.knowscroll.mobile.ui.scroll.WhyControls(why, viewModel::loadWhy, viewModel::correctEncounter),
                                        ask = com.knowscroll.mobile.ui.scroll.AskControls(
                                            ask, viewModel::openAsk, viewModel::askQuestion,
                                            viewModel::requestAnswer, viewModel::cancelAskAnswer, viewModel::closeAsk,
                                        ),
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
                            relics = RelicControls(
                                state = relics, releases = releases,
                                onLetGo = returnViewModel::letGo, onRetryLetGo = returnViewModel::retryLetGo,
                                onRetryLoad = returnViewModel::retryRelics,
                            ),
                        )
                    is Screen.System ->
                        atlasStates.SaveableStateProvider("system:$scopeKey") {
                            SystemScreen(
                                state = system,
                                atlasState = atlas,
                                placeRejectState = placeReject,
                                evidenceState = atlasEvidence,
                                onReturn = viewModel::returnFromSystem,
                                onRetry = viewModel::retrySystem,
                                onEnterScroll = viewModel::enterScrollFromSystem,
                                onOpenKeep = viewModel::openKeep,
                                onRequestSetAside = viewModel::requestSetAside,
                                onCancelSetAside = viewModel::cancelSetAside,
                                onConfirmSetAside = viewModel::confirmSetAside,
                                onOpenEvidence = viewModel::openEvidence,
                                onCloseEvidence = viewModel::closeEvidence,
                                away = AwayControls(
                                    state = away, acknowledge = acknowledge, connections = connections,
                                    onMarkSeen = returnViewModel::markSeen, onRetryMarkSeen = returnViewModel::retryMarkSeen,
                                    connection = ConnectionActions(
                                        onKeep = returnViewModel::keep, onRetryKeep = returnViewModel::retryKeep,
                                        onSeemsWrong = returnViewModel::seemsWrong, onRetrySeemsWrong = returnViewModel::retrySeemsWrong,
                                    ),
                                ),
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
                            viewModel.credentialProvider,
                        )
                    else
                        com.knowscroll.mobile.ui.preview.AuthoredPreview(
                            confirmed,
                            { previewOpen = false },
                            viewModel::onMediaAuthorityFailure,
                            credential = viewModel.credentialProvider,
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
