# pi-aws-ec2-watcher

> Pi extension that watches an AWS EC2 instance by ID for state transitions,
> injecting state-change notifications into chat.

## Features

- **Real-time state monitoring** — polls DescribeInstances at 60-second intervals
  (backs off to 10 minutes when idle)
- **Smart terminal detection** — `terminated` always stops the watch; `stopped`
  optionally stops it (`stopOnStopped`)
- **Transient state visibility** — emits notifications for `pending`, `stopping`,
  `shutting-down` transitions without marking the watch terminal
- **not_found detection** — immediately marks terminal when the instance vanishes
- **Optional timeout** — cap any watch at up to 72 hours
- **TUI widget** — live panel below the editor showing instance IDs, states, and
  time remaining; switchable to compact status-line
- **Interactive `/ec2-watcher` menu** — pause, resume, browse, and configure
  display mode without an LLM round-trip

## Quick start

```ts
// Activate the tool (one-time per session)
manage_tools({ action: "activate", tools: ["ec2_instance_watcher"] })

// Watch an instance until terminated
ec2_instance_watcher({
  action: "add",
  instanceId: "i-0a1b2c3d4e5f67890",
  profile: "my-aws-profile",
  region: "us-east-1",
})
```

## Installation

This package is part of the `pi-extensions` monorepo. It is loaded automatically
by pi if listed in your `pi.json` extensions.

## Skill

The `skills/aws-ec2-watcher/` directory contains a SKILL.md that teaches
pi coding agents how to use this extension.

## Development

```bash
# Run tests
npx vitest run packages/pi-aws-ec2-watcher/

# Type-check
npx tsc --noEmit

# Full suite
npm run check
```

## Package structure

```
src/
  index.ts          Extension entrypoint
  types.ts          Shared TypeScript types
  instanceId.ts     Instance ID validation
  ec2-client.ts     AWS SDK v3 client wrapper
  poller.ts         Change-detection logic (pure)
  runtime.ts        Poll-loop control + runtime state
  toolAction.ts     Tool parameter handling
  persistence.ts    Session-log serialisation
  format.ts         Chat-message formatters
  config.ts         User-level config (~/.pi/agent/*.json)
  command.ts        /ec2-watcher TUI menu
  ui/
    ec2-widget.ts   Widget shell (TUI, excluded from coverage)
    watches-view.ts Watches overlay (TUI, excluded from coverage)
    widgetRows.ts   Pure row builder for the widget
    watchesModel.ts Pure display-row model for the overlay
    watchesKeys.ts  Pure key dispatch for the overlay
```
