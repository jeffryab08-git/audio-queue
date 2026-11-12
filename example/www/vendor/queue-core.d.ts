/**
 * Pure queue arithmetic. Deliberately framework-free and side-effect free so it
 * can be unit tested in Node and reused by the web engine.
 *
 * The native engines implement the same rules natively (Media3 playlist order /
 * AVQueuePlayer item order), so this module is only the JS-side mirror that the
 * UI renders and that the web fallback executes.
 */
import type { RepeatMode, Track } from './definitions.js';
export type AdvanceResult = {
    kind: 'same';
    index: number;
} | {
    kind: 'next';
    index: number;
} | {
    kind: 'finished';
};
export declare class QueueCore {
    private tracks;
    private index;
    private repeat;
    get length(): number;
    get currentIndex(): number;
    get current(): Track | null;
    get repeatMode(): RepeatMode;
    snapshot(): Track[];
    setRepeatMode(mode: RepeatMode): void;
    /** Replaces the queue and clamps the start index. Returns the effective index. */
    setQueue(tracks: Track[], startIndex?: number): number;
    /**
     * What should play when the current track ends on its own.
     * `repeat=track` keeps the same index (the engine restarts that item),
     * `repeat=queue` wraps to 0, otherwise stop at the end.
     */
    advanceAutomatic(): AdvanceResult;
    /** Manual skip forward. Always moves; wraps only with repeat=queue. */
    advanceManual(): number | null;
    /** Manual skip back. No wrap. */
    previous(): number | null;
    /** Moves the index without bounds checks (engine says "now playing index N"). */
    setIndex(next: number): void;
    append(track: Track): number;
    insertAt(track: Track, at: number): number;
    removeAt(at: number): Track | null;
    move(from: number, to: number): boolean;
}
