import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/selector-resolver.js', import.meta.url), 'utf8');

function harness(build) {
  class Element {
    constructor(tag = 'div', attributes = {}, children = []) {
      this.tagName = tag.toUpperCase(); this.attributes = { ...attributes };
      this.children = []; this.parentElement = null; this.isConnected = true;
      this.disabled = attributes.disabled === true; this.multiple = attributes.multiple === true;
      this.hidden = attributes.hidden === true; this.innerText = this.textContent = attributes.text || '';
      this.value = 'C:\\private\\customer-photo.png'; this.files = [{ name: 'customer-photo.png', text: 'private contents' }];
      children.forEach((child) => this.append(child));
    }
    append(node) { this.children.push(node); node.parentElement = this; return node; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    getBoundingClientRect() {
      let hidden = this.hidden;
      for (let parent = this.parentElement; parent; parent = parent.parentElement) hidden ||= parent.hidden;
      return { width: hidden ? 0 : 120, height: hidden ? 0 : 30 };
    }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    matches(selector) {
      return selector.split(',').some((part) => {
        part = part.trim();
        if (part === ':disabled') return this.disabled || Boolean(this.closest('fieldset')?.disabled);
        const descendant = part.indexOf('] ');
        if (descendant >= 0) {
          if (!this.matches(part.slice(descendant + 2))) return false;
          return Boolean(this.parentElement?.closest(part.slice(0, descendant + 1)));
        }
        const tag = part.match(/^[a-z]+/i)?.[0];
        if (tag && this.tagName.toLowerCase() !== tag.toLowerCase()) return false;
        const id = part.match(/#([\w-]+)/)?.[1];
        if (id && this.getAttribute('id') !== id) return false;
        const checks = [...part.matchAll(/\[([\w-]+)(?:(\^=|\*=|=)"([^"]*)")?\]/g)];
        return checks.every(([, name, op, value]) => {
          const actual = this.getAttribute(name);
          if (!op) return actual != null;
          if (actual == null) return false;
          return op === '=' ? String(actual) === value : op === '^=' ? String(actual).startsWith(value) : String(actual).includes(value);
        });
      });
    }
    closest(selector) {
      for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
      return null;
    }
    querySelectorAll(selector) {
      const all = this.children.flatMap((child) => [child, ...child.querySelectorAll('*')]);
      return selector === '*' ? all : all.filter((node) => node.matches(selector));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  const document = new Element('body');
  const node = (tag, attributes = {}, children = []) => new Element(tag, attributes, children);
  const makeComposer = ({ hidden = false, tag = 'form', attrs = {} } = {}) => {
    const surface = node(tag, { hidden, ...attrs });
    const composer = surface.append(node('div', { id: 'prompt-textarea', contenteditable: 'true' }));
    document.append(surface); return { surface, composer };
  };
  const input = (attributes = {}) => node('input', { type: 'file', ...attributes });
  const references = build({ document, node, makeComposer, input });
  const window = { __WATCH_AUTOMATION_ENABLED__: true };
  const context = vm.createContext({ document, window, Element,
    getComputedStyle: (element) => ({ display: element.hidden ? 'none' : 'block', visibility: 'visible', opacity: '1' }) });
  vm.runInContext(source, context);
  return { ...references, document, resolver: window.WatchSelectorResolver };
}

for (const accept of [
  'application/pdf,image/png,image/jpeg', 'application/pdf, IMAGE/*', '.pdf,.png,.jpg,.webp',
  '.docx,.HEIC,.avif', '*/*'
]) {
  test(`active composer accepts mixed image upload tokens: ${accept}`, () => {
    const h = harness(({ makeComposer, input }) => {
      const { surface } = makeComposer(); const upload = surface.append(input({ accept, hidden: true }));
      return { upload };
    });
    assert.equal(h.resolver.resolve('fileInput').element, h.upload);
  });
}

test('enabled generic file input without accept belongs to the active composer', () => {
  const h = harness(({ document, makeComposer, input }) => {
    document.append(input({ id: 'other-input' }));
    const { surface } = makeComposer(); return { upload: surface.append(input({ hidden: true, multiple: true })) };
  });
  assert.equal(h.resolver.resolve('fileInput').element, h.upload);
});

test('bare upload-files remains a recognized hidden portal without the photo data flag', () => {
  const h = harness(({ document, makeComposer, input }) => {
    makeComposer(); return { upload: document.append(input({ id: 'upload-files', hidden: true })) };
  });
  assert.equal(h.resolver.resolve('fileInput').element, h.upload);
  assert.equal(h.resolver.resolve('fileInput').strategy, 'upload-files-id');
});

test('active composer beats an obsolete composer and positively identified portal inputs', () => {
  const h = harness(({ document, makeComposer, input }) => {
    const old = makeComposer({ hidden: true }); old.surface.append(input({ id: 'upload-photos', hidden: true }));
    document.append(input({ id: 'upload-files', hidden: true }));
    const active = makeComposer(); return { upload: active.surface.append(input({ accept: 'application/pdf,image/*', hidden: true })) };
  });
  assert.equal(h.resolver.resolve('fileInput').element, h.upload);
  assert.ok(h.resolver.fileInputDiagnostics().candidates.some((candidate) => candidate.rejectionReasons.includes('inactive-or-unrelated-surface')));
});

test('disabled, aria-disabled, detached and disabled-fieldset controls are rejected', () => {
  const h = harness(({ node, makeComposer, input }) => {
    const { surface } = makeComposer();
    surface.append(input({ id: 'upload-photos', disabled: true }));
    surface.append(input({ 'data-testid': 'upload-photos-input', 'aria-disabled': 'true' }));
    surface.append(input({ id: 'upload-files' })).isConnected = false;
    surface.append(node('fieldset', { disabled: true })).append(input({ accept: 'image/*' }));
    return { upload: surface.append(input({ accept: '.png' })) };
  });
  assert.equal(h.resolver.resolve('fileInput').element, h.upload);
  assert.equal(h.resolver.fileInputDiagnostics().candidates.filter((candidate) => candidate.eligible).length, 1);
});

test('document-only input cannot accept images even with a known upload id', () => {
  const h = harness(({ makeComposer, input }) => {
    const { surface } = makeComposer(); surface.append(input({ id: 'upload-files', accept: '.pdf,application/msword' })); return {};
  });
  assert.equal(h.resolver.resolve('fileInput').element, null);
  assert.ok(h.resolver.fileInputDiagnostics().candidates[0].rejectionReasons.includes('accept-excludes-images'));
});

test('avatar, import and account controls never become global image upload fallbacks', () => {
  const h = harness(({ document, node, makeComposer, input }) => {
    makeComposer();
    document.append(input({ accept: 'image/*', name: 'avatar-upload' }));
    document.append(input({ accept: '.png' }));
    document.append(input({ accept: 'application/pdf,image/*' }));
    document.append(input());
    document.append(node('div', { 'data-testid': 'account-settings' })).append(input({ id: 'upload-files' }));
    document.append(node('form', { id: 'import' })).append(input({ id: 'upload-photos' }));
    document.append(node('div', { 'aria-label': 'Avatar' })).append(input({ id: 'upload-files' }));
    document.append(node('div', { 'data-testid': 'import-dialog' })).append(input({ id: 'upload-files' }));
    return {};
  });
  assert.equal(h.resolver.resolve('fileInput').element, null);
  assert.ok(h.resolver.fileInputDiagnostics().candidates.every((candidate) => candidate.rejectionReasons.length));
});

test('a known upload portal beats an inactive hidden composer with a higher selector rank', () => {
  const h = harness(({ document, makeComposer, input }) => {
    makeComposer({ hidden: true }).surface.append(input({ 'data-testid': 'upload-photos-input' }));
    makeComposer(); return { upload: document.append(input({ id: 'upload-files', hidden: true })) };
  });
  assert.equal(h.resolver.resolve('fileInput').element, h.upload);
});

test('an old hidden form inside a shared composer surface is rejected before the active form', () => {
  const h = harness(({ document, node, input }) => {
    const surface = document.append(node('div', { 'data-composer-surface': 'true' }));
    const old = surface.append(node('form', { hidden: true }));
    old.append(node('div', { id: 'prompt-textarea', contenteditable: 'true' }));
    old.append(input({ 'data-testid': 'upload-photos-input' }));
    const active = surface.append(node('form'));
    active.append(node('div', { id: 'prompt-textarea', contenteditable: 'true' }));
    return { upload: active.append(input({ accept: 'application/pdf,image/*' })) };
  });
  assert.equal(h.resolver.resolve('fileInput').element, h.upload);
  assert.ok(h.resolver.fileInputDiagnostics().candidates[0].rejectionReasons.includes('inactive-composer-form'));
});

test('known uploads in an inactive hidden composer do not masquerade as portals', () => {
  const h = harness(({ makeComposer, input }) => {
    makeComposer({ hidden: true }).surface.append(input({ id: 'upload-files' }));
    makeComposer(); return {};
  });
  assert.equal(h.resolver.resolve('fileInput').element, null);
});

test('legacy explicit selector priority is retained for known enabled portals', () => {
  const h = harness(({ document, input }) => {
    document.append(input({ id: 'upload-files', hidden: true }));
    document.append(input({ id: 'upload-photos', hidden: true }));
    return { upload: document.append(input({ 'data-testid': 'upload-photos-input', hidden: true })) };
  });
  assert.equal(h.resolver.resolve('fileInput').element, h.upload);
  assert.equal(h.resolver.resolve('fileInput').strategy, 'data-testid');
});

for (const label of ['Add files and more', 'Add photos and files', 'Attach files', 'Добавить файлы и другое', 'Добавить фото и файлы']) {
  test(`attachment menu resolver scopes visible exact label to the composer: ${label}`, () => {
    const h = harness(({ document, node, makeComposer }) => {
      document.append(node('button', { 'data-testid': 'composer-plus-btn' }));
      const old = makeComposer({ hidden: true }); old.surface.append(node('button', { 'data-testid': 'composer-plus-btn' }));
      const { surface } = makeComposer();
      surface.append(node('button', { 'aria-label': 'Add files and more', disabled: true }));
      surface.append(node('button', { 'aria-label': 'Add files and more', hidden: true }));
      return { plus: surface.append(node('button', { 'aria-label': label })) };
    });
    assert.equal(h.resolver.resolve('composerPlus').element, h.plus);
  });
}

test('attachment resolver does not select a generic file-picker or unrelated Add button', () => {
  const h = harness(({ node, makeComposer }) => {
    const { surface } = makeComposer();
    for (const text of ['Upload from computer', 'Add', 'Add account', 'Add files to profile', 'Choose file']) surface.append(node('button', { text }));
    return {};
  });
  assert.equal(h.resolver.resolve('composerPlus').element, null);
});

test('plus controls in an obsolete form under a shared surface never override the active composer', () => {
  const h = harness(({ document, node }) => {
    const surface = document.append(node('div', { 'data-composer-surface': 'true' }));
    const old = surface.append(node('form'));
    old.append(node('div', { id: 'prompt-textarea', contenteditable: 'true', hidden: true }));
    old.append(node('button', { 'data-testid': 'composer-plus-btn' }));
    const active = surface.append(node('form'));
    active.append(node('div', { id: 'prompt-textarea', contenteditable: 'true' }));
    return { plus: active.append(node('button', { 'aria-label': 'Add files and more' })) };
  });
  assert.equal(h.resolver.resolve('composerPlus').element, h.plus);
});

test('missing input diagnostics are capped and contain no file names, values, contents or markup', () => {
  const h = harness(({ document, makeComposer, input }) => {
    makeComposer(); for (let index = 0; index < 25; index++) document.append(input({ accept: 'image/*' })); return {};
  });
  const report = h.resolver.fileInputDiagnostics({ maxCandidates: 100 });
  assert.equal(report.totalCandidates, 25); assert.equal(report.candidates.length, 20); assert.equal(report.truncated, true);
  assert.ok(report.candidates.every((candidate) => candidate.rejectionReasons.includes('unidentified-portal')));
  const json = JSON.stringify(report);
  for (const secret of ['customer-photo', 'private contents', 'C:\\private', 'outerHTML', 'innerHTML', '"files"', '"value"']) assert.equal(json.includes(secret), false);
});

