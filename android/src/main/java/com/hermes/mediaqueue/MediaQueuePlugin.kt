package com.hermes.mediaqueue

import android.Manifest
import android.os.Build
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * JS <-> native surface. Deliberately dumb: it validates arguments and forwards
 * them to PlaybackService, which owns all state. Nothing here touches the queue
 * logic, so the same code path is exercised whether the call came from the UI,
 * from the notification or from a Bluetooth headset.
 */
@CapacitorPlugin(
    name = "MediaQueue",
    permissions = [
        Permission(
            alias = "notifications",
            strings = [Manifest.permission.POST_NOTIFICATIONS],
        ),
    ],
)
class MediaQueuePlugin : Plugin() {

    override fun load() {
        // Bind the event sink now: the service may already be running from a
        // previous session (process kept alive by the foreground service).
        PlaybackHub.run(context) { service ->
            bindSink(service)
            if ((service.stateJson().getInteger("queueLength") ?: 0) > 0) {
                notifyListeners("stateChanged", service.stateJson())
            }
        }
    }

    private fun bindSink(service: PlaybackService) {
        service.eventSink = { name, payload -> notifyListeners(name, payload) }
    }

    private fun dispatch(action: (PlaybackService) -> Unit) {
        PlaybackHub.run(context) { service ->
            bindSink(service)
            action(service)
        }
    }

    // ---------------------------------------------------------------- queue

    @PluginMethod
    fun setQueue(call: PluginCall) {
        val array = call.getArray("tracks")
        if (array == null) {
            call.reject("setQueue requires a 'tracks' array")
            return
        }
        val tracks = Track.listFromJson(array)
        val startIndex = call.getInt("startIndex") ?: 0
        val startPositionMs = ((call.getDouble("startPosition") ?: 0.0) * 1000).toLong()
        val autoplay = call.getBoolean("autoplay") ?: true
        val headers = mutableMapOf<String, String>()
        call.getObject("headers")?.let { obj ->
            obj.keys().forEach { key -> headers[key] = obj.getString(key) ?: "" }
        }
        dispatch { it.setQueue(tracks, startIndex, startPositionMs, autoplay, headers) }
        call.resolve()
    }

    @PluginMethod
    fun addToQueue(call: PluginCall) {
        val track = call.getObject("track")
        if (track == null) {
            call.reject("addToQueue requires a 'track' object")
            return
        }
        dispatch { it.addToQueue(Track.fromJson(track)) }
        call.resolve()
    }

    @PluginMethod
    fun insertAfterCurrent(call: PluginCall) {
        val track = call.getObject("track")
        if (track == null) {
            call.reject("insertAfterCurrent requires a 'track' object")
            return
        }
        dispatch { service ->
            val index = (service.stateJson().getInteger("currentIndex") ?: 0) + 1
            service.insertAt(Track.fromJson(track), index.coerceAtLeast(0))
        }
        call.resolve()
    }

    @PluginMethod
    fun insertAt(call: PluginCall) {
        val track = call.getObject("track")
        val index = call.getInt("index")
        if (track == null || index == null) {
            call.reject("insertAt requires 'track' and 'index'")
            return
        }
        dispatch { it.insertAt(Track.fromJson(track), index) }
        call.resolve()
    }

    @PluginMethod
    fun removeAt(call: PluginCall) {
        val index = call.getInt("index")
        if (index == null) {
            call.reject("removeAt requires 'index'")
            return
        }
        dispatch { it.removeAt(index) }
        call.resolve()
    }

    @PluginMethod
    fun move(call: PluginCall) {
        val from = call.getInt("from")
        val to = call.getInt("to")
        if (from == null || to == null) {
            call.reject("move requires 'from' and 'to'")
            return
        }
        dispatch { it.move(from, to) }
        call.resolve()
    }

    // ------------------------------------------------------------ transport

    @PluginMethod
    fun play(call: PluginCall) {
        dispatch { it.play() }
        call.resolve()
    }

    @PluginMethod
    fun pause(call: PluginCall) {
        dispatch { it.pause() }
        call.resolve()
    }

