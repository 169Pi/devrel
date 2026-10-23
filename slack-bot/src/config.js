import os from 'node:os';
import path from 'node:path';

const REPO = /^[\w.-]+\/[\w.-]+$/;
const GITHUB_MENTION = /^@[A-Za-z0-9-]+(\/[A-Za-z0-9_.-]+)?$/;

export function loadConfig(env = process.env) {
  const missing = ['SLACK_BOT_TOKEN'].filter((k) => !env[k]);
  // The bot acts on GitHub as its GitHub App, or failing that with a token.
  const appId = env.GITHUB_APP_ID?.trim() || null;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY?.trim() || null;
  if (Boolean(appId) !== Boolean(privateKey)) missing.push(appId ? 'GITHUB_APP_PRIVATE_KEY' : 'GITHUB_APP_ID');
  else if (!appId && !env.GITHUB_TOKEN) missing.push('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY (or GITHUB_TOKEN)');
  // People sign in to GitHub through the App's device flow; their tokens are stored encrypted.
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim() || null;
  const encryptionKey = env.TOKEN_ENCRYPTION_KEY?.trim() || null;
  if (clientId && !encryptionKey) missing.push('TOKEN_ENCRYPTION_KEY (to store GitHub sign-ins)');
  if (!env.SLACK_APP_TOKEN && !env.SLACK_SIGNING_SECRET) {
    missing.push('SLACK_APP_TOKEN (Socket Mode) or SLACK_SIGNING_SECRET (HTTP mode)');
  }
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  if (encryptionKey && encryptionKey.length < 32) throw new Error('TOKEN_ENCRYPTION_KEY must be at least 32 characters, e.g. from `openssl rand -base64 32`');

  const repo = env.GITHUB_REPO || '169Pi/devrel';
  if (!REPO.test(repo)) throw new Error(`GITHUB_REPO must look like owner/repo, got "${repo}"`);
  const feedbackRepo = env.FEEDBACK_REPO?.trim() || null;
  if (feedbackRepo && !REPO.test(feedbackRepo)) throw new Error(`FEEDBACK_REPO must look like owner/repo, got "${feedbackRepo}"`);
  if (feedbackRepo && feedbackRepo.toLowerCase() === repo.toLowerCase()) throw new Error('FEEDBACK_REPO must differ from GITHUB_REPO');
  const mention = (env.FEEDBACK_GITHUB_MENTION ?? '@169Pi/engineering').trim();
  if (mention && !GITHUB_MENTION.test(mention)) {
    throw new Error(`FEEDBACK_GITHUB_MENTION must be a GitHub @user or @org/team, got "${mention}"`);
  }
  // Alpieca's own channels, where it answers every message without an @mention. Set it empty to turn this off.
  const homeChannels = (env.SLACK_HOME_CHANNELS ?? 'C0C507GN03A').split(',').map((s) => s.trim()).filter(Boolean);
  const badChannel = homeChannels.find((id) => !/^[CG][A-Z0-9]+$/.test(id));
  if (badChannel) throw new Error(`SLACK_HOME_CHANNELS must be channel IDs (C…), got "${badChannel}"`);
  // Repos Alpieca only answers questions about, never files into: "owner/repo" or "owner/repo=What people call it".
  // 169Pi's Good First Alpie contributions arrive as pull requests on 169Pi/.github.
  const watched = (env.GITHUB_WATCH_REPOS ?? '169Pi/.github=Good First Alpie')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, ...about] = entry.split('=');
      if (!REPO.test(name.trim())) throw new Error(`GITHUB_WATCH_REPOS must list owner/repo names, got "${name.trim()}"`);
      return { repo: name.trim(), about: about.join('=').trim() || null };
    })
    .filter((w) => ![repo, feedbackRepo].some((r) => r?.toLowerCase() === w.repo.toLowerCase()));
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
      homeChannels,
    },
    github: {
      // Without a GitHub App, a token. Issues then show the token's owner as their author.
      token: env.GITHUB_TOKEN || null,
      app: appId || clientId ? { appId, privateKey, clientId, clientSecret: env.GITHUB_APP_CLIENT_SECRET?.trim() || null } : null,
      encryptionKey,
      // Shown to people who can't see a private repo, e.g. a form or channel where they ask for access.
      accessRequestUrl: env.GITHUB_ACCESS_REQUEST_URL?.trim() || null,
      repo,
      ref: env.GITHUB_TEMPLATE_REF || undefined,
      watched,
    },
    // Optional second repo for product feedback, usually private. Its issues @mention a team and
    // link the screenshots and recordings shared in Slack.
    feedback: feedbackRepo
      ? {
          repo: feedbackRepo,
          // A separate token keeps the main token's Contents access away from the feedback repo's
          // code: this one only needs Issues. With a GitHub App, its installation token is narrowed instead.
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
