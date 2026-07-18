import { chromium } from 'playwright-core';
import fs from 'node:fs';

const SHOTS = new URL('../shots/', import.meta.url).pathname;
const log = [];
const errors = [];

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 });

async function snap(name, settleMs = 1600) {
  await page.waitForTimeout(settleMs);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
  console.log('snap:', name);
}
async function clickFirst(selectors) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count()) { await loc.click({ timeout: 2500 }); return sel; }
    } catch { /* next */ }
  }
  errors.push(`none of: ${selectors.join(' | ')}`);
  return null;
}

try {
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await clickFirst(['button:has-text("I Understand")']);
  await page.waitForTimeout(800);
  await clickFirst(['button:has-text("Create an account")']);
  await page.waitForTimeout(800);
  const email = `audit-oc-${Date.now()}@example.com`;
  await page.locator('input[placeholder="Email"]').last().fill(email);
  await page.fill('input[placeholder="Password (8+ characters)"]', 'AuditPass123!');
  await page.fill('input[placeholder="Confirm password"]', 'AuditPass123!');
  await clickFirst(['button:has-text("Create Account")']);
  await page.waitForTimeout(5000);

  // Enable AUTO contract selection so canTrade becomes true.
  await clickFirst(['button:has-text("Auto +1 OTM selection")', 'button:has-text("AUTO")']);
  await page.waitForTimeout(5000);

  const buyState = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const buy = btns.find((b) => b.textContent.trim().toUpperCase() === 'BUY');
    return buy ? { found: true, disabled: buy.disabled } : { found: false };
  });
  log.push({ buyState });

  await clickFirst(['button:text-is("BUY")', 'button:has-text("BUY")']);
  await snap('11-order-confirm', 2500);

  // Dismiss via whatever affordance exists; then also grab a toast if any.
  const ocButtons = await page.evaluate(() =>
    [...document.querySelectorAll('button')].filter((b) => b.offsetParent).map((b) => b.textContent.trim()));
  log.push({ ocButtons });
  await clickFirst(['button:has-text("Cancel")', 'button:has-text("Close")', '[aria-label="Close"]']);
} catch (err) {
  errors.push(String(err));
}

fs.writeFileSync(new URL('capture2-log.json', import.meta.url), JSON.stringify({ log, errors }, null, 2));
console.log(JSON.stringify({ log, errors }, null, 2));
await browser.close();