    @PluginMethod
    fun next(call: PluginCall) {
        PlaybackHub.onMain {
            val service = PlaybackHub.current()
            if (service == null) {
                dispatch { it.next() }
                call.resolve(JSObject().put("state", emptyState()))
            } else {
                service.next()
                call.resolve(JSObject().put("state", service.stateJson()))
            }
        }
    }

    @PluginMethod
    fun prev(call: PluginCall) {
        PlaybackHub.onMain {
            val service = PlaybackHub.current()
            if (service == null) {
                dispatch { it.previous() }
                call.resolve(JSObject().put("state", emptyState()))
            } else {
                service.previous()
                call.resolve(JSObject().put("state", service.stateJson()))
            }
        }
    }

    @PluginMethod
    fun seekTo(call: PluginCall) {
        val seconds = call.getDouble("seconds")
        if (seconds == null) {
            call.reject("seekTo requires 'seconds'")
            return
        }
        dispatch { it.seekTo(seconds) }
        call.resolve()
    }

    @PluginMethod
    fun setRepeatMode(call: PluginCall) {
        val mode = call.getString("mode") ?: "off"
        dispatch { it.setRepeatMode(mode) }
        call.resolve()
    }

    @PluginMethod
    fun setVolume(call: PluginCall) {
        val volume = call.getDouble("volume") ?: 1.0
        dispatch { it.setVolume(volume.toFloat()) }
        call.resolve()
    }

    @PluginMethod
    fun setPlaybackRate(call: PluginCall) {
        val rate = call.getDouble("rate") ?: 1.0
        dispatch { it.setPlaybackRate(rate.toFloat()) }
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        dispatch { it.stop() }
        call.resolve()
    }

    // ----------------------------------------------------------------- state

    @PluginMethod
    fun getState(call: PluginCall) {
        PlaybackHub.onMain { resolveState(call) }
    }

    private fun resolveState(call: PluginCall) {
        val service = PlaybackHub.current()
        if (service != null) {
            call.resolve(JSObject().put("state", service.stateJson()))
            return
        }
        val snapshot = QueuePersistence.load(context)
        val state = JSObject().apply {
            put("isPlaying", false)
            put("isBuffering", false)
            put("currentIndex", snapshot?.index ?: -1)
            put("trackId", snapshot?.let { it.tracks.getOrNull(it.index)?.id })
            put("position", (snapshot?.positionMs ?: 0L) / 1000.0)
            put("duration", 0.0)
            put("repeatMode", snapshot?.repeatMode ?: "off")
            put("queueLength", snapshot?.tracks?.size ?: 0)
            put("native", true)
        }
        call.resolve(JSObject().put("state", state))
    }

    @PluginMethod
    fun getQueue(call: PluginCall) {
        PlaybackHub.onMain { resolveQueue(call) }
    }

    private fun resolveQueue(call: PluginCall) {
        val service = PlaybackHub.current()
        if (service != null) {
            call.resolve(service.queueJson())
            return
        }
        val snapshot = QueuePersistence.load(context)
        call.resolve(
            JSObject().apply {
                put("tracks", Track.listToJson(snapshot?.tracks ?: emptyList()))
                put("currentIndex", snapshot?.index ?: -1)
            }
        )
    }

    @PluginMethod
    fun requestNotificationPermission(call: PluginCall) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            call.resolve(JSObject().put("granted", true))
            return
        }
        if (getPermissionState("notifications") == PermissionState.GRANTED) {
            call.resolve(JSObject().put("granted", true))
            return
        }
        requestPermissionForAlias("notifications", call, "notificationPermissionCallback")
    }

    @PermissionCallback
    fun notificationPermissionCallback(call: PluginCall) {
        val granted = getPermissionState("notifications") == PermissionState.GRANTED
        call.resolve(JSObject().put("granted", granted))
    }

    private fun emptyState(): JSObject = JSObject().apply {
        put("isPlaying", false)
        put("isBuffering", false)
        put("currentIndex", -1)
        put("trackId", null as String?)
        put("position", 0.0)
        put("duration", 0.0)
        put("repeatMode", "off")
        put("queueLength", 0)
        put("native", true)
    }
}
