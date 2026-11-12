import Foundation
import AVFoundation
import Capacitor

/// Mirror of `Track` in src/definitions.ts and Track.kt.
struct Track {
    let id: String
    let url: String
    let title: String?
    let artist: String?
    let album: String?
    let artwork: String?
    let headers: [String: String]

    init?(json: JSObject) {
        guard let url = json["url"] as? String, !url.isEmpty else { return nil }
        self.id = (json["id"] as? String) ?? url
        self.url = url
        self.title = json["title"] as? String
        self.artist = json["artist"] as? String
        self.album = json["album"] as? String
        self.artwork = json["artwork"] as? String
        self.headers = (json["headers"] as? [String: String]) ?? [:]
    }

    init(
        id: String,
        url: String,
        title: String? = nil,
        artist: String? = nil,
        album: String? = nil,
        artwork: String? = nil,
        headers: [String: String] = [:]
    ) {
        self.id = id
        self.url = url
        self.title = title
        self.artist = artist
        self.album = album
        self.artwork = artwork
        self.headers = headers
    }

    var assetURL: URL? { URL(string: url) }

    func toJSON() -> JSObject {
        var out: JSObject = ["id": id, "url": url]
        if let title { out["title"] = title }
        if let artist { out["artist"] = artist }
        if let album { out["album"] = album }
        if let artwork { out["artwork"] = artwork }
        return out
    }

    /// Metadata lives in MediaMetadata; the bytes are owned by AVQueuePlayer, which
    /// keeps the next item prepared. `preferredForwardBufferDuration` gives each
    /// item ~10s of runway so a short network hiccup at a transition is invisible.
    ///
    /// Per-track HTTP headers are intentionally NOT applied here: the only way to
    /// do it with AVFoundation is the undocumented AVURLAssetHTTPHeaderFieldsKey
    /// option, which risks App Store rejection. Use Android for signed URLs, or
    /// put the token in the URL itself.
    func makePlayerItem() -> AVPlayerItem? {
        guard let assetURL else { return nil }
        let asset = AVURLAsset(url: assetURL)
        let item = AVPlayerItem(asset: asset)
        item.canUseNetworkResourcesForLiveStreamingWhilePaused = true
        item.preferredForwardBufferDuration = 10
        return item
    }
}
