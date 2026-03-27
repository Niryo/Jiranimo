/**
 * Standalone cleanup script for stale test issues.
 * Run: npm run test:e2e:cleanup
 */

import { cleanupStaleTestIssues, verifyConnection } from './jira-helpers.js';

async function main() {
  console.log('Verifying Jira connection...');
  const connected = await verifyConnection();
  if (!connected) {
    console.error('Failed to connect to Jira. Check .env.test credentials.');
    process.exit(1);
  }
  console.log('Connected.');

  console.log('Cleaning up all test issues in JTEST...');
  await cleanupStaleTestIssues();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
