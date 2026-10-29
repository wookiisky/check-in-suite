import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeReleaseChecksums } from './release.mjs';

// SHA256SUMS must describe shipped bytes including release.json, without hashing itself.
test('release checksums cover nested files and the manifest', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'island-checksums-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'web'));
  await writeFile(path.join(directory, 'web', 'index.html'), '<main>island</main>');
  await writeFile(path.join(directory, 'release.json'), '{"version":"test"}\n');
  await writeReleaseChecksums(directory);
  const first = await readFile(path.join(directory, 'SHA256SUMS'), 'utf8');
  const entries = first.trimEnd().split('\n').map((line) => [line.slice(0, 64), line.slice(66)]);
  assert.deepEqual(entries.map((entry) => entry[1]).sort(), ['release.json', 'web/index.html']);
  for (const [digest, name] of entries) {
    assert.equal(digest, createHash('sha256').update(await readFile(path.join(directory, name))).digest('hex'));
  }
  await writeReleaseChecksums(directory);
  assert.equal(await readFile(path.join(directory, 'SHA256SUMS'), 'utf8'), first);
});
