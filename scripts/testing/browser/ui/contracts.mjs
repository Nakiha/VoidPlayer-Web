import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { withBrowserFixture } from '../../browser-fixture.mjs';
import { waitForDialogClosed, settleAppearance } from '../../browser-contracts.mjs';
import { repositoryRoot } from '../../manifest.mjs';

const engine = process.argv[2] ?? 'webkit';
const directory = process.env.VOIDPLAYER_TEST_ARTIFACTS ?? path.join(repositoryRoot, '.run/browser-fixtures', `browser-contracts-${engine}`);
// Deliberately exercise failure capture in a real browser without a media/core
// dependency. The outer case passes only when the expected failure is preserved.
await assert.rejects(withBrowserFixture({ caseName: 'browser-contracts', engine, directory, roots: [], phaseTimeoutMs: 5000,
  dependencies: { startService: async () => ({ url: 'about:blank', close: async () => {} }) },
}, async ({ page, phase, checkpoint }) => {
  await page.setContent('<button id="settings-open" aria-expanded="true">Settings</button><dialog id="settings" data-closing>Settings</dialog><canvas id="analysis-shared-axis" data-view-start="0" data-view-end="40000"></canvas><div id="pulse"></div>');
  await page.evaluate(() => {
    window.voidPlayer = { getState: () => ({ positionUs: 123, busy: false, tracks: [] }) };
    const dialog = document.querySelector('dialog'); dialog.showModal();
    setTimeout(() => {
      dialog.close(); dialog.removeAttribute('data-closing');
      document.querySelector('button').setAttribute('aria-expanded', 'false');
      document.querySelector('button').focus();
    }, 40);
  });
  await phase('dismiss-dialog', () => waitForDialogClosed(page));
  await page.evaluate(() => {
    document.querySelector('#pulse').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 40, iterations: Infinity });
    document.querySelector('canvas').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 80, fill: 'forwards' });
  });
  await phase('settle-appearance', () => settleAppearance(page));
  assert.equal(await page.evaluate(() => document.querySelector('canvas').getAnimations()[0].playState), 'finished');
  const baseline = { start: 0, end: 40000 }; checkpoint('view-baseline', baseline); baseline.end = 50000;
  // Playwright's own deadline is shorter than the fixture phase deadline.
  await phase('unreachable-view', () => page.waitForFunction(() => false, null, { timeout: 150 }), { expectedSpan: 20000 });
}), /Timeout 150ms exceeded/);

const report = JSON.parse(await readFile(path.join(directory, 'browser-contracts-failure.json'), 'utf8'));
assert.equal(report.phase, 'unreachable-view');
assert.equal(report.phases.at(-1).status, 'failed');
assert.equal(report.phases.at(-1).details.expectedSpan, 20000);
assert.equal(report.checkpoints[0].details.end, 40000);
assert.equal(report.state.positionUs, 123);
assert.equal(report.browser.focus.id, 'settings-open');
assert.equal(report.browser.dialogs.length, 0);
assert.equal(report.browser.probes.find(probe => probe.id === 'analysis-shared-axis').dataset.viewEnd, '40000');
assert.equal(report.browser.viewport.dpr, 1);
assert.ok(report.browser.userAgent);
await access(path.join(directory, 'browser-contracts-failure.png'));
await access(path.join(directory, 'browser-contracts-failure.html'));
console.log(`PASS ${engine}: dialog focus, finite animation waits, immutable baselines and real timeout JSON/DOM/screenshot evidence`);
