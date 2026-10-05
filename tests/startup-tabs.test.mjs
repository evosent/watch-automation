import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { applicationRestartScript, AUTOMATION_STARTUP_URL, prepareAutomationBrowserStartup,
  repairAutomationLauncherFromTemplate } from '../dev/update-utils.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function withTemporaryRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'watch-automation-startup-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('startup helper sets one canonical ChatGPT startup URL and preserves other preferences', async () => {
  await withTemporaryRoot(async (temporaryRoot) => {
    const profileRoot = path.join(temporaryRoot, 'WatchAutomation', 'ChromeProfile');
    const defaultRoot = path.join(profileRoot, 'Default');
    const preferencesPath = path.join(defaultRoot, 'Preferences');
    await mkdir(defaultRoot, { recursive: true });
    await writeFile(preferencesPath, JSON.stringify({
      session: { restore_on_startup: 1, urls_to_restore_on_startup: ['https://old.example/'] },
      profile: { exit_type: 'Crashed', exited_cleanly: false },
      unrelated: { keep: true }
    }));

    const first = await prepareAutomationBrowserStartup(profileRoot, { isChromeRunning: () => false });
    const preferences = JSON.parse(await readFile(preferencesPath, 'utf8'));
    assert.deepEqual(first, { changed: true, startupUrlCount: 1 });
    assert.equal(preferences.session.restore_on_startup, 4);
    assert.deepEqual(preferences.session.urls_to_restore_on_startup, [AUTOMATION_STARTUP_URL]);
    assert.equal(preferences.profile.exit_type, 'Normal');
    assert.equal(preferences.profile.exited_cleanly, true);
    assert.deepEqual(preferences.unrelated, { keep: true });

    const second = await prepareAutomationBrowserStartup(profileRoot, { isChromeRunning: () => false });
    assert.deepEqual(second, { changed: false, startupUrlCount: 1 });
  });
});

test('startup helper leaves Preferences byte-for-byte unchanged while Chrome owns the profile', async () => {
  await withTemporaryRoot(async (temporaryRoot) => {
    const profileRoot = path.join(temporaryRoot, 'WatchAutomation', 'ChromeProfile');
    const defaultRoot = path.join(profileRoot, 'Default');
    const preferencesPath = path.join(defaultRoot, 'Preferences');
    await mkdir(defaultRoot, { recursive: true });
    const original = Buffer.from('{"session":{"restore_on_startup":1,"urls_to_restore_on_startup":["https://private.example/"]}}');
    await writeFile(preferencesPath, original);

    await assert.rejects(prepareAutomationBrowserStartup(profileRoot, {
      isChromeRunning: () => true,
      timeoutMs: 0
    }), /Chrome ещё использует профиль/);
    assert.deepEqual(await readFile(preferencesPath), original);
  });
});

test('launcher repair waits for the legacy launcher and then installs the packaged template', async () => {
  await withTemporaryRoot(async (projectRoot) => {
    const templatePath = path.join(projectRoot, 'extension', 'local-service', 'launcher-templates', 'launch-automation-profile.cmd');
    const destinationPath = path.join(projectRoot, 'launch-automation-profile.cmd');
    const packagedTemplate = Buffer.from('rem WATCH_AUTOMATION_STARTUP_TABS_V1\r\nstart chrome');
    await mkdir(path.dirname(templatePath), { recursive: true });
    await writeFile(templatePath, packagedTemplate);
    await writeFile(destinationPath, 'legacy launcher');

    await assert.rejects(repairAutomationLauncherFromTemplate(projectRoot, {
      isLauncherRunning: () => true,
      timeoutMs: 0
    }), /Launcher WatchAutomation ещё выполняется/);
    assert.equal(await readFile(destinationPath, 'utf8'), 'legacy launcher');

    const result = await repairAutomationLauncherFromTemplate(projectRoot, { isLauncherRunning: () => false });
    assert.deepEqual(result, { changed: true });
    assert.deepEqual(await readFile(destinationPath), packagedTemplate);
  });
});

test('all managed startup paths prepare one URL before launching Chrome', async () => {
  const launcherPath = path.join(PROJECT_ROOT, 'launch-automation-profile.cmd');
  const launcher = await readFile(launcherPath, 'utf8');
  const packagedLauncher = await readFile(path.join(PROJECT_ROOT, 'extension', 'local-service', 'launcher-templates', 'launch-automation-profile.cmd'));
  assert.deepEqual(packagedLauncher, await readFile(launcherPath), 'packaged launcher template stays canonical');
  const chromeStart = launcher.split(/\r?\n/).find((line) => line.startsWith('start "Watch Automation Chrome"'));
  assert.ok(chromeStart, 'root launcher has a Chrome start command');
  assert.equal((chromeStart.match(/https:\/\/chatgpt\.com\/\?watch_automation=1/g) || []).length, 1);
  assert.ok(launcher.indexOf('--prepare-browser-startup') < launcher.indexOf(chromeStart));
  assert.doesNotMatch(chromeStart, /--disable-restore-session-state/);
  assert.match(launcher, /WATCH_AUTOMATION_STARTUP_TABS_V1/);

  const restart = applicationRestartScript({ projectRoot: 'C:\\WatchAutomation', nodeExecutable: 'node.exe',
    watcherPath: 'C:\\WatchAutomation\\dev\\watch-extension.mjs', profilePath: 'C:\\Users\\test\\WatchAutomation\\ChromeProfile',
    chromePath: 'C:\\WatchAutomation\\chrome.exe', extensionPath: 'C:\\WatchAutomation\\extension',
    hostName: '127.0.0.1', port: 17321, healthUrl: 'http://127.0.0.1:17321/health', packageId: 'test',
    previousPid: 1234, requestedAt: '2026-01-01T00:00:00.000Z' });
  assert.ok(restart.indexOf('--prepare-browser-startup') < restart.indexOf('$arguments = @('));
  assert.ok(restart.indexOf('if (@(Get-ManagedBrowsers).Count) { throw') < restart.indexOf('--prepare-browser-startup'));
  assert.match(restart, /https:\/\/chatgpt\.com\/\?watch_automation=1/);
  assert.doesNotMatch(restart, /--disable-restore-session-state/);

  const watcher = await readFile(path.join(PROJECT_ROOT, 'dev', 'watch-extension.mjs'), 'utf8');
  assert.match(watcher, /process\.argv\[2\] === '--prepare-browser-startup'/);
  assert.match(watcher, /repairAutomationLauncherFromTemplate\(PROJECT_ROOT/);
});
