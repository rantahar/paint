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

## Running Locally

No build step required. The app is plain HTML/CSS/JavaScript.

### Option 1: Serve locally (recommended)
```bash
python -m http.server 8765
```
Then visit `http://localhost:8765/` in your browser.

### Option 2: Open directly
Open `index.html` in a modern browser. Works from the `file://` protocol, though some features (image upload) work better when served over HTTP.

## Architecture

- **Two-canvas system**: separate background and drawing layers
- **Global namespace pattern** (`window.FP`) for simplicity and `file://` protocol compatibility
- **Brush API**: each brush implements `beginStroke`, `continueStroke`, `endStroke`
- **Layout system**: pure JavaScript geometry that computes absolute positions for all UI elements based on screen size
- **localStorage persistence**: drawings stored as PNG data URLs

See [CLAUDE.md](CLAUDE.md) for detailed architecture documentation.

## Not Yet Implemented

- **Audio** — sound system is designed but awaiting audio assets
- **Keyboard safety** — accidental keypresses can affect drawing
- **Bar alignment** — toolbar edges don't perfectly align in all orientations

## Browser Support

Works in any modern browser with support for:
- Canvas 2D
- Pointer Events with `getCoalescedEvents()`
- localStorage
- CSS Grid (for minor styling)
