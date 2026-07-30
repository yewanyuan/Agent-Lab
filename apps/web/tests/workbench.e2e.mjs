import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
page.on('dialog', (dialog) => dialog.accept());

try {
  await page.goto(process.env.BASE_URL ?? 'http://127.0.0.1:8000', { waitUntil: 'networkidle' });
  await page.locator('.react-flow__node').first().waitFor();
  if (await page.locator('.react-flow__node').count() !== 4) throw new Error('starter template did not load four nodes');
  const initialNodeFont = await page.locator('.node-title').first().evaluate((element) => getComputedStyle(element).fontSize);
  const initialBrandFont = await page.locator('.brand strong').evaluate((element) => getComputedStyle(element).fontSize);

  const initialEdges = await page.locator('.react-flow__edge').count();
  await page.locator('.react-flow__edge').first().click({ force: true });
  await page.locator('.toolbar button[title="Delete"]').click();
  if (await page.locator('.react-flow__edge').count() !== initialEdges - 1) throw new Error('selected edge was not deleted');
  await page.locator('.toolbar button[title="Undo"]').click();
  await page.waitForFunction((count) => document.querySelectorAll('.react-flow__edge').length === count, initialEdges);

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /110%/ }).click();
  if (await page.locator('.app-shell').getAttribute('data-ui-font') !== '110') throw new Error('font preference was not applied');
  const scaledNodeFont = await page.locator('.node-title').first().evaluate((element) => getComputedStyle(element).fontSize);
  const scaledBrandFont = await page.locator('.brand strong').evaluate((element) => getComputedStyle(element).fontSize);
  if (scaledNodeFont !== initialNodeFont) throw new Error('canvas node text must remain independent from interface scaling');
  if (scaledBrandFont === initialBrandFont) throw new Error('non-canvas interface text did not scale');
  const stored = await page.evaluate(() => localStorage.getItem('agentlab.ui.preferences.v1'));
  if (!stored?.includes('"fontScale":110')) throw new Error('font preference was not persisted');
  await page.getByRole('button', { name: 'Providers' }).click();
  await page.getByText('openai-compatible', { exact: true }).waitFor();
  const openaiRow = page.locator('.provider-row').filter({ has: page.getByText('openai', { exact: true }) });
  await openaiRow.locator('.provider-model input').fill('gpt-4.1-mini-2025-04-14');
  await openaiRow.getByRole('button', { name: 'Save model' }).click();
  await page.getByRole('button', { name: 'Done' }).click();

  await page.locator('.bottom-tabs button').filter({ hasText: /^Io$/ }).click();
  await page.locator('.io-input').fill('hello from e2e');

  await page.getByRole('button', { name: /Run$/ }).click();
  await page.locator('.trace-row.success').first().waitFor({ timeout: 15_000 });
  await page.locator('.bottom-tabs button').filter({ hasText: /^Io$/ }).click();
  await page.getByText(/simulated response to hello from e2e/i).waitFor();

  await page.getByRole('button', { name: /Save$/ }).click();
  await page.getByText('Revision saved').waitFor();

  await page.locator('.project-switcher').click();
  await page.locator('.switcher-menu').waitFor();
  await page.getByRole('button', { name: /Manage projects/ }).waitFor();
  await page.locator('.project-switcher').click();
  await page.locator('.switcher-menu').waitFor({ state: 'detached' });

  await page.locator('.rail button[title="Projects"]').click();
  await page.locator('.projects-modal').waitFor();
  await page.locator('.project-open').first().waitFor();
  await page.locator('.project-open').first().click();
  await page.getByText('Project opened').waitFor();
  await page.locator('.react-flow__node').first().waitFor();

  await page.getByRole('button', { name: /Evaluations/ }).click();
  await page.getByRole('heading', { name: 'A/B evaluations' }).waitFor();
  await page.getByRole('button', { name: 'New suite' }).click();
  await page.locator('.suite-editor').getByRole('button', { name: /Save suite/ }).click();
  const revisionSelects = page.locator('.evaluation-launcher select');
  await revisionSelects.nth(0).selectOption({ index: 1 });
  await revisionSelects.nth(1).selectOption({ index: 2 });
  await revisionSelects.nth(2).locator('option').nth(1).waitFor({ state: 'attached' });
  await revisionSelects.nth(2).selectOption({ index: 1 });
  await page.getByRole('button', { name: /Start A\/B evaluation/ }).click();
  await page.locator('.evaluation-detail .run-pill.completed').waitFor({ timeout: 20_000 });
  await page.locator('.case-row').nth(1).waitFor();
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'A/B evaluations' }).waitFor();
  await page.locator('.evaluation-history button').first().waitFor();
  await page.locator('.evaluation-history button').first().click();
  await page.locator('.evaluation-detail').waitFor();
  await page.locator('.evaluation-detail-head').getByRole('button', { name: 'Delete' }).click();
  await page.locator('.evaluation-empty').waitFor();
  await page.getByRole('button', { name: /Runs/ }).click();
  await page.locator('.run-table .table-row').nth(1).waitFor();
  await page.locator('.run-table .run-row').first().click();
  await page.locator('.run-detail .run-detail-span').nth(1).waitFor();
  await page.getByRole('button', { name: /Versions/ }).click();
  await page.getByRole('heading', { name: 'Versions' }).waitFor();
  const versionItems = page.locator('.version-item');
  await versionItems.nth(1).locator('input[name="baseline"]').check();
  await versionItems.nth(0).locator('input[name="candidate"]').check();
  await page.getByRole('button', { name: /^Compare$/ }).click();
  await page.locator('.revision-compare').waitFor();
  await page.getByRole('button', { name: /Design/ }).click();

  await page.getByRole('button', { name: /Start from template/i }).click();
  await page.getByRole('button', { name: /Harness Evolution Lab/i }).click();
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length === 20);

  const example = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/blocks/text_stats.py');
  await page.locator('input[type="file"][accept=".py"]').setInputFiles(example);
  await page.getByText('text_stats', { exact: true }).last().waitFor();

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Chinese' }).click();
  await page.getByRole('button', { name: '完成' }).click();
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /设计/ }).waitFor();
  if (await page.evaluate(() => localStorage.getItem('agentlab.ui.locale.v1')) !== 'zh-CN') throw new Error('language preference was not persisted');

  console.log(JSON.stringify({ appearance: 'passed', edgeDeletion: 'passed', providers: 'passed', workspaceRestore: 'passed', starterRun: 'passed', workspaceSwitcher: 'passed', projectsList: 'passed', evaluations: 'passed', evaluationDelete: 'passed', runDetail: 'passed', versions: 'passed', language: 'passed', harnessNodes: 20, pythonImport: 'passed' }));
} finally {
  await browser.close();
}
