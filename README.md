# codex-message-schdeuler

Unofficial local scheduler for Codex CLI. Not affiliated with, endorsed by, or maintained by OpenAI.

`codex-message-schdeuler` schedules a future message to a local Codex CLI session. Users choose Codex sessions, not tmux sessions. tmux is only local execution infrastructure used when a scheduled job actually runs.

## What it does

- Lists locally discoverable Codex sessions
- Lets you choose a session, create a new one, or enter one manually
- Lets you schedule by custom local time, 5-hour reset, or weekly reset
- Stores scheduled jobs locally
- On macOS, arms a one-shot launchd timer for the exact next pending job
- At due time, resumes Codex inside tmux, injects the message, verifies submission, and writes logs

## Why it exists

Codex CLI is good at active work, but it does not natively provide a simple “send this exact message to this exact session later” flow. This tool fills that gap with a local scheduler and a session-first terminal UI.

## Disclaimer

- This package is unofficial.
- It uses the term “Codex CLI” descriptively to refer to the local CLI tool.
- It does not use OpenAI branding, logos, or claim official support.

## Requirements

- Node.js `>=18.17.0`
- Codex CLI installed and already authenticated locally
- `tmux` installed locally
- macOS for automatic one-shot launchd scheduling

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
codex-message-schdeuler jobs
codex-message-schdeuler cancel <jobId>
codex-message-schdeuler doctor
```

Typical flow:

1. Run `codex-message-schdeuler`.
2. Choose whether you mainly use Codex CLI or Codex app sessions.
3. Pick a discovered session, create a new session, or enter one manually.
4. Choose one of:
   - `Send at custom time`
   - `Send when my 5-hour limit resets`
   - `Send when my weekly limit resets`
5. If you choose custom time, enter a local future time such as `05:01 pm`.
6. If you choose a reset mode, the tool resumes the selected session in hidden tmux, runs `/status`, parses the reset time, and asks you to confirm it.
7. Enter the message.
8. Confirm the job.

Example reset-based flow:

```text
codex-message-schdeuler

Choose:
Send when my 5-hour limit resets

Then enter:
continue the refactor and run tests
```

## User-facing model

The user interacts with Codex sessions, not tmux sessions.

- Session discovery is best-effort from local Codex metadata.
- tmux is never the primary user-facing abstraction.
- tmux exists only so the scheduler can resume Codex in a detached terminal and inject the message later.

## How it works

End-to-end architecture:

1. Session discovery
2. Local job storage
3. Optional Codex CLI `/status` usage capture for reset-based scheduling
4. One-shot launchd scheduling on macOS
5. `run-due` at the exact next due time
6. tmux-hosted `codex resume`
7. Message injection and submission verification
8. Per-job logs and status updates

Detailed runtime path:

1. The interactive CLI discovers sessions from `~/.codex/sessions/**/*.jsonl`.
2. If you choose a reset-based schedule mode, the tool resumes the selected session in hidden tmux, sends `/status`, captures the pane output, and parses reset times locally.
3. A scheduled job is stored locally in JSON.
4. The daemon service finds the earliest pending job.
5. On macOS it writes a one-shot launchd plist with `StartCalendarInterval`.
6. launchd invokes `codex-message-schdeuler run-due` only when that next job is due.
7. `run-due` executes all pending jobs whose `scheduledAt <= now`.
8. Each due job creates a detached tmux session, runs `codex resume`, injects the message, and checks that the draft prompt actually cleared.
9. After execution, launchd is re-armed for the next future pending job, or fully disarmed if none remain.

Reset-based scheduling notes:

- Reset times come from Codex CLI `/status`.
- The tool does not call undocumented web APIs.
- The tool does not scrape chatgpt.com.
- If Codex says limits may be stale, the CLI warns you and lets you continue or fall back to custom time.

## Efficient macOS daemon behavior

`codex-message-schdeuler` does not keep an always-running background daemon on macOS.

Instead:

- No worker polls every minute by default.
- launchd is armed only for the next pending job.
- When there are no pending jobs, launchd is disarmed and no background worker remains active.

Manual fallback always remains available:

```bash
codex-message-schdeuler run-due
```

## Commands

```bash
codex-message-schdeuler
codex-message-schdeuler schedule
codex-message-schdeuler jobs
codex-message-schdeuler cancel <jobId>
codex-message-schdeuler run-due
codex-message-schdeuler doctor
codex-message-schdeuler doctor --status-check
codex-message-schdeuler install-daemon
```

Command notes:

- `schedule`: interactive flow
- `jobs`: list stored jobs
- `cancel <jobId>`: cancel a pending job
- `run-due`: run all due jobs now and refresh scheduling
- `doctor`: inspect local dependencies, storage, next pending job, and launchd status
- `doctor --status-check`: explicitly run Codex `/status` against a real session to verify reset-based scheduling
- `install-daemon`: refresh one-shot macOS launchd scheduling for the next pending job

## Storage locations

Default storage remains:

```text
~/.codex-scheduler/
```

This is intentionally preserved for backward compatibility with existing local users. The package name changed, but the default storage path did not.

Environment overrides:

- `CODEX_TMUX_SCHEDULER_HOME`
- `CODEX_SCHEDULER_HOME`

Stored files:

- `~/.codex-scheduler/jobs.json`
- `~/.codex-scheduler/config.json`
- `~/.codex-scheduler/logs/<jobId>.log`
- `~/.codex-scheduler/runtime.log`
- `~/.codex-scheduler/launchd.stdout.log`
- `~/.codex-scheduler/launchd.stderr.log`

## Security and privacy

- No Codex auth tokens are stored by this tool.
- No prompts or scheduled messages are uploaded anywhere by this tool.
- Reset-based scheduling uses local Codex CLI `/status` output only.
- No undocumented web APIs are called.
- No chatgpt.com scraping is performed.
- No telemetry, analytics, crash reporting, or hidden network calls are implemented.
- Scheduled messages stay local on disk in the app data directory.
- tmux execution is local only.
- Session discovery is local only and uses best-effort local Codex metadata.
- The package does not sync data to any cloud service.
- Do not schedule secrets unless you are comfortable storing them locally.

## Safety review summary

Publish-safety audit findings:

- No token storage logic is present.
- No HTTP client, fetch-based API call, telemetry SDK, or external reporting path is present.
- Session discovery does not hardcode one private machine path; it uses the current user home directory and Codex metadata paths.
- The worker uses `spawn` / argument arrays rather than shell interpolation for tmux and launchctl execution.
- tmux and Codex commands are executed locally only.
- Published files are allowlisted through `package.json#files`.

