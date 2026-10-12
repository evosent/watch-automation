// Isolated gallery fixture. Never connects to the user's extension or database.
// Run: node scripts/preview-gallery-review.mjs <existing PNG for visual QA>
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const png = await readFile(process.argv[2]);
const hash = createHash('sha256').update(png).digest('hex');
const origin = 'http://127.0.0.1:18764';
const fixture = `
import { upsertGenerationRevision, replaceModelCatalog, getAllGenerationRevisions, getAllModelCatalog } from '/extension/idb.js';
import { createCardEditController } from '/extension/card-edit-controller.js';
const hash = ${JSON.stringify(hash)}, listeners = [], storage = { outputDestination: { mode: 'downloads' } };
const nativeFetch = window.fetch.bind(window);
window.fetch = (url, options) => nativeFetch(String(url).replace('http://127.0.0.1:17321', location.origin), options);
let tail = Promise.resolve();
const ctrl = createCardEditController({ lock: task => { const next = tail.then(task); tail = next.catch(() => {}); return next; },
  buildFactsPrompt: () => 'OCR', normalizeFacts: (record, text) => ({ ...JSON.parse(text), status: 'ok', profileId: record.profileId }),
  refreshAccounting: async () => {}, runIsActive: run => !!run });
const make = (id, sourceId, model, size, parent) => ({ generationId: id, sourceId, modelName: 'Casio G-Shock ' + model, profileId: 'casio',
 groupId: 'in_sale_good', outputPath: 'D:/Fixture/WatchAutomation/in_sale_good/' + id + '.png', outputFileName: id + '.png', outputHash: hash,
 factsJobId: 'facts-' + id, status: parent ? 'REVIEW_PENDING' : 'READY', reviewStatus: parent ? 'pending' : undefined,
 parentGenerationId: parent, generatedAt: '2026-10-12T08:00:00Z', completedAt: '2026-10-12T08:00:00Z', factsStatus: 'ok',
 facts: { status: 'ok', generationId: id, factsJobId: 'facts-' + id, outputHash: hash, titleBrand: 'Casio', titleSeries: 'G-Shock', titleModel: model,
 utp1: 'Минеральное стекло', utp2: 'Ударопрочный корпус', waterResistance: '20 бар водозащита', caseSize: size + ' мм размер корпуса' } });
const revisions = [make('current', 'casio:GA21001A', 'GA-2100-1A', '45,4'), make('old', 'casio:GA21001A', 'GA-2100-1A', '43'),
 make('candidate', 'casio:GA21001A', 'GA-2100-1A', '45,4', 'current'), make('color', 'casio:GA21004A', 'GA-2100-4A', '48')];
const models = [{ skuKey: 'casio:GA21001A', modelName: revisions[0].modelName, brandId: 'casio', sourcePresent: true, currentGenerationId: 'current', latestReadyGenerationId: 'current', variants: [] },
 { skuKey: 'casio:GA21004A', modelName: revisions[3].modelName, brandId: 'casio', sourcePresent: true, currentGenerationId: 'color', latestReadyGenerationId: 'color', variants: [] }];
let snapshotSequence = 0;
async function snapshot() {
 const revs = await getAllGenerationRevisions(); const catalog = await getAllModelCatalog({ includeRemoved: true });
 return { version: 1, snapshotSequence: ++snapshotSequence, generatedAt: new Date().toISOString(), reconciliationComplete: true, verificationAvailable: true,
 entries: catalog.map(m => ({ skuKey: m.skuKey, status: 'READY', identityStatus: 'OK', model: m, acceptedGenerationId: m.latestReadyGenerationId,
 acceptedRevision: revs.find(r => r.generationId === m.latestReadyGenerationId), artifactVerification: { verified: true }, revisionCount: revs.filter(r => r.sourceId === m.skuKey).length })) };
}
window.chrome = { storage: { onChanged: { addListener: fn => listeners.push(fn) }, local: {
 async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, storage[k]])); },
 async set(values) { const changes = Object.fromEntries(Object.entries(values).map(([key,value]) => [key, { oldValue: storage[key], newValue: value }])); Object.assign(storage, structuredClone(values)); listeners.forEach(fn => fn(changes, 'local')); }
 } }, runtime: { getURL: name => location.origin + '/extension/' + name, async sendMessage(message) {
  try { if (message.type === 'GET_ACCOUNTING_SNAPSHOT') return { ok: true, value: await snapshot() };
    if (message.type === 'GET_RESULTS_TRANSFER_INFO') return { ok: true, value: { identity: {}, runs: [], count: 2 } };
    window.fixtureMessages.push(structuredClone(message));
    return { ok: true, value: await ctrl.handle(message, {}) };
  } catch (error) { return { ok: false, error: error.message }; }
 } }, downloads: { search: async () => [], download: async () => 1 },
 tabs: { create: async () => ({ id: 9 }), get: async () => ({ id: 9 }), sendMessage: async () => {} },
 alarms: { create: async () => {}, clear: async () => {} } };
window.fixtureMessages = [];
for (const r of revisions) await upsertGenerationRevision(r);
await replaceModelCatalog(models);
await import('/extension/gallery.js');
`;
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    if (url.pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fixture); }
    if (url.pathname === '/health') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ok: true, service: 'watch-extension', apiVersion: 8 })); }
    if (url.pathname === '/output-files') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ok: true, root: 'D:/Fixture/WatchAutomation', files: [] })); }
    if (url.pathname === '/output-verify') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ valid: true, sha256: hash, bytes: png.length })); }
    if (url.pathname === '/output-file') {
      if (url.searchParams.get('expectedHash') !== hash) { res.writeHead(409); return res.end('hash mismatch'); }
      res.setHeader('Content-Type', 'image/png'); return res.end(png);
    }
    const relative = url.pathname === '/' ? '/extension/gallery.html' : decodeURIComponent(url.pathname);
    const file = path.resolve(root, '.' + relative);
    if (!file.startsWith(root + path.sep) || !relative.startsWith('/extension/')) { res.writeHead(404); return res.end(); }
    let bytes = await readFile(file);
    if (file.endsWith('gallery.html')) bytes = Buffer.from(bytes.toString().replace('<script type="module" src="gallery.js"></script>', '<script type="module" src="/fixture.js"></script>'));
    if (file.endsWith('gallery.js')) bytes = Buffer.from(bytes.toString().replace("const WATCHER_BASE = 'http://127.0.0.1:17321'", "const WATCHER_BASE = '" + origin + "'"));
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(bytes);
  } catch (error) { res.writeHead(500); res.end(error.message); }
}).listen(18764, '127.0.0.1', () => console.log('Isolated fixture: ' + origin));
