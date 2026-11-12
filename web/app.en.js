/**
 * English mirror of app.js (the Spanish original stays the default entry point).
 * Keep both in sync when changing demo behavior: only the user-facing strings differ.
 *
 * PWA fallback demo. Imports the compiled ESM build directly (serve the repo
 * root with any static server, e.g. `npx http-server .` and open /web/).
 *
 * It forces the web engine on purpose: this page documents what the web platform
 * can and cannot do, independently of the native shell.
 */
import { createMediaQueue } from '../dist/esm/index.js';

const AUDIO = [
  { file: 'track1.wav', title: 'Tone A', artist: '440 Hz' },
  { file: 'track2.wav', title: 'Tone B', artist: '494 Hz' },
  { file: 'track3.wav', title: 'Tone C', artist: '523 Hz' },
  { file: 'track4.wav', title: 'Tone D', artist: '587 Hz' },
  { file: 'track5.wav', title: 'Tone E', artist: '659 Hz' },
];

const tracks = AUDIO.map((a, i) => ({
  id: a.file,
  url: `../example/www/audio/${a.file}`,
  title: a.title,
  artist: a.artist,
  album: 'MediaQueue demo',
  artwork: '../docs/assets/cover.svg',
}));

const queue = createMediaQueue({ force: 'web' });
const $ = (id) => document.getElementById(id);
const logEl = $('log');

const fmt = (s) => {
  if (!Number.isFinite(s) || s <= 0) return '0:00';
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
};
const log = (line) => {
  const t = new Date().toISOString().slice(11, 23);
  logEl.textContent = `${t}  ${line}\n${logEl.textContent}`.slice(0, 6000);
};

let state = { isPlaying: false, currentIndex: -1, position: 0, duration: 0 };
let current = [];

const render = () => {
  const t = current[state.currentIndex];
  $('now').childNodes[0].nodeValue = t ? t.title : 'Nothing playing';
  $('artist').textContent = t ? `${t.artist ?? ''}${state.isBuffering ? ' · buffering…' : ''}` : '—';
  $('toggle').textContent = state.isPlaying ? '❚❚' : '▶';
  $('qinfo').textContent = String(current.length);
  const pct = state.duration > 0 ? Math.min(100, (state.position / state.duration) * 100) : 0;
  $('progress').style.width = `${pct}%`;
  $('pos').textContent = fmt(state.position);
  $('dur').textContent = fmt(state.duration);
  const list = $('list');
  list.innerHTML = '';
  current.forEach((t2, i) => {
    const li = document.createElement('li');
    if (i === state.currentIndex) li.className = 'playing';
    li.innerHTML = `<span class="idx">${i + 1}</span><span><b></b><span class="artist"></span></span>`;
    li.querySelector('b').textContent = t2.title;
    li.querySelector('.artist').textContent = t2.artist ?? '';
    list.appendChild(li);
  });
};

const refresh = async () => {
  state = await queue.getState();
  current = (await queue.getQueue()).tracks;
  render();
};

await queue.addListener('trackChanged', (e) => {
  log(`trackChanged #${e.index} ${e.track?.title} (${e.reason}${e.automatic ? ', automatic' : ''})`);
  void refresh();
});
await queue.addListener('stateChanged', (s) => { state = { ...state, ...s }; render(); });
await queue.addListener('error', (e) => log(`error ${e.code} fatal=${e.fatal} retries=${e.retries}`));
await queue.addListener('progress', (p) => {
  state.position = p.position;
  state.duration = p.duration || state.duration;
  render();
});

$('toggle').onclick = async () => { state.isPlaying ? await queue.pause() : await queue.play(); await refresh(); };
$('next').onclick = async () => { await queue.next(); await refresh(); };
$('prev').onclick = async () => { await queue.prev(); await refresh(); };
$('clear').onclick = () => { logEl.textContent = ''; };

// ---------------------------------------------------------------- wake lock
// Only meaningful while the document is visible: the browser releases the screen
// wake lock as soon as the page is hidden, so it cannot keep audio alive when the
// phone locks. It is here to be explicit about that limitation.
let sentinel = null;
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) { $('wake').textContent = 'wake lock: unsupported'; return; }
  try {
    sentinel = await navigator.wakeLock.request('screen');
    $('wake').textContent = 'wake lock: active';
    $('wake').className = 'badge ok';
    sentinel.addEventListener('release', () => {
      $('wake').textContent = 'wake lock: released';
      $('wake').className = 'badge';
    });
  } catch {
    $('wake').textContent = 'wake lock: denied';
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.isPlaying && !sentinel) void requestWakeLock();
});

// service worker: app shell caching only (see service-worker.js for why it cannot
// keep audio running).
if ('serviceWorker' in navigator) {
  try {
    await navigator.serviceWorker.register('./service-worker.js', { scope: './' });
    log('service worker registered');
  } catch (e) {
    log(`service worker failed: ${e.message}`);
  }
}

await queue.setQueue(tracks, { startIndex: 0, autoplay: false });
await refresh();
void requestWakeLock();
log(`ready: ${tracks.length} tracks, engine=web`);
window.__mediaQueue = queue;
