package com.hermes.mediaqueue

import android.content.Context
import org.json.JSONArray

/**
 * Persists the queue so a process death (low memory, Doze kill, OEM battery
 * manager) does not lose the playlist. On restore the player is prepared but not
 * started: resurrecting audio without a user gesture is hostile, and Android
 * would refuse the foreground service start anyway.
 */
object QueuePersistence {

    private const val PREFS = "com.hermes.mediaqueue.state"
    private const val KEY_TRACKS = "tracks"
    private const val KEY_INDEX = "index"
    private const val KEY_POSITION = "position"
    private const val KEY_REPEAT = "repeat"

    data class Snapshot(
        val tracks: List<Track>,
        val index: Int,
        val positionMs: Long,
        val repeatMode: String,
    )

    fun save(context: Context, tracks: List<Track>, index: Int, positionMs: Long, repeatMode: String) {
        if (tracks.isEmpty()) {
            clear(context)
            return
        }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_TRACKS, Track.listToJson(tracks).toString())
            .putInt(KEY_INDEX, index)
            .putLong(KEY_POSITION, positionMs)
            .putString(KEY_REPEAT, repeatMode)
            .apply()
    }

    fun load(context: Context): Snapshot? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString(KEY_TRACKS, null) ?: return null
        return try {
            val array = JSONArray(raw)
            val tracks = Track.listFromJson(array)
            if (tracks.isEmpty()) null
            else Snapshot(
                tracks = tracks,
                index = prefs.getInt(KEY_INDEX, 0).coerceIn(0, tracks.size - 1),
                positionMs = prefs.getLong(KEY_POSITION, 0L),
                repeatMode = prefs.getString(KEY_REPEAT, "off") ?: "off",
            )
        } catch (_: Throwable) {
            null
        }
    }

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
    }
}
