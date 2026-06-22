---
name: update-pi-agent
description: >
  Safely update the pi coding agent (and optionally its extensions) by first
  reviewing the upstream changelog and every relevant commit for malware across
  all first-party monorepo packages, auditing the pinned dependency tree, and
  diffing the published npm artifact against both the installed version and the
  git source — then updating only after the user confirms the security report.
  Always reviews the latest published version (ignoring any local npm cooldown,
  since the thorough review is the safeguard) and re-applies the tool-renderer
  patch afterwards. Use when asked to "update pi", "upgrade pi",
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
- **Commit review may fan out to parallel subagents** (`andrey-reviewer`) —
  ⚗️ experimental, see Step 5; inline review by the primary agent is an
  accepted fallback.
- If any finding is `SUSPICIOUS`/`UNSAFE` and unresolved, **stop** — do not
  offer to update.
- **Always target the latest published version**, and pass `--min-release-age=0`
  to every `npm pack`/`npm install` so a local cooldown config doesn't silently
  downgrade the version you review (Step 1).

---

## Step 1 — Resolve versions (always the latest)

Target the latest published version. We deliberately **ignore any local npm
cooldown** (`min-release-age`): the thorough review below is the safeguard, and
the installed agent is rarely on the bleeding edge anyway. Note that because the
machine's npm config may set `min-release-age`, you must pass
`--min-release-age=0` to `npm pack`/`npm install` everywhere, or npm silently
resolves an older version than the one you intend to review.

```bash
INSTALLED=$(pi --version)                                           # e.g. 0.79.9
TARGET=$(npm view @earendil-works/pi-coding-agent version)          # latest, e.g. 0.79.10
echo "installed=$INSTALLED  target=$TARGET"
```

- If `TARGET == INSTALLED`: already up to date — report and stop.
- Otherwise the review range is **`vINSTALLED..vTARGET`**.

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
# Target tarball (latest; --min-release-age=0 overrides any local cooldown), no scripts run:
cd "$WORK" && npm pack "@earendil-works/pi-coding-agent@$TARGET" --min-release-age=0
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

## Step 5 — Review every commit for malware

> **⚗️ EXPERIMENTAL — parallel subagent fan-out.** Dispatching the review to
> parallel `andrey-reviewer` subagents is the *intended* approach but is **not
> yet validated**: it's unproven whether the fan-out actually improves review
> quality over a careful inline review by the primary agent, once you account for
> added latency, token cost, and lossy summarization back to the orchestrator.
> Both modes are acceptable for now. (In the run that first exercised this skill,
> the agent reviewed inline and did not fan out.)
>
> **For the next session evaluating this skill:** compare the two modes on a real
> version range on (a) catch rate / missed indicators, (b) wall-clock time,
> (c) token cost, (d) quality of the synthesized verdict table. Then either
> promote fan-out to a hard requirement, drop it, or gate it on a threshold
> (e.g. fan out only when the range exceeds N commits / M changed files). Record
> the decision here and remove this banner.

**Fan-out mode (experimental):** split the commit list into batches; dispatch one
`andrey-reviewer` per batch (`run_in_background=true`), collect with
`get_subagent_result`. **Inline mode (accepted fallback):** the primary agent
reviews `$WORK/commits.patch` directly. Either way, apply this **malware
checklist** to every commit (for fan-out, give each subagent the exact commit
hashes, `$WORK/commits.patch`, and the checklist):

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
cd "$WORK" && npm install --prefix "$WORK/depcheck" --ignore-scripts --min-release-age=0 "@earendil-works/pi-coding-agent@$TARGET" >/dev/null 2>&1
find "$WORK/depcheck/node_modules" -name package.json -maxdepth 3 -exec node -e '
  const p=require(process.argv[1]); const s=p.scripts||{};
  for(const h of ["preinstall","install","postinstall","prepare"]) if(s[h]) console.log(p.name+"@"+p.version, h+":", s[h]);
' {} \; 2>/dev/null
```

A `RETAMPER` line (same version, changed integrity) or a brand-new install hook
is high-signal — treat as `SUSPICIOUS` until explained. Prioritize **new deps**
and **first-party** packages.

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

- Version picture: `installed → target` (the latest published version).
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

**Version-match guard:** confirm `pi --version` equals `$TARGET` (the version
you reviewed). `pi update` resolves the latest itself, so if a newer version was
published between your review and the install, it may land something you never
reviewed — **do not accept it**: re-run Steps 1–8 against the newly-installed
version before trusting it.

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
- **We ignore npm cooldown by design.** The thorough review (commits + shrinkwrap
  delta + artifact diff) is the safeguard; `--min-release-age=0` is passed
  everywhere only to stop a local cooldown config from silently downgrading the
  version under review. Trade-off: you forgo the few-days window in which the
  ecosystem might independently flag a novel supply-chain compromise.
- **Discover, don't hardcode.** First-party packages come from the target's
  `dependencies` (Step 3); extensions come from `pi list` (`_npm:` lines). Both
  lists drift over time.
- For the "review all" path, run Steps 1–8 independently per package (each has
  its own version), gate each separately, then update only the approved ones.
