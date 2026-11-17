#!/usr/bin/env bash
# PreToolUse guard: the .kiro directory must stay tracked (hackathon requirement).
# Blocks edits to a .gitignore file whose content mentions .kiro.
# Reads the tool-call JSON on stdin. Fails open (exit 0) when it cannot tell.

input="$(cat)"

target="$(printf '%s' "$input" \
  | grep -Eo '"(path|file_path|filePath)"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -n1 \
  | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/')"

case "$target" in
  *.gitignore) ;;
  *) exit 0 ;;
esac

if printf '%s' "$input" | grep -Eq '(^|[^A-Za-z0-9_])\.kiro([^A-Za-z0-9_]|$)|\.kiro/?'; then
  {
    echo "Blocked: $target references .kiro."
    echo "The .kiro/ directory (steering, specs, hooks) must stay tracked in git and must not be ignored."
    echo "See .kiro/steering/product.md and .kiro/steering/submission-checklist.md."
  } >&2
  exit 2
fi

exit 0
