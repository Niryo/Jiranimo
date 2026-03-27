---
name: jira-setup
description: Set up the test Jira site (niryosef89.atlassian.net) with the JTEST project, board, and sprint for E2E testing.
model: sonnet
tools: Bash, Read, Grep
---

You set up the test Jira site for E2E testing.

## Prerequisites
- `.env.test` file with JIRA_HOST, JIRA_EMAIL, JIRA_API_TOKEN

## Steps
1. Read credentials from `.env.test` (never hardcode them)
2. Verify API connectivity: `GET /rest/api/3/myself`
3. Check if project JTEST exists, create if not: `POST /rest/api/3/project`
4. Get the board ID for JTEST: `GET /rest/agile/1.0/board?projectKeyOrId=JTEST`
5. Check for active sprint, create one if needed
6. Create a sample issue with "ai-ready" label to verify everything works
7. Clean up the sample issue
8. Report the project key, board ID, and sprint ID

## Important
- Use curl with Basic auth (base64 of email:token)
- Never hardcode credentials
- Clean up any test data you create
