# Local tracker adapter contract

The Skill is independent of any particular CSV implementation. A local adapter must expose equivalent operations and preserve optimistic concurrency.

Before registering a newly researched role, the caller must pass the user-selected stable position ID and verify that it is contained in `readiness.registerable_position_ids`. `can_register_selected_position` is only meaningful when the same `selected_position_id` was supplied; never use a global true value to register a different role. A report may contain verified individual positions while the overall directory is partial; those positions can be displayed, but they must not be treated as a complete research batch.

Decision rule for registration: `recommended` requires all hard/core requirements satisfied; `consider` requires hard qualifications satisfied and a core `transferable + pending` gap, which permits user-reviewed trial application; `pending` remains non-registerable when hard qualifications are unresolved or core evidence is absent/conflicted. These states are derived from requirements, not selected by label to change permission.

For human readability, copy the verified pipeline human-summary.json values into match_grade and match_estimate when registering a researched job. match_estimate is an evidence-match range, not a hiring probability; neither display field grants registration permission.

## Read and write sequence

```text
snapshot → plan(expected_revision) → preview → apply → read-back → validate
```

`expected_revision` is mandatory for writes. On conflict, re-read the snapshot and merge the intended patch; never silently overwrite a newer revision.

## Logical tables

### job_pool

Recommended fields:

```text
job_id, company, job_title, location, job_url, source,
application_date, status, next_action, resume_variant, role_family,
match_grade, match_estimate, deadline, application_limit,
preference_order, notes, job_description, research_file,
matching_file, cohort_status, online_record_id
```

`job_id` is the stable key. Company plus title is not guaranteed to be unique.

### application_log

Use `log_id` and `job_id`. A `Submitted` transition requires a real submission evidence field, confirmation URL/text, or equivalent account evidence, plus the actual submission date.

### follow_up

Use `event_id` and `job_id`. Keep ordinary reminders separate from hiring stages. Suggested stages: `0 application`, `1 assessment`, `2 first interview`, `3 second interview`, `4 later interview`, `5 offer`. Only assign a stage when evidence supports it.

### sync_queue

Every confirmed local mutation creates a queue item with a change/revision. `pending`, `error` and `synced` are local synchronization states, not recruiting outcomes.

## Status semantics

```text
Pending   selected and ready to apply
Deferred  intentionally postponed, reason retained
Needs user / Blocked  waiting for user or an external condition
Submitted verified application submission
Ended     process ended without a known final outcome
Skipped   intentionally not pursued
Rejected  explicit rejection evidence
Offer     explicit offer evidence
```

Do not infer status from a plan date, page visit, or a generic reminder.
