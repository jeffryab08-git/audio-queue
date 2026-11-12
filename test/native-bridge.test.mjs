/**
 * Native bridge resolution tests: verifies that the same bundle picks the native
 * engine inside a Capacitor shell and the web engine everywhere else, and that
 * every call is forwarded with the argument shape the Kotlin/Swift side expects.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

function fakeNativePlugin(calls) {
  const handlers = new Map();
  const rec = (name) => (args) => {
    calls.push([name, args ?? null]);
    return Promise.resolve({ state: baseState });
  };
  const baseState = {
    isPlaying: true,
    isBuffering: false,
    currentIndex: 0,
    trackId: 'a',
    position: 12,
    duration: 180,
    repeatMode: 'off',
    queueLength: 5,
  };
  return {
    setQueue: rec('setQueue'),
    addToQueue: rec('addToQueue'),
    insertAfterCurrent: rec('insertAfterCurrent'),
    insertAt: rec('insertAt'),
    removeAt: rec('removeAt'),
    move: rec('move'),
    play: rec('play'),
    pause: rec('pause'),
    next: () => {
      calls.push(['next', null]);
      return Promise.resolve({ state: { ...baseState, currentIndex: 1 } });
    },
    prev: () => {
      calls.push(['prev', null]);
      return Promise.resolve({ state: baseState });
    },
    seekTo: rec('seekTo'),
    setRepeatMode: rec('setRepeatMode'),
    setVolume: rec('setVolume'),
    setPlaybackRate: rec('setPlaybackRate'),
    getState: () => Promise.resolve({ state: baseState }),
    getQueue: () => Promise.resolve({ tracks: [{ id: 'a', url: 'u' }], currentIndex: 0 }),
    stop: rec('stop'),
    requestNotificationPermission: () => Promise.resolve({ granted: true }),
    addListener: (name, cb) => {
      handlers.set(name, cb);
      return Promise.resolve({ remove: () => handlers.delete(name) });
    },
    removeAllListeners: () => Promise.resolve(),
    __emit: (name, payload) => handlers.get(name)?.(payload),
  };
}

test('no Capacitor runtime -> web engine with native=false', async () => {
  const mod = await import('../dist/esm/index.js');
  delete globalThis.Capacitor;
  assert.equal(mod.hasNativeEngine(), false);
  const q = mod.createMediaQueue({ force: 'web' });
  assert.equal((await q.getState()).native, false);
});

test('Capacitor web platform -> still the web engine (preview/Google AI Studio build)', async () => {
  globalThis.Capacitor = { isNativePlatform: () => false, Plugins: {}, registerPlugin: (n) => ({ name: n }) };
  const mod = await import('../dist/esm/index.js');
  assert.equal(mod.hasNativeEngine(), false);
  assert.equal(mod.createMediaQueue().constructor.name, 'WebMediaQueue');
  delete globalThis.Capacitor;
});

test('Capacitor native platform -> native engine forwards every call verbatim', async () => {
  const calls = [];
  globalThis.Capacitor = {
    isNativePlatform: () => true,
    Plugins: { MediaQueue: fakeNativePlugin(calls) },
  };
  const mod = await import('../dist/esm/index.js');
  assert.equal(mod.hasNativeEngine(), true);

  const q = mod.createMediaQueue();
  assert.equal(q.constructor.name, 'NativeMediaQueue');
  assert.equal((await q.getState()).native, true);

  const tracks = [{ id: 'a', url: 'https://x/a.mp3' }];
  await q.setQueue(tracks, { startIndex: 1, autoplay: true });
  await q.addToQueue(tracks[0]);
  await q.insertAfterCurrent(tracks[0]);
  await q.insertAt(tracks[0], 2);
  await q.removeAt(1);
  await q.move(0, 2);
  await q.play();
  await q.pause();
  const st = await q.next();
  await q.prev();
  await q.seekTo(30);
  await q.setRepeatMode('queue');
  await q.setVolume(0.5);
  await q.setPlaybackRate(1.25);
  await q.stop();

  assert.deepEqual(calls[0], ['setQueue', { tracks, startIndex: 1, autoplay: true }]);
  assert.deepEqual(calls.find((c) => c[0] === 'insertAt'), ['insertAt', { track: tracks[0], index: 2 }]);
  assert.deepEqual(calls.find((c) => c[0] === 'move'), ['move', { from: 0, to: 2 }]);
  assert.deepEqual(calls.find((c) => c[0] === 'seekTo'), ['seekTo', { seconds: 30 }]);
  assert.deepEqual(calls.find((c) => c[0] === 'setRepeatMode'), ['setRepeatMode', { mode: 'queue' }]);
  assert.equal(st.currentIndex, 1);
  assert.equal(st.native, true);
  delete globalThis.Capacitor;
});

test('native events arrive through addListener and unsubscribe closes the channel', async () => {
  const calls = [];
  const plugin = fakeNativePlugin(calls);
  globalThis.Capacitor = { isNativePlatform: () => true, Plugins: { MediaQueue: plugin } };
  const mod = await import('../dist/esm/index.js');
  const q = mod.createMediaQueue();

  const seen = [];
  const off = await q.addListener('trackChanged', (e) => seen.push(e));
  plugin.__emit('trackChanged', { index: 3, track: { id: 'd' }, automatic: true, reason: 'ended' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].index, 3);
  off();
  plugin.__emit('trackChanged', { index: 4 });
  assert.equal(seen.length, 1, 'listener removed');
  delete globalThis.Capacitor;
});

test('registerPlugin is used when Capacitor.Plugins is not pre-populated', async () => {
  const calls = [];
  const plugin = fakeNativePlugin(calls);
  let registered = 0;
  globalThis.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {},
    registerPlugin: (name) => {
      registered += 1;
      assert.equal(name, 'MediaQueue');
      globalThis.Capacitor.Plugins[name] = plugin;
      return plugin;
    },
  };
  const mod = await import('../dist/esm/index.js');
  // module-level resolution happens per call, not at import time
  assert.equal(mod.hasNativeEngine(), true);
  assert.equal(registered >= 1, true);
  delete globalThis.Capacitor;
});
