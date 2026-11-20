---
name: jth-flow
description: JTH workflow — AIOS-style capability-driven Harness with evidence gate. Use when starting substantial work: requirements, design, planning, TDD, implementation, review, or debugging.
---

# JTH Flow

## Workflow policy

Declare intent to get a disposition:

```sh
jth harness policy --intent implement --relationship new
jth harness policy --intent debug --relationship continue --active-plan
```

Dispositions:
- `noop` / `direct`: no harness needed
- `guarded`: bounded change with focused verification  
- `planned`: multi-stage capability sequence with evidence gate

## Capability sequence (planned work)

```sh
jth harness start --intent implement   # Start or resume workflow
jth harness status                      # Current stage and expected evidence
jth harness submit --kind passing-test-observed --receipt receipt:<id>  # Submit evidence; a passing gate advances the stage
```

## Evidence gate

Every stage has `expectedEvidence`. The harness rejects advancement without matching evidence:

| Stage | Required evidence kind |
|---|---|
| TDD: write failing test | `failing-test-observed` + `receipt:` ref with nonzero exit |
| TDD: make pass | `passing-test-observed` + `receipt:` ref with zero exit |
| Implementation | `implementation-complete` |
| Review | `review-verdict` |
| Debug | `debug-root-cause-identified` |

## Verification

After the last stage completes, run the project checks the repository documents and report their results. `jth harness reset` clears the workflow state to start over.
