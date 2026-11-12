/**
 * Pure queue arithmetic. Deliberately framework-free and side-effect free so it
 * can be unit tested in Node and reused by the web engine.
 *
 * The native engines implement the same rules natively (Media3 playlist order /
 * AVQueuePlayer item order), so this module is only the JS-side mirror that the
 * UI renders and that the web fallback executes.
 */
export class QueueCore {
    tracks = [];
    index = -1;
    repeat = 'off';
    get length() {
        return this.tracks.length;
    }
    get currentIndex() {
        return this.index;
    }
    get current() {
        return this.index >= 0 && this.index < this.tracks.length ? this.tracks[this.index] : null;
    }
    get repeatMode() {
        return this.repeat;
    }
    snapshot() {
        return this.tracks.map((t) => ({ ...t }));
    }
    setRepeatMode(mode) {
        this.repeat = mode;
    }
    /** Replaces the queue and clamps the start index. Returns the effective index. */
    setQueue(tracks, startIndex = 0) {
        this.tracks = tracks.map((t) => ({ ...t }));
        if (this.tracks.length === 0) {
            this.index = -1;
            return -1;
        }
        this.index = Math.min(Math.max(startIndex, 0), this.tracks.length - 1);
        return this.index;
    }
    /**
     * What should play when the current track ends on its own.
     * `repeat=track` keeps the same index (the engine restarts that item),
     * `repeat=queue` wraps to 0, otherwise stop at the end.
     */
    advanceAutomatic() {
        if (this.tracks.length === 0 || this.index < 0)
            return { kind: 'finished' };
        if (this.repeat === 'track')
            return { kind: 'same', index: this.index };
        if (this.index + 1 < this.tracks.length)
            return { kind: 'next', index: this.index + 1 };
        if (this.repeat === 'queue')
            return { kind: 'next', index: 0 };
        return { kind: 'finished' };
    }
    /** Manual skip forward. Always moves; wraps only with repeat=queue. */
    advanceManual() {
        if (this.tracks.length === 0 || this.index < 0)
            return null;
        if (this.index + 1 < this.tracks.length) {
            this.index += 1;
            return this.index;
        }
        if (this.repeat === 'queue') {
            this.index = 0;
            return this.index;
        }
        return null;
    }
    /** Manual skip back. No wrap. */
    previous() {
        if (this.tracks.length === 0 || this.index <= 0)
            return null;
        this.index -= 1;
        return this.index;
    }
    /** Moves the index without bounds checks (engine says "now playing index N"). */
    setIndex(next) {
        if (next >= 0 && next < this.tracks.length)
            this.index = next;
    }
    append(track) {
        this.tracks.push({ ...track });
        if (this.index < 0)
            this.index = 0;
        return this.tracks.length - 1;
    }
    insertAt(track, at) {
        const position = Math.min(Math.max(at, 0), this.tracks.length);
        this.tracks.splice(position, 0, { ...track });
        if (this.index < 0)
            this.index = 0;
        else if (position <= this.index)
            this.index += 1;
        return position;
    }
    removeAt(at) {
        if (at < 0 || at >= this.tracks.length)
            return null;
        const [removed] = this.tracks.splice(at, 1);
        if (this.tracks.length === 0) {
            this.index = -1;
        }
        else if (at < this.index) {
            this.index -= 1;
        }
        else if (at === this.index && this.index >= this.tracks.length) {
            this.index = this.tracks.length - 1;
        }
        return removed ?? null;
    }
    move(from, to) {
        if (from < 0 || from >= this.tracks.length)
            return false;
        const target = Math.min(Math.max(to, 0), this.tracks.length - 1);
        if (from === target)
            return true;
        const [moved] = this.tracks.splice(from, 1);
        if (!moved)
            return false;
        this.tracks.splice(target, 0, moved);
        if (this.index === from)
            this.index = target;
        else if (from < this.index && target >= this.index)
            this.index -= 1;
        else if (from > this.index && target <= this.index)
            this.index += 1;
        return true;
    }
}
