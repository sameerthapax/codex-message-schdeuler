# codex-message-schdeuler

Unofficial local scheduler for Codex CLI. Not affiliated with, endorsed by, or maintained by OpenAI.

`codex-message-schdeuler` lets you schedule messages for local Codex sessions, or keep a session warm with recurring looped `hi` messages. Users choose Codex sessions, not tmux sessions. tmux is only local execution infrastructure used when a scheduled job actually runs.

## What it does

- Lists locally discoverable Codex sessions
- Lets you choose a session, create a new one, or enter one manually
- Supports one-time scheduling and recurring loops
- Supports custom local times and Codex 5-hour reset based starts
- Stores jobs and loops locally
- Uses one-shot automatic scheduling on macOS and Windows
- Resumes Codex in tmux only when a job is actually due

## Disclaimer

- This package is unofficial.
- It uses the term “Codex CLI” descriptively to refer to the local CLI tool.
- It does not use OpenAI branding, logos, or claim official support.

## Requirements

- Node.js `>=18.17.0`
- Codex CLI installed and already authenticated locally
- `tmux` installed locally
- macOS for automatic one-shot `launchd` scheduling
- Windows for automatic one-shot Task Scheduler scheduling
- Linux currently requires manual `run-due` or an external scheduler

## Installation

```bash
npm install -g codex-message-schdeuler
codex-message-schdeuler
```

Compatibility note:

- `codex-message-schdeuler` is the primary binary.
- `codex-tmux-scheduler` and `codex-scheduler` are still shipped as compatibility aliases for existing users.

## Quick start

```bash
codex-message-schdeuler
codex-message-schdeuler schedule
codex-message-schdeuler loop
codex-message-schdeuler loops
codex-message-schdeuler jobs
codex-message-schdeuler cancel <jobId>
codex-message-schdeuler cancel-loop <loopId>
codex-message-schdeuler doctor
```

## Main flow

When you run:

```bash
codex-message-schdeuler
```

the CLI flow is:

1. Choose whether you mainly use Codex CLI or Codex app sessions.
2. Select a discovered session, create a new session, or enter one manually.
3. Choose:
   - `One time schedule`
   - `Re run this schedule in a loop (keep session alive)`

### One-time schedule flow

1. Choose:
   - `Send at custom time`
   - `Send when my 5-hour limit resets`
   - `Send when my weekly limit resets`
2. If you choose custom time, enter a local future time such as `05:01 pm`.
3. If you choose a reset mode, the tool resumes the selected session in hidden tmux, runs `/status`, parses the reset time, and asks you to confirm it.
4. Enter the message.
5. Confirm the job.

### Loop flow

1. Choose loop cadence:
   - `Every 5 hours`
   - `Daily`
   - `Weekly`
2. Choose the first loop run timing:
   - `Send at custom time`
   - `Send when my 5-hour limit resets`
3. Loop messages are always `hi`.
4. The loop keeps exactly two future pending loop jobs queued automatically.

Important loop rule:

- If you start a loop from the 5-hour reset option, the tool uses only the reset time-of-day, not the full reset date.
- That keeps the loop anchored to a recurring time instead of inheriting a one-off date from `/status`.

## Reset-based scheduling

Reset-based scheduling uses Codex CLI `/status`.

- It does not call undocumented web APIs.
- It does not scrape chatgpt.com.
- It does not store auth tokens.
- If Codex says limits may be stale, the CLI warns you and lets you continue or fall back to custom time.

Example `/status`-based use:

```text
codex-message-schdeuler

Choose:
One time schedule

Then:
Send when my 5-hour limit resets
```

## How it works

End-to-end:

1. Session discovery
2. Local job or loop storage
3. Optional Codex CLI `/status` capture for reset-based timing
4. Loop expansion into future `hi` jobs when loops are active
5. One-shot OS scheduler arms for the next pending job
6. `run-due` executes due jobs
7. tmux-hosted `codex resume`
8. Message injection and submission verification
9. Logs and status updates

Runtime path:

1. The interactive CLI discovers sessions from local Codex metadata.
2. If reset timing is chosen, the tool resumes the selected session in hidden tmux, sends `/status`, captures the pane output, and parses reset times locally.
3. A one-time job or loop definition is stored locally in JSON.
4. Active loops keep exactly two future pending loop jobs queued, each sending `hi`.
5. The scheduler backend finds the earliest pending job.
6. On macOS it writes a one-shot `launchd` plist. On Windows it creates a one-shot Task Scheduler entry.
7. The OS scheduler invokes `codex-message-schdeuler run-due` only when that next job is due.
8. `run-due` executes all pending jobs whose `scheduledAt <= now`.
9. After due jobs run, active loops are replenished back to two future jobs.
10. Each due job creates a detached tmux session, runs `codex resume`, injects the message, and verifies that the prompt actually advanced.

