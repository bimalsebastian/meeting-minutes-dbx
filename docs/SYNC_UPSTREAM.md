# Syncing upstream changes into your fork

Use this workflow to pull new changes and bug fixes from the **original repo** (the one you forked from) into **your fork**, without losing your own changes and without merging your changes back upstream.

---

## 1. Add the original repo as `upstream` (one-time)

From the repo root (`meeting-minutes-dbx`):

```bash
# Replace with the actual original repo URL you forked from, e.g.:
# https://github.com/Zackriya-Solutions/meeting-minutes
git remote add upstream https://github.com/ORIGINAL_OWNER/ORIGINAL_REPO.git
```

Check remotes:

```bash
git remote -v
# origin   = your fork (e.g. bimalsebastian/meeting-minutes-dbx)
# upstream = original repo
```

---

## 2. Fetch latest from upstream

```bash
git fetch upstream
```

This only downloads commits; it does not change your working tree.

---

## 3. Review what’s new upstream

See commits that exist in upstream but not in your current branch:

```bash
# If the main branch on upstream is called main:
git log --oneline HEAD..upstream/main

# Or to see a short summary of changed files:
git log --oneline --stat HEAD..upstream/main
```

Inspect specific files before merging:

```bash
git diff HEAD..upstream/main -- path/to/file
```

---

## 4. Merge upstream into your branch (keeps all your changes)

From your branch (e.g. `main`):

```bash
git merge upstream/main
```

- Git will create a merge commit that combines upstream’s history with yours.
- Your existing commits stay as they are; upstream’s new commits are brought in.
- If there are conflicts, Git will list the files. Resolve them, then:

  ```bash
  git add .
  git commit -m "Merge upstream/main into main"
  ```

---

## 5. Push to your fork (optional)

```bash
git push origin main
```

This only updates **your fork** on GitHub. It does not send anything to the original repo.

---

## Alternative: rebase (linear history, slightly riskier)

If you prefer a linear history instead of a merge commit:

```bash
git fetch upstream
git rebase upstream/main
# Resolve any conflicts per file, then:
# git add . && git rebase --continue
git push origin main
```

Use rebase only if you’re comfortable with it; merge is safer if you’re unsure.

---

## Quick reference

| Goal                         | Command / step                          |
|-----------------------------|-----------------------------------------|
| Add original repo           | `git remote add upstream <URL>`         |
| Get latest from original    | `git fetch upstream`                    |
| See what’s new upstream     | `git log HEAD..upstream/main`           |
| Bring upstream into my fork | `git merge upstream/main` (then push)   |
| Push only to my fork       | `git push origin main`                  |

---

## If you don’t know the original repo URL

- On GitHub: open **your fork** → “Forked from …” under the repo name.
- Or check with the person/team you forked from.

Once `upstream` is added, repeat **fetch → review → merge → push** whenever you want to pull in new upstream changes without losing your work or merging upward.
