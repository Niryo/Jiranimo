#!/usr/bin/env tsx
/**
 * Interactive test runner for Jiranimo.
 * Runs all test tiers in order, checks prerequisites,
 * and guides you through fixing any issues.
 *
 * Usage: npm run test:all
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const SERVER = resolve(ROOT, 'packages', 'server');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function log(msg: string) { console.log(msg); }
function pass(msg: string) { log(`  ${GREEN}✓${RESET} ${msg}`); }
function fail(msg: string) { log(`  ${RED}✗${RESET} ${msg}`); }
function warn(msg: string) { log(`  ${YELLOW}!${RESET} ${msg}`); }
function info(msg: string) { log(`  ${DIM}${msg}${RESET}`); }
function header(msg: string) { log(`\n${BOLD}${CYAN}── ${msg} ──${RESET}\n`); }

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`  ${YELLOW}?${RESET} ${question} `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runTests(script: string, label: string): boolean {
  log(`\n  Running ${label}...`);
  const result = spawnSync('npm', ['run', script], {
    cwd: SERVER,
    stdio: 'pipe',
    encoding: 'utf-8',
  });

  if (result.status === 0) {
    // Strip ANSI codes for regex matching
    const clean = (result.stdout + result.stderr).replace(/\x1b\[[0-9;]*m/g, '');
    const fileMatch = clean.match(/Test Files\s+(\d+) passed/);
    const testMatch = clean.match(/Tests\s+(\d+) passed/);
    const files = fileMatch ? fileMatch[1] : '?';
    const tests = testMatch ? testMatch[1] : '?';
    pass(`${label}: ${tests} tests passed (${files} files)`);
    return true;
  } else {
    fail(`${label} failed`);
    // Show the relevant failure output (strip ANSI for matching, show raw for readability)
    const output = (result.stdout + result.stderr);
    const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
    const failLines = clean.split('\n').filter(l =>
      l.includes('FAIL') || l.includes('Error') || l.includes('expected') || l.includes('×')
    ).slice(0, 15);
    if (failLines.length > 0) {
      log('');
      for (const line of failLines) {
        info(line.trim());
      }
    }
    return false;
  }
}

async function checkPrerequisites(): Promise<boolean> {
  header('Step 1: Prerequisites');
  let ok = true;

  // Node.js
  if (commandExists('node')) {
    const version = execSync('node --version', { encoding: 'utf-8' }).trim();
    pass(`Node.js ${version}`);
  } else {
    fail('Node.js not found');
    log(`\n    Install Node.js: https://nodejs.org/`);
    ok = false;
  }

  // npm/yarn
  if (commandExists('npm')) {
    pass('npm available');
  } else {
    fail('npm not found');
    ok = false;
  }

  // git
  if (commandExists('git')) {
    pass('git available');
  } else {
    fail('git not found — needed for integration tests');
    ok = false;
  }

  // node_modules
  if (existsSync(resolve(SERVER, 'node_modules'))) {
    pass('Dependencies installed');
  } else {
    warn('Dependencies not installed');
    const answer = await prompt('Run npm install now? (Y/n)');
    if (answer.toLowerCase() !== 'n') {
      log('  Installing...');
      spawnSync('npm', ['install'], { cwd: SERVER, stdio: 'inherit' });
      if (existsSync(resolve(SERVER, 'node_modules'))) {
        pass('Dependencies installed');
      } else {
        fail('Failed to install dependencies');
        ok = false;
      }
    } else {
      fail('Dependencies required — run: cd packages/server && npm install');
      ok = false;
    }
  }

  // vitest
  if (existsSync(resolve(SERVER, 'node_modules', '.bin', 'vitest'))) {
    pass('vitest available');
  } else {
    fail('vitest not found in node_modules');
    log(`\n    Run: cd packages/server && npm install`);
    ok = false;
  }

  return ok;
}

async function runUnitTests(): Promise<boolean> {
  header('Step 2: Unit Tests');
  info('Testing pure logic: config, state machine, prompt builder, output parser, etc.');

  const ok = runTests('test', 'Unit tests');
  if (!ok) {
    log(`
    ${BOLD}How to fix:${RESET}
    1. Run ${CYAN}cd packages/server && npx vitest run${RESET} to see full output
    2. Fix the failing test or source code
    3. Re-run this script
    `);
  }
  return ok;
}

async function runIntegrationTests(): Promise<boolean> {
  header('Step 3: Integration Tests');
  info('Testing git operations on temp repos + WebSocket connections.');

  const ok = runTests('test:integration', 'Integration tests');
  if (!ok) {
    log(`
    ${BOLD}How to fix:${RESET}
    1. Run ${CYAN}cd packages/server && npx vitest run --config vitest.integration.config.ts${RESET}
    2. These tests create temp git repos — ensure git is configured:
       ${DIM}git config --global user.email "you@example.com"${RESET}
       ${DIM}git config --global user.name "Your Name"${RESET}
    3. Fix and re-run
    `);
  }
  return ok;
}

async function checkE2ePrerequisites(): Promise<'ready' | 'skip' | 'setup'> {
  header('Step 4: E2E Test Setup');
  info('E2E tests run against a real Jira Cloud instance.');

  const envPath = resolve(ROOT, '.env.test');

  // Check .env.test exists
  if (!existsSync(envPath)) {
    fail('.env.test file not found');
    log(`
    ${BOLD}To set up E2E tests:${RESET}
    1. Copy the example: ${CYAN}cp .env.test.example .env.test${RESET}
    2. Edit ${CYAN}.env.test${RESET} with your real Jira credentials
    `);
    const answer = await prompt('Skip E2E tests for now? (Y/n)');
    return answer.toLowerCase() === 'n' ? 'setup' : 'skip';
  }

  pass('.env.test exists');

  // Check credentials are real (not placeholder)
  const envContent = readFileSync(envPath, 'utf-8');
  const host = envContent.match(/JIRA_HOST=(.+)/)?.[1]?.trim();
  const email = envContent.match(/JIRA_EMAIL=(.+)/)?.[1]?.trim();
  const token = envContent.match(/JIRA_API_TOKEN=(.+)/)?.[1]?.trim();

  if (!host || !email || !token) {
    fail('.env.test is missing required fields');
    log(`
    ${BOLD}Required fields in .env.test:${RESET}
    JIRA_HOST=yoursite.atlassian.net
    JIRA_EMAIL=your-email@example.com
    JIRA_API_TOKEN=your-api-token
    `);
    return 'setup';
  }

  if (token === 'your-api-token-here') {
    fail('.env.test has placeholder token — needs a real API token');
    log(`
    ${BOLD}To get a Jira API token:${RESET}
    1. Go to ${CYAN}https://id.atlassian.com/manage-profile/security/api-tokens${RESET}
    2. Click "Create API token"
    3. Copy the token and paste it in .env.test as JIRA_API_TOKEN=<token>
    `);
    const answer = await prompt('Skip E2E tests for now? (Y/n)');
    return answer.toLowerCase() === 'n' ? 'setup' : 'skip';
  }

  pass(`Jira host: ${host}`);
  pass(`Jira email: ${email}`);
  pass('API token configured (not placeholder)');

  // Test connection
  log('\n  Testing Jira connection...');
  const auth = Buffer.from(`${email}:${token}`).toString('base64');
  try {
    const res = await fetch(`https://${host}/rest/api/3/myself`, {
      headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
    });

    if (res.ok) {
      const me = await res.json() as { displayName: string; accountId: string };
      pass(`Connected as: ${me.displayName}`);
      // Store accountId for project creation
      (globalThis as any).__jiraAccountId = me.accountId;
      (globalThis as any).__jiraAuth = auth;
      (globalThis as any).__jiraHost = host;
    } else if (res.status === 401) {
      fail('Authentication failed (401) — token may be expired or invalid');
      log(`
    ${BOLD}How to fix:${RESET}
    1. Go to ${CYAN}https://id.atlassian.com/manage-profile/security/api-tokens${RESET}
    2. Revoke the old token and create a new one
    3. Update JIRA_API_TOKEN in .env.test
      `);
      const answer = await prompt('Skip E2E tests for now? (Y/n)');
      return answer.toLowerCase() === 'n' ? 'setup' : 'skip';
    } else {
      fail(`Jira responded with ${res.status}`);
      log(`\n    Check your JIRA_HOST value: ${host}`);
      const answer = await prompt('Skip E2E tests for now? (Y/n)');
      return answer.toLowerCase() === 'n' ? 'setup' : 'skip';
    }
  } catch (err) {
    fail(`Cannot reach Jira: ${(err as Error).message}`);
    log(`\n    Check your network connection and JIRA_HOST value.`);
    const answer = await prompt('Skip E2E tests for now? (Y/n)');
    return answer.toLowerCase() === 'n' ? 'setup' : 'skip';
  }

  // Check if JTEST project exists
  log('\n  Checking JTEST project...');
  try {
    const res = await fetch(`https://${host}/rest/api/3/project/JTEST`, {
      headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
    });

    if (res.ok) {
      pass('JTEST project exists');
    } else if (res.status === 404) {
      info('JTEST project not found — creating it automatically...');

      const accountId = (globalThis as any).__jiraAccountId;
      const createRes = await fetch(`https://${host}/rest/api/3/project`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          key: 'JTEST',
          name: 'Jiranimo Test',
          projectTypeKey: 'software',
          projectTemplateKey: 'com.pyxis.greenhopper.jira:gh-simplified-scrum-classic',
          leadAccountId: accountId,
        }),
      });

      if (createRes.ok) {
        pass('JTEST project created');
      } else {
        const errBody = await createRes.text();
        // Try simplified template if classic fails
        const retryRes = await fetch(`https://${host}/rest/api/3/project`, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify({
            key: 'JTEST',
            name: 'Jiranimo Test',
            projectTypeKey: 'software',
            leadAccountId: accountId,
          }),
        });

        if (retryRes.ok) {
          pass('JTEST project created');
        } else {
          const retryErr = await retryRes.text();
          fail(`Could not create JTEST project (${createRes.status})`);
          info(errBody.slice(0, 200));
          log(`
    ${BOLD}Create it manually:${RESET}
    1. Go to ${CYAN}https://${host}/jira/projects${RESET}
    2. Create project with key ${BOLD}JTEST${RESET}
          `);
          const answer = await prompt('Press Enter once created, or type "skip": ');
          if (answer.toLowerCase() === 'skip') return 'skip';

          const recheck = await fetch(`https://${host}/rest/api/3/project/JTEST`, {
            headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
          });
          if (!recheck.ok) {
            fail('JTEST project still not found');
            return 'skip';
          }
          pass('JTEST project found');
        }
      }
    }
  } catch (err) {
    warn(`Could not check for JTEST project: ${(err as Error).message}`);
  }

  // Ensure delete permission exists (needed for test cleanup)
  log('\n  Checking delete permission...');
  try {
    const permRes = await fetch(`https://${host}/rest/api/3/mypermissions?permissions=DELETE_ISSUES&projectKey=JTEST`, {
      headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
    });
    if (permRes.ok) {
      const permData = await permRes.json() as { permissions: { DELETE_ISSUES: { havePermission: boolean } } };
      if (permData.permissions.DELETE_ISSUES.havePermission) {
        pass('Delete permission available');
      } else {
        info('Delete permission missing — adding it automatically...');
        // Get the permission scheme for the project
        const schemeRes = await fetch(`https://${host}/rest/api/3/project/JTEST/permissionscheme`, {
          headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
        });
        if (schemeRes.ok) {
          const scheme = await schemeRes.json() as { id: number };
          const addRes = await fetch(`https://${host}/rest/api/3/permissionscheme/${scheme.id}/permission`, {
            method: 'POST',
            headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ holder: { type: 'applicationRole', parameter: 'jira-software' }, permission: 'DELETE_ISSUES' }),
          });
          if (addRes.ok || (await addRes.text()).includes('already exists')) {
            pass('Delete permission granted');
          } else {
            warn('Could not add delete permission — test cleanup may fail');
          }
        }
      }
    }
  } catch {
    warn('Could not check delete permission');
  }

  return 'ready';
}

async function runE2eTests(): Promise<boolean> {
  header('Step 5: E2E Tests');
  info('Running tests against real Jira (creates/deletes test issues).');

  const ok = runTests('test:e2e', 'E2E tests');
  if (!ok) {
    log(`
    ${BOLD}How to fix:${RESET}
    1. Run ${CYAN}cd packages/server && npx vitest run --config vitest.e2e.config.ts${RESET}
    2. If issues were left behind: ${CYAN}npm run test:e2e:cleanup${RESET}
    3. Check that JTEST project exists and your token has write access
    `);
  }
  return ok;
}

async function main() {
  log(`\n${BOLD}${CYAN}Jiranimo Test Runner${RESET}\n`);
  log(`${DIM}This will run all test tiers and guide you through any setup needed.${RESET}`);

  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  // Step 1: Prerequisites
  const prereqOk = await checkPrerequisites();
  if (!prereqOk) {
    log(`\n${RED}Fix the prerequisites above and re-run.${RESET}\n`);
    process.exit(1);
  }
  totalPassed++;

  // Step 2: Unit tests
  const unitOk = await runUnitTests();
  if (unitOk) totalPassed++; else totalFailed++;

  // Step 3: Integration tests (only if unit passed)
  if (unitOk) {
    const integrationOk = await runIntegrationTests();
    if (integrationOk) totalPassed++; else totalFailed++;
  } else {
    warn('Skipping integration tests (unit tests failed)');
    totalSkipped++;
  }

  // Step 4-5: E2E tests
  const e2eStatus = await checkE2ePrerequisites();
  if (e2eStatus === 'ready') {
    totalPassed++;
    const e2eOk = await runE2eTests();
    if (e2eOk) totalPassed++; else totalFailed++;
  } else if (e2eStatus === 'skip') {
    warn('E2E tests skipped');
    totalSkipped++;
  } else {
    warn('E2E setup incomplete — skipped');
    totalSkipped++;
  }

  // Summary
  header('Summary');

  if (totalFailed === 0 && totalSkipped === 0) {
    log(`  ${GREEN}${BOLD}All tests passed!${RESET} 🎉\n`);
  } else if (totalFailed === 0) {
    log(`  ${GREEN}${totalPassed} passed${RESET}, ${YELLOW}${totalSkipped} skipped${RESET}\n`);
  } else {
    log(`  ${GREEN}${totalPassed} passed${RESET}, ${RED}${totalFailed} failed${RESET}, ${YELLOW}${totalSkipped} skipped${RESET}\n`);
  }

  process.exit(totalFailed > 0 ? 1 : 0);
}

main();
