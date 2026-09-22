package com.knowscroll.mobile.ui.reel

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import com.knowscroll.mobile.ui.theme.Cosmos

/** One visible player, no speculative player, no disk cache. Scope reconciliation unmounts it. */
@Composable
fun ReelPlayer(
    mediaUrl: String,
    requestHeaders: Map<String, String>,
    modifier: Modifier = Modifier,
    onFirstFrame: () -> Unit = {},
    onAuthorityFailure: () -> Unit = {},
    onPosition: (Long) -> Unit = {},
    initialPositionMs: Long = 0,
    active: Boolean = true,
    gestureModifier: Modifier = Modifier,
) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var resumed by
        remember(lifecycle) {
            mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))
        }
    var position by rememberSaveable(mediaUrl) { mutableLongStateOf(initialPositionMs) }
    var wantsPlay by rememberSaveable(mediaUrl) { mutableStateOf(true) }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, _ ->
            resumed = lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    if (resumed && active)
        ActiveReelPlayer(
            mediaUrl,
            requestHeaders,
            modifier,
            position,
            wantsPlay,
            { wantsPlay = it },
            onFirstFrame,
            onAuthorityFailure,
            gestureModifier,
        ) {
            position = it
            onPosition(it)
        }
    else
        Box(modifier, contentAlignment = Alignment.Center) {
            Text("Playback paused", color = Cosmos.Cream)
        }
}

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
@Composable
private fun ActiveReelPlayer(
    url: String,
    headers: Map<String, String>,
    modifier: Modifier,
    position: Long,
    wantsPlay: Boolean,
    onWantsPlay: (Boolean) -> Unit,
    onFirstFrame: () -> Unit,
    onAuthorityFailure: () -> Unit,
    gestureModifier: Modifier,
    onPosition: (Long) -> Unit,
) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val firstFrame by rememberUpdatedState(onFirstFrame)
    val authorityFailure by rememberUpdatedState(onAuthorityFailure)
    val positionChanged by rememberUpdatedState(onPosition)
    var state by remember(url) { mutableIntStateOf(Player.STATE_BUFFERING) }
    var failed by remember(url) { mutableStateOf(false) }
    var playing by remember(url) { mutableStateOf(false) }
    val player =
        remember(url, headers) {
            ExoPlayer.Builder(context)
                .setLoadControl(
                    DefaultLoadControl.Builder()
                        .setBufferDurationsMs(2000, 8000, 250, 750)
                        .setTargetBufferBytes(8 * 1024 * 1024)
                        .setPrioritizeTimeOverSizeThresholds(false)
                        .build()
                )
                .setMediaSourceFactory(
                    DefaultMediaSourceFactory(
                        DataSource.Factory { SafeMediaDataSource(url, headers) }
                    )
                )
                .build()
        }
    DisposableEffect(player) {
        val listener =
            object : Player.Listener {
                override fun onPlaybackStateChanged(playbackState: Int) {
                    state = playbackState
                }

                override fun onIsPlayingChanged(isPlaying: Boolean) {
                    playing = isPlaying
                }

                override fun onRenderedFirstFrame() {
                    if (lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) firstFrame()
                }

                override fun onPlayerError(error: PlaybackException) {
                    failed = true
                    if (
                        generateSequence(error as Throwable?) { it.cause }
                            .filterIsInstance<MediaHttpException>()
                            .any { it.status in setOf(401, 409, 422) }
                    )
                        authorityFailure()
                }
            }
        player.addListener(listener)
        player.setMediaItem(MediaItem.fromUri(url))
        player.seekTo(position.coerceAtLeast(0))
        player.playWhenReady = wantsPlay
        player.prepare()
        onDispose {
            positionChanged(player.currentPosition)
            player.removeListener(listener)
            player.release()
        }
    }
    Box(
        modifier.semantics {
            contentDescription = "Reel video"
            stateDescription =
                when {
                    failed -> "Video unavailable"
                    state == Player.STATE_BUFFERING -> "Buffering"
                    state == Player.STATE_ENDED -> "Ended"
                    playing -> "Playing"
                    else -> "Paused"
                }
        }
    ) {
        AndroidView(
            factory = {
                PlayerView(it).apply {
                    useController = false
                    this.player = player
                }
            },
            update = { it.player = player },
            onRelease = { it.player = null },
            modifier = Modifier.fillMaxSize(),
        )
        // Compose owns discovery gestures above the native SurfaceView; player buttons
        // are later siblings and retain their own touch targets.
        Box(Modifier.matchParentSize().then(gestureModifier))
        if (state == Player.STATE_BUFFERING && !failed)
            Column(
                Modifier.align(Alignment.Center),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                CircularProgressIndicator(color = Cosmos.Teal)
                Text("Buffering video…", color = Cosmos.Cream)
            }
        if (failed)
            Column(
                Modifier.align(Alignment.Center),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("Video unavailable. Check your connection.", color = Cosmos.Cream)
                Button(
                    onClick = {
                        failed = false
                        player.prepare()
                        player.playWhenReady = wantsPlay
                    }
                ) {
                    Text("Retry video")
                }
            }
        else
            FilledTonalButton(
                onClick = {
                    if (state == Player.STATE_ENDED) {
                        player.seekTo(0)
                        player.play()
                        onWantsPlay(true)
                    } else {
                        val play = !wantsPlay
                        player.playWhenReady = play
                        onWantsPlay(play)
                    }
                },
                modifier = Modifier.align(Alignment.BottomStart).padding(12.dp),
            ) {
                Text(
                    if (state == Player.STATE_ENDED) "Replay"
                    else if (wantsPlay) "Pause" else "Play"
                )
            }
    }
}
