# Robot Maze

Picture-only programming game for kids who can't read yet. Shares styles,
icons and dialogs with `../finger_paint/`.

- Drag command blocks (bottom) into the 20 program slots (top); tap a block to append it
- Drag a placed block to another slot to swap, or off the program to remove it
- ▶ runs the slots in order (empty slots skipped); ■ stops; 🏠 resets the robot
- Robot covers 2×2 cells. Forward/back = 2 cells, jump = 4 cells over walls/fruit
- Fruit under the robot is collected and counted in the top bar
- Arriving on 🏁 makes the robot spin; no win condition
- Level button (dots) cycles the 3 levels (open field → walls → maze)

Levels are ASCII maps in `robot.js` (`LEVELS`). Program + level persist in localStorage.

Serve the repo root and open `/robot/`.
