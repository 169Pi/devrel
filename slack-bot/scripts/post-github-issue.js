// Posts an issue opened directly on GitHub to Slack as an Alpieca card with triage buttons.
// Run by .github/workflows/alpieca-new-issue.yml. Uses only Node built-ins and src/issue-card.js,
// so the workflow doesn't need `npm ci`. Button clicks are handled by the running Alpieca bot,
// because the message is posted with Alpieca's own bot token.
import { readFile } from 'node:fs/promises';
import { isFromSlack, issueCard } from '../src/issue-card.js';

const { SLACK_BOT_TOKEN, SLACK_ISSUES_CHANNEL, GITHUB_EVENT_PATH, GITHUB_REPOSITORY } = process.env;
const SLACK_API = process.env.SLACK_API_URL || 'https://slack.com/api'; // overridable for tests

if (!SLACK_BOT_TOKEN || !SLACK_ISSUES_CHANNEL) {
  console.error('Set the SLACK_BOT_TOKEN secret and the SLACK_ISSUES_CHANNEL variable on this repo.');
  process.exit(1);
}

const { issue } = JSON.parse(await readFile(GITHUB_EVENT_PATH, 'utf8'));

if (isFromSlack(issue.body)) {
  console.log(`#${issue.number} was filed from Slack; Alpieca already posted it.`);
  process.exit(0);
}

const login = issue.user.login;
const card = issueCard(issue, {
  repo: GITHUB_REPOSITORY,
  headline: `:inbox_tray: New issue opened on GitHub by <https://github.com/${login}|@${login}>`,
});

const res = await fetch(`${SLACK_API}/chat.postMessage`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ channel: SLACK_ISSUES_CHANNEL, ...card }),
});
const data = await res.json();
if (!data.ok) {
  const hint = data.error === 'not_in_channel' ? ' Invite @Alpieca to the channel.' : '';
  console.error(`Slack rejected the message: ${data.error}.${hint}`);
  process.exit(1);
}
console.log(`Posted #${issue.number} to Slack.`);
