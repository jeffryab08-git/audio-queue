import Foundation
import AVFoundation
import MediaPlayer
import UIKit

/// Owns the AVQueuePlayer and the native queue.
///
/// The important property: the transition from track N to N+1 is performed by
/// AVQueuePlayer itself. This class keeps exactly two items loaded (current +
/// next) and refills from `tracks` when AVQueuePlayer reports that `currentItem`
/// changed. Swift is never in the audio path; it only observes and refills, so a
/// late callback (or a suspended JS context) cannot cause a gap.
///
/// Why two items and not the whole playlist: AVQueuePlayer keeps every item it
/// is given prepared, which costs memory and network for long playlists. Two
/// items is the sweet spot: item 2 is already `readyToPlay` when item 1 ends, and
/// the refill happens during playback of item 2, minutes before it is needed.
final class QueuePlayerEngine: NSObject {

    enum RepeatMode: String {
        case off, track, queue
    }

    /// 1 = current only, 2 = current + next (double buffer).
    private let windowSize = 2
    private let maxErrorRetries = 2

    private var player: AVQueuePlayer?
    private var tracks: [Track] = []
    private var currentIndex = -1
    private var repeatMode: RepeatMode = .off
    private var volume: Float = 1
    private var rate: Float = 1
    private var wantsPlayback = false
    private var shouldResumeAfterInterruption = false
    private var retries = 0
    private var isActive = false

    private var itemObservation: NSKeyValueObservation?
    private var statusObservation: NSKeyValueObservation?
    private var observers: [NSObjectProtocol] = []
    private var progressTimer: Timer?

    var onEvent: ((String, JSObject) -> Void)?

    // MARK: - Session

