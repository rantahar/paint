# Finger Paint

A simple, touch-friendly drawing app with multiple brushes, colors, and drawing persistence.

## Features

- **Four brush types**: marker, watercolor, crayon, eraser
- **16 colors** to choose from with visual color picker
- **Adjustable brush size** with visual indicator
- **Background fill** with solid colors or uploaded images
- **Save & load drawings** stored in browser localStorage
- **Multi-touch support** — paint with multiple fingers simultaneously
- **Responsive layout** that adapts to landscape and portrait orientations
- **Page-flip animation** when clearing or loading drawings

## Variants

### Standard (`finger_paint/`)
Full-featured drawing app with all brushes, size controls, save/load, and upload.

### Crayon Mode (`finger_paint/crayon-mode/`)
Simplified variant designed for quick, casual drawing:
- Defaults to **floating-buttons mode** (canvas fills the full viewport)
- Defaults to the **crayon brush**
- Shows only **color swatches**, **set background color**, and **clear** — no save, upload, or brush/size controls

## Running Locally

No build step required. The app is plain HTML/CSS/JavaScript.

### Option 1: Serve locally (recommended)
```bash
python -m http.server 8765
```
Then visit `http://localhost:8765/finger_paint/` (or `.../finger_paint/crayon-mode/`) in your browser.

### Option 2: Open directly
Open `index.html` in a modern browser. Works from the `file://` protocol, though some features (image upload) work better when served over HTTP.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+,` | Decrease brush size |
| `Ctrl+.` | Increase brush size |
| `Ctrl+B` | Cycle brush type |
| `Ctrl+Shift+↑` | Upload background image |
| `Ctrl+Shift+↓` | Save / download drawing |
| `Ctrl+G` | Toggle frame / floating-buttons mode |
| `Ctrl+F` | Toggle fullscreen |

## Architecture

- **Two-canvas system**: separate background and drawing layers
- **Global namespace pattern** (`window.FP`) for simplicity and `file://` protocol compatibility
- **Brush API**: each brush implements `beginStroke`, `continueStroke`, `endStroke`
- **Layout system**: pure JavaScript geometry that computes absolute positions for all UI elements based on screen size
- **localStorage persistence**: drawings stored as PNG data URLs

See [CLAUDE.md](CLAUDE.md) for detailed architecture documentation.

## Not Yet Implemented

- **Audio** — sound system is designed but awaiting audio assets
- **Bar alignment** — toolbar edges don't perfectly align in all orientations

## Browser Support

Works in any modern browser with support for:
- Canvas 2D
- Pointer Events with `getCoalescedEvents()`
- localStorage
- CSS Grid (for minor styling)
