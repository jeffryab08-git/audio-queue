package com.hermes.mediaqueue

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import java.util.ArrayDeque

/**
 * Hands the PlaybackService instance to the Capacitor plugin.
 *
 * The service and the WebView live in the same process, so a static reference is
 * enough; no binder round trip, no MediaController indirection for our own calls.
 * Commands issued before the service finished being created are queued and
 * replayed once `attach()` runs (service creation is asynchronous).
 */
object PlaybackHub {

    private val main = Handler(Looper.getMainLooper())
    private val pending = ArrayDeque<(PlaybackService) -> Unit>()

    @Volatile
    private var service: PlaybackService? = null

    fun attach(target: PlaybackService) {
        service = target
        main.post {
            while (pending.isNotEmpty()) {
                pending.removeFirst().invoke(target)
            }
        }
    }

    fun detach(target: PlaybackService) {
        if (service === target) service = null
    }

    /**
     * Runs [action] against the service **on the main thread**, starting it if
     * needed.
     *
     * Two invariants here:
     *  1. ExoPlayer is thread-confined to the thread that created it (the main
     *     thread, where the service is created). Capacitor invokes plugin methods
     *     on its own "CapacitorPlugins" HandlerThread, so every call must be
     *     marshalled back or Media3 throws IllegalStateException("Player is
     *     accessed on the wrong thread").
     *  2. `startService` (never `startForegroundService`) is deliberate: a
     *     MediaSessionService must only enter the foreground when playback
     *     actually starts, otherwise Android 12+ kills it for not calling
     *     startForeground() within 5 seconds.
     */
    fun run(context: Context, action: (PlaybackService) -> Unit) {
        val appContext = context.applicationContext
        main.post {
            val current = service
            if (current != null) {
                action(current)
                return@post
            }
            pending.addLast(action)
            try {
                appContext.startService(Intent(appContext, PlaybackService::class.java))
            } catch (_: Throwable) {
                // Background start rejection (Android 12+): the command stays
                // queued and runs whenever a legal start happens.
            }
        }
    }

    /** Runs [block] on the main thread (use it to read player state). */
    fun onMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post(block)
    }

    fun current(): PlaybackService? = service
}
