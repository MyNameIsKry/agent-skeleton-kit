#!/usr/bin/env bash
# PreToolUse guard: block writes that make packages/core/src/{domain,application}
# import infrastructure code or forbidden third-party packages.
# Reads the tool-call JSON on stdin. Fails open (exit 0) when it cannot tell.
# Exit 2 blocks the tool call and forwards stderr to the agent.

input="$(cat)"

# Extract the target path from the tool input (keys: path, file_path, filePath).
target="$(printf '%s' "$input" \
  | grep -Eo '"(path|file_path|filePath)"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -n1 \
  | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/')"

case "$target" in
  *packages/core/src/domain/*|*packages/core/src/application/*) ;;
  *) exit 0 ;;
esac

# In JSON, quotes inside file content appear as \" so allow an optional backslash.
forbidden_pkgs='from[[:space:]]+\\?.(mongodb|bullmq|ioredis|redis|fastify|openai|pino)(/[^"\\]*)?\\?.'
infra_import='from[[:space:]]+\\?.[./]+(/)?(infrastructure|interfaces)(/|\\?.)'

if printf '%s' "$input" | grep -Eq "$forbidden_pkgs|$infra_import"; then
  {
    echo "Blocked: architecture boundary violation in $target."
    echo "domain/ and application/ must not import mongodb, bullmq, ioredis, redis, fastify, openai SDKs, pino, or anything from infrastructure/ or interfaces/."
    echo "Depend on a port from domain/ports.ts and wire the adapter in main.api.ts or main.worker.ts."
    echo "See .kiro/steering/architecture-boundaries.md."
  } >&2
  exit 2
fi

exit 0
