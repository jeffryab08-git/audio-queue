import test from 'node:test';
import assert from 'node:assert/strict';
import { QueueCore } from '../dist/esm/queue-core.js';

const t = (id) => ({ id, url: `https://example.test/${id}.mp3` });
const five = () => [t('a'), t('b'), t('c'), t('d'), t('e')];

test('setQueue clamps the start index and defaults to 0', () => {
  const q = new QueueCore();
  assert.equal(q.setQueue(five()), 0);
  assert.equal(q.current.id, 'a');
  const q2 = new QueueCore();
  assert.equal(q2.setQueue(five(), 99), 4);
  assert.equal(q2.current.id, 'e');
  const q3 = new QueueCore();
  assert.equal(q3.setQueue(five(), -3), 0);
  assert.equal(q3.setQueue([]), -1);
  assert.equal(q3.current, null);
});

test('advanceAutomatic walks the queue and stops at the end', () => {
  const q = new QueueCore();
  q.setQueue(five());
  assert.deepEqual(q.advanceAutomatic(), { kind: 'next', index: 1 });
  q.setIndex(4);
  assert.deepEqual(q.advanceAutomatic(), { kind: 'finished' });
});

test('repeat=track keeps the index, repeat=queue wraps to 0', () => {
  const q = new QueueCore();
  q.setQueue(five());
  q.setRepeatMode('track');
  q.setIndex(2);
  assert.deepEqual(q.advanceAutomatic(), { kind: 'same', index: 2 });

  q.setRepeatMode('queue');
  q.setIndex(4);
  assert.deepEqual(q.advanceAutomatic(), { kind: 'next', index: 0 });
});

test('manual skip does not wrap unless repeat=queue', () => {
  const q = new QueueCore();
  q.setQueue(five());
  q.setIndex(4);
  assert.equal(q.advanceManual(), null);
  assert.equal(q.currentIndex, 4);
  q.setRepeatMode('queue');
  assert.equal(q.advanceManual(), 0);

  const q2 = new QueueCore();
  q2.setQueue(five());
  assert.equal(q2.previous(), null);
  q2.setIndex(2);
  assert.equal(q2.previous(), 1);
});

test('insertAt keeps the currently playing track stable', () => {
  const q = new QueueCore();
  q.setQueue(five());
  q.setIndex(2); // c
  q.insertAt(t('x'), 0);
  assert.equal(q.current.id, 'c');
  assert.equal(q.currentIndex, 3);
  q.insertAt(t('y'), q.length - 1);
  assert.equal(q.current.id, 'c');
});

test('removeAt shifts the index correctly', () => {
  const q = new QueueCore();
  q.setQueue(five());
  q.setIndex(2); // c
  q.removeAt(0); // remove a -> index 1 (c)
  assert.equal(q.current.id, 'c');
  assert.equal(q.currentIndex, 1);
  q.removeAt(1); // remove current c -> index 1 is now d
  assert.equal(q.current.id, 'd');
  q.removeAt(q.length - 1); // remove last
  assert.equal(q.current.id, 'd');
  const empty = new QueueCore();
  empty.setQueue([t('solo')]);
  empty.removeAt(0);
  assert.equal(empty.currentIndex, -1);
  assert.equal(empty.current, null);
});

test('removeAt on the last playing item clamps the index', () => {
  const q = new QueueCore();
  q.setQueue(five());
  q.setIndex(4);
  q.removeAt(4);
  assert.equal(q.currentIndex, 3);
  assert.equal(q.current.id, 'd');
});

test('move keeps the playing track as current', () => {
  const q = new QueueCore();
  q.setQueue(five());
  q.setIndex(1); // b
  q.move(1, 4);
  assert.equal(q.current.id, 'b');
  assert.equal(q.currentIndex, 4);
  q.move(4, 0);
  assert.equal(q.current.id, 'b');
  assert.equal(q.currentIndex, 0);
  assert.equal(q.move(9, 0), false);
});

test('snapshot is a copy, not a live reference', () => {
  const q = new QueueCore();
  q.setQueue(five());
  const snap = q.snapshot();
  snap[0].title = 'mutated';
  assert.equal(q.snapshot()[0].title, undefined);
});
