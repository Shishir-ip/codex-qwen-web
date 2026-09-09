#!/usr/bin/env node
// Simple Playwright probe to help identify Qwen Web DOM structure for automation
// Run locally: node tests/qwen-probe.ts

import { chromium } from 'playwright-core';

async function probe() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    console.log('Opening https://chat.qwen.ai/');
    await page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('Page loaded. Take a screenshot to inspect: tests/qwen-screenshot.png');
    await page.screenshot({ path: 'tests/qwen-screenshot.png', fullPage: true });

    // Example heuristics to locate composer and first response container; these will likely need refinement.
    const possibleComposer = await page.$('textarea, [contenteditable], form textarea, form [contenteditable]');
    if (possibleComposer) {
      console.log('Found a candidate composer element. Outer HTML snippet:');
      const snippet = await page.evaluate(el => el.outerHTML.slice(0, 1000), possibleComposer);
      console.log(snippet);
    } else {
      console.log('No obvious composer element found — inspect tests/qwen-screenshot.png and refine selectors.');
    }

    // Try to detect a send button
    const possibleSend = await page.$('button:has-text("Send"), button[type=submit], button[aria-label*=send], button[aria-label*=Send]');
    console.log('Send button candidate:', Boolean(possibleSend));

    // Try a quick DOM dump of the main chat container
    const chatRoot = await page.$('main, #root, .chat, [role=main]');
    if (chatRoot) {
      const html = await page.evaluate(el => el.innerHTML.slice(0, 2000), chatRoot);
      console.log('Chat root snippet (first 2k chars):');
      console.log(html);
    } else {
      console.log('No chat root candidate found');
    }

    console.log('\nProbe complete. Inspect tests/qwen-screenshot.png and the console output then update src/adapters/chatqwen-web.ts selectors.');
  } catch (error) {
    console.error('Probe failed:', error);
  } finally {
    // do not close browser automatically to allow manual inspection when headful
    // await browser.close();
  }
}

probe().catch(e => { console.error(e); process.exit(1); });
