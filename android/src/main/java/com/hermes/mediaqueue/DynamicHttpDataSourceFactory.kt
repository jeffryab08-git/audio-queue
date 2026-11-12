package com.hermes.mediaqueue

import android.net.Uri
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.TransferListener

/**
 * Upstream factory whose headers can be replaced at runtime.
 *
 * ExoPlayer's media source factory is fixed when the player is built, so signed
 * URLs / Authorization headers cannot be injected by rebuilding the player. This
 * wrapper reads the current header map every time a DataSource is created, which
 * is per-request: changing `headers` affects the next fetch without touching the
 * player, the queue or the cache key.
 */
class DynamicHttpDataSourceFactory(
    private val userAgent: String = "capacitor-media-queue/0.1",
    private val transferListener: TransferListener? = null,
) : DataSource.Factory {

    @Volatile
    var headers: Map<String, String> = emptyMap()

    override fun createDataSource(): DataSource =
        DefaultHttpDataSource.Factory()
            .setDefaultRequestProperties(headers)
            .setUserAgent(userAgent)
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(15_000)
            .setAllowCrossProtocolRedirects(true)
            .setTransferListener(transferListener)
            .createDataSource()

    /** Exposed for tests: the headers a request would use right now. */
    fun headersFor(uri: String): Map<String, String> = headers + mapOf("uri" to Uri.parse(uri).toString())
}
