# Legacy snapshot fixture

`legacy-snapshot.json` emulates the on-disk snapshot shape written by a
`gh-delta` version **before** commits `6fb3bbe` ("observe mergeStateStatus in
the PR fingerprint boundary") and `730ce69` ("fetch base ref, labels,
assignees, and review requests") -- i.e. roughly v0.3.x, right before the PR
fingerprint grew the fields listed in `ADDITIVE_COMPARED_FIELDS`
(`lib/fingerprint.mjs`).

Dropped from the current PR fingerprint shape (`lib/fingerprint.mjs`
`prFingerprint()`), relative to today:

- `mergeStateStatus`
- `base`
- `labels`
- `assignees`
- `reviewRequests`

The issue fingerprint is untouched: `labels` and `assignees` have been
present on issue snapshots since the very first shipped version, so there is
nothing "legacy" to strip there (see the comment on `ADDITIVE_COMPARED_FIELDS`
in `lib/fingerprint.mjs`).

`ciChecks` / `reviewSummary` (added later, in the "name the exact checks and
reviews" commit) ARE included here deliberately -- they predate the fields
this fixture is testing the absence of, so a snapshot missing only the five
fields above is the most realistic "just before the next feature landed"
shape. They are also stripped from change comparison entirely
(`comparableFingerprint`), so their presence or absence does not affect this
test.

Used by `test/legacy-snapshot.test.mjs` to verify that a real fleet upgrading
`gh-delta` and reading a snapshot written by the old version on its first
upgraded tick does not manufacture phantom deltas from the newly-added
fields, and that the very next tick converges the snapshot to the current
shape without oscillating.
