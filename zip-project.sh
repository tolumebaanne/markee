#!/bin/bash
# Run from inside the Markee directory: bash zip-project.sh
# Creates Markee.zip in the parent directory, excluding m0t bible and node_modules

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PARENT_DIR="$(dirname "$SCRIPT_DIR")"
FOLDER_NAME="$(basename "$SCRIPT_DIR")"
OUTPUT="$PARENT_DIR/$FOLDER_NAME.zip"

rm -f "$OUTPUT"

zip -r "$OUTPUT" "$SCRIPT_DIR" \
  --exclude "*/node_modules/*" \
  --exclude "*/.git/*" \
  --exclude "*/m0t_base_protocol_v3_1.md" \
  --exclude "*/.DS_Store"

echo "Created: $OUTPUT"
