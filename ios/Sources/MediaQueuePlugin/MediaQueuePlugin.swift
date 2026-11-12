import Foundation
import Capacitor

/**
 JS <-> native surface. Same method names as MediaQueuePlugin.kt so the shared
 TypeScript bridge needs no per-platform branching.
 */
@objc(MediaQueuePlugin)
public class MediaQueuePlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "MediaQueuePlugin"
    public let jsName = "MediaQueue"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setQueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "addToQueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "insertAfterCurrent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "insertAt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeAt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "move", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "next", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prev", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seekTo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRepeatMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPlaybackRate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getQueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestNotificationPermission", returnType: CAPPluginReturnPromise),
    ]

    private let engine = QueuePlayerEngine()

    override public func load() {
        engine.onEvent = { [weak self] name, payload in
            // notifyListeners is a no-op when the WebView is gone; the JS side
            // re-reads state with getState() on resume, so dropped events are safe.
            self?.notifyListeners(name, data: payload)
        }
        // Bring the session up as soon as the plugin loads: with
        // UIBackgroundModes=audio in Info.plist this is what allows the process to
        // keep running (and keep decoding) once the screen locks.
        engine.activateSession()
    }

    private func tracksFrom(_ call: CAPPluginCall) -> [Track]? {
        guard let raw = call.getArray("tracks") else { return nil }
        return raw.compactMap { $0 as? JSObject }.compactMap { Track(json: $0) }
    }

    // MARK: - Queue

    @objc func setQueue(_ call: CAPPluginCall) {
        guard let tracks = tracksFrom(call) else {
            call.reject("setQueue requires a 'tracks' array")
            return
        }
        let startIndex = call.getInt("startIndex") ?? 0
        let startPosition = call.getDouble("startPosition") ?? 0
        let autoplay = call.getBool("autoplay") ?? true
        engine.setQueue(tracks, startIndex: startIndex, startPosition: startPosition, autoplay: autoplay)
        call.resolve()
    }

    @objc func addToQueue(_ call: CAPPluginCall) {
        guard let json = call.getObject("track"), let track = Track(json: json) else {
            call.reject("addToQueue requires a 'track' object")
            return
        }
        engine.addToQueue(track)
        call.resolve()
    }

    @objc func insertAfterCurrent(_ call: CAPPluginCall) {
        guard let json = call.getObject("track"), let track = Track(json: json) else {
            call.reject("insertAfterCurrent requires a 'track' object")
            return
        }
        let index = (engine.state()["currentIndex"] as? Int ?? -1) + 1
        engine.insertAt(track, index: max(index, 0))
        call.resolve()
    }

    @objc func insertAt(_ call: CAPPluginCall) {
        guard let json = call.getObject("track"), let track = Track(json: json), let index = call.getInt("index") else {
            call.reject("insertAt requires 'track' and 'index'")
            return
        }
        engine.insertAt(track, index: index)
        call.resolve()
    }

    @objc func removeAt(_ call: CAPPluginCall) {
        guard let index = call.getInt("index") else {
            call.reject("removeAt requires 'index'")
            return
        }
        engine.removeAt(index)
        call.resolve()
    }

    @objc func move(_ call: CAPPluginCall) {
        guard let from = call.getInt("from"), let to = call.getInt("to") else {
            call.reject("move requires 'from' and 'to'")
            return
        }
        engine.move(from: from, to: to)
        call.resolve()
    }

    // MARK: - Transport

    @objc func play(_ call: CAPPluginCall) {
        engine.play()
        call.resolve()
    }

    @objc func pause(_ call: CAPPluginCall) {
        engine.pause()
        call.resolve()
    }

    @objc func next(_ call: CAPPluginCall) {
        engine.next()
        call.resolve(["state": engine.state()])
    }

    @objc func prev(_ call: CAPPluginCall) {
        engine.previous()
        call.resolve(["state": engine.state()])
    }

    @objc func seekTo(_ call: CAPPluginCall) {
        guard let seconds = call.getDouble("seconds") else {
            call.reject("seekTo requires 'seconds'")
            return
        }
        engine.seek(toSeconds: seconds)
        call.resolve()
    }

    @objc func setRepeatMode(_ call: CAPPluginCall) {
        engine.setRepeatMode(call.getString("mode") ?? "off")
        call.resolve()
    }

    @objc func setVolume(_ call: CAPPluginCall) {
        engine.setVolume(Float(call.getDouble("volume") ?? 1))
        call.resolve()
    }

    @objc func setPlaybackRate(_ call: CAPPluginCall) {
        engine.setRate(Float(call.getDouble("rate") ?? 1))
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        engine.stop()
        call.resolve()
    }

    // MARK: - State

    @objc func getState(_ call: CAPPluginCall) {
        call.resolve(["state": engine.state()])
    }

    @objc func getQueue(_ call: CAPPluginCall) {
        call.resolve(engine.queueJSON())
    }

    @objc func requestNotificationPermission(_ call: CAPPluginCall) {
        // iOS has no equivalent of POST_NOTIFICATIONS for the Now Playing card.
        call.resolve(["granted": true])
    }
}
