# PAPER 86

A 60-second top-down drift score attack. Hold space, thread paper cones, leave ink tire marks on a paper-craft circuit.

## How to Play

- **Objective**: Score as many points as possible in 60 seconds by drifting and threading cones
- **Controls**:
  - **Steer**: Arrow keys or A/D
  - **Drift**: Hold Space (or click and hold on canvas)
  - **Restart**: Press R or tap the end card
- **Scoring**:
  - Drift near cones for points (angle × speed × combo multiplier)
  - Thread cones to build combo (×2, ×3, ×4...)
  - Missing a cone drops your combo
  - Hitting walls or leaving the track ends your run
- **Mobile**: On-screen drift button appears on touch devices. Steer with A/D or screen edges.

## Run Locally

### Option 1: Direct Open
Just open `index.html` in your browser. No build step required.

### Option 2: Local Server
```bash
npx serve
```
Then visit `http://localhost:3000`

## Deployment

Ready for GitHub Pages deployment. The game works at the repository root, so it will deploy at:
```
https://<username>.github.io/<repo-name>/
```

To deploy, go to your repository Settings → Pages → Source → Deploy from a branch → Select `main` and `/root`.

## Technical Details

- **Tech**: Vanilla JavaScript with HTML5 Canvas. No frameworks, no bundlers.
- **Files**: 
  - `index.html` - Game container and HUD
  - `game.js` - Physics engine, rendering, controls
  - `style.css` - Paper-craft aesthetic styling
- **Physics**: Momentum-based drift mechanics with grip/slip states
- **Storage**: High score saved to localStorage (browser-local)

## Visual Style

Current aesthetic is paper-craft placeholder (cream paper background, graphite outlines, ink tire marks, orange cones). Color palette is centralized in CSS custom properties for easy restyling. Studio will handle final look and copy.

## License

Open source - see repository license.
