package com.hermes.mediaqueue

import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.media3.common.C
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.CacheWriter

/**
 * Downloads the next queue entry into the same SimpleCache the player reads from.
 *
 * Why this exists: ExoPlayer's LoadControl only starts fetching the next period
 * once the current one is nearly fully buffered, which for a 4-minute track means
 * the next item starts downloading seconds before the transition. On a locked
 * phone that is exactly when the network is least available. Writing the next
 * track into the cache ahead of time makes the transition a local file read, so
 * it does not depend on the radio at all.
 *
 * The work runs on a plain thread (no coroutines) so the plugin has no dependency
 * beyond Media3. A generation counter makes cancellation race-free: a stale
 * worker exits at its next checkpoint instead of corrupting the new download.
 */
class TrackPreloader(private val cacheFactory: CacheDataSource.Factory) {

    private val main = Handler(Looper.getMainLooper())

    @Volatile
    private var generation = 0

    @Volatile
    private var worker: Thread? = null

    /** Called on the main thread with true when the track is fully cached. */
    var onPreloaded: ((Track, Boolean) -> Unit)? = null

    fun preload(track: Track?) {
        val myGeneration = ++generation
        worker?.interrupt()
        worker = null
        if (track == null) return

        val thread = Thread {
            var attempt = 0
            while (attempt < MAX_ATTEMPTS && myGeneration == generation) {
                try {
                    val source = cacheFactory.createDataSource()
                    val spec = DataSpec(Uri.parse(track.url), 0L, C.LENGTH_UNSET.toLong(), null)
                    CacheWriter(source, spec, null, null).cache()
                    if (myGeneration == generation) {
                        main.post { onPreloaded?.invoke(track, true) }
                    }
                    return@Thread
                } catch (_: Throwable) {
                    attempt += 1
                    if (myGeneration != generation || attempt >= MAX_ATTEMPTS) {
                        if (myGeneration == generation) {
                            main.post { onPreloaded?.invoke(track, false) }
                        }
                        return@Thread
                    }
                    try {
                        Thread.sleep(BACKOFF_MS * attempt)
                    } catch (_: InterruptedException) {
                        return@Thread
                    }
                }
            }
        }
        thread.name = "mediaqueue-preload"
        thread.priority = Thread.MIN_PRIORITY
        thread.isDaemon = true
        worker = thread
        thread.start()
    }

    fun cancel() {
        generation += 1
        worker?.interrupt()
        worker = null
    }

    companion object {
        private const val MAX_ATTEMPTS = 3
        private const val BACKOFF_MS = 1_500L
    }
}
