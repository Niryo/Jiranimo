# Jiranimo

Jiranimo allows you to spawn a local code agent directly from your Jira boards, in order to implement tickets.

It ships as two parts:

- a Chrome extension that adds Jiranimo controls directly inside Jira
- a local Node server that runs the agent.

## How To Use

1. Install Jiranimo globally:

   ```bash
   npm install -g jiranimo
   ```

2. Start Jiranimo for the repository you want to work on, or give it a path to a folder that hosts multiple repos and it will find the right one for each ticket:

   ```bash
   jiranimo /path/to/your/repo
   ```

3. Install the Jiranimo browser extension from the store.
   Store link coming soon.

4. Open your Jira board, choose the ticket you want to implement, and click the AI button on the card.

5. Jiranimo will start the local agent for that ticket, and you can track its progress directly from Jira while it runs.

## Release Artifacts

- `jiranimo-extension-vX.Y.Z.zip` for Chrome Web Store upload
- `jiranimo-server-node24-vX.Y.Z.zip` for a compact standalone Node 24 server bundle
- `jiranimo-X.Y.Z.tgz` for the published npm package
