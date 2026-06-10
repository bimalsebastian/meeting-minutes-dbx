"""Step 1 — confirm KB_BASE resolves to Google Drive and list all files."""
from pathlib import Path

GDRIVE_KB = (
    Path.home()
    / "Library/CloudStorage"
    / "GoogleDrive-bimal.sebastian@databricks.com"
    / "My Drive"
    / "Databricks notes"
    / "Databricks"
    / "genie-live-knowledge"
)
REPO_KB = Path(__file__).parent.parent / "copilot-knowledge"

kb = GDRIVE_KB if GDRIVE_KB.exists() else REPO_KB
print(f"KB_BASE → {kb}")
print(f"GDrive exists: {GDRIVE_KB.exists()}")
print()

files = sorted(kb.glob("**/*.md"))
print(f"{len(files)} .md files found:")
for f in files:
    size = f.stat().st_size
    print(f"  {str(f.relative_to(kb)):<55} {size:>6} bytes")

print()

# ── Step 2: run the scorer against two representative queries ──────────────
def score(rel, query_lower, customer=None):
    parts = rel.replace("/", " ").replace("-", " ").replace("_", " ").replace(".md", "")
    s = 0
    if customer and rel == f"customers/{customer}.md":
        s += 100
    if "/" not in rel:
        s += 25
    dir_name = rel.split("/")[0].replace("-", " ") if "/" in rel else ""
    if dir_name and dir_name in query_lower:
        s += 35
    for w in parts.split():
        if len(w) >= 4 and w in query_lower:
            s += 15
    return s

CHAR_BUDGET = 10_000

test_cases = [
    (
        "We are in a meeting with Mahendra from GSK discussing Unity Catalog "
        "governance for 70k PowerBI dashboards and GxP regulated environments.",
        "gsk",
    ),
    (
        "The customer is asking about MLflow model tracking and AgentBricks "
        "for AI agent orchestration on Databricks.",
        None,
    ),
]

all_files = [
    (str(p.relative_to(kb)), p)
    for p in kb.glob("**/*.md")
    if p.name != "_template.md"
]

for query, customer in test_cases:
    q = query.lower()
    print(f"Query: {query[:80]}...")
    print(f"Customer: {customer or 'none'}")

    scored = sorted(
        [(score(rel, q, customer), rel, p) for rel, p in all_files],
        key=lambda x: -x[0],
    )

    total = 0
    for s, rel, p in scored:
        if s == 0 and total > 0:
            break
        size = p.stat().st_size
        status = "LOADED "
        if total + size > CHAR_BUDGET:
            remaining = CHAR_BUDGET - total
            status = f"PARTIAL({remaining}c)"
            size = remaining
        print(f"  {status}  score={s:3d}  {rel}")
        total += size
        if total >= CHAR_BUDGET:
            break

    print(f"  → {total} / {CHAR_BUDGET} chars loaded\n")
