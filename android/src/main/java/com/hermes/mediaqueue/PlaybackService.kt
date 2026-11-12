package com.hermes.mediaqueue

import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.getcapacitor.JSObject
import java.io.File

/**
 * The single owner of playback.
 *
 * Everything that must survive a locked screen lives here, in a foreground
 * service, not in the WebView:
 *  - the queue is a native ExoPlayer playlist, so the transition from track N to
 *    N+1 is executed by the media engine, not by a JS `ended` handler;
 *  - the format/decoder is already open for the next item because it is part of
 *    the same playlist and preloaded into SimpleCache by TrackPreloader;
 *  - audio focus, noisy-headset handling and the wake lock are ExoPlayer features
 *    (setAudioAttributes(..., true), setHandleAudioBecomingNoisy, setWakeMode);
 *  - the notification and the MediaSession are provided by MediaSessionService,
 *    which is what makes the process a "foreground service" and therefore exempt
 *    from Doze network restrictions (developer.android.com/topic/performance/
 *    power/power-details: "App process is running a foreground service ->
 *    Network: No restrictions").
 */
class PlaybackService : MediaSessionService() {

    companion object {
        const val CHANNEL_ID = "com.hermes.mediaqueue.playback"
        const val NOTIFICATION_ID = 4711
        private const val MAX_ERROR_RETRIES = 2
        private const val ERROR_RETRY_DELAY_MS = 1_200L
        private const val CACHE_BYTES = 256L * 1024L * 1024L
    }

    /** Set by the Capacitor plugin; null while no WebView is attached. */
    var eventSink: ((String, JSObject) -> Unit)? = null

    private lateinit var player: ExoPlayer
    private lateinit var mediaSession: MediaSession
    private lateinit var cache: SimpleCache
    private lateinit var cacheDataSourceFactory: CacheDataSource.Factory
    private lateinit var upstreamFactory: DynamicHttpDataSourceFactory
    private lateinit var preloader: TrackPreloader

    private val handler = Handler(Looper.getMainLooper())
    private val tracks = mutableListOf<Track>()
    private var repeatMode: String = "off"
    private var errorRetries = 0
    private var disposed = false

    // ------------------------------------------------------------- lifecycle

    override fun onCreate() {
        super.onCreate()
        cache = SimpleCache(
            File(cacheDir, "media-queue-cache"),
            LeastRecentlyUsedCacheEvictor(CACHE_BYTES),
            StandaloneDatabaseProvider(this),
        )
        upstreamFactory = DynamicHttpDataSourceFactory("capacitor-media-queue/0.1")
        cacheDataSourceFactory = CacheDataSource.Factory()
            .setCache(cache)
            .setUpstreamDataSourceFactory(upstreamFactory)
            // If the cache file is corrupt (interrupted download) fall back to the
            // network instead of failing the track.
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)

        // Generous buffer: with 60s of pre-buffer the playlist keeps playing
        // through short network drops instead of stalling at a transition.
        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(
                /* minBufferMs = */ 60_000,
                /* maxBufferMs = */ 300_000,
                /* bufferForPlaybackMs = */ 2_000,
                /* bufferForPlaybackAfterRebufferMs = */ 4_000,
            )
            .setBackBuffer(30_000, true)
            .build()

