/**
 * Functional tests for the web fallback engine, using a fake <audio> element so
 * the double-buffer swap, the retry policy and the Media Session integration are
 * all exercised headlessly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebMediaQueue } from '../dist/esm/web-engine.js';

class FakeAudio {
  constructor() {
    this.src = '';
    this.preload = '';
    this.currentTime = 0;
    this.duration = 180;
    this.paused = true;
    this.ended = false;
    this.volume = 1;
    this.playbackRate = 1;
    this.playCalls = 0;
    this.loadCalls = [];
    this.listeners = new Map();
  }
  addEventListener(type, cb) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(cb);
  }
  removeEventListener(type, cb) {
    const arr = this.listeners.get(type) ?? [];
    this.listeners.set(type, arr.filter((x) => x !== cb));
  }
  fire(type, ev = {}) {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb(ev);
  }
  load() {
    this.loadCalls.push(this.src);
  }
  play() {
    this.playCalls += 1;
    this.paused = false;
    this.fire('playing');
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.fire('pause');
  }
}

class FakeMediaSession {
  constructor() {
    this.metadata = null;
    this.playbackState = 'none';
    this.handlers = new Map();
    this.positionStates = [];
  }
  setActionHandler(action, handler) {
    this.handlers.set(action, handler);
  }
  setPositionState(state) {
    this.positionStates.push(state);
  }
}

function makeEngine(opts = {}) {
  const created = [];
  const session = new FakeMediaSession();
  const engine = new WebMediaQueue({
    audioFactory: () => {
      const a = new FakeAudio();
      created.push(a);
      return a;
    },
    mediaSession: session,
    metadataFactory: (init) => ({ ...init }),
    progressIntervalMs: 100000,
    retryBaseMs: 5,
    ...opts,
  });
  return { engine, created, session };
}

const track = (id) => ({ id, url: `https://cdn.test/${id}.mp3`, title: id.toUpperCase(), artist: 'T' });
const playlist = () => ['a', 'b', 'c', 'd', 'e'].map(track);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('setQueue plays the first track and preloads the second in the other element', async () => {
  const { engine, created, session } = makeEngine();
  const changes = [];
  await engine.addListener('trackChanged', (e) => changes.push(e));
  await engine.setQueue(playlist());

  const [el0, el1] = created;
  assert.equal(el0.src, 'https://cdn.test/a.mp3');
  assert.equal(el0.playCalls, 1);
  assert.equal(el1.src, 'https://cdn.test/b.mp3', 'next track must be preloaded before it is needed');
  assert.equal(el1.playCalls, 0);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].track.id, 'a');
  assert.equal(session.metadata.title, 'A');
  assert.equal(session.playbackState, 'playing');
  assert.ok(session.handlers.has('nexttrack'));
  engine.dispose();
});

test('auto-advance on `ended` swaps to the already-preloaded element (no reload, no gap)', async () => {
  const { engine, created, session } = makeEngine();
  const changes = [];
  await engine.addListener('trackChanged', (e) => changes.push(e));
  await engine.setQueue(playlist(), { startIndex: 0 });

  const [el0, el1] = created;
  const loadsBefore = el1.loadCalls.length;
  el0.fire('ended'); // simulated end of track a
  await sleep(0);

  assert.equal(el1.playCalls, 1, 'preloaded element starts playing immediately');
  assert.equal(el1.loadCalls.length, loadsBefore, 'no extra load() on the preloaded element');
  assert.equal(changes.at(-1).track.id, 'b');
  assert.equal(changes.at(-1).automatic, true);
  assert.equal(changes.at(-1).reason, 'ended');
  assert.equal(session.metadata.title, 'B');
  // and track c is now preloaded back into the retired element
  assert.equal(el0.src, 'https://cdn.test/c.mp3');
  engine.dispose();
});

test('the whole 5-track playlist advances without any external intervention', async () => {
  const { engine, created } = makeEngine();
  const seen = [];
  await engine.addListener('trackChanged', (e) => seen.push(e.track.id));
  await engine.setQueue(playlist());

  // Simulate the media clock: whichever element is audible fires `ended`.
  for (let i = 0; i < 4; i += 1) {
    const audible = created.find((el) => el.playCalls > 0 && !el.paused);
    assert.ok(audible, `no audible element at step ${i}`);
    // Real browsers fire `pause` immediately before `ended` at end of media.
    audible.ended = true;
    audible.paused = true;
    audible.fire('pause');
    audible.fire('ended');
    audible.ended = false;
    await sleep(0);
  }
  assert.deepEqual(seen, ['a', 'b', 'c', 'd', 'e']);

  const state = await engine.getState();
  assert.equal(state.currentIndex, 4);
  assert.equal(state.isPlaying, true);

  // After the last track ends, playback stops instead of looping.
  const last = created.find((el) => el.playCalls > 0 && !el.paused);
  last.fire('ended');
  await sleep(0);
  const final = await engine.getState();
  assert.equal(final.isPlaying, false);
  assert.equal(final.currentIndex, 4);
  engine.dispose();
});

test('the swap happens fast: one microtask, no network wait', async () => {
  const { engine, created } = makeEngine();
  await engine.setQueue(playlist());
  const [el0] = created;
  const t0 = performance.now();
  el0.fire('ended');
  await Promise.resolve();
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 250, `advance took ${elapsed.toFixed(1)}ms`);
  engine.dispose();
});

test('repeat=track restarts the same element instead of advancing', async () => {
  const { engine, created } = makeEngine();
  await engine.setQueue(playlist());
  await engine.setRepeatMode('track');
  const [el0] = created;
  el0.currentTime = 42;
  el0.fire('ended');
  await sleep(0);
  assert.equal(el0.currentTime, 0);
  assert.equal(el0.playCalls, 2);
  assert.equal((await engine.getState()).currentIndex, 0);
  engine.dispose();
});

test('repeat=queue wraps from the last track back to the first', async () => {
  const { engine } = makeEngine();
  await engine.setQueue(playlist(), { startIndex: 4 });
  await engine.setRepeatMode('queue');
  await engine.next();
  assert.equal((await engine.getState()).currentIndex, 0);
  engine.dispose();
});

test('manual next/prev move through the queue', async () => {
  const { engine } = makeEngine();
  await engine.setQueue(playlist());
  await engine.next();
  await engine.next();
  assert.equal((await engine.getState()).currentIndex, 2);
  await engine.prev();
  assert.equal((await engine.getState()).currentIndex, 1);
  engine.dispose();
});

test('a network error retries with backoff, then reports a fatal error', async () => {
  const { engine, created } = makeEngine({ maxRetries: 1 });
  const errors = [];
  await engine.addListener('error', (e) => errors.push(e));
  await engine.setQueue(playlist());

  const active = created[0];
  active.fire('error');
  await sleep(30);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].fatal, false);
  assert.equal(errors[0].retries, 1);
  assert.ok(active.loadCalls.length >= 2, 'the retry re-loads the same track');

  active.fire('error');
  await sleep(60);
  const fatal = errors.at(-1);
  assert.equal(fatal.fatal, true);
  engine.dispose();
});

test('play() rejection is reported as a PERMISSION error without throwing', async () => {
  const { engine, created } = makeEngine();
  const errors = [];
  await engine.addListener('error', (e) => errors.push(e));
  await engine.setQueue(playlist(), { autoplay: false });
  const [el0] = created;
  el0.play = () => Promise.reject(new Error('NotAllowedError'));
  await engine.play();
  assert.equal(errors.at(-1).code, 'PERMISSION');
  assert.equal((await engine.getState()).isPlaying, false);
  engine.dispose();
});

test('setQueue with an empty list is a no-op that clears the state', async () => {
  const { engine } = makeEngine();
  await engine.setQueue([]);
  const state = await engine.getState();
  assert.equal(state.currentIndex, -1);
  assert.equal(state.queueLength, 0);
  assert.equal(state.isPlaying, false);
  engine.dispose();
});

test('queue mutations keep the playing track current and stay consistent', async () => {
  const { engine } = makeEngine();
  await engine.setQueue(playlist(), { startIndex: 1 }); // b
  await engine.insertAfterCurrent(track('x')); // a,b,x,c,d,e
  let q = await engine.getQueue();
  assert.deepEqual(q.tracks.map((t) => t.id), ['a', 'b', 'x', 'c', 'd', 'e']);
  assert.equal(q.currentIndex, 1);

  await engine.move(1, 3);
  q = await engine.getQueue();
  assert.deepEqual(q.tracks.map((t) => t.id), ['a', 'x', 'c', 'b', 'd', 'e']);
  assert.equal(q.tracks[q.currentIndex].id, 'b');

  await engine.removeAt(0);
  q = await engine.getQueue();
  assert.equal(q.tracks[q.currentIndex].id, 'b');
  engine.dispose();
});
