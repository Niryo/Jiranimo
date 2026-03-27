# Extension Manual Test Checklist

## Setup
- [ ] Server running (`cd server && npm run dev`)
- [ ] Extension loaded unpacked in Chrome (chrome://extensions)
- [ ] Jira host configured in extension options
- [ ] Logged into Jira in the browser

## First Run (Board Config)
- [ ] Visit a board with no saved config -> config modal appears
- [ ] Column dropdown shows actual board columns
- [ ] Selecting columns and saving works
- [ ] Revisiting the same board does NOT show config modal again
- [ ] Different board DOES show config modal

## Card Detection
- [ ] Cards with "ai-ready" label show "Implement" badge
- [ ] Cards without the label do NOT show badge
- [ ] Dragging a card to a different column preserves the badge
- [ ] Adding the label to a card shows badge after refresh

## Badge Lifecycle
- [ ] Click "Implement" -> badge shows "Sending..." then "Queued"
- [ ] While Claude runs -> badge shows spinner + "Running..."
- [ ] On success -> badge shows checkmark + "PR Ready" with link
- [ ] On failure -> badge shows "Failed", click to retry
- [ ] Retry resets to "Queued" and re-runs

## Jira Updates
- [ ] On task start: issue transitions to "In Progress"
- [ ] On task complete: issue transitions to "In Review"
- [ ] On task complete: PR link posted as Jira comment

## Options Page
- [ ] Server URL field saves and is used
- [ ] Default label field saves and is used
- [ ] Board configs listed with edit/delete

## Dashboard
- [ ] Open localhost:3456, verify live status updates
- [ ] WebSocket connects (shows "Connected")
- [ ] Tasks appear in correct columns by status
- [ ] Failed tasks show error message and retry button

## Edge Cases
- [ ] Server not running -> badge shows error, does not crash
- [ ] Extension survives page reload
- [ ] Multiple cards with label all get badges
