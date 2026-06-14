#!/usr/bin/env bash
# Create a new essay from a title, with the frontmatter pre-filled.
# Usage:  ./new-post.sh "Why Scientists Embrace Being Wrong"
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "Usage: ./new-post.sh \"Your Essay Title\""
  exit 1
fi

TITLE="$*"
# slug: lowercase, spaces -> hyphens, strip anything that isn't a-z/0-9/hyphen, collapse hyphens
SLUG=$(echo "$TITLE" \
  | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
DIR="$(cd "$(dirname "$0")" && pwd)"
FILE="$DIR/writing/$SLUG.qmd"
TODAY=$(date +%Y-%m-%d)

if [ -e "$FILE" ]; then
  echo "✋ $FILE already exists — pick a different title or edit that file."
  exit 1
fi

cat > "$FILE" <<EOF
---
title: "$TITLE"
description: ""                     # one sentence for Google / social previews
date: $TODAY
categories: []                      # lowercase tags, e.g. [biosecurity, voice]
---

::: {.dropcap}
Start writing here. The first letter becomes a large raised cap.
:::

EOF

echo "✅ Created writing/$SLUG.qmd  (dated $TODAY)"
echo "   Opening it in VS Code and starting a live preview..."
# open in VS Code if available
command -v code >/dev/null 2>&1 && code "$FILE" || true
echo ""
echo "   Live preview:  quarto preview   (auto-reloads as you save)"
echo "   When done, fill in the description + categories, then tell Claude to render & review."
