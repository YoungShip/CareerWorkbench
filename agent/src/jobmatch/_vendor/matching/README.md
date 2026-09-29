# Fixed validator dependency for the offline demo

The four Python files in this directory are unmodified source from the repository and
revision recorded in SOURCE.json. Only CRLF line endings are normalized to LF.
The upstream MIT license is included.

This snapshot lets a fresh checkout run the synthetic, scripted demo without a second
repository, personal files, credentials, or network access at runtime. Production
matching continues to load the workspace Skill selected by JOBHUNT_SKILLS_DIR.

Do not change matching rules here. Update the canonical Skill, pin its commit, copy the
corresponding files and license, refresh the normalized SHA-256 values, and run the
demo and regression tests. The demo checks these hashes before executing.
