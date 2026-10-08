// Who may use Alpieca. Issues land in a public repo under the bot's GitHub token, so people from
// other organisations (Slack Connect) are turned away, and guests can raise issues but not triage.

/**
 * @param user  a Slack users.info `user` object (or null if it couldn't be looked up)
 * @param home  { teamId, enterpriseId } of the workspace Alpieca is installed in
 * @returns { member, triager, reason }
 */
export function accessFor(user, home) {
  if (!user || user.deleted || user.is_bot) return { member: false, triager: false, reason: 'unknown' };
  const sameOrg =
    user.team_id === home.teamId || Boolean(home.enterpriseId && user.enterprise_user?.enterprise_id === home.enterpriseId);
  if (!sameOrg) return { member: false, triager: false, reason: 'external' };
  const guest = Boolean(user.is_restricted || user.is_ultra_restricted);
  return { member: true, triager: !guest, reason: guest ? 'guest' : null };
}

/** True only for ordinary public channels, whose links are safe to put in a public issue. */
export function isPublicChannel(channel) {
  return Boolean(channel?.is_channel && !channel.is_private && !channel.is_im && !channel.is_mpim);
}
