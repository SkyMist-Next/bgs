# Image delivery

Default-branch pushes run application checks before publishing an immutable
Linux/amd64 image through the private BuildKit daemon. `candidate.json` records
the source SHA, image digest, workflow run/attempt, contract and capabilities.
A completed-workflow notification wakes the chart reconciler; its scheduled
reconciliation independently verifies successful trusted source workflows.

Keep `deploymentContract` aligned with the sibling chart. Increment both sides
for coordinated changes. Capabilities and migration inventory describe supported
contracts; removing a capability still required by a deployed consumer blocks
promotion. Builds continue while deployment is paused. Recover through the chart
repository's workflow using an explicit immutable release ID.
