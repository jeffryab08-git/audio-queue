package com.hermes.mediaqueue

import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import com.getcapacitor.JSObject
import org.json.JSONArray
import org.json.JSONObject

/**
 * A queue entry. This is the Kotlin mirror of `Track` in src/definitions.ts and
 * of `Track` in the Swift module: the three must stay in sync.
 */
data class Track(
    val id: String,
    val url: String,
    val title: String? = null,
    val artist: String? = null,
    val album: String? = null,
    val artwork: String? = null,
    val headers: Map<String, String> = emptyMap(),
) {
    /**
     * The MediaItem carries metadata only. The actual bytes are resolved by the
     * DefaultMediaSourceFactory built on top of CacheDataSource, so the native
     * player - not JavaScript - decides when to fetch and when to transition.
     */
    fun toMediaItem(): MediaItem {
        val metadata = MediaMetadata.Builder()
            .setTitle(title ?: id)
            .setArtist(artist)
            .setAlbumTitle(album)
            .setIsBrowsable(false)
            .setIsPlayable(true)
            .apply { artwork?.let { setArtworkUri(Uri.parse(it)) } }
            .build()

        return MediaItem.Builder()
            .setMediaId(id)
            .setUri(url)
            .setMediaMetadata(metadata)
            .build()
    }

    fun toJson(): JSObject = JSObject().apply {
        put("id", id)
        put("url", url)
        put("title", title)
        put("artist", artist)
        put("album", album)
        put("artwork", artwork)
    }

    companion object {
        fun fromJson(obj: JSONObject): Track {
            val headers = mutableMapOf<String, String>()
            obj.optJSONObject("headers")?.let { h ->
                h.keys().forEach { key -> headers[key] = h.optString(key) }
            }
            return Track(
                id = obj.optString("id").ifBlank { obj.optString("url") },
                url = obj.getString("url"),
                title = obj.optStringOrNull("title"),
                artist = obj.optStringOrNull("artist"),
                album = obj.optStringOrNull("album"),
                artwork = obj.optStringOrNull("artwork"),
                headers = headers,
            )
        }

        fun listFromJson(array: JSONArray): List<Track> {
            val out = ArrayList<Track>(array.length())
            for (i in 0 until array.length()) {
                val obj = array.optJSONObject(i) ?: continue
                if (obj.optString("url").isBlank()) continue
                out.add(fromJson(obj))
            }
            return out
        }

        fun listToJson(tracks: List<Track>): JSONArray {
            val array = JSONArray()
            tracks.forEach { array.put(it.toJson()) }
            return array
        }
    }
}

internal fun JSONObject.optStringOrNull(key: String): String? {
    if (!has(key) || isNull(key)) return null
    val value = optString(key, "")
    return value.ifBlank { null }
}