Remaining caution:

- This tool stores scheduled message content in plain text locally by design.
- It depends on Codex CLI and terminal UI behavior, which may change over time.

## launchd naming and migration

Current launchd label:

- `com.codex-message-schdeuler.agent`

Legacy migration:

- Older versions used `com.codex.scheduler`
- Older polling builds used `StartInterval=60`
- Current versions detect and replace the old polling plist on `schedule`, `doctor`, `install-daemon`, or `run-due`

## Limitations

- Session discovery is best-effort and depends on local Codex metadata layout.
- Reset-based scheduling depends on Codex CLI `/status` output remaining parseable.
- Codex may report that limits are stale, and those reset times may lag briefly.
- Codex UI readiness detection is heuristic.
- tmux and terminal UI submission behavior can still be sensitive to upstream CLI changes.
- macOS one-shot launchd scheduling is the primary automatic background mode.
- Other operating systems may need manual `run-due` usage or an external scheduler.
- launchd timing is minute-resolution because `StartCalendarInterval` is minute-based.

## Troubleshooting

### tmux not found

- Run `codex-message-schdeuler doctor`
- Ensure `tmux` is installed
- Refresh launchd after install:

```bash
codex-message-schdeuler install-daemon
```

### codex not found

- Ensure the Codex CLI is installed and available locally
- If you installed it through a version manager, rerun:

```bash
codex-message-schdeuler install-daemon
```

### no sessions found

- Use manual session entry
- Or choose `Create new session`
- Session discovery is best-effort from local Codex transcript files

### reset time could not be parsed

- Retry after running `/status` manually in Codex once
- Use `codex-message-schdeuler doctor --status-check` for an explicit live verification
- Fall back to custom time if Codex changes its `/status` format

### launchd not armed

- Run:

```bash
codex-message-schdeuler doctor
codex-message-schdeuler install-daemon
```

- If there are no pending jobs, launchd should be disarmed by design

### message appears in draft but did not submit

- Inspect the per-job log:

```bash
cat ~/.codex-scheduler/logs/<jobId>.log
```

- The job will fail rather than falsely report success if the active prompt still contains the unsent draft

### permission or path issues

- Confirm the app data directory is writable
- Check:

```bash
cat ~/.codex-scheduler/runtime.log
cat ~/.codex-scheduler/launchd.stderr.log
```

## Development

```bash
npm install
npm run build
npm run typecheck
npm test
```

## Publishing checklist

- Confirm package name and bin names are correct
- Run `npm run build`
- Run `npm run typecheck`
- Run `npm test`
- Run `npm pack --dry-run`
- Verify only `dist`, `README.md`, and `LICENSE` are published
- Verify no local logs, configs, or machine-specific artifacts are included

## Credits

Thanks to the major packages this tool builds on:

- TypeScript
- Commander
- `@inquirer/prompts`
- chalk
- ora
- boxen
- `cli-table3`
- chrono-node
- date-fns
- Vitest
- tsx

## License

MIT
