Upstream

**Repository:** [`buddingnewinsights/pi-diff`](https://github.com/buddingnewinsights/pi-diff)

**Upstream path:** `.` (entire repo)

**License:** MIT, © huynhgiabuu

**Initially ported:** `0c4768c` (local commit `7443d13`)

**Last synced:** `0c4768c` (`fix: include dist/edit-guard.* in published package`, 2026-06-28)

**Differences from upstream**

None so far — this is a direct copy.

```bash
UP=$(mktemp -d)/pi-diff
git clone --quiet https://github.com/buddingnewinsights/pi-diff.git "$UP"
git -C "$UP" log --oneline 0c4768c..origin/HEAD
```