    func activateSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            // .playback keeps playing with the silent switch on and, together with
            // UIBackgroundModes=audio, while the screen is locked.
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
            isActive = true
        } catch {
            emit("error", [
                "code": "PERMISSION",
                "message": "AVAudioSession activation failed: \(error.localizedDescription)",
                "retries": 0,
                "fatal": false,
            ])
        }
        UIApplication.shared.beginReceivingRemoteControlEvents()
        registerRemoteCommands()
        registerNotifications()
    }

    private func deactivateSessionIfIdle() {
        guard isActive, !wantsPlayback else { return }
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
            isActive = false
        } catch {
            // Non-fatal: another app may still hold the session.
        }
    }

    // MARK: - Queue

    func setQueue(_ newTracks: [Track], startIndex: Int, startPosition: Double, autoplay: Bool) {
        tracks = newTracks
        retries = 0
        teardownPlayer()

        guard !tracks.isEmpty else {
            currentIndex = -1
            emitState()
            emitQueue()
            return
        }

        currentIndex = min(max(startIndex, 0), tracks.count - 1)
        activateSession()
        buildPlayer(from: currentIndex)
        if startPosition > 0 {
            player?.seek(to: CMTime(seconds: startPosition, preferredTimescale: 1000))
        }
        wantsPlayback = autoplay
        if autoplay { startPlayback() }
        emitQueue()
        emitTrackChanged(automatic: false, reason: "queue")
        emitState()
    }

    private func buildPlayer(from index: Int) {
        let items = makeItems(from: index, count: windowSize)
        let queuePlayer = AVQueuePlayer(items: items)
        queuePlayer.automaticallyWaitsToMinimizeStalling = true
        queuePlayer.volume = volume
        if #available(iOS 16.0, *) {
            queuePlayer.defaultRate = rate
        }
        player = queuePlayer
        observe(player: queuePlayer)
        observeCurrentItem()
        updateNowPlaying()
    }

    /// Builds up to `count` items starting at `index`, following the repeat mode.
    private func makeItems(from index: Int, count: Int) -> [AVPlayerItem] {
        var items: [AVPlayerItem] = []
        var cursor: Int? = index
        var guardCounter = 0
        while items.count < count, let i = cursor, guardCounter < count + 1 {
            guardCounter += 1
            guard let item = tracks[i].makePlayerItem() else { break }
            items.append(item)
            cursor = nextIndex(after: i)
        }
        return items
    }

    /// Repeat-aware successor. nil = end of playlist (no repeat).
    private func nextIndex(after index: Int) -> Int? {
        guard !tracks.isEmpty else { return nil }
        switch repeatMode {
        case .track:
            return index
        case .queue:
            return (index + 1) % tracks.count
        case .off:
            return index + 1 < tracks.count ? index + 1 : nil
        }
    }

    /// Keeps the native queue at `windowSize` items. Called whenever currentItem changes.
    private func refill() {
        guard let player else { return }
        let queued = player.items().count
        if queued >= windowSize { return }
        // Compute the path from the current item forward.
        var cursor = nextIndex(after: currentIndex)
        var appended = queued
        while appended < windowSize, let i = cursor {
            guard let item = tracks[i].makePlayerItem() else { break }
            if player.canInsert(item, after: nil) {
                player.insert(item, after: nil)
                appended += 1
            } else {
                break
            }
            cursor = nextIndex(after: i)
        }
    }

    private func teardownPlayer() {
        itemObservation?.invalidate()
        itemObservation = nil
        statusObservation?.invalidate()
        statusObservation = nil
        player?.pause()
        player?.removeAllItems()
        player = nil
        stopProgressTimer()
    }

    // MARK: - Transport

    func play() {
        guard !tracks.isEmpty else { return }
        wantsPlayback = true
        activateSession()
        // `player == nil` = never built; empty items = the queue drained at the end
        // of the playlist. Both cases need a rebuild, otherwise play() is a no-op.
        if player == nil || player?.items().isEmpty == true {
            buildPlayer(from: max(currentIndex, 0))
        }
        startPlayback()
    }

    private func startPlayback() {
        player?.play()
        player?.rate = rate
        startProgressTimer()
        emitState()
    }

    func pause() {
        wantsPlayback = false
        player?.pause()
        stopProgressTimer()
        deactivateSessionIfIdle()
        updateNowPlaying()
        emitState()
    }

    func next() {
        guard !tracks.isEmpty else { return }
        let target = nextIndex(after: currentIndex) ?? 0
        seek(toIndex: target, automatic: false, reason: "next")
    }

    func previous() {
        guard !tracks.isEmpty else { return }
        if let player, player.currentTime().seconds > 3 {
            player.seek(to: .zero)
            emitState()
            return
        }
        let target = max(currentIndex - 1, 0)
        seek(toIndex: target, automatic: false, reason: "prev")
    }

    private func seek(toIndex index: Int, automatic: Bool, reason: String) {
        guard index >= 0, index < tracks.count else { return }
        currentIndex = index
        buildPlayer(from: index)
        if wantsPlayback { startPlayback() } else { emitState() }
        emitTrackChanged(automatic: automatic, reason: reason)
    }

    func seek(toSeconds seconds: Double) {
        player?.seek(to: CMTime(seconds: max(0, seconds), preferredTimescale: 1000))
        emitState()
    }

    func setRepeatMode(_ mode: String) {
        repeatMode = RepeatMode(rawValue: mode) ?? .off
        // Rebuild the window so a newly enabled repeat takes effect immediately.
        if let player, !tracks.isEmpty, player.items().count < windowSize {
            refill()
        }
        emitState()
    }

    func setVolume(_ value: Float) {
        volume = min(max(value, 0), 1)
        player?.volume = volume
        emitState()
    }

    func setRate(_ value: Float) {
        rate = min(max(value, 0.25), 4)
        if wantsPlayback { player?.rate = rate }
        emitState()
    }

    func stop() {
        wantsPlayback = false
        teardownPlayer()
        tracks = []
        currentIndex = -1
        retries = 0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        deactivateSessionIfIdle()
        emitState()
        emitQueue()
    }

    // MARK: - Queue mutation

    func addToQueue(_ track: Track) {
        tracks.append(track)
        emitQueue()
        if tracks.count == 1 { setQueue(tracks, startIndex: 0, startPosition: 0, autoplay: false) } else { refill() }
    }

    func insertAt(_ track: Track, index: Int) {
        let position = min(max(index, 0), tracks.count)
        tracks.insert(track, at: position)
        if position <= currentIndex { currentIndex += 1 }
        emitQueue()
    }

    func removeAt(_ index: Int) {
        guard index >= 0, index < tracks.count else { return }
        tracks.remove(at: index)
        if tracks.isEmpty {
            stop()
            return
        }
        if index < currentIndex {
            currentIndex -= 1
        } else if index == currentIndex {
            currentIndex = min(currentIndex, tracks.count - 1)
            seek(toIndex: currentIndex, automatic: false, reason: "queue")
        }
        emitQueue()
    }

    func move(from: Int, to: Int) {
        guard from >= 0, from < tracks.count else { return }
        let target = min(max(to, 0), tracks.count - 1)
        let track = tracks.remove(at: from)
        tracks.insert(track, at: target)
        if currentIndex == from {
            currentIndex = target
        } else if from < currentIndex && target >= currentIndex {
            currentIndex -= 1
        } else if from > currentIndex && target <= currentIndex {
            currentIndex += 1
        }
        emitQueue()
    }

    // MARK: - State

    func state() -> JSObject {
        let duration = player?.currentItem?.duration.seconds ?? 0
        return [
            "isPlaying": wantsPlayback && (player?.timeControlStatus == .playing),
            "isBuffering": player?.timeControlStatus == .waitingToPlayAtSpecifiedRate,
            "currentIndex": currentIndex,
            "trackId": currentTrack()?.id,
            "position": player?.currentTime().seconds ?? 0,
            "duration": duration.isFinite ? duration : 0,
            "repeatMode": repeatMode.rawValue,
            "queueLength": tracks.count,
            "native": true,
        ]
    }

    func queueJSON() -> JSObject {
        ["tracks": tracks.map { $0.toJSON() }, "currentIndex": currentIndex]
    }

    func currentTrack() -> Track? {
        currentIndex >= 0 && currentIndex < tracks.count ? tracks[currentIndex] : nil
    }

    // MARK: - Observation

    private func observe(player: AVQueuePlayer) {
        itemObservation = player.observe(\.currentItem, options: [.new, .old]) { [weak self] _, change in
            guard let self else { return }
            guard let newItem = change.newValue ?? nil, newItem !== (change.oldValue ?? nil) else { return }
            self.handleCurrentItemChanged()
        }
    }

    private func observeCurrentItem() {
        statusObservation?.invalidate()
        statusObservation = player?.currentItem?.observe(\.status, options: [.new]) { [weak self] item, _ in
            guard let self else { return }
            switch item.status {
            case .failed:
                self.handleItemFailure(item.error)
            case .readyToPlay:
                if self.wantsPlayback { self.player?.play() }
                self.updateNowPlaying()
            default:
                break
            }
        }
    }

    /// AVQueuePlayer advanced by itself (or we rebuilt the player).
    private func handleCurrentItemChanged() {
        guard let player else { return }
        let nextIndexValue = nextIndex(after: currentIndex)
        if player.currentItem == nil {
            // Queue drained: end of playlist without repeat.
            wantsPlayback = false
            stopProgressTimer()
            emitState()
            return
        }
        if let nextIndexValue, nextIndexValue != currentIndex {
            currentIndex = nextIndexValue
        }
        retries = 0
        observeCurrentItem()
        refill()
        updateNowPlaying()
        emitTrackChanged(automatic: true, reason: "ended")
        emitState()
    }

    private func handleItemFailure(_ error: Error?) {
        let message = error?.localizedDescription ?? "unknown AVPlayerItem failure"
        guard retries < maxErrorRetries else {
            emit("error", ["code": "NETWORK", "message": message, "trackId": currentTrack()?.id ?? "", "retries": retries, "fatal": true])
            // Skip the broken entry: one bad URL must not kill the playlist.
            if let player, player.items().count > 1 {
                player.advanceToNextItem()
            } else if let next = nextIndex(after: currentIndex), next != currentIndex {
                seek(toIndex: next, automatic: true, reason: "error")
            } else {
                pause()
            }
            return
        }
        retries += 1
        emit("error", ["code": "NETWORK", "message": message, "trackId": currentTrack()?.id ?? "", "retries": retries, "fatal": false])
        let delay = 1.0 * Double(retries)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, let player = self.player, self.wantsPlayback else { return }
            // Rebuild the window for the current track to force a fresh load.
            self.seek(toIndex: self.currentIndex, automatic: true, reason: "error")
            player.play()
        }
    }

    private func registerNotifications() {
        guard observers.isEmpty else { return }
        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] note in
            self?.handleInterruption(note)
        })
        observers.append(center.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
        ) { [weak self] note in
            self?.handleRouteChange(note)
        })
        observers.append(center.addObserver(
            forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let error = note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error else { return }
            self?.handleItemFailure(error)
        })
    }

    private func handleInterruption(_ note: Notification) {
        guard
            let info = note.userInfo,
            let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: raw)
        else { return }

        switch type {
        case .began:
            // A call or another app took the session. Pause and remember intent.
            shouldResumeAfterInterruption = wantsPlayback
            wantsPlayback = false
            player?.pause()
            stopProgressTimer()
            updateNowPlaying()
            emitState()
        case .ended:
            let optionsRaw = info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let options = AVAudioSession.InterruptionOptions(rawValue: optionsRaw)
            if options.contains(.shouldResume), shouldResumeAfterInterruption {
                // Resume by itself: this is what makes "call ends -> music returns"
                // work without touching the phone.
                shouldResumeAfterInterruption = false
                activateSession()
                wantsPlayback = true
                startPlayback()
            }
        @unknown default:
            break
        }
    }

    private func handleRouteChange(_ note: Notification) {
        guard
            let info = note.userInfo,
            let raw = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
            let reason = AVAudioSession.RouteChangeReason(rawValue: raw)
        else { return }
        if reason == .oldDeviceUnavailable {
            // Headphones unplugged -> pause, like every other player.
            pause()
        }
    }

    // MARK: - Remote commands / Now Playing

    private func registerRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.removeTarget(nil)
        center.pauseCommand.removeTarget(nil)
        center.togglePlayPauseCommand.removeTarget(nil)
        center.nextTrackCommand.removeTarget(nil)
        center.previousTrackCommand.removeTarget(nil)
        center.changePlaybackPositionCommand.removeTarget(nil)

        center.playCommand.addTarget { [weak self] _ in self?.play(); return .success }
        center.pauseCommand.addTarget { [weak self] _ in self?.pause(); return .success }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            if self.wantsPlayback { self.pause() } else { self.play() }
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in self?.next(); return .success }
        center.previousTrackCommand.addTarget { [weak self] _ in self?.previous(); return .success }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self?.seek(toSeconds: event.positionTime)
            return .success
        }
    }

    private func updateNowPlaying() {
        guard let track = currentTrack() else {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            return
        }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: track.title ?? track.id,
            MPMediaItemPropertyArtist: track.artist ?? "",
            MPMediaItemPropertyAlbumTitle: track.album ?? "",
            MPNowPlayingInfoPropertyElapsedPlaybackTime: player?.currentTime().seconds ?? 0,
            MPNowPlayingInfoPropertyPlaybackRate: wantsPlayback ? 1.0 : 0.0,
        ]
        let duration = player?.currentItem?.duration.seconds ?? 0
        if duration.isFinite, duration > 0 {
            info[MPMediaItemPropertyPlaybackDuration] = duration
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info

        if let artwork = track.artwork, let url = URL(string: artwork) {
            let expectedId = track.id
            URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
                guard let data, let image = UIImage(data: data), self?.currentTrack()?.id == expectedId else { return }
                DispatchQueue.main.async {
                    let art = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                    var updated = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
                    updated[MPMediaItemPropertyArtwork] = art
                    MPNowPlayingInfoCenter.default().nowPlayingInfo = updated
                }
            }.resume()
        }
    }

    // MARK: - Progress

    private func startProgressTimer() {
        guard progressTimer == nil else { return }
        progressTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self, let player = self.player else { return }
            // Only meaningful (and only cheap) while the app is visible: the JS
            // context is frozen in background anyway, and the native engine does
            // not need progress to keep playing.
            guard UIApplication.shared.applicationState == .active else { return }
            let duration = player.currentItem?.duration.seconds ?? 0
            self.emit("progress", [
                "position": player.currentTime().seconds,
                "duration": duration.isFinite ? duration : 0,
                "trackId": self.currentTrack()?.id ?? "",
            ])
        }
    }

    private func stopProgressTimer() {
        progressTimer?.invalidate()
        progressTimer = nil
    }

    // MARK: - Events

    private func emitState() {
        onEvent?("stateChanged", state())
    }

    private func emitQueue() {
        onEvent?("queueChanged", queueJSON())
    }

    private func emitTrackChanged(automatic: Bool, reason: String) {
        onEvent?("trackChanged", [
            "index": currentIndex,
            "track": currentTrack()?.toJSON() ?? [:],
            "automatic": automatic,
            "reason": reason,
            "state": state(),
        ])
    }

    private func emit(_ name: String, _ payload: JSObject) {
        onEvent?(name, payload)
    }
}
