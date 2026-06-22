---
name: update-pi-agent
description: >
  Safely update the pi coding agent (and optionally its extensions) by first
  reviewing the upstream changelog and every relevant commit for malware across
  all first-party monorepo packages, auditing the pinned dependency tree, and
  diffing the published npm artifact against both the installed version and the
  git source — then updating only after the user confirms the security report.
  Honors any local npm cooldown / min-release-age policy and re-applies the
  tool-renderer patch afterwards. Use when asked to "update pi", "upgrade pi",
  "update the agent", "self-update", "update pi-coding-agent", "check pi for a
  new version", or "security-review the pi update".
---

# update-pi-agent

Update pi the careful way: **review before you install.** Three threats are in
scope, and each needs its own lens:

1. **Malicious source** — a commit between two versions carries malware. Caught
   by reviewing commits across **all first-party packages** (Steps 3–5).
2. **Malicious dependency** — a transitive dep is poisoned (the classic
   supply-chain attack). Caught by auditing the pinned `npm-shrinkwrap.json`
   delta (Step 6).
3. **Published-vs-source tampering** — what npm ships differs from GitHub.
   Caught by diffing the actual artifact (Step 7).

The update is **never performed without explicit user confirmation**, even when
every check passes.

## Defaults & scope

- **Default target: pi core** — `@earendil-works/pi-coding-agent`. But pi core
  is not one package: its published `dependencies` pull sibling **first-party**
  packages from the same monorepo (e.g. `@earendil-works/pi-agent-core`,
  `pi-ai`, `pi-tui`), versioned in lockstep. **Derive this set at runtime**
  (Step 3) and review all of them — never hardcode the list, it changes.
