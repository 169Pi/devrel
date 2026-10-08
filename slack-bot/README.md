# Alpieca 🦙

*Slack ↔ GitHub, the woolly way.* Alpieca is 169Pi's Slack app. PR alerts trot in from GitHub, issues trot out to GitHub, and Alpie turns any thread into a template-ready issue.

Lets anyone in Slack raise an issue in [`169Pi/devrel`](https://github.com/169Pi/devrel) through a form generated from the repo's own [issue templates](../.github/ISSUE_TEMPLATE). Issues land with the template's exact headings, title prefix, labels and assignees, so they look the same as issues opened from GitHub's **New issue** page.

## How people use it

- `/alpieca` opens a picker for every template in the repo, then a form for the one you choose.
- `/alpieca merch` or `/alpieca showcase` skips the picker.
- `/alpieca help` lists the templates.
- The **Raise a GitHub issue** shortcut in Slack's ⚡ menu does the same as `/alpieca`.
- `/alpieca <describe it in your own words>`, or the picker's *describe it* box: Alpie drafts the issue for you (see below).
- **More actions (⋯) → Turn into GitHub issue** on any message: Alpie drafts an issue from that message and its whole thread.
- **@Alpieca** in any channel or thread it's in, or a **DM** to Alpieca: ask a question, or describe a bug or idea (see *Talking to Alpieca* below).
- `/alpieca github <username>` links your GitHub account. You're also asked for it the first time you raise an issue.

After you submit, Alpieca posts an **issue card** (title, labels, a preview of the body, and triage buttons) where you raised it: the channel you ran `/alpieca` in, or the thread you mentioned it in or used the shortcut on. In private channels Alpieca hasn't been invited to, and for the ⚡ shortcut, the card comes to you as a DM instead. If GitHub rejects the issue, Alpieca DMs you everything you typed, so you don't lose your answers.

## Who raised it

Every issue is opened by the bot's GitHub token, so on GitHub it looks like the token's owner opened all of them. To credit the real person, the form asks each reporter for their GitHub username once, checks that the account exists, and remembers it. The issue footer then reads *Raised from Slack by Priya (@priya-dev)*. The @mention notifies and subscribes them on GitHub, and the Slack card shows them as the author, not the token owner.

## Issue cards and triage

Cards have **View on GitHub**, **🙋 Assign to me**, **🏷️ Label**, **💬 Comment** and **✅ Close** (or **↩️ Reopen**) buttons. Each action happens on GitHub, then the card refreshes from GitHub with a note like *Closed by @Rahul*. Comments are posted with the commenter's name and GitHub username, and quoted in the card's thread. *Assign to me* needs a linked GitHub account and repo access. Set `SLACK_TRIAGE_USERS` to limit the buttons to specific people.

**Issues opened directly on GitHub** get the same card, posted by the [`alpieca-new-issue`](../.github/workflows/alpieca-new-issue.yml) workflow. Issues filed from Slack carry a hidden `<!-- alpieca -->` marker, so they're never posted twice. To set it up, go to the repo's **Settings → Secrets and variables → Actions** and add:
- **Secret `SLACK_BOT_TOKEN`:** Alpieca's `xoxb-…` token. It must be Alpieca's, so that button clicks reach the bot.
- **Variable `SLACK_ISSUES_CHANNEL`:** the channel ID (`C…`) for new issues. Invite `@Alpieca` there, and set the bot's `SLACK_NOTIFY_CHANNEL` to the same channel so issues from both sources land together.


## Talking to Alpieca

Mention `@Alpieca` in a channel or thread, or DM it. If you mention it in a channel it isn't in, Slack offers to invite it.

- **Something to raise** (*"the docs search is broken"*, *"we should make hoodies"*): Alpieca privately offers **✨ Review Alpie's draft** or **Pick a template**. Alpie **starts drafting the moment you send the message**, so the draft is usually ready, or nearly ready, by the time you click. The issue card is posted back in that thread or DM.
- **A question** (*"are there any merch ideas filed?"*): Alpie answers in the thread, using the issue templates, the 25 most recently updated issues and the conversation, plus **📝 Draft an issue from this** in case it should be one. Links that aren't to real issues, the repo or the conversation are removed from answers.
- A bare `@Alpieca` in a thread means *turn this thread into an issue*. `@Alpieca help` (or `hi`) shows what it can do.

Whether a message is "something to raise" or "a question" is a quick keyword check (`looksLikeIssue` in `src/slack-text.js`). Either way the other option is one click away.

### Why drafting takes ~15 seconds

Alpie is a reasoning model: it writes about 1,200 characters of reasoning before the ~400-character JSON draft, at roughly 30 tokens/second. Prompt size barely matters, and the API ignores the usual ways of turning reasoning off: pre-filled answers, `enable_thinking: false`, and instructions to be brief. So the bot hides the wait instead, by drafting in the background as soon as an issue-like mention or DM arrives. A faster Alpie mode would need to come from the Alpie API itself.

## Drafting with Alpie

When `ALPIE_API_KEY` is set, [Alpie](https://huggingface.co/169Pi/Alpie-Core) (`alpie-32b` via `api.169pi.com`) turns rough feedback or a Slack thread into the template:

1. The reporter writes freely or picks a message. Alpie gets the template fields and the feedback. If no template was chosen, Alpie also picks the one that fits best.
2. Alpie fills in what the feedback supports and writes an **Additional context** section for maintainers: who else was involved, constraints or deadlines mentioned, and open questions or missing details to follow up on.
3. The reporter sees the pre-filled form and edits it. **Nothing is filed until they click _Create issue_.** Required fields Alpie couldn't answer are left blank, so Slack makes the reporter fill them in.

The bot doesn't trust Alpie's output blindly:

- It keeps only fields the template defines, strips the title prefix, and enforces Slack's length limits.
- It drops any link that didn't appear in the original feedback, so a made-up demo URL never reaches GitHub.
- Feedback is passed to Alpie as data, so instructions written inside a message are ignored.
- The repo is public. Alpie is told to leave out secrets and personal details, and the form warns the reporter to check before filing.
- If Alpie errors, times out, or nothing fits, the reporter falls back to the manual form or the picker, and their original text is kept.

Drafted issues end with an `🤖 Additional context` section and a footer linking back to the Slack thread.

## How templates turn into forms

The bot reads `.github/ISSUE_TEMPLATE/*.md` from GitHub, not from a bundled copy, and caches them for 5 minutes. When a template is added or edited on the default branch, Slack shows the change automatically. No redeploy is needed.

| In the template | In Slack |
| --- | --- |
| `title: "[Project]: <…>"` | **Title** field. The issue is titled `[Project]: <what you typed>`. |
| `### Heading` + `*italic guidance*` | Multi-line text box, with the guidance shown as a hint |
| `* **Field:**` bullets under a heading | One single-line input per bullet |
| `(Optional)` / `(if applicable)` in a heading or bullet | Optional input. Everything else is required. |
| Bullet named like *Repo / Link / Demo / Docs / URL* | Must contain an `https://` link |
| Bullet named like *Mastermind / Author / Owner* | Pre-filled with the reporter's Slack name |
| `labels:` / `assignees:` | Applied to the issue. If GitHub drops any labels, the bot warns you. |

Empty optional answers are written as `_No response_`, as GitHub issue forms do. A `Raised from Slack by <name>` footer records who filed the issue.

## Setup

1. **Create the Slack app.** Go to [api.slack.com/apps](https://api.slack.com/apps) → *Create New App* → *From an app manifest*, and paste [`manifest.yml`](manifest.yml). Install it to the workspace. Whenever the manifest's scopes or events change (e.g. this version adds `chat:write.public`, `app_mentions:read` and the `app_mention` event), paste it again and **Reinstall to Workspace**. Invite the bot to channels where you'll use *Turn into GitHub issue* (`/invite @Alpieca`) so it can read whole threads. Otherwise Alpie drafts from the selected message only.
   - **Bot token:** *OAuth & Permissions* → *Bot User OAuth Token* (`xoxb-…`) → `SLACK_BOT_TOKEN`
   - **App token:** *Basic Information* → *App-Level Tokens* → create one with `connections:write` (`xapp-…`) → `SLACK_APP_TOKEN`

   **Upgrading the existing "169pi PR Bot" app instead:** open it at api.slack.com/apps → **App Manifest**, replace the whole manifest with [`manifest.yml`](manifest.yml), and save. That renames it to Alpieca and adds the issue features. Then **Reinstall to Workspace** to grant the new scopes. The manifest keeps the `incoming-webhook` scope, so the `SLACK_WEBHOOK_URL` used by the PR notifier in `169Pi/.github` keeps working. Don't *uninstall* the app, because that revokes the webhook. Socket Mode is already on there, so reuse its app-level token if one exists.
2. **Create a GitHub token.** Make a [fine-grained PAT](https://github.com/settings/personal-access-tokens/new) (or a GitHub App installation token) limited to `169Pi/devrel` with **Issues: Read and write** and **Contents: Read** → `GITHUB_TOKEN`. Issues are created as the token's owner, so a dedicated bot account keeps attribution tidy.
3. **(Optional) Turn on Alpie.** Create a key at [playground.169pi.ai](https://playground.169pi.ai/dashboard/api-keys) → `ALPIE_API_KEY`. Without it, the bot runs as plain forms.
4. **Run it:**

   ```bash
   cp .env.example .env   # fill in the tokens
   npm install
   npm run dev            # or: npm start / docker build -t alpieca . && docker run --env-file .env alpieca
   ```

The bot uses Socket Mode, so it needs no public URL or ingress and can run on any always-on host. To use HTTP instead, leave `SLACK_APP_TOKEN` empty, set `SLACK_SIGNING_SECRET`, and point the app's Request URL at `https://<host>/slack/events`.

Optional settings: `SLACK_NOTIFY_CHANNEL` posts every new issue to a team channel. `GITHUB_TEMPLATE_REF` reads templates from a branch other than the default. `TEMPLATE_DIR` reads templates from disk. See [`.env.example`](.env.example).

## Deploying on AWS

Alpieca runs on one small EC2 instance. It needs no inbound ports, load balancer or public URL, because Socket Mode connects outbound only. Secrets live in SSM Parameter Store and are never written to disk. You manage the instance through Session Manager, so there are no SSH keys. [`deploy/aws/user-data.sh`](deploy/aws/user-data.sh) does all of the server setup on first boot.

1. **Secrets:** in **Systems Manager → Parameter Store**, create these as `SecureString`: `/alpieca/SLACK_BOT_TOKEN`, `/alpieca/SLACK_APP_TOKEN`, `/alpieca/GITHUB_TOKEN`, `/alpieca/ALPIE_API_KEY`. Any other variable from `.env.example` works the same way, e.g. `/alpieca/SLACK_NOTIFY_CHANNEL`.
2. **Instance role:** in **IAM → Roles → Create role → EC2**, attach `AmazonSSMManagedInstanceCore` and add [`deploy/aws/iam-policy.json`](deploy/aws/iam-policy.json) as an inline policy. Name the role `alpieca-ec2`.
3. **Launch:** create an **Amazon Linux 2023 (arm64)** instance of type `t4g.micro`. Pick no key pair, a security group with **no inbound rules**, and a public IP. Set the IAM instance profile to `alpieca-ec2`, and paste `user-data.sh` into **Advanced details → User data**.
4. **Verify:** **Connect → Session Manager**, then run `sudo journalctl -u alpieca -f`. You should see `Alpieca running (Socket Mode)…`. Stop any other running copy, such as a laptop, because only one instance should run at a time.

- **Deploy a new version:** run `sudo alpieca-update` in Session Manager. It pulls `main`, installs dependencies and restarts.
- **Rotate a secret:** update the parameter, then run `sudo systemctl restart alpieca`.
- **Cost:** roughly $7–10 a month: the instance (about $3 for a `t4g.nano`, $6 for a `t4g.micro`), plus about $3.65 for the public IPv4 address that outbound traffic needs, plus under $1 for an 8 GB disk. The bot uses about 100 MB of RAM, so a `t4g.nano` (0.5 GB) works if you want the lowest cost.

## Development

```bash
npm test   # real templates in ../.github/ISSUE_TEMPLATE, rendering, Slack limits, and Alpie parsing against a fake API
```
