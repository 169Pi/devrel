import os from 'node:os';
import path from 'node:path';

export function loadConfig(env = process.env) {
  const missing = ['SLACK_BOT_TOKEN', 'GITHUB_TOKEN'].filter((k) => !env[k]);
  if (!env.SLACK_APP_TOKEN && !env.SLACK_SIGNING_SECRET) {
    missing.push('SLACK_APP_TOKEN (Socket Mode) or SLACK_SIGNING_SECRET (HTTP mode)');
  }
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);

  const repo = env.GITHUB_REPO || '169Pi/devrel';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`GITHUB_REPO must look like owner/repo, got "${repo}"`);

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
