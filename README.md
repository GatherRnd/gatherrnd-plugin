# Gather Rnd for AI assistants

The [Gather Rnd](https://gatherrnd.app) plugin: it connects an AI assistant to your circle in Gather Rnd, so it can help you plan the week and make asks, through your own Gather Rnd account and with your yes before anything changes.

Gather Rnd is an iPhone app for a small circle of people, such as a family, roommates or a carpool, who plan their week together. It is invite only for now: you need an account from the app, in a circle you joined by invitation or started yourself. AI assistants are off in each circle until the circle turns them on in Circle settings, and it can turn them off again.

## Add it

- **Claude Code:** `/plugin marketplace add GatherRnd/gatherrnd-plugin`, then `/plugin install gatherrnd@gatherrnd`, then `/mcp` to sign in to Gather Rnd.
- **Claude (web, Desktop, Cowork; paid plans):** Customize › Plugins › Add › Add marketplace › Add from a repository, enter `GatherRnd/gatherrnd-plugin`, add **Gather Rnd**, then connect it from the plugin's **Connectors** tab.
- **Just the connector, any Claude plan** (Free allows one custom connector): add a custom connector named Gather Rnd with the URL `https://mcp.gatherrnd.app/mcp`. You get the tools without the plugin's skills.

Either way, a Gather Rnd page asks you to sign in and **Allow**. Disconnect at any time in the app, under Settings › AI assistants.

## What is here

| Path                                                        | What it is                                                                                               |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `plugins/gatherrnd/`                                        | The plugin: three skills, a README, the connector's address, and its icons.                              |
| `plugins/gatherrnd/.claude-plugin/plugin.json`, `.mcp.json` | Claude's manifest and connector entry.                                                                   |
| `plugins/gatherrnd/plugin.json`, `mcp.json`                 | The same plugin in the [Agent Plugins](https://agent-plugins.org) format, for OpenAI's plugin directory. |
| `.claude-plugin/marketplace.json`                           | This repository as a Claude plugin marketplace.                                                          |
| `contract/tools.json`                                       | The connector tools the skills name.                                                                     |
| `scripts/check.mjs`                                         | The rules the plugin keeps for both directories; CI runs them on every pull request.                     |
| `schemas/agent-plugins-1.0.0/`                              | The Agent Plugins schemas the manifests are checked against.                                             |

The plugin is instructions and the address of Gather Rnd's connector. It runs no code of its own and holds no secrets.

Help: [support.gatherrnd.app](https://support.gatherrnd.app) or [info@gatherrnd.app](mailto:info@gatherrnd.app). Security reports: see [SECURITY.md](SECURITY.md).

## Licence

The files in this repository are under the [MIT licence](LICENSE), with two exceptions:

- The Gather Rnd name and the logos in `plugins/gatherrnd/assets/` are not under it. They may be shown unchanged in an installed, shared or forked copy of the plugin, and in the listing of a directory Gather Rnd submits it to; [NOTICE](plugins/gatherrnd/NOTICE) says what else is allowed.
- The two schemas in `schemas/agent-plugins-1.0.0/` (`plugin.schema.json` and `mcp.schema.json`) belong to the Agent Plugins project and are under the [Apache License 2.0](schemas/agent-plugins-1.0.0/LICENSE).

The plugin's connection files (`.mcp.json` and `mcp.json`, which hold only the connector's address) are under the MIT licence like the rest. The licence covers these files only. The Gather Rnd app, its API, the connector at `https://mcp.gatherrnd.app/mcp` and the service behind them are not open source and are not in this repository. This licence gives no right to use them; using the connector needs a Gather Rnd account.
