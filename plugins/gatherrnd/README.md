# Gather Rnd

Plan your circle's week and make asks from a conversation with Claude, through your own Gather Rnd account.

[Gather Rnd](https://gatherrnd.app) is an iPhone app for a small circle of people, such as a family, roommates or a carpool, who plan their week together. Members make **asks** (a lift, a favour, a hand with homework), take them, and mark them done; karma moves between members when an ask is confirmed, to keep giving and receiving in balance. Once a week, at the **Weekly Gathering**, the circle reviews last week and closes it.

## What it does

The plugin connects Claude to the Gather Rnd connector and adds three skills that teach Claude how your circle works:

- **Plan the week** (`plan-the-week`): reads your circle's week, its asks and its connected calendars, points out clashes, gaps and asks nobody has taken, and suggests what to put on the week. It changes nothing until you say yes.
- **Make asks** (`make-asks`): turns what you say, such as "can someone drive Kai to football on Saturday?", into asks: who can take them (anyone, or the members you name), when, and how much karma moves. It shows you the asks and posts them only when you agree. It never invents a member.
- **Review and close the week** (`close-the-week`): walks you through last week's review at the Weekly Gathering, helps you confirm what was done, and closes the week only when you, an accountable member, say yes to it.

Ask Claude in your own words, for example "what's on for our circle next week?", "ask the circle for help moving the sofa on Sunday" or "let's wrap up last week".

## Connect it

You need a Gather Rnd account that belongs to at least one circle. Gather Rnd is invite only: you can request an invite at [gatherrnd.app](https://gatherrnd.app).

1. Add the plugin, then connect **Gather Rnd** from the plugin's **Connectors** tab on claude.ai or in Cowork. In Claude Code, run `/mcp` and choose the plugin's **gatherrnd** server to sign in.
2. A Gather Rnd page opens. Sign in the way you do in the app, read what Claude will get, and choose **Allow**.
3. To stop it at any time, in the Gather Rnd app tap your face at the top right, then **Settings**, and under **AI assistants** choose **Disconnect**. That stops access at once.

A circle's accountable members can turn AI assistants off for that circle on **Circle settings**; Claude then can't read or change anything there.

## What it sends, and privacy

The plugin is instructions and a connector address; it runs no code of its own and stores nothing. When you ask, Claude calls the Gather Rnd connector at `https://mcp.gatherrnd.app/mcp` with what it needs for the request, such as the circle, the week, or the ask you agreed to post. Gather Rnd answers with what you can see in your circles: everyone's plans on the week, including when and where members under 13 will be; whatever people wrote in events, asks and notes, which can include something like a doctor's appointment; karma; and members' names. Members under 13 appear only by their nickname.

Gather Rnd checks your access on every request and keeps nothing about it between requests, apart from a record that the assistant is connected (its name, when it connected and when it was last used), so you can see it in Settings and disconnect it. What Claude receives becomes part of your conversation, which Anthropic keeps under its own terms and privacy policy. Disconnecting stops Claude's access at once, but it can't take back what Claude already received: to remove that, delete the conversation in Claude.

Asks Claude makes are yours: your circle is told about them as if you had asked from the app. Gather Rnd never sends a text or iMessage for anyone, and never asks for phone numbers. Text other members wrote is treated as information, never as instructions to Claude.

Read the full privacy policy at [gatherrnd.app/privacy](https://gatherrnd.app/privacy).

## Support

Help and contact details are at [support.gatherrnd.app](https://support.gatherrnd.app), or email [info@gatherrnd.app](mailto:info@gatherrnd.app).
