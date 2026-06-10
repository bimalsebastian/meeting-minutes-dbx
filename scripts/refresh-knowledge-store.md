---
# Genie Live Knowledge Store — Refresh Prompt
# Run with: claude -p scripts/refresh-knowledge-store.md
# Recommended: every Sunday 7am via cron
# crontab entry:
# 0 7 * * 0 cd /Users/bimal.sebastian/meeting-minutes-dbx && claude -p scripts/refresh-knowledge-store.md >> logs/knowledge-refresh.log 2>&1

Re-read all meeting notes from:
/Users/bimal.sebastian/Library/CloudStorage/GoogleDrive-bimal.sebastian@databricks.com/My Drive/Databricks notes/Databricks/meetings

Process the most recent 60 files sorted by last modified date (most recent first).
Skip files under 100 words.

Update ONLY the following files in the knowledge store at:
/Users/bimal.sebastian/Library/CloudStorage/GoogleDrive-bimal.sebastian@databricks.com/My Drive/Databricks notes/Databricks/genie-live-knowledge

Files to fully refresh (overwrite):
- customers/gsk.md (re-extract stakeholders, active initiatives, status; max 1200 words)
- open-actions.md (last 30 days ONLY — full refresh; no items older than 30 days)
- databricks-sa-context.md (regenerate from updated files; max 2500 words)

Files to update incrementally (add new content, do not overwrite existing):
- products/unity-catalog.md — add new questions, new gaps, or new field patterns found in notes
- products/genie.md — update Genie MCP status, new objections/responses, GiGi POC progress
- products/delta-sharing.md — update SAP BDC status, new technical findings
- products/lakebase.md — update qualification status, new use cases
- products/agentbricks.md — update Code Orange qualification status, new use cases
- products/mlflow.md — update field use cases if new mentions found
- competitive/microsoft.md — update competitive framings, Power BI language rules
- competitive/glean.md — update GiGi integration architecture progress
- competitive/snowflake.md — add new competitive scenarios if found
- technical-patterns/uc-credential-passthrough.md — update FEIP-1423 status, new workarounds
- technical-patterns/cdf-incremental-pipelines.md — update SAP BDC status, open questions
- technical-patterns/gxp-regulated-environments.md — add new regulated environment patterns

For incremental updates:
- Add new sections where new content is found
- Do NOT overwrite sections that are already accurate
- Update the "Last refreshed" date at the top of every file touched
- Add a "## Recent Updates (since {previous refresh date})" section at the bottom of each incrementally updated file listing what changed

At the end, print a diff summary:
- Files fully refreshed: {list}
- Files incrementally updated: {list with what changed}
- Files unchanged: {list}
- New stakeholders found: {list}
- New action items found: {count}
- Date range of notes processed: {from} to {to}
---
