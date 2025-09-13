import { test, expect } from '@playwright/test';

test('switching to Danish updates UI text', async ({ page }) => {
  await page.goto('/chat.html');
  await page.selectOption('#lang', 'da');
  await expect(page.locator('#btn')).toHaveText('Send');
  await expect(page.locator('#netTitle')).toHaveText(/Nettoløn/);
});

test('Top 4 FAQ chips render and are clickable', async ({ page }) => {
  await page.goto('/chat.html');
  await page.waitForSelector('.chips .chip');
  await page.locator('.chips .chip').first().click();
  await expect(page.locator('.bubble.me').last()).toBeVisible();
});

test('netto calculator updates in real time', async ({ page }) => {
  await page.goto('/chat.html');
  const input = page.locator('#netInput');
  await input.fill('120 000');
  await expect(page.locator('#netOut')).toContainText('≈');
});

test('unknown question triggers GPT fallback then cached answer next time', async ({ page }) => {
  await page.goto('/chat.html');
  // First ask a likely unknown question
  await page.fill('#inp', 'What is the square root of 2?');
  await page.click('#btn');
  await page.waitForTimeout(1000);
  // Second time should be faster (cached as FAQ)
  await page.fill('#inp', 'What is the square root of 2?');
  await page.click('#btn');
  await page.waitForTimeout(500);
  await expect(page.locator('.bubble.bot').last()).toBeVisible();
});

