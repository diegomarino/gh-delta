# Alternatives and Adjacent Tools

How `gh-delta` compares to related projects — tools that overlap in intent or audience.

## Closer alternatives

| Project                                                       | What it is                                                                                      | Why it is somewhat close                                | Why `gh-delta` is different                                                                                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [`openclaw/gitcrawl`](https://github.com/openclaw/gitcrawl)   | Local-first GitHub issue and pull request crawler with SQLite, CLI/JSON/TUI surfaces            | Local-first, CLI-oriented, works from GitHub state      | `gitcrawl` is a broader crawler and triage system; `gh-delta` is narrower and centered on deterministic snapshot-to-snapshot change detection |
| [`yungookim/oh-my-pr`](https://github.com/yungookim/oh-my-pr) | Local-first PR babysitter that watches repos and dispatches AI agents to fix code               | Also watches GitHub state and is automation-oriented    | `oh-my-pr` takes actions and manages agent workflows; `gh-delta` stops at detection and leaves actions to the caller                          |
| [`k1LoW/gh-triage`](https://github.com/k1LoW/gh-triage)       | `gh` extension for triaging issues, pull requests, and discussions through unread notifications | Terminal-native GitHub workflow tool for ongoing triage | Notification-inbox workflow, not deterministic diffing against a local snapshot                                                               |

## Adjacent tools, not near-direct replacements

| Project                                                         | What it is                                                                              | Why it is adjacent                               | Why it is not a near-direct replacement                                                               |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| [`google/triage-party`](https://github.com/google/triage-party) | Stateless self-hosted web app for issue and PR triage                                   | Helps teams react to GitHub activity             | Human-facing web triage UI, not a one-shot machine-readable delta detector                            |
| [`kenn-io/middleman`](https://github.com/kenn-io/middleman)     | Local-first maintainer console and dashboard for triage, review, and merge across repos | Local-first GitHub operations surface            | Interactive dashboard and console rather than a detector primitive for schedulers, scripts, or agents |
| [`meiji163/gh-notify`](https://github.com/meiji163/gh-notify)   | `gh` extension to view GitHub notifications in the terminal                             | Lightweight terminal tool around GitHub activity | Notification reader UX, not snapshot-based state change detection                                     |
