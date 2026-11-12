/**
 * Minimal demo: five public-domain-ish tones generated at build time (www/audio)
 * so the demo works offline in a browser and over HTTP on a device.
 *
 * Query parameters:
 *   ?base=<url>     audio base URL (default: ./audio/ on web, http://10.0.2.2:8099/ on Android)
 *   ?autoplay=1     start playing on load (used by the automated device test)
 *   ?tracks=5       how many tracks to queue (default 5)
 */
import { createMediaQueue, hasNativeEngine } from './vendor/index.js';

const params = new URLSearchParams(location.search);
const platform = window.Capacitor?.getPlatform?.() ?? 'web';
const defaultBase = platform === 'android' ? 'http://10.0.2.2:8099/' : './audio/';
const base = params.get('base') ?? defaultBase;
const trackCount = Number(params.get('tracks') ?? 5);

const TITLES = [
  ['Tono A', 'Demo · 440 Hz'],
  ['Tono B', 'Demo · 494 Hz'],
  ['Tono C', 'Demo · 523 Hz'],
  ['Tono D', 'Demo · 587 Hz'],
  ['Tono E', 'Demo · 659 Hz'],
];

const makeTrack = (i) => {
  const n = (i % 5) + 1;
  const [title, artist] = TITLES[n - 1];
  return {
    id: `track${n}-${i}`,
    url: `${base}track${n}.wav`,
    title: `${title} #${i + 1}`,
    artist,
    album: 'MediaQueue demo',
  };
};

const queue = createMediaQueue();
const $ = (id) => document.getElementById(id);
const logEl = $('log');

function log(line) {
  const time = new Date().toISOString().slice(11, 23);
  logEl.textContent = `${time}  ${line}\n` + logEl.textContent;
  if (logEl.textContent.length > 8000) logEl.textContent = logEl.textContent.slice(0, 8000);
  // Also mirror to logcat via the console so `adb logcat` can follow a device run.
  console.log(`[MediaQueueDemo] ${line}`);
}

const fmt = (s) => {
  if (!Number.isFinite(s) || s <= 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
};

let state = { isPlaying: false, currentIndex: -1, position: 0, duration: 0, repeatMode: 'off' };
let tracks = [];

function render() {
  const current = tracks[state.currentIndex];
  $('nowTitle').childNodes[0].nodeValue = current ? current.title ?? current.id : 'Sin reproducción';
  $('nowArtist').textContent = current ? `${current.artist ?? ''}${state.isBuffering ? ' · buffering…' : ''}` : '—';
  $('toggle').textContent = state.isPlaying ? '❚❚' : '▶';
  $('engine').textContent = `engine: ${hasNativeEngine() ? 'native' : 'web'}`;
  $('engine').className = `badge${hasNativeEngine() ? ' native' : ''}`;
  $('repeat').textContent = `repeat: ${state.repeatMode}`;
  $('queueInfo').textContent = `${tracks.length} tracks`;
  const pct = state.duration > 0 ? Math.min(100, (state.position / state.duration) * 100) : 0;
  $('progress').style.width = `${pct}%`;
  $('pos').textContent = fmt(state.position);
  $('dur').textContent = fmt(state.duration);

  const list = $('list');
  list.innerHTML = '';
  tracks.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = i === state.currentIndex ? 'playing' : '';
    li.innerHTML = `<span class="idx">${i + 1}</span><span class="meta"><b></b><span></span></span>`;
    li.querySelector('b').textContent = t.title ?? t.id;
    li.querySelector('.meta span').textContent = t.artist ?? '';
    list.appendChild(li);
  });
}

async function refresh() {
  state = await queue.getState();
  const q = await queue.getQueue();
  tracks = q.tracks;
  render();
}

// ------------------------------------------------------------------ events

await queue.addListener('trackChanged', (e) => {
  log(`trackChanged → #${e.index} ${e.track?.title ?? '∅'} (${e.reason}${e.automatic ? ', automatic' : ''})`);
  void refresh();
});
await queue.addListener('stateChanged', (s) => {
  state = { ...state, ...s };
  if (s.isBuffering) log('stateChanged → buffering');
  render();
});
await queue.addListener('queueChanged', (q) => {
  tracks = q.tracks;
  log(`queueChanged → ${q.tracks.length} tracks (current=${q.currentIndex})`);
  render();
});
await queue.addListener('error', (e) => log(`error ${e.code} fatal=${e.fatal} retries=${e.retries} :: ${e.message}`));
await queue.addListener('progress', (p) => {
  state.position = p.position;
  state.duration = p.duration || state.duration;
  const pct = state.duration > 0 ? Math.min(100, (state.position / state.duration) * 100) : 0;
  $('progress').style.width = `${pct}%`;
  $('pos').textContent = fmt(state.position);
  $('dur').textContent = fmt(state.duration);
});

// --------------------------------------------------------------- controls

$('toggle').onclick = async () => {
  if (state.isPlaying) await queue.pause();
  else await queue.play();
  await refresh();
};
$('next').onclick = async () => { await queue.next(); await refresh(); };
$('prev').onclick = async () => { await queue.prev(); await refresh(); };
$('add').onclick = async () => {
  await queue.addToQueue(makeTrack(tracks.length));
  await refresh();
};
$('playnext').onclick = async () => {
  await queue.insertAfterCurrent(makeTrack(tracks.length + 100));
  await refresh();
};
$('remove').onclick = async () => {
  if (state.currentIndex >= 0) await queue.removeAt(state.currentIndex);
  await refresh();
};
$('move').onclick = async () => {
  if (state.currentIndex >= 0 && tracks.length > 1) {
    await queue.move(state.currentIndex, (state.currentIndex + 1) % tracks.length);
    await refresh();
  }
};
$('cycleRepeat').onclick = async () => {
  const order = ['off', 'track', 'queue'];
  const nextMode = order[(order.indexOf(state.repeatMode) + 1) % order.length];
  await queue.setRepeatMode(nextMode);
  await refresh();
};
$('stop').onclick = async () => { await queue.stop(); await refresh(); };
$('clear').onclick = () => { logEl.textContent = ''; };

// ------------------------------------------------------------------ boot

if (hasNativeEngine()) {
  const permission = await queue.requestNotificationPermission();
  log(`notification permission granted=${permission.granted}`);
}

const initial = Array.from({ length: trackCount }, (_, i) => makeTrack(i));
await queue.setQueue(initial, { startIndex: 0, autoplay: params.get('autoplay') === '1' });
await refresh();
log(`queue ready: ${initial.length} tracks, native=${hasNativeEngine()}, base=${base}`);
// Expose for scripted checks (adb shell + chrome devtools, or the browser console).
window.__mediaQueue = queue;
window.__mediaQueueState = () => queue.getState();
