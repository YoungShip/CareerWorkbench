# Tracker update entrypoint

The current implementation should expose a safe adapter equivalent to:

```text
tracker snapshot
tracker validate
tracker preview <plan.json>
tracker apply <plan.json>
tracker snapshot
```

The adapter owns file locking, backups, schema validation, revision checks and queue creation. The Skill supplies a narrow plan keyed by `job_id`; it must not rewrite source CSV files directly.

