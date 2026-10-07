import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(root, 'extension', 'service-worker.js'), 'utf8');
const helperStart = source.indexOf('function normalizedArtifactProofPath(');
const helperEnd = source.indexOf('\nfunction resetLaunchScheduler(', helperStart);
const helperSource = helperStart >= 0 && helperEnd > helperStart ? source.slice(helperStart, helperEnd).trim() : '';
assert.match(helperSource, /function fileVerificationForCompletedArtifact\(/, 'the service worker must define the artifact proof builder');
const buildProof = runInNewContext(`${helperSource}\nfileVerificationForCompletedArtifact`, { Date });
const hash = 'a'.repeat(64);

test('watcher proof binds the exact downloaded path, hash, byte count, generation, and source', () => {
  const proof = buildProof({
    verification: { valid: true, verified: true, verificationMode: 'watcher', sha256: hash, bytes: 4096 },
    generationId: 'generation-1', sourceId: 'casio:GA100',
    outputPath: 'C:\\Downloads\\WatchAutomation\\Casio GA-100.png',
    downloadItem: { filename: 'c:/downloads/watchautomation/casio ga-100.png', fileSize: 4096 }
  });
  assert.deepEqual({
    verified: proof.verified, exists: proof.exists, isFile: proof.isFile,
    sizeBytes: proof.sizeBytes, generationId: proof.generationId, sourceId: proof.sourceId,
    outputPath: proof.outputPath, outputHash: proof.outputHash
  }, {
    verified: true, exists: true, isFile: true, sizeBytes: 4096,
    generationId: 'generation-1', sourceId: 'casio:GA100',
    outputPath: 'C:\\Downloads\\WatchAutomation\\Casio GA-100.png', outputHash: hash
  });
});

test('a page-source hash cannot be promoted to proof of the physical saved file', () => {
  const proof = buildProof({
    verification: { valid: true, verified: true, verificationMode: 'page-source', sha256: hash, bytes: 4096 },
    generationId: 'generation-1', sourceId: 'casio:GA100',
    outputPath: 'C:\\Downloads\\WatchAutomation\\Casio GA-100.png',
    downloadItem: { filename: 'C:\\Downloads\\WatchAutomation\\Casio GA-100.png', fileSize: 4096 }
  });
  assert.equal(proof.verified, false);
  assert.equal(proof.exists, false);
  assert.equal(proof.isFile, false);
});

test('watcher proof is rejected if the verified path differs from the registered path', () => {
  const proof = buildProof({
    verification: { valid: true, verified: true, verificationMode: 'watcher', sha256: hash, bytes: 4096 },
    generationId: 'generation-1', sourceId: 'casio:GA100',
    outputPath: 'C:\\Downloads\\WatchAutomation\\other.png',
    downloadItem: { filename: 'C:\\Downloads\\WatchAutomation\\Casio GA-100.png', fileSize: 4096 }
  });
  assert.equal(proof.verified, false);
});

test('File System Access proof requires a verified readback of the exact saved path', () => {
  const input = {
    verification: { valid: true, verified: true, verificationMode: 'file-system-access', sha256: hash,
      bytes: 4096, exists: true, isFile: true, sizeBytes: 4096,
      fileReadBackVerified: true, outputPath: 'custom://Results/in_sale/Casio GA-100.png' },
    generationId: 'generation-2', sourceId: 'casio:GA100',
    outputPath: 'custom://Results/in_sale/Casio GA-100.png'
  };
  assert.equal(buildProof(input).verified, true);
  assert.equal(buildProof({ ...input, verification: { ...input.verification, fileReadBackVerified: false } }).verified, false);
  assert.equal(buildProof({ ...input, outputPath: 'custom://Results/in_sale/other.png' }).verified, false);
});

test('custom-directory writer re-reads and hashes the written file before allowing registration', () => {
  const start = source.indexOf('async function writeGeneratedToCustomDirectory(');
  const end = source.indexOf('\nasync function permissionForDirectoryHandle(', start);
  assert.ok(start >= 0 && end > start, 'custom-directory writer is present');
  const writer = source.slice(start, end);
  assert.match(writer, /const written = await fileHandle\.getFile\(\)/);
  assert.match(writer, /const readBackVerification = await verifyPngBlob\(written\)/);
  assert.match(writer, /fileReadBackVerified: true/);
  assert.match(writer, /outputPath,/);
});

test('image revision persistence receives the validated physical file proof', () => {
  const start = source.indexOf('async function finalizeCompletedArtifact(');
  const end = source.indexOf('\nasync function finishDownload(', start);
  assert.ok(start >= 0 && end > start, 'finalization function is present');
  const finalizer = source.slice(start, end);
  assert.match(finalizer, /const fileVerification = fileVerificationForCompletedArtifact\(/);
  assert.match(finalizer, /if \(!fileVerification\.verified\)/);
  assert.match(finalizer, /outputHash: verification\.sha256 \|\| null,\s*fileVerification,/);
});
