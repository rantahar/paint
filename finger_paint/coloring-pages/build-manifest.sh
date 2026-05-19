#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# build-manifest.sh
#
# Regenerate coloring-pages/manifest.json from processed images.
#
# Pipeline:
#   source/
#     ├─ *.pdf     → pdftoppm → *.png (if pdftoppm available)
#     ├─ *.png     → ImageMagick convert (greyscale, trim, resize)
#     └─ *.svg     → copy unchanged
#   ↓
#   processed/
#     └─ *.png, *.svg
#   ↓
#   manifest.json
#
# The runtime tries the manifest FIRST and falls back to HTML
# directory autoindex (which never works on GitHub Pages, S3,
# Netlify, Vercel, or any other static-CDN host) — so for any
# production deployment the manifest is required.
#
# Usage:
#   ./build-manifest.sh
# ─────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

shopt -s nullglob nocaseglob

# Ensure directories exist
mkdir -p source processed

# Optional PDF → PNG conversion (output to source/)
for pdf in source/*.pdf; do
  [ -e "$pdf" ] || continue
  if command -v pdftoppm >/dev/null 2>&1; then
    base="${pdf%.*}"
    base_name=$(basename "$base")
    echo "converting $pdf → source/${base_name}-N.png"
    pdftoppm -r 150 -png "$pdf" "source/$base_name"
  else
    echo "warning: $pdf present but pdftoppm not installed; skipping conversion" >&2
  fi
done

# Process PNGs: greyscale, trim whitespace, resize to max 1000px width
echo "Processing PNGs (greyscale, trim, resize)..."

# Try to find ImageMagick magick/convert
MAGICK_CMD=""
if [ -f "/p/ImageMagick/magick.exe" ]; then
  MAGICK_CMD="/p/ImageMagick/magick.exe"
elif command -v magick >/dev/null 2>&1; then
  MAGICK_CMD="magick"
elif command -v convert >/dev/null 2>&1 && ! [ -x "/c/WINDOWS/system32/convert" ]; then
  MAGICK_CMD="convert"
fi

for png in source/*.png; do
  [ -e "$png" ] || continue
  filename=$(basename "$png")
  # Custom overlay companions (<base>_overlay.png) are passed through unchanged
  # below — skip them here so the artist's alpha isn't squashed.
  case "$filename" in
    *_overlay.png) continue ;;
  esac
  output="processed/$filename"

  if [ -n "$MAGICK_CMD" ]; then
    echo "  $filename"
    # Greyscale + trim + resize, then luminance → alpha.
    # Algorithm: alpha = 255 - luma, RGB forced to black.
    #   1. -negate       inverts grey channel (black src → white, white src → black)
    #   2. -alpha copy   copies the inverted intensity into a new alpha channel
    #   3. -fill black -colorize 100   forces RGB to black, leaves alpha intact
    # Result: black lines opaque, white paper transparent, anti-aliased greys
    # become semi-transparent BLACK (not grey-on-bg) over the runtime bg color.
    #
    # We deliberately do NOT use `-alpha set ( +clone -negate )` — `-negate`
    # touches the alpha channel when one is present, which flips alpha=255 → 0
    # and produces an entirely transparent output.
    "$MAGICK_CMD" "$png" \
      -colorspace Gray \
      -trim \
      -resize '1000x>' \
      -negate \
      -alpha copy \
      -fill black -colorize 100 \
      -depth 8 \
      "$output"
  else
    echo "warning: ImageMagick not installed; skipping processing" >&2
    # Fallback: copy unprocessed (runtime luminance-to-alpha will still kick in).
    cp "$png" "$output"
  fi
done

# Copy custom overlay PNGs unchanged (artist controls the alpha)
echo "Copying overlay companions..."
for png in source/*_overlay.png; do
  [ -e "$png" ] || continue
  filename=$(basename "$png")
  cp "$png" "processed/$filename"
  echo "  $filename"
done

# Copy SVGs unchanged
echo "Copying SVGs..."
for svg in source/*.svg; do
  [ -e "$svg" ] || continue
  filename=$(basename "$svg")
  cp "$svg" "processed/$filename"
  echo "  $filename"
done

# Collect image files from processed/ for manifest. Overlay companions
# (<base>_overlay.<ext>) are paired with their base entry rather than listed
# as standalone pages.
pages=()
for f in processed/*.png processed/*.jpg processed/*.jpeg processed/*.gif processed/*.webp processed/*.svg; do
  [ -e "$f" ] || continue
  filename=$(basename "$f")
  case "$filename" in
    *_overlay.*) continue ;;
  esac
  name_base="${filename%.*}"
  ext="${filename##*.}"
  pretty=$(echo "$name_base" \
    | sed -E 's/[-_]+/ /g' \
    | sed -E 's/(^| )([a-z])/\1\u\2/g')
  overlay_name="${name_base}_overlay.${ext}"
  if [ -e "processed/$overlay_name" ]; then
    pages+=("    { \"file\": \"processed/$filename\", \"name\": \"$pretty\", \"overlay\": \"processed/$overlay_name\" }")
  else
    pages+=("    { \"file\": \"processed/$filename\", \"name\": \"$pretty\" }")
  fi
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
