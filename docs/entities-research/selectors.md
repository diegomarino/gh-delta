# Selector Applicability Research

Status: research only, not public contract
Last verified: 2026-07-01
GitHub CLI version: 2.95.0

Selectors are not global filters. A selector is valid only for entity types whose
GitHub data model actually contains that relationship. For example, `branch`
can be meaningful for commits or workflow runs, but it is not meaningful for
repository issues.

## Vocabulary

- Entity: the object family being watched, such as `pr`, `issue`, `commit`, or
  `workflow-run`.
- Selector: a constraint on the entity universe, such as branch, label, author,
  state, workflow, or tag.
- Monitor id: the stable identity of a recurring monitor. It is not a selector.

## Applicability States

| State      | Meaning                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------- |
| `valid`    | The selector is known to apply and can become public after fingerprint and pagination work. |
| `invalid`  | The selector does not apply to that entity and should produce a CLI error if supplied.      |
| `research` | The concept might apply, but the exact command/API shape or semantics are not proven.       |
| `derived`  | The relationship exists as a field, but not necessarily as a direct fetch selector.         |

## Initial Matrix

| Selector    | PR       | Issue    | Commit  | Workflow Run | Release  | Discussion |
| ----------- | -------- | -------- | ------- | ------------ | -------- | ---------- |
| `branch`    | research | invalid  | valid   | valid        | research | invalid    |
| `label`     | research | valid    | invalid | invalid      | invalid  | research   |
| `state`     | valid    | valid    | invalid | valid        | research | research   |
| `author`    | valid    | valid    | valid   | research     | research | valid      |
| `assignee`  | valid    | valid    | invalid | invalid      | invalid  | invalid    |
| `workflow`  | invalid  | invalid  | invalid | valid        | invalid  | invalid    |
| `tag`       | invalid  | invalid  | invalid | invalid      | valid    | invalid    |
| `milestone` | research | research | invalid | invalid      | invalid  | invalid    |

## Current Contract

No selectors in this matrix are public today. The current CLI supports only:

```bash
--entities pr
--entities issue
--entities pr,issue
```

Future selectors must declare:

1. which entities they apply to;
2. whether they are a fetch-time selector or a derived field;
3. what happens to previously known objects that leave the selector;
4. how selector values affect snapshot identity and outpost event identity.

## Branch Selector Note

`branch` must not be used as monitor identity. A future branch selector should be
accepted only for entities where branch membership is meaningful, such as
commits and workflow runs. It should be rejected for issues.