        player = ExoPlayer.Builder(this)
            .setLoadControl(loadControl)
            .setMediaSourceFactory(DefaultMediaSourceFactory(cacheDataSourceFactory))
            // handleAudioFocus = true -> ExoPlayer pauses on calls/other apps and
            // resumes afterwards by itself (AUDIOFOCUS_GAIN).
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build(),
                /* handleAudioFocus = */ true,
            )
            .setHandleAudioBecomingNoisy(true)
            .build()
            .apply {
                // Partial wake lock + Wi-Fi lock while playing or buffering. Note:
                // Doze *ignores* wake locks - the foreground service is what keeps
                // the network usable; the lock keeps the CPU decoding between
                // tracks and the radio from dozing during a prefetch.
                setWakeMode(C.WAKE_MODE_NETWORK)
                setPauseAtEndOfMediaItems(false)
                addListener(playerListener)
            }

        mediaSession = MediaSession.Builder(this, player).build()
        setMediaNotificationProvider(
            DefaultMediaNotificationProvider.Builder(this)
                .setChannelId(CHANNEL_ID)
                .setChannelName(R.string.media_queue_channel_name)
                .setNotificationId(NOTIFICATION_ID)
                .build()
        )

        preloader = TrackPreloader(cacheDataSourceFactory)
        PlaybackHub.attach(this)
        restore()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession = mediaSession

    override fun onDestroy() {
        disposed = true
        handler.removeCallbacksAndMessages(null)
        preloader.cancel()
        PlaybackHub.detach(this)
        eventSink = null
        persist()
        mediaSession.run {
            player.release()
            release()
        }
        if (this::cache.isInitialized) cache.release()
        super.onDestroy()
    }

    /** Dismissing the app from recents must not kill playback (Spotify behaviour). */
    override fun onTaskRemoved(rootIntent: Intent?) {
        if (!player.isPlaying) {
            pauseAllPlayersAndStopSelf()
        }
    }

    // --------------------------------------------------------------- commands

    fun setQueue(
        newTracks: List<Track>,
        startIndex: Int,
        startPositionMs: Long,
        autoplay: Boolean,
        headers: Map<String, String>,
    ) {
        tracks.clear()
        tracks.addAll(newTracks)
        errorRetries = 0
        // Headers apply to the next fetch only; the player, the queue and the
        // cache keys are untouched (see DynamicHttpDataSourceFactory).
        upstreamFactory.headers = headers
        if (tracks.isEmpty()) {
            player.stop()
            player.clearMediaItems()
            notifyState()
            persist()
            return
        }
        val items = tracks.map { it.toMediaItem() }
        val index = startIndex.coerceIn(0, items.size - 1)
        player.setMediaItems(items, index, startPositionMs.coerceAtLeast(0))
        player.repeatMode = playerRepeatMode()
        player.prepare()
        if (autoplay) player.play() else player.pause()
        // The listener fires onMediaItemTransition(PLAYLIST_CHANGED) which already
        // preloads and notifies; nothing else to do here.
        persist()
    }

    fun addToQueue(track: Track) {
        tracks.add(track)
        player.addMediaItem(track.toMediaItem())
        persist()
        notifyQueue()
        if (player.currentMediaItemIndex == tracks.size - 2) preloadNext()
    }

    fun insertAt(track: Track, index: Int) {
        val position = index.coerceIn(0, tracks.size)
        tracks.add(position, track)
        player.addMediaItem(position, track.toMediaItem())
        persist()
        notifyQueue()
        preloadNext()
    }

    fun removeAt(index: Int) {
        if (index < 0 || index >= tracks.size) return
        tracks.removeAt(index)
        player.removeMediaItem(index)
        if (tracks.isEmpty()) {
            player.pause()
            notifyState()
        }
        persist()
        notifyQueue()
        preloadNext()
    }

    fun move(from: Int, to: Int) {
        if (from < 0 || from >= tracks.size) return
        val target = to.coerceIn(0, tracks.size - 1)
        val moved = tracks.removeAt(from)
        tracks.add(target, moved)
        player.moveMediaItem(from, target)
        persist()
        notifyQueue()
    }

    fun play() {
        if (player.mediaItemCount == 0) return
        when (player.playbackState) {
            // Replay from the top: the queue already reached its end.
            Player.STATE_ENDED -> {
                player.seekTo(0, 0)
                player.prepare()
            }
            Player.STATE_IDLE -> player.prepare()
            else -> Unit
        }
        player.play()
        notifyState()
    }

    fun pause() {
        player.pause()
        notifyState()
        persist()
    }

    fun next() {
        if (player.hasNextMediaItem()) player.seekToNextMediaItem() else player.seekTo(0)
        if (!player.isPlaying) player.play()
        notifyState()
    }

    fun previous() {
        if (player.currentPosition > 3_000) {
            player.seekTo(0)
        } else if (player.hasPreviousMediaItem()) {
            player.seekToPreviousMediaItem()
        } else {
            player.seekTo(0)
        }
        notifyState()
    }

    fun seekTo(seconds: Double) {
        player.seekTo((seconds * 1000).toLong().coerceAtLeast(0))
        notifyState()
    }

    fun setRepeatMode(mode: String) {
        repeatMode = when (mode) {
            "track", "queue" -> mode
            else -> "off"
        }
        player.repeatMode = playerRepeatMode()
        notifyState()
        persist()
    }

    fun setVolume(volume: Float) {
        player.volume = volume.coerceIn(0f, 1f)
        notifyState()
    }

    fun setPlaybackRate(rate: Float) {
        player.setPlaybackSpeed(rate.coerceIn(0.25f, 4f))
        notifyState()
    }

    fun stop() {
        handler.removeCallbacksAndMessages(null)
        player.pause()
        player.clearMediaItems()
        player.stop()
        tracks.clear()
        preloader.cancel()
        QueuePersistence.clear(this)
        notifyState()
        notifyQueue()
        pauseAllPlayersAndStopSelf()
    }

    fun stateJson(): JSObject {
        val duration = player.duration
        return JSObject().apply {
            put("isPlaying", player.isPlaying)
            put("isBuffering", player.playbackState == Player.STATE_BUFFERING)
            put("currentIndex", player.currentMediaItemIndex)
            put("trackId", player.currentMediaItem?.mediaId)
            put("position", player.currentPosition / 1000.0)
            put("duration", if (duration == C.TIME_UNSET || duration < 0) 0.0 else duration / 1000.0)
            put("repeatMode", repeatMode)
            put("queueLength", tracks.size)
            put("native", true)
        }
    }

    fun queueJson(): JSObject = JSObject().apply {
        put("tracks", Track.listToJson(tracks))
        put("currentIndex", player.currentMediaItemIndex)
    }

    // ---------------------------------------------------------------- internal

    private fun playerRepeatMode(): Int = when (repeatMode) {
        "track" -> Player.REPEAT_MODE_ONE
        "queue" -> Player.REPEAT_MODE_ALL
        else -> Player.REPEAT_MODE_OFF
    }

    private fun nextTrack(): Track? {
        if (tracks.isEmpty()) return null
        val current = player.currentMediaItemIndex
        val candidate = when (repeatMode) {
            "track" -> current
            "queue" -> (current + 1) % tracks.size
            else -> current + 1
        }
        return tracks.getOrNull(candidate)
    }

    private fun preloadNext() {
        val next = nextTrack()
        preloader.preload(next)
    }

    private fun restore() {
        val snapshot = QueuePersistence.load(this) ?: return
        tracks.clear()
        tracks.addAll(snapshot.tracks)
        repeatMode = snapshot.repeatMode
        val items = tracks.map { it.toMediaItem() }
        player.setMediaItems(items, snapshot.index, snapshot.positionMs)
        player.repeatMode = playerRepeatMode()
        player.pause()
        player.prepare()
    }

    private fun persist() {
        if (disposed) return
        QueuePersistence.save(
            this,
            tracks,
            player.currentMediaItemIndex.coerceAtLeast(0),
            player.currentPosition.coerceAtLeast(0),
            repeatMode,
        )
    }

    private fun notifyState() {
        eventSink?.invoke("stateChanged", stateJson())
    }

    private fun notifyQueue() {
        eventSink?.invoke("queueChanged", queueJson())
    }

    private fun notifyTrackChanged(automatic: Boolean, reason: String) {
        val payload = JSObject().apply {
            put("index", player.currentMediaItemIndex)
            val track = tracks.getOrNull(player.currentMediaItemIndex)
            put("track", track?.toJson())
            put("automatic", automatic)
            put("reason", reason)
            put("state", stateJson())
        }
        eventSink?.invoke("trackChanged", payload)
    }

    private fun notifyError(code: String, message: String, trackId: String?, retries: Int, fatal: Boolean) {
        val payload = JSObject().apply {
            put("code", code)
            put("message", message)
            put("trackId", trackId)
            put("retries", retries)
            put("fatal", fatal)
        }
        eventSink?.invoke("error", payload)
    }

    private val playerListener = object : Player.Listener {

        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            errorRetries = 0
            preloadNext()
            val reasonName = when (reason) {
                Player.MEDIA_ITEM_TRANSITION_REASON_AUTO -> "ended"
                Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT -> "ended"
                Player.MEDIA_ITEM_TRANSITION_REASON_SEEK -> "next"
                else -> "queue"
            }
            notifyTrackChanged(
                automatic = reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO ||
                    reason == Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT,
                reason = reasonName,
            )
            notifyState()
            persist()
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (isPlaying) preloadNext()
            notifyState()
            persist()
        }

        override fun onPlaybackStateChanged(playbackState: Int) {
            if (playbackState == Player.STATE_ENDED) {
                notifyState()
                persist()
            } else if (playbackState == Player.STATE_BUFFERING) {
                notifyState()
            }
        }

        override fun onRepeatModeChanged(repeatModeInt: Int) {
            notifyState()
        }

        override fun onPlayerError(error: PlaybackException) {
            val trackId = player.currentMediaItem?.mediaId
            val code = when (error.errorCode) {
                PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
                PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
                PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS,
                -> "NETWORK"

                PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND -> "NOT_FOUND"
                PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED,
                PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED,
                PlaybackException.ERROR_CODE_DECODING_FAILED,
                PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
                -> "DECODE"

                else -> "UNKNOWN"
            }

            if (errorRetries < MAX_ERROR_RETRIES) {
                errorRetries += 1
                val attempt = errorRetries
                notifyError(code, error.message ?: "playback error", trackId, attempt, false)
                handler.postDelayed({
                    if (disposed) return@postDelayed
                    // Re-preparing the same item is the documented retry path:
                    // ExoPlayer parks in STATE_IDLE after a fatal source error.
                    player.prepare()
                    if (player.playWhenReady) player.play()
                }, ERROR_RETRY_DELAY_MS * attempt)
                return
            }

            errorRetries = 0
            notifyError(code, error.message ?: "playback error", trackId, MAX_ERROR_RETRIES, true)
            // Skip the broken entry so one bad URL does not stop the playlist.
            if (player.hasNextMediaItem()) {
                player.seekToNextMediaItem()
                player.prepare()
                player.play()
            }
        }
    }
}
