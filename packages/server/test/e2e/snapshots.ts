/**
 * Test screenshot system.
 * Generates actual PNG screenshots of test state using Playwright.
 *
 * Structure:
 *   test/e2e/screenshots/
 *     <test-suite>/
 *       <test-name>/
 *         01-<phase>.png
 */

import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chromium, type Browser } from 'playwright';

const SCREENSHOTS_DIR = resolve(import.meta.dirname, 'screenshots');

let browser: Browser | null = null;
let currentSuite = '';
let currentTest = '';
let stepCounter = 0;

export async function initScreenshots(): Promise<void> {
  if (existsSync(SCREENSHOTS_DIR)) {
    rmSync(SCREENSHOTS_DIR, { recursive: true, force: true });
  }
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  browser = await chromium.launch({ headless: process.env.PWHEADLESS !== 'false' });
}

export async function closeScreenshots(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

export function startSuite(name: string): void {
  currentSuite = name.replace(/[^a-zA-Z0-9_-]/g, '-');
}

export function startTest(name: string): void {
  currentTest = name.replace(/[^a-zA-Z0-9_-]/g, '-');
  stepCounter = 0;
  mkdirSync(join(SCREENSHOTS_DIR, currentSuite, currentTest), { recursive: true });
}

export async function screenshot(phase: string, data: unknown, summary?: string): Promise<void> {
  stepCounter++;
  const prefix = String(stepCounter).padStart(2, '0');
  const slug = phase.replace(/[^a-zA-Z0-9_-]/g, '-');
  const dir = join(SCREENSHOTS_DIR, currentSuite, currentTest);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${prefix}-${slug}.png`);

  const html = renderHtml(phase, data, summary);

  if (!browser) return;

  const page = await browser.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.setContent(html, { waitUntil: 'load' });
  const height = await page.evaluate(() => document.body.scrollHeight);
  await page.setViewportSize({ width: 800, height: Math.min(Math.max(height + 40, 200), 2000) });
  await page.screenshot({ path: filePath, fullPage: true });
  await page.close();
}

function renderHtml(phase: string, data: unknown, summary?: string): string {
  const title = phase.replace(/-/g, ' ');
  const breadcrumb = `${currentSuite} / ${currentTest}`;
  const bodyContent = summary
    ? `<pre class="summary">${esc(summary)}</pre>`
    : renderData(data);

  return `<!DOCTYPE html><html><head><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d1117;color:#c9d1d9;padding:24px}
.breadcrumb{font-size:12px;color:#8b949e;margin-bottom:4px}
h1{font-size:18px;color:#58a6ff;margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid #21262d}
.summary{font-size:14px;line-height:1.6;white-space:pre-wrap;color:#e6edf3;background:#161b22;padding:16px;border-radius:8px;border:1px solid #30363d}
table{width:100%;border-collapse:collapse;font-size:13px;background:#161b22;border-radius:8px;overflow:hidden;border:1px solid #30363d}
th{text-align:left;padding:8px 12px;background:#21262d;color:#8b949e;font-weight:600;font-size:11px;text-transform:uppercase}
td{padding:8px 12px;border-top:1px solid #21262d;color:#c9d1d9;max-width:500px;overflow:hidden;text-overflow:ellipsis}
.timestamp{font-size:11px;color:#484f58;margin-top:12px}
</style></head><body>
<div class="breadcrumb">${esc(breadcrumb)}</div>
<h1>${esc(title)}</h1>
${bodyContent}
<div class="timestamp">${new Date().toISOString()}</div>
</body></html>`;
}

function renderData(data: unknown): string {
  if (data === null || data === undefined) return '<pre class="summary">(empty)</pre>';
  if (Array.isArray(data)) {
    if (data.length === 0) return '<pre class="summary">(empty array)</pre>';
    if (typeof data[0] === 'object' && data[0] !== null) {
      const keys = [...new Set(data.flatMap(item => Object.keys(item as object)))];
      const header = keys.map(k => `<th>${esc(k)}</th>`).join('');
      const rows = data.slice(0, 30).map(item => {
        const obj = item as Record<string, unknown>;
        return `<tr>${keys.map(k => `<td>${fmtVal(obj[k])}</td>`).join('')}</tr>`;
      }).join('');
      return `<table><tr>${header}</tr>${rows}</table>`;
    }
    return data.map(item => `<div style="background:#161b22;border:1px solid #30363d;border-radius:6px;padding:10px 14px;margin-bottom:6px;font-size:13px">${esc(String(item))}</div>`).join('');
  }
  if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const rows = Object.entries(obj).map(([k, v]) => `<tr><td style="color:#d2a8ff">${esc(k)}</td><td>${fmtVal(v)}</td></tr>`).join('');
    return `<table><tr><th>Field</th><th>Value</th></tr>${rows}</table>`;
  }
  return `<pre class="summary">${esc(String(data))}</pre>`;
}

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return '<span style="color:#484f58">null</span>';
  if (typeof v === 'string') return `<span style="color:#a5d6ff">${esc(v.slice(0, 200))}</span>`;
  if (typeof v === 'number') return `<span style="color:#79c0ff">${v}</span>`;
  if (typeof v === 'boolean') return `<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;background:${v ? '#238636' : '#9e6a03'};color:#fff">${v}</span>`;
  if (Array.isArray(v)) return `<span style="color:#8b949e">[${v.length} items]</span>`;
  if (typeof v === 'object') return `<span style="color:#8b949e">${esc(JSON.stringify(v).slice(0, 150))}</span>`;
  return esc(String(v));
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