- **Review all** (core + installed extensions) **only when the user asks.**
  **Discover the extension list dynamically with `pi list`** — never hardcode
  it. The npm-published extensions appear as `_npm:<spec>@<version>` lines;
  packages referenced by local filesystem path are out of scope (they are
  governed by this repo's own workflow, not an npm update).
- Repo: `github.com/earendil-works/pi` (monorepo). Version tags are `v<version>`.

## Hard rules

- **Never run install/lifecycle scripts during review.** Use `npm pack` /
  `npm install --ignore-scripts` in a throwaway temp dir. Never execute the
  temp-installed binary.
- **Never run `pi update` until the user has seen the report and said go.**
- **Delegate the commit review to parallel subagents** (`andrey-reviewer`).
- If any finding is `SUSPICIOUS`/`UNSAFE` and unresolved, **stop** — do not
  offer to update.
- **Review the version that will actually install, not the registry "latest".**
  See Step 1 (cooldown).

---

## Step 1 — Resolve versions under the cooldown policy

This machine may have an npm **cooldown** (`min-release-age`) enabled — a
supply-chain safeguard that refuses to install any version published more
recently than N days ago, giving freshly-published malware time to be caught
and yanked. **Lean into it:** target the version cooldown actually permits, and
treat the version's age as a positive signal.

```bash
INSTALLED=$(pi --version)                                                    # e.g. 0.79.9
REGISTRY_LATEST=$(npm view @earendil-works/pi-coding-agent version)          # ignores cooldown, e.g. 0.79.10
# The version npm/pack will ACTUALLY resolve under the cooldown policy:
TARGET=$(npm pack @earendil-works/pi-coding-agent --dry-run --json 2>/dev/null \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.parse(d)[0].version))")
echo "installed=$INSTALLED  registry_latest=$REGISTRY_LATEST  cooldown_target=$TARGET"
npm config get min-release-age 2>/dev/null   # show the active policy (null = disabled)
```

Interpret the result:

- **`TARGET` may be older than `REGISTRY_LATEST`** (and can even be ≤
  `INSTALLED`) because newer releases are still inside the quarantine window.
  This is expected and desirable.
- If `TARGET == INSTALLED` (or older): nothing newer is eligible yet. Report
  *"the newest eligible version is X; versions up to `REGISTRY_LATEST` are still
  within your N-day cooldown quarantine"* and stop, unless the user explicitly
  asks to bypass cooldown (`--min-release-age=0`) — in which case **say so
  loudly** in the report, since it removes the safeguard.
- Otherwise the review range is **`vINSTALLED..vTARGET`**.
- Report the publish age of `TARGET` (from `npm view <pkg> time --json`) — e.g.
  "target is 3 days old, satisfies your cooldown."

Locate the installed package for the on-disk diff (the `pi` launcher is a
wrapper script, **not** a symlink into the package):

```bash
PI_PKG="$(npm root -g)/@earendil-works/pi-coding-agent"
ls "$PI_PKG/package.json" "$PI_PKG/npm-shrinkwrap.json" "$PI_PKG/CHANGELOG.md"
```

## Step 2 — Read the changelog for the range

Read `CHANGELOG.md` between `v$INSTALLED` and `v$TARGET`; summarize notable
changes and flag anything touching network, auth, process spawning, or
dependencies for closer review.

```bash
sed -n '1,160p' "$PI_PKG/CHANGELOG.md"
# Or the target's copy: https://raw.githubusercontent.com/earendil-works/pi/v$TARGET/packages/coding-agent/CHANGELOG.md
```

## Step 3 — Determine the full first-party review set

pi core ships several sibling packages as ordinary dependencies. Derive the set
**from the resolved target's `package.json`** and map each to its monorepo
directory — do not assume names match paths.

```bash
WORK=$(mktemp -d /tmp/pi-update-review.XXXXXX)
# Target tarball (cooldown-resolved), no scripts run:
cd "$WORK" && npm pack "@earendil-works/pi-coding-agent@$TARGET"
mkdir -p new && tar -xzf earendil-works-pi-coding-agent-*.tgz -C new
NEW_PKG="$WORK/new/package"

# First-party deps to review (in addition to coding-agent itself):
node -e "const d=require('$NEW_PKG/package.json').dependencies||{};Object.keys(d).filter(n=>n.startsWith('@earendil-works/')).forEach(n=>console.log(n))"

# Clone repo metadata and map each first-party package name -> packages/<dir>:
git clone --filter=blob:none --no-checkout https://github.com/earendil-works/pi.git "$WORK/repo"
git -C "$WORK/repo" fetch --tags --quiet
git -C "$WORK/repo" sparse-checkout set --no-cone 'packages/*/package.json' 2>/dev/null
git -C "$WORK/repo" checkout "v$TARGET" 2>/dev/null
for f in "$WORK/repo"/packages/*/package.json; do
  [ -f "$f" ] && node -e "const p=require('$f');if(/^@earendil-works\//.test(p.name))console.log(p.name,'->','packages/'+'$f'.split('/packages/')[1].split('/')[0])"
done
# Known mapping at time of writing: pi-coding-agent->packages/coding-agent,
# pi-agent-core->packages/agent, pi-ai->packages/ai, pi-tui->packages/tui.
```

The review path set = `packages/coding-agent` **plus** the dir of every
first-party dependency above.

## Step 4 — Enumerate commits across all first-party packages

```bash
PATHS=(packages/coding-agent packages/agent packages/ai packages/tui)   # from Step 3, not hardcoded
git -C "$WORK/repo" log --oneline "v$INSTALLED..v$TARGET" -- "${PATHS[@]}"
git -C "$WORK/repo" log -p     "v$INSTALLED..v$TARGET" -- "${PATHS[@]}" > "$WORK/commits.patch"
wc -l "$WORK/commits.patch"
```

If a tag is missing (yanked/pre-release), fall back to artifact diff (Step 7)
and note the gap in the report.

## Step 5 — Review every commit for malware (parallel subagents)

Split the commit list into batches; dispatch one `andrey-reviewer` per batch
(`run_in_background=true`), collect with `get_subagent_result`. Give each the
exact commit hashes, `$WORK/commits.patch`, and this **malware checklist**:

- New/changed **network calls** (`fetch`, `http(s)`, `net`, `dgram`, DNS, WS) —
  especially to unfamiliar hosts/IPs.
- **Process/shell execution** (`child_process`, `exec`, `spawn`, backticks).
- **Env/credential/secret access** read *and* transmitted (`process.env`,
  `~/.aws`, `~/.ssh`, keychain, token files, `.npmrc`).
- **Filesystem access** outside the package's expected area.
- **Obfuscation**: `eval`, `new Function`, base64/hex blobs, dynamic `require`,
  selectively-minified source.
- **Dependency changes** in any `package.json` (new/typosquat/git-URL deps).
- **Install hooks**: added/changed `preinstall`/`install`/`postinstall`/`prepare`.
- Crypto-mining, beaconing, self-update, anti-analysis.

Each subagent returns, per commit: verdict (`SAFE`/`SUSPICIOUS`/`UNSAFE`),
indicators hit, `file:line` citations. The primary agent synthesizes one table.

## Step 6 — Audit the dependency tree (shrinkwrap delta)

pi ships a pinned **`npm-shrinkwrap.json`** (~140 packages with exact versions
and integrity hashes). The tarball carries **no `node_modules`**, so the
shrinkwrap *is* the precise, deterministic dependency attack surface — diff it
without installing anything.

```bash
# Old (installed) vs new (target) lockfile, comparing version + integrity per pkg:
node -e '
  const load=p=>Object.entries(require(p).packages||{}).reduce((m,[k,v])=>{if(k)m[k]={version:v.version,integrity:v.integrity};return m;},{});
  const a=load("'"$PI_PKG"'/npm-shrinkwrap.json"), b=load("'"$NEW_PKG"'/npm-shrinkwrap.json");
  const keys=[...new Set([...Object.keys(a),...Object.keys(b)])].sort();
  for(const k of keys){const x=a[k],y=b[k];
    if(!x) console.log("ADDED   ",k,y.version);
    else if(!y) console.log("REMOVED ",k,x.version);
    else if(x.version!==y.version) console.log("CHANGED ",k,x.version,"->",y.version);
    else if(x.integrity!==y.integrity) console.log("RETAMPER",k,y.version,"(same version, different integrity!)");
  }'
```

For every `ADDED`/`CHANGED` dependency: apply the Step 5 checklist (review its
changelog/commits or `npm pack` its tarball into the temp dir with
`--ignore-scripts` and inspect), and **scan for lifecycle scripts**:

```bash
# In a temp install of the target (scripts disabled), flag any dep with install hooks:
cd "$WORK" && npm install --prefix "$WORK/depcheck" --ignore-scripts "@earendil-works/pi-coding-agent@$TARGET" >/dev/null 2>&1
find "$WORK/depcheck/node_modules" -name package.json -maxdepth 3 -exec node -e '
  const p=require(process.argv[1]); const s=p.scripts||{};
  for(const h of ["preinstall","install","postinstall","prepare"]) if(s[h]) console.log(p.name+"@"+p.version, h+":", s[h]);
' {} \; 2>/dev/null
```

A `RETAMPER` line (same version, changed integrity) or a brand-new install hook
is high-signal — treat as `SUSPICIOUS` until explained. Prioritize **new deps**
and **first-party** packages. Cooldown (Step 1) already reduces the odds that a
changed dep version is a fresh poisoning.

## Step 7 — Diff the published artifact against installed + source

Verify what npm actually ships. Two diffs:

**A — new tarball vs the version installed on this machine** (both compiled JS;
the real line-level change you'd accept). The tarball has no `node_modules`, so
this is application code only — the dependency surface is covered by Step 6.

```bash
diff -ruq "$PI_PKG" "$NEW_PKG" --exclude=node_modules | head -200
# Drill into any changed file: diff -ru "$PI_PKG/<file>" "$NEW_PKG/<file>"
```

Confirm every changed/added application file is explained by a commit reviewed
in Step 5. Unexplained changes are a red flag.

**B — new tarball vs git source at the target tag** (compiled-vs-TS → structural
check). Confirm the file manifest, `package.json` scripts, and dependency set of
the published artifact correspond to the reviewed source:

```bash
git -C "$WORK/repo" checkout "v$TARGET" -- packages/coding-agent 2>/dev/null
diff <(cd "$NEW_PKG" && find . -type f | sort) \
     <(cd "$WORK/repo/packages/coding-agent" && find . -type f | sort) | head -100
node -e "const a=require('$NEW_PKG/package.json');console.log(JSON.stringify({scripts:a.scripts,deps:a.dependencies},null,2))"
```

Confirm: no unexpected lifecycle hooks in published `scripts`; dependency set
matches source; no extra files beyond expected build output.

## Step 8 — Produce the security report and PAUSE

Present one consolidated report and **wait for explicit confirmation**:

- Version picture: `installed → target` (+ target age), and any gap to
  `registry_latest` still held back by cooldown.
- Changelog summary.
- Commit review: count + per-commit verdict table (across all first-party pkgs).
- Dependency audit: the shrinkwrap delta + verdict on each changed/added dep +
  any lifecycle-hook findings.
- Artifact diff: Diff A summary + Diff B structural check.
- **Overall verdict: SAFE / SUSPICIOUS / UNSAFE**, and the exact command to run.

If `SAFE`, ask the user to confirm. If anything is unresolved, stop and report.

## Step 9 — Update, then verify it matches what was reviewed

```bash
pi update --self        # core only (default). Or: pi update pi
# Reviewing all: per-package gate, then  pi update --all  /  pi update --extension <source>
pi --version
```

**Cooldown-bypass guard:** confirm `pi --version` equals `$TARGET` (the version
you reviewed). If `pi update` installed something newer — e.g. it does not honor
the npm cooldown — **do not accept it**: re-run Steps 1–8 against the
newly-installed version before trusting it.

## Step 10 — Re-apply the tool-renderer patch

The renderer patch is wiped by every pi install/upgrade. After a successful
**core** update, apply the `patch-pi-tool-renderer` skill — read and follow
`.pi/skills/patch-pi-tool-renderer/SKILL.md` (source of truth; do not duplicate
its steps). It only applies to a pi core update, not extension updates.

## Step 11 — Clean up

```bash
rm -rf "$WORK"
```

---

## Notes

- Steps 1–8 are read-only on the system and never run downloaded code; nothing
  installs until Step 9 after your confirmation.
- **Cooldown is your friend.** If `min-release-age` is set, the target is
  deliberately a few days old so malicious releases have had time to surface.
  Only bypass it (`--min-release-age=0`) on explicit user instruction, and flag
  it prominently when you do.
- **Discover, don't hardcode.** First-party packages come from the target's
  `dependencies` (Step 3); extensions come from `pi list` (`_npm:` lines). Both
  lists drift over time.
- For the "review all" path, run Steps 1–8 independently per package (each has
  its own version and may have its own cooldown-resolved target), gate each
  separately, then update only the approved ones.
