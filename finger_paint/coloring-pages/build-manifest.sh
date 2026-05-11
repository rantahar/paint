#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# build-manifest.sh
#
# Regenerate coloring-pages/manifest.json from the files in this
# folder. The runtime tries the manifest FIRST and falls back to
# HTML directory autoindex (which never works on GitHub Pages, S3,
# Netlify, Vercel, or any other static-CDN host) — so for any
# production deployment the manifest is required.
#
# Usage:
#   ./build-manifest.sh
#
# Optional: if pdftoppm is installed (poppler-utils on Linux, brew
# install poppler on macOS), multi-page PDFs in this folder are
# rasterised to one PNG per page at 150 DPI before the manifest is
# written. Otherwise PDFs are skipped with a warning.
# ─────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

shopt -s nullglob nocaseglob

# Optional PDF → PNG conversion
for pdf in *.pdf; do
  if command -v pdftoppm >/dev/null 2>&1; then
    base="${pdf%.*}"
    echo "converting $pdf → ${base}-N.png"
    pdftoppm -r 150 -png "$pdf" "$base"
  else
    echo "warning: $pdf present but pdftoppm not installed; skipping conversion" >&2
  fi
done

# Collect image files
pages=()
for f in *.png *.jpg *.jpeg *.gif *.webp *.svg; do
  [ -e "$f" ] || continue
  name_base="${f%.*}"
  pretty=$(echo "$name_base" \
    | sed -E 's/[-_]+/ /g' \
    | sed -E 's/(^| )([a-z])/\1\u\2/g')
  pages+=("    { \"file\": \"$f\", \"name\": \"$pretty\" }")
done

# Write manifest.json (deterministically sorted file order matches `*` glob)
{
  echo "{"
  echo "  \"pages\": ["
  if [ "${#pages[@]}" -gt 0 ]; then
    # Join with ",\n"
    sep=""
    for line in "${pages[@]}"; do
      printf "%s%s" "$sep" "$line"
      sep=$',\n'
    done
    printf "\n"
  fi
  echo "  ]"
  echo "}"
} > manifest.json

echo "wrote $(pwd)/manifest.json with ${#pages[@]} page(s)"
