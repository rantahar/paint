#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# build-manifest.sh
#
# Regenerate coloring-pages manifests from organized book structure.
#
# Directory structure:
#   books/
#     ├─ {book-name}/
#     │   ├─ source/
#     │   │   ├─ *.pdf     → pdftoppm → *.png (if pdftoppm available)
#     │   │   ├─ *.png     → ImageMagick convert (greyscale, trim, resize)
#     │   │   └─ *.svg     → copy unchanged
#     │   └─ processed/
#     │       └─ *.png, *.svg
#     └─ ...
#   ↓
#   books/{book-name}/manifest.json (per-book manifest)
#   manifest.json (top-level index of all books)
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

# Try to find ImageMagick magick/convert
MAGICK_CMD=""
if [ -f "/p/ImageMagick/magick.exe" ]; then
  MAGICK_CMD="/p/ImageMagick/magick.exe"
elif command -v magick >/dev/null 2>&1; then
  MAGICK_CMD="magick"
elif command -v convert >/dev/null 2>&1 && ! [ -x "/c/WINDOWS/system32/convert" ]; then
  MAGICK_CMD="convert"
fi

# Process a single book
process_book() {
  local book_dir="$1"
  local book_name=$(basename "$book_dir")

  echo "Processing book: $book_name"

  # Ensure directories exist
  mkdir -p "$book_dir/source" "$book_dir/processed"

  # Optional PDF → PNG conversion (output to source/)
  for pdf in "$book_dir/source"/*.pdf; do
    [ -e "$pdf" ] || continue
    if command -v pdftoppm >/dev/null 2>&1; then
      base="${pdf%.*}"
      base_name=$(basename "$base")
      echo "  converting $pdf → ${base_name}-N.png"
      pdftoppm -r 150 -png "$pdf" "$book_dir/source/$base_name"
    else
      echo "  warning: $pdf present but pdftoppm not installed; skipping conversion" >&2
    fi
  done

  # Process PNGs: greyscale, trim whitespace, resize to max 1000px width
  echo "  Processing PNGs (greyscale, trim, resize)..."

  for png in "$book_dir/source"/*.png; do
    [ -e "$png" ] || continue
    filename=$(basename "$png")
    # Custom overlay companions (<base>_overlay.png) are passed through unchanged
    # below — skip them here so the artist's alpha isn't squashed.
    case "$filename" in
      *_overlay.png) continue ;;
    esac
    output="$book_dir/processed/$filename"

    if [ -n "$MAGICK_CMD" ]; then
      echo "    $filename"
      # Greyscale + trim + resize, then luminance → alpha.
      # Algorithm: alpha = 255 - luma, RGB forced to black.
      #   1. -negate       inverts grey channel (black src → white, white src → black)
      #   2. -alpha copy   copies the inverted intensity into a new alpha channel
      #   3. -fill black -colorize 100   forces RGB to black, leaves alpha intact
      # Result: black lines opaque, white paper transparent, anti-aliased greys
      # become semi-transparent BLACK (not grey-on-bg) over the runtime bg color.
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
      echo "    warning: ImageMagick not installed; skipping processing" >&2
      cp "$png" "$output"
    fi
  done

  # Copy custom overlay PNGs unchanged (artist controls the alpha)
  echo "  Copying overlay companions..."
  for png in "$book_dir/source"/*_overlay.png; do
    [ -e "$png" ] || continue
    filename=$(basename "$png")
    cp "$png" "$book_dir/processed/$filename"
    echo "    $filename"
  done

  # Copy SVGs unchanged
  echo "  Copying SVGs..."
  for svg in "$book_dir/source"/*.svg; do
    [ -e "$svg" ] || continue
    filename=$(basename "$svg")
    cp "$svg" "$book_dir/processed/$filename"
    echo "    $filename"
  done

  # Generate per-book manifest
  pages=()
  for f in "$book_dir/processed"/*.png "$book_dir/processed"/*.jpg "$book_dir/processed"/*.jpeg "$book_dir/processed"/*.gif "$book_dir/processed"/*.webp "$book_dir/processed"/*.svg; do
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
    if [ -e "$book_dir/processed/$overlay_name" ]; then
      pages+=("    { \"file\": \"books/$book_name/processed/$filename\", \"name\": \"$pretty\", \"overlay\": \"books/$book_name/processed/$overlay_name\" }")
    else
      pages+=("    { \"file\": \"books/$book_name/processed/$filename\", \"name\": \"$pretty\" }")
    fi
  done

  # Generate book thumbnail from first image
  echo "  Generating thumbnail..."
  local first_page=""
  for f in "$book_dir/processed"/*.png "$book_dir/processed"/*.svg; do
    [ -e "$f" ] || continue
    filename=$(basename "$f")
    case "$filename" in
      *_overlay.*) continue ;;
    esac
    first_page="$f"
    break
  done

  if [ -n "$first_page" ] && [ -n "$MAGICK_CMD" ] && [[ "$first_page" == *.png ]]; then
    local thumb_file="$book_dir/thumbnail.png"
    "$MAGICK_CMD" "$first_page" \
      -resize '200x200' \
      -background white \
      -gravity center \
      -extent 200x200 \
      "$thumb_file"
    echo "    thumbnail: $thumb_file"
  fi

  # Write per-book manifest.json
  local thumbnail_file=""
  if [ -f "$book_dir/thumbnail.png" ]; then
    thumbnail_file="\"thumbnail\": \"books/$book_name/thumbnail.png\","
  fi

  {
    echo "{"
    if [ -n "$thumbnail_file" ]; then
      echo "  $thumbnail_file"
    fi
    echo "  \"pages\": ["
    if [ "${#pages[@]}" -gt 0 ]; then
      sep=""
      for line in "${pages[@]}"; do
        printf "%s%s" "$sep" "$line"
        sep=$',\n'
      done
      printf "\n"
    fi
    echo "  ]"
    echo "}"
  } > "$book_dir/manifest.json"

  echo "  wrote $book_dir/manifest.json with ${#pages[@]} page(s)"
}

# Process all books in books/ directory
books_data=()
echo "Scanning for books in books/ directory..."
for book_dir in books/*/; do
  [ -d "$book_dir" ] || continue
  process_book "$book_dir"

  book_name=$(basename "$book_dir")
  # Derive book display name from directory name (capitalize words)
  book_pretty=$(echo "$book_name" \
    | sed -E 's/[-_]+/ /g' \
    | sed -E 's/(^| )([a-z])/\1\u\2/g')

  # Count pages in this book
  page_count=0
  for f in "$book_dir/processed"/*.png "$book_dir/processed"/*.jpg "$book_dir/processed"/*.jpeg "$book_dir/processed"/*.gif "$book_dir/processed"/*.webp "$book_dir/processed"/*.svg; do
    [ -e "$f" ] || continue
    filename=$(basename "$f")
    case "$filename" in
      *_overlay.*) continue ;;
    esac
    page_count=$((page_count + 1))
  done

  books_data+=("  { \"id\": \"$book_name\", \"name\": \"$book_pretty\", \"manifest\": \"books/$book_name/manifest.json\", \"pageCount\": $page_count }")
done

# Write top-level manifest.json that indexes all books
{
  echo "{"
  echo "  \"books\": ["
  if [ "${#books_data[@]}" -gt 0 ]; then
    sep=""
    for line in "${books_data[@]}"; do
      printf "%s%s" "$sep" "$line"
      sep=$',\n'
    done
    printf "\n"
  fi
  echo "  ]"
  echo "}"
} > manifest.json

echo "wrote $(pwd)/manifest.json with ${#books_data[@]} book(s)"
