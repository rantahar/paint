# Robot Maze

Picture-only programming game for kids who can't read yet. Shares styles with `../finger_paint/`.

- Drag command blocks (bottom) into the 20 program slots (top); tap a block to append it
- Drag a placed block to another slot to swap, or off the program to remove it
- ▶ runs the slots in order (empty slots skipped); ■ stops; 🏠 resets the robot; 🗑 removes the last instruction
- One square size: robot, walls, fruit, exit each fill 1 square
- Repeat blocks 2 / 3 / 4 run the next instruction that many times (2, 3, → = 6 steps)
- Forward/back = 1 square, jump = 2 squares (over a wall or fruit)
- Fruit under the robot is collected and counted in the top bar
- Arriving on 🏁 makes the robot spin; no win condition
- Level button (dots) cycles the 3 levels (open field → walls → maze)

Levels are ASCII maps in `robot.js` (`LEVELS`). Program + level persist in localStorage.

Serve the repo root and open `/robot/`.
