import os from 'node:os';
import path from 'node:path';

const REPO = /^[\w.-]+\/[\w.-]+$/;
const GITHUB_MENTION = /^@[A-Za-z0-9-]+(\/[A-Za-z0-9_.-]+)?$/;

export function loadConfig(env = process.env) {
  const missing = ['SLACK_BOT_TOKEN', 'GITHUB_TOKEN'].filter((k) => !env[k]);
  if (!env.SLACK_APP_TOKEN && !env.SLACK_SIGNING_SECRET) {
    missing.push('SLACK_APP_TOKEN (Socket Mode) or SLACK_SIGNING_SECRET (HTTP mode)');
  }
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);

  const repo = env.GITHUB_REPO || '169Pi/devrel';
  if (!REPO.test(repo)) throw new Error(`GITHUB_REPO must look like owner/repo, got "${repo}"`);
  const feedbackRepo = env.FEEDBACK_REPO?.trim() || null;
  if (feedbackRepo && !REPO.test(feedbackRepo)) throw new Error(`FEEDBACK_REPO must look like owner/repo, got "${feedbackRepo}"`);
  if (feedbackRepo && feedbackRepo.toLowerCase() === repo.toLowerCase()) throw new Error('FEEDBACK_REPO must differ from GITHUB_REPO');
  const mention = (env.FEEDBACK_GITHUB_MENTION ?? '@169Pi/engineering').trim();
  if (mention && !GITHUB_MENTION.test(mention)) {
    throw new Error(`FEEDBACK_GITHUB_MENTION must be a GitHub @user or @org/team, got "${mention}"`);
  }
  const slackMention = env.FEEDBACK_SLACK_MENTION?.trim() || null;
  if (slackMention && !/^[SUW][A-Z0-9]+$/.test(slackMention)) {
    throw new Error(`FEEDBACK_SLACK_MENTION must be a Slack user group (S…) or user (U…) ID, got "${slackMention}"`);
  }

  return {
    slack: {
      token: env.SLACK_BOT_TOKEN,
      appToken: env.SLACK_APP_TOKEN,
      signingSecret: env.SLACK_SIGNING_SECRET,
      socketMode: Boolean(env.SLACK_APP_TOKEN),
      port: Number(env.PORT) || 3000,
      command: env.SLACK_COMMAND || '/alpieca',
      notifyChannel: env.SLACK_NOTIFY_CHANNEL || null,
      // Slack user IDs allowed to use the triage buttons (close, label, assign…). Empty = everyone.
      triageUsers: (env.SLACK_TRIAGE_USERS || '').split(',').map((s) => s.trim()).filter(Boolean),
    },
    github: {
      token: env.GITHUB_TOKEN,
      repo,
      ref: env.GITHUB_TEMPLATE_REF || undefined,
    },
    // Optional second repo for product feedback, usually private. Its issues @mention a team and
    // link the screenshots and recordings shared in Slack.
    feedback: feedbackRepo
      ? {
          repo: feedbackRepo,
          // A separate token keeps the main token's Contents access away from the feedback repo's
          // code: this one only needs Issues.
          token: env.FEEDBACK_GITHUB_TOKEN || null,
          mention: mention || null,
          slackMention,
          // Its templates live with the bot, in this repo, so the feedback repo needs no Alpieca files.
          templatePath: env.FEEDBACK_TEMPLATE_PATH || 'slack-bot/feedback-templates',
          templateDir: env.FEEDBACK_TEMPLATE_DIR || null,
        }
      : null,
    // Optional: without a key or base URL the bot works as plain forms, no drafting.
    // The hosted Alpie Seed endpoint needs no key, so setting ALPIE_BASE_URL alone turns it on.
    alpie:
      env.ALPIE_API_KEY || env.ALPIE_BASE_URL
        ? {
            apiKey: env.ALPIE_API_KEY || null,
            baseUrl: env.ALPIE_BASE_URL || 'https://test.169pi.ai/v1',
            model: env.ALPIE_MODEL || 'alpie_9b',
            // Reasoning mode is slower and adds little to filling in a template, so it's off by default.
            thinking: /^(1|true|yes|on)$/i.test(env.ALPIE_THINKING ?? ''),
            timeoutMs: (Number(env.ALPIE_TIMEOUT_SECONDS) || 60) * 1000,
          }
        : null,
    // Where Alpieca remembers Slack -> GitHub usernames.
    dataDir: env.DATA_DIR || path.join(os.homedir(), '.alpieca'),
    // Read templates from disk instead of GitHub (local development / tests).
    templateDir: env.TEMPLATE_DIR || null,
    templateTtlMs: (Number(env.TEMPLATE_CACHE_SECONDS) || 300) * 1000,
  };
}
