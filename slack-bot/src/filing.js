// Who opens an issue on GitHub. Someone signed in to GitHub (`/alpieca github login`) opens it
// themselves, and GitHub marks it "with Alpieca". Everyone else's issues are opened by the bot. A
// person's sign-in can only do what they can do, so on a private repo it also tells us whether they
// have access: those without it are turned away, not quietly filed as the bot.

const statusOf = (err) => err.status ?? err.cause?.status;

/**
 * @param dest    the repo, from createRepos: { repo, public, github }
 * @param user    { token, login } if the filer is signed in to GitHub, else null
 * @param signIn  whether people can sign in at all (the GitHub App has a client ID)
 * @param asUser  (token) => a GitHub client for dest that acts as that person
 * @returns {{ created, as: 'user' | 'bot', signedOut?: boolean }}
 *        | {{ refused: 'no-access' | 'sign-in', login?: string, signedOut?: boolean }}
 */
export async function fileIssue({ dest, issue, user, signIn, asUser, logger = console }) {
  const signedOut = { signedOut: true };
  if (user?.token) {
    const github = asUser(user.token);
    try {
      if (!dest.public && !(await github.canRead())) return { refused: 'no-access', login: user.login };
      const created = await github.createIssue(issue);
      await applyDropped(dest, issue, created, logger);
      return { created, as: 'user' };
    } catch (err) {
      const status = statusOf(err);
      // Revoked or expired for good: carry on as if they never signed in.
      if (status === 401) return { ...(await fileIssue({ dest, issue, user: null, signIn, asUser, logger })), ...signedOut };
      // They can see the repo but GitHub won't let the App open issues as them, e.g. it isn't installed
      // there. That's Alpieca's setup, not their access, so the bot files it.
      if (status !== 403 && status !== 404) throw err;
      logger.warn(`Couldn't open the issue in ${dest.repo} as @${user.login} (${err.message}); opening it as the bot`);
    }
  } else if (!dest.public && signIn) {
    // Without a sign-in there's no telling whether they may see a private repo.
    return { refused: 'sign-in' };
  }
  return { created: await dest.github.createIssue(issue), as: 'bot' };
}

/**
 * GitHub silently drops the labels and assignees of an issue opened by someone without triage access.
 * The bot adds them back, so the template's labels apply whoever opened it.
 */
async function applyDropped(dest, issue, created, logger) {
  if (created.missingLabels.length) {
    try {
      await dest.github.setLabels(created.number, issue.labels);
      created.issue = { ...created.issue, labels: issue.labels.map((name) => ({ name })) };
      created.missingLabels = [];
    } catch (err) {
      logger.warn(`Couldn't add labels to ${dest.repo}#${created.number}: ${err.message}`);
    }
  }
  const assigned = new Set((created.issue.assignees ?? []).map((a) => a.login.toLowerCase()));
  for (const login of (issue.assignees ?? []).filter((l) => !assigned.has(l.toLowerCase()))) {
    await dest.github.assign(created.number, login).catch((err) => logger.warn(`Couldn't assign @${login} to ${dest.repo}#${created.number}: ${err.message}`));
  }
}