## Automatic scheduling

`codex-message-schdeuler` does not keep an always-running background worker on supported operating systems.

Instead:

- No worker polls every minute by default.
- The OS scheduler is armed only for the next pending job.
- When there are no pending jobs, the scheduled entry is removed.

Automatic scheduler backends:

- macOS: one-shot `launchd`
- Windows: one-shot Task Scheduler
- Linux: currently manual `run-due` or external scheduler only

Manual fallback always remains available:

```bash
codex-message-schdeuler run-due
```

## Commands

```bash
codex-message-schdeuler
codex-message-schdeuler schedule
codex-message-schdeuler loop
codex-message-schdeuler loops
codex-message-schdeuler jobs
codex-message-schdeuler cancel <jobId>
codex-message-schdeuler cancel-loop <loopId>
codex-message-schdeuler run-due
codex-message-schdeuler doctor
codex-message-schdeuler doctor --status-check
codex-message-schdeuler install-daemon
```

Command notes:

- `schedule`: open the interactive scheduling flow
- `loop`: directly create a recurring `hi` loop
- `loops`: list configured loops
- `jobs`: list stored jobs
- `cancel <jobId>`: cancel a pending job
- `cancel-loop <loopId>`: cancel a loop and its pending generated jobs
- `run-due`: run all due jobs now and refresh automatic scheduling
- `doctor`: inspect dependencies, storage, next pending job, and scheduler backend status
- `doctor --status-check`: explicitly run Codex `/status` against a real session
- `install-daemon`: refresh one-shot automatic scheduling for the next pending job

## Storage locations

Default storage:

```text
~/.codex-message-scheduler/
```

Compatibility behavior:

- New installs default to `~/.codex-message-scheduler/`
- If an existing `~/.codex-scheduler/` directory exists and the new directory does not yet exist, the CLI continues using the legacy directory automatically

Environment overrides:

- `CODEX_MESSAGE_SCHEDULER_HOME`
- `CODEX_TMUX_SCHEDULER_HOME`
- `CODEX_SCHEDULER_HOME`

Stored files:

- `~/.codex-message-scheduler/jobs.json`
- `~/.codex-message-scheduler/loops.json`
- `~/.codex-message-scheduler/config.json`
- `~/.codex-message-scheduler/logs/<jobId>.log`
- `~/.codex-message-scheduler/runtime.log`
- `~/.codex-message-scheduler/launchd.stdout.log`
- `~/.codex-message-scheduler/launchd.stderr.log`

## Security and privacy

- No Codex auth tokens are stored by this tool.
- No prompts or scheduled messages are uploaded anywhere by this tool.
- Reset-based scheduling uses local Codex CLI `/status` output only.
- No undocumented web APIs are called.
- No chatgpt.com scraping is performed.
- No telemetry, analytics, crash reporting, or hidden network calls are implemented.
- Scheduled messages and loop metadata stay local on disk.
- tmux execution is local only.
- Session discovery is local only and uses best-effort local Codex metadata.
- Do not schedule secrets unless you are comfortable storing them locally.

## Limitations

- Session discovery is best-effort and depends on local Codex metadata layout.
- Reset-based scheduling depends on Codex CLI `/status` remaining parseable.
- tmux is required for execution and `/status` capture.
- Native Windows still depends on having a tmux-capable environment.
- Linux automatic one-shot scheduling is not implemented yet.
- Codex UI readiness detection and prompt submission are still heuristic because they depend on upstream terminal behavior.

## Troubleshooting

### Missing dependencies on first run

- The CLI now blocks normal interactive use if required runtime dependencies are missing.
- Run:

```bash
codex-message-schdeuler doctor
```

### tmux not found

- Install `tmux`
- On Windows, this usually means using WSL or another Unix-like environment

### codex not found

- Ensure the Codex CLI is installed and available on `PATH`

### reset time could not be parsed

- Retry after running `/status` manually in Codex once
- Use:

```bash
codex-message-schdeuler doctor --status-check
```

- Fall back to custom time if Codex changes its `/status` format

### launchd or Task Scheduler is not armed

- Run:

```bash
codex-message-schdeuler install-daemon
codex-message-schdeuler doctor
```

### inspect logs

```bash
cat ~/.codex-message-scheduler/runtime.log
cat ~/.codex-message-scheduler/logs/<jobId>.log
```

## Development

```bash
npm install
npm run build
npm run typecheck
npm test
```

## License

MIT
