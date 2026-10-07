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

After you submit, the form changes to show a link to the new issue, and the bot also sends you a DM with that link. If GitHub rejects the issue, the bot DMs you everything you typed, so you don't lose your answers.

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

1. **Create the Slack app.** Go to [api.slack.com/apps](https://api.slack.com/apps) → *Create New App* → *From an app manifest*, and paste [`manifest.yml`](manifest.yml). Install it to the workspace. Invite the bot to channels where you'll use *Turn into GitHub issue* (`/invite @Alpieca`) so it can read whole threads. Otherwise Alpie drafts from the selected message only.
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

## Development

```bash
npm test   # real templates in ../.github/ISSUE_TEMPLATE, rendering, Slack limits, and Alpie parsing against a fake API
```
