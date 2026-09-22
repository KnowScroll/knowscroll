package com.knowscroll.mobile.ui.scroll.content

import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.compose.foundation.Image
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

@Composable
fun ScrollBlocks(
    document: ScrollDocument,
    modifier: Modifier = Modifier,
    imageLoader: suspend (String) -> android.graphics.Bitmap? = ::loadDocumentImage,
) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(20.dp)) {
        document.blocks.forEachIndexed { index, block ->
            key(index, block) {
                when (block) {
                    is ScrollBlock.Prose ->
                        Text(block.text, style = MaterialTheme.typography.bodyLarge)
                    is ScrollBlock.Heading ->
                        Text(
                            block.text,
                            style = MaterialTheme.typography.titleLarge,
                            modifier = Modifier.semantics { heading() },
                        )
                    is ScrollBlock.Citation -> Citation(block)
                    is ScrollBlock.Image -> DocumentImage(block, imageLoader)
                    is ScrollBlock.ComparisonSlider -> Comparison(block)
                    is ScrollBlock.Diagram ->
                        Column {
                            Text(block.label, style = MaterialTheme.typography.titleMedium)
                            Row(
                                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                block.nodes.forEach { node ->
                                    OutlinedCard(Modifier.width(160.dp)) {
                                        Text(node, Modifier.padding(16.dp))
                                    }
                                }
                            }
                        }
                    is ScrollBlock.Unsupported ->
                        Text("This content type is not supported: ${block.type}")
                }
            }
        }
    }
}

@Composable
private fun Citation(block: ScrollBlock.Citation) {
    val context = LocalContext.current
    var failed by remember { mutableStateOf(false) }
    TextButton(
        colors = ButtonDefaults.textButtonColors(contentColor = LocalContentColor.current),
        onClick = {
            val uri = Uri.parse(block.url)
            failed =
                uri.scheme !in setOf("https", "http") ||
                    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, uri)) }.isFailure
        },
    ) {
        Text(block.label)
    }
    if (failed) Text("This source could not be opened.")
}

@Composable
private fun Comparison(block: ScrollBlock.ComparisonSlider) {
    var value by rememberSaveable(block) { mutableFloatStateOf(.5f) }
    Column {
        Text(block.label, style = MaterialTheme.typography.titleMedium)
        Text("${block.left} ${(100*(1-value)).toInt()}% · ${block.right} ${(100*value).toInt()}%")
        Slider(
            value,
            onValueChange = { value = it },
            colors =
                SliderDefaults.colors(
                    thumbColor = LocalContentColor.current,
                    activeTrackColor = LocalContentColor.current,
                ),
            modifier = Modifier.semantics { contentDescription = block.label },
        )
    }
}

private sealed interface ImageState {
    data object Loading : ImageState

    data object Failed : ImageState

    data class Ready(val bitmap: android.graphics.Bitmap) : ImageState
}

@Composable
private fun DocumentImage(
    block: ScrollBlock.Image,
    loader: suspend (String) -> android.graphics.Bitmap?,
) {
    val state by
        produceState<ImageState>(ImageState.Loading, block.url) {
            value = loader(block.url)?.let(ImageState::Ready) ?: ImageState.Failed
        }
    when (val current = state) {
        ImageState.Loading -> Text("Loading image: ${block.alt}")
        ImageState.Failed -> Text("Image unavailable: ${block.alt}")
        is ImageState.Ready ->
            Image(
                current.bitmap.asImageBitmap(),
                block.alt,
                Modifier.fillMaxWidth().heightIn(max = 360.dp),
            )
    }
    if (block.caption.isNotBlank()) Text(block.caption, style = MaterialTheme.typography.bodySmall)
}

/**
 * HTTPS only, no redirects, credentials, disk cache or executable content; bounded decode off main.
 */
internal suspend fun loadDocumentImage(address: String): android.graphics.Bitmap? =
    withContext(Dispatchers.IO) {
        runCatching {
                val url = URL(address)
                require(url.protocol == "https")
                val connection = url.openConnection() as HttpURLConnection
                try {
                    connection.instanceFollowRedirects = false
                    connection.connectTimeout = 4000
                    connection.readTimeout = 4000
                    require(connection.responseCode == 200)
                    require(connection.contentLengthLong <= 4 * 1024 * 1024)
                    val output = java.io.ByteArrayOutputStream()
                    connection.inputStream.use { input ->
                        val buffer = ByteArray(8192)
                        while (true) {
                            ensureActive()
                            val count = input.read(buffer)
                            if (count < 0) break
                            require(output.size() + count <= 4 * 1024 * 1024)
                            output.write(buffer, 0, count)
                        }
                    }
                    val bytes = output.toByteArray()
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                    require(bounds.outWidth > 0 && bounds.outHeight > 0)
                    var sample = 1
                    while (
                        bounds.outWidth / sample > 1600 || bounds.outHeight / sample > 1600
                    ) sample *= 2
                    BitmapFactory.decodeByteArray(
                        bytes,
                        0,
                        bytes.size,
                        BitmapFactory.Options().apply { inSampleSize = sample },
                    )
                } finally {
                    connection.disconnect()
                }
            }
            .getOrNull()
    }
