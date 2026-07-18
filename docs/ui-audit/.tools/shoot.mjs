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
const page = await browser.newPage({
  viewport: { width: 430, height: 932 },
  deviceScaleFactor: 2,
});

async function snap(name, settleMs = 1600) {
  await page.waitForTimeout(settleMs);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
  const state = await page.evaluate(() => ({
    buttons: [...document.querySelectorAll('button,[role="button"]')]
      .filter((e) => e.offsetParent !== null)
      .map((e) => (e.getAttribute('aria-label') || e.textContent.trim()).slice(0, 60)),
    inputs: [...document.querySelectorAll('input')].map((e) => e.placeholder),
    headings: [...document.querySelectorAll('h1,h2,h3,.section-header,.nav-title')]
      .map((e) => e.textContent.trim()).slice(0, 12),
  }));
  log.push({ name, ...state });
  console.log('snap:', name);
}

async function clickFirst(selectors) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        await loc.click({ timeout: 2000 });
        return sel;
      }
    } catch { /* next */ }
  }
  errors.push(`clickFirst found none of: ${selectors.join(' | ')}`);
  return null;
}

try {
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle', timeout: 30000 });
  await snap('01-risk-disclaimer', 2500);

  await clickFirst(['button:has-text("I Understand")', 'button:has-text("Accept")']);
  await snap('02-login');

  await clickFirst(['button:has-text("Create an account")', 'button:has-text("Create account")', 'button:has-text("Register")', 'button:has-text("Sign up")']);
  await snap('03-register');

  // Register a throwaway audit account (register sheet duplicates the login
  // Email field, so use .last() for Email; password placeholders are unique).
  const email = `audit-${Date.now()}@example.com`;
  await page.locator('input[placeholder="Email"]').last().fill(email).catch((e) => errors.push(String(e)));
  await page.locator('input[placeholder="Password"]').last().fill('AuditPass123!').catch((e) => errors.push(String(e)));
  await page.locator('input[placeholder="Confirm password"]').last().fill('AuditPass123!').catch((e) => errors.push(String(e)));
  await clickFirst(['button:has-text("Create Account")', 'button[type="submit"]']);
  await snap('04-after-register', 4000);

  // Trade screen (fullscreen layout A).
  await snap('05-trade-fullscreen', 4000);

  // Symbol search sheet.
  await clickFirst(['header button >> nth=0', 'button:has-text("SPY")', 'button:has-text("QQQ")']);
  await snap('06-symbol-search');
  await clickFirst(['button:has-text("Cancel")', 'button:has-text("Done")', 'button:has-text("Close")', '[aria-label="Close"]', '[aria-label="Dismiss"]']);

  // Indicator settings sheet.
  await clickFirst(['[aria-label="Indicator settings"]']);
  await snap('07-indicator-settings');
  await clickFirst(['button:has-text("Done")', 'button:has-text("Cancel")', 'button:has-text("Close")', '[aria-label="Close"]']);

  // Split layout (layout B).
  await clickFirst(['[aria-label="Toggle layout"]']);
  await snap('08-trade-split', 2500);

  // Profile sheet.
  await clickFirst(['[aria-label="Profile"]']);
  await snap('09-profile');
  await clickFirst(['button:has-text("Done")', 'button:has-text("Close")', '[aria-label="Close"]', '[aria-label="Dismiss"]']);

  // History sheet.
  await clickFirst(['[aria-label="Trade history"]']);
  await snap('10-history');
  await clickFirst(['button:has-text("Done")', 'button:has-text("Close")', '[aria-label="Close"]', '[aria-label="Dismiss"]']);

  // Order confirm sheet (needs an enabled Buy/Sell button).
  await clickFirst(['button:has-text("Buy")']);
  await snap('11-order-confirm', 2500);
  await clickFirst(['button:has-text("Cancel")', 'button:has-text("Close")', '[aria-label="Close"]']);
} catch (err) {
  errors.push(String(err));
}

fs.writeFileSync(new URL('capture-log.json', import.meta.url), JSON.stringify({ log, errors }, null, 2));
console.log('errors:', errors);
await browser.close();
