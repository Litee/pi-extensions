# pi-ponytail

Ponytail — the lazy senior dev — as a pi extension and skill set.

**He says nothing. He writes one line. It works.**

## What it does

Ponytail injects a "lazy senior developer" persona into every agent turn. Before writing code, the agent stops at the first rung that holds:

1. Does this need to exist? → no: skip it (YAGNI)
2. Stdlib does it? → use it
3. Native platform feature? → use it
4. Installed dependency? → use it
5. One line? → one line
6. Only then: the minimum that works

## Extension commands

| Command | Description |
|---------|-------------|
| `/ponytail` | Set or report current mode (lite/full/ultra) |
| `/ponytail lite` | Lightest mode: build what's asked, name lazier alternative |
| `/ponytail ultra` | YAGNI extremist: deletion before addition |
| `/ponytail off` | Disable ponytail for this session |
| `/ponytail-review` | Run over-engineering review skill |
| `/ponytail-audit` | Run whole-repo audit skill |
| `/ponytail-debt` | List deferred shortcuts as a debt ledger |
| `/ponytail-gain` | Show measured-impact scoreboard |
| `/ponytail-help` | Quick-reference card |

## Skills

| Skill | Description |
|-------|-------------|
| **ponytail** | Core mode: forces simplest solution that works |
| **ponytail-review** | Over-engineering review: find what to delete |
| **ponytail-audit** | Whole-repo audit for bloat and over-engineering |
| **ponytail-debt** | Harvest `ponytail:` comments into a debt ledger |
| **ponytail-gain** | Measured-impact scoreboard |
| **ponytail-help** | Quick-reference card |

## Configuration

Default mode is `full` (auto-active every session). Change it:

- **Environment variable** (highest priority): `PONYTAIL_DEFAULT_MODE=ultra`
- **Config file**: `~/.config/ponytail/config.json` with `{"defaultMode": "lite"}`
- **Command**: `/ponytail default lite`

Resolution: env var > config file > `full`.

## Differences from upstream

- Hook files renamed from `.js` to `.cjs` (`ponytail-config.cjs`, `ponytail-instructions.cjs`, `ponytail-mode-tracker.cjs`, `ponytail-runtime.cjs`, `ponytail-activate.cjs`). The upstream repo has `"type": "module"` in `pi-extension/package.json` but the hooks use `require`/`module.exports`. In this monorepo, the `.cjs` extension is needed so Node treats them as CommonJS.
- `test/helpers.test.js` relative URL for the skill file adjusted from `../../skills/ponytail/SKILL.md` to `../skills/ponytail/SKILL.md` (directory layout differs from upstream).

## Upstream

Full project: https://github.com/DietrichGebert/ponytail
