// Real production button panel, isolated browser storage and simulated IPC boundary.
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from 'playwright';

const pcRoot = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(process.env.PET_UI_REPORT_DIR || resolve(pcRoot, '../output/playwright/button-double-press'));
mkdirSync(output, {recursive: true});
const server = await createServer({root: pcRoot, configFile: resolve(pcRoot, 'vite.config.js'),
  server: {host: '127.0.0.1', port: 0}});
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({headless: true,
    ...(process.env.PET_TEST_BROWSER ? {executablePath: process.env.PET_TEST_BROWSER} : {})});
  const results = [];
  for (const supported of [false, true]) {
    const context = await browser.newContext({viewport: {width: 1440, height: 1400}, serviceWorkers: 'block'});
    const errors = [];
    await context.route('**/*', route => new URL(route.request().url()).origin === origin
      ? route.continue() : route.abort('blockedbyclient'));
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${origin}/tests/manual/button-double-press.html?double=${supported ? 1 : 0}`);
    const panel = page.getByTestId('board-button-config-card');
    await panel.waitFor();
    const doubleRows = panel.locator('[data-event$=".double_press"]');
    assert.equal(await doubleRows.count(), 3, 'all three double controls must remain visible on old firmware');
    assert.equal(await panel.getByText('需升级固件', {exact: true}).count(), supported ? 0 : 3);
    for (const [sw, action] of [[1, 'agent_prompt'], [2, 'realtime_chat'], [3, 'page_back']]) {
      const row = panel.locator(`[data-event="button.sw${sw}.double_press"]`);
      const select = row.locator('select');
      assert.equal(await select.isEnabled(), true);
      await select.selectOption(action);
    }
    await panel.locator('[data-event="button.sw1.double_press"] textarea').fill('记录今天的灵感');
    await panel.locator('[data-event="button.sw1.short_press"] select').selectOption('session_next');
    if (!supported) await panel.getByText('双击已保存 · 等待固件支持', {exact: true}).waitFor();
    const usage = await panel.locator('.usage-help__operations').innerText();
    assert.equal(usage.includes('双击'), supported, 'usage must only describe executable gestures');
    await panel.getByText('15 GESTURES', {exact: true}).waitFor();
    await panel.getByRole('button', {name: '同步到设备', exact: true}).click();
    await page.waitForFunction(() => window.__buttonAcceptance.calls.length === 1);
    const request = await page.evaluate(() => window.__buttonAcceptance.calls[0].input);
    assert.equal(request.bindings.length, supported ? 19 : 16);
    assert.equal(request.bindings.find(b => b.event === 'button.sw1.short_press').action, 'session_next');
    const doubles = request.bindings.filter(b => b.event.endsWith('.double_press'));
    assert.equal(doubles.length, supported ? 3 : 0);
    if (supported) assert.equal(doubles.find(b => b.event === 'button.sw1.double_press').value, '记录今天的灵感');
    await page.reload(); await panel.waitFor();
    assert.equal(await panel.locator('[data-event="button.sw2.double_press"] select').inputValue(), 'realtime_chat');
    assert.equal(await panel.locator('[data-event="button.sw1.double_press"] textarea').inputValue(), '记录今天的灵感');
    const screenshot = resolve(output, supported ? 'double-supported.png' : 'old-firmware.png');
    await panel.screenshot({path: screenshot});
    assert.deepEqual(errors, []);
    results.push({firmware: supported ? 'double-supported' : 'legacy', visibleDoubles: 3,
      savedAcrossReload: true, transmittedDoubles: doubles.length, normalMappingSynced: true, screenshot});
    console.log(`PASS ${supported ? 'new' : 'old'} firmware: visible/editable/saved/reloaded/payload checked`);
    await context.close();
  }
  writeFileSync(resolve(output, 'report.json'), JSON.stringify({results}, null, 2));
} finally {
  await browser?.close(); await server.close();
}
