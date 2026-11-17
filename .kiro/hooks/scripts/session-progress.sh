#!/usr/bin/env bash
# SessionStart hook: print spec progress so the agent starts with context.
# stdout is forwarded to the agent. Always exits 0.

root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
tasks="$root/.kiro/specs/core-skeleton/tasks.md"

[ -f "$tasks" ] || exit 0

done_count="$(grep -Ec '^[[:space:]]*- \[x\]' "$tasks")"
open_count="$(grep -Ec '^[[:space:]]*- \[ \]' "$tasks")"
# First open sub-task (indented), not the top-level parent line.
next_task="$(grep -E '^[[:space:]]+- \[ \]' "$tasks" | head -n1 | sed -E 's/^[[:space:]]*- \[ \][[:space:]]*//')"

echo "agent-skeleton-kit progress (core-skeleton spec): ${done_count} done, ${open_count} open."
[ -n "$next_task" ] && echo "Next open task: ${next_task}"
echo "Rules: .kiro/steering/ (tenant isolation and architecture boundaries are mandatory). Never edit packages/core while building a tenant."
exit 0
