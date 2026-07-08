# Examples

Worked examples of consuming gh-delta, one integration axis each. They are
repo documentation — none ship in the npm package.

| Example                                                     | Axis it demonstrates                         | Consumes                                         |
| ----------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------ |
| [github-actions-slack-digest](github-actions-slack-digest/) | Infra-owned scheduling in CI, chat digest    | `--format json --detail` + `actions/cache` state |
| [outpost-ntfy-receiver](outpost-ntfy-receiver/)             | Push delivery to a phone                     | `--outpost-url` payload schema v1                |
| [systemd-timer](systemd-timer/)                             | Init-system ops; exit taxonomy → unit states | `--format text` + `SuccessExitStatus`            |
| [programmatic-embed](programmatic-embed/)                   | Library reuse; scopes the CLI can't express  | `gh-delta/detect`, `/snapshot`, `/contract`      |

Shared ground rules across all of them: the detector stays a dumb one-shot
(the scheduler owns the clock), exit `2` means fix-your-config (never
blind-retry), and the exact classes, exit codes, and payload schema live in
[docs/contract.md](../docs/contract.md).
