/* ────────────────────────────────────────────────────────────
   robot.js — Robot Maze: a picture-only programming game.

   The world is a grid of robot-sized squares: robot, walls, fruit and
   exit each take exactly one square.
   The player drags command blocks from the palette (bottom) into the
   20 program slots (top). ▶ runs the slots in order, skipping empty
   ones. Fruits under the robot are collected and counted in the top
   bar; arriving on the 🏁 exit makes the robot spin.

   Movement: forward/back = 1 square, jump = 2 squares (over whatever
   is between).
   ──────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const SLOT_COUNT = 20;
  const STEP = 1;          // squares per forward/back
  const JUMP = 2;          // squares per jump
  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];   // up, right, down, left

  const FRUITS = { B: '🍌', A: '🍎', C: '🍒', S: '🍓' };

  /* Map legend (one character = one square = one robot):
       .  empty   #  wall   R  robot start (faces right)   E  exit
       B/A/C/S  fruit                                                    */
  const LEVELS = [
    [
      '..........',
      '.R...B....',
      '...A......',
      '.......B..',
      '..........',
      '.B...A..E.',
      '..........',
    ],
    [
      '..........',
      '.R..#..B..',
      '....#.....',
      '.A..#.....',
      '..........',
      '..####..E.',
      '.B........',
    ],
    [
      'R...B.#.C.',
      '.####.#...',
      '.A..#.#.#.',
      '.##.#...#.',
      '....###.#S',
      '.##.....#.',
      'E...#.....',
    ],
  ];

  /* ── Commands ── */
  const COMMANDS = {
    forward:  { kind: 'move', icon: `<line x1="12" y1="21" x2="12" y2="4"/><polyline points="5 11 12 4 19 11"/>` },
    back:     { kind: 'move', icon: `<line x1="12" y1="3" x2="12" y2="20"/><polyline points="5 13 12 20 19 13"/>` },
    left:     { kind: 'turn', icon: `<path d="M17 21v-8a5 5 0 00-5-5H5"/><polyline points="9 4 5 8 9 12"/>` },
    right:    { kind: 'turn', icon: `<path d="M7 21v-8a5 5 0 015-5h7"/><polyline points="15 4 19 8 15 12"/>` },
    turnback: { kind: 'turn', icon: `<path d="M7 21V10a5 5 0 0110 0v9"/><polyline points="13 15 17 19 21 15"/>` },
    jump:     { kind: 'jump', icon: `<rect x="10" y="15" width="4" height="6" fill="#b9744f" stroke="#7a4429" stroke-width="1.2"/>
                                     <path d="M3 21Q12 0 20 18"/><polyline points="15.1 14.5 20 18 20.6 12"/>` },
  };
  const PALETTE_ORDER = ['forward', 'back', 'left', 'right', 'turnback', 'jump'];

  const ICONS = {
    play:  `<polygon points="7 4 20 12 7 20" fill="#3c9a3c" stroke="#222"/>`,
    stop:  `<rect x="6" y="6" width="12" height="12" rx="1.5" fill="#cc4422" stroke="#222"/>`,
    home:  `<path d="M3 11l9-8 9 8"/><path d="M5 9.5V21h14V9.5"/><rect x="10" y="14" width="4" height="7"/>`,
  };

  const ROBOT_SVG = `<svg viewBox="0 0 100 100">
    <line x1="50" y1="16" x2="50" y2="6" stroke="#222" stroke-width="4"/>
    <circle cx="50" cy="6" r="5.5" fill="#e8574a" stroke="#222" stroke-width="3"/>
    <rect x="3" y="40" width="9" height="24" rx="3" fill="#7d93a8" stroke="#222" stroke-width="3"/>
    <rect x="88" y="40" width="9" height="24" rx="3" fill="#7d93a8" stroke="#222" stroke-width="3"/>
    <rect x="12" y="16" width="76" height="76" rx="14" fill="#9fc0dc" stroke="#222" stroke-width="4"/>
    <circle cx="35" cy="42" r="11" fill="#fff" stroke="#222" stroke-width="3"/>
    <circle cx="65" cy="42" r="11" fill="#fff" stroke="#222" stroke-width="3"/>
    <circle cx="35" cy="38" r="5" fill="#222"/>
    <circle cx="65" cy="38" r="5" fill="#222"/>
    <rect x="30" y="64" width="40" height="14" rx="4" fill="#fff" stroke="#222" stroke-width="3"/>
    <line x1="43" y1="64" x2="43" y2="78" stroke="#222" stroke-width="2.5"/>
    <line x1="57" y1="64" x2="57" y2="78" stroke="#222" stroke-width="2.5"/>
  </svg>`;

  function svg(inner, size) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#222"
      stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ── DOM ── */
  const $ = id => document.getElementById(id);
  const app = $('robot-app');
  const fruitsEl = $('rb-fruits');
  const programEl = $('rb-program');
  const worldWrap = $('rb-world-wrap');
  const worldEl = $('rb-world');
  const paletteEl = $('rb-palette');
  const playBtn = $('rb-play');
  const resetBtn = $('rb-reset');
  const levelBtn = $('rb-level');

  /* ── State ── */
  const program = loadProgram();
  let levelIdx = loadInt('rb-level', 0) % LEVELS.length;
  let level = null;        // parsed level
  let robot = null;        // { x, y, dir, angle }
  let robotEl = null;
  let items = [];          // { x, y, type, el, taken }
  let counts = {};         // type → collected
  let slotSize = 56;
  let cell = 32;
  let runToken = 0;        // incremented to cancel a running program
  let running = false;

  function loadProgram() {
    try {
      const p = JSON.parse(localStorage.getItem('rb-program'));
      if (Array.isArray(p) && p.length === SLOT_COUNT) return p.map(c => (COMMANDS[c] ? c : null));
    } catch (e) { /* ignore */ }
    return new Array(SLOT_COUNT).fill(null);
  }
  function saveProgram() {
    try { localStorage.setItem('rb-program', JSON.stringify(program)); } catch (e) { /* ignore */ }
  }
  function loadInt(key, def) {
    try { const v = parseInt(localStorage.getItem(key), 10); return isNaN(v) ? def : v; } catch (e) { return def; }
  }

  /* ── Level parsing ── */
  function parseLevel(rows) {
    const h = rows.length, w = rows[0].length;
    const walls = [];
    const fruit = [];
    let start = null, exit = null;
    for (let y = 0; y < h; y++) {
      walls.push([]);
      for (let x = 0; x < w; x++) {
        const ch = rows[y][x];
        walls[y].push(ch === '#');
        if (ch === 'R' && !start) start = { x, y };
        if (ch === 'E' && !exit) exit = { x, y };
        if (FRUITS[ch]) fruit.push({ x, y, type: ch });
      }
    }
    return { w, h, walls, fruit, start, exit };
  }

  function blocked(x, y) {
    if (x < 0 || y < 0 || x >= level.w || y >= level.h) return true;
    return level.walls[y][x];
  }

  function onExit() {
    return robot.x === level.exit.x && robot.y === level.exit.y;
  }

  /* ── Rendering ── */
  function buildWorld() {
    level = parseLevel(LEVELS[levelIdx]);
    worldEl.innerHTML = '';

    for (let y = 0; y < level.h; y++) {
      for (let x = 0; x < level.w; x++) {
        if (!level.walls[y][x]) continue;
        const d = document.createElement('div');
        d.className = 'rb-wall';
        d.dataset.x = x; d.dataset.y = y;
        worldEl.appendChild(d);
      }
    }
    const ex = document.createElement('div');
    ex.className = 'rb-exit';
    ex.textContent = '🏁';
    worldEl.appendChild(ex);

    robotEl = document.createElement('div');
    robotEl.className = 'rb-robot';
    robotEl.innerHTML = ROBOT_SVG;
    worldEl.appendChild(robotEl);

    resetWorld();
    layoutWorld();
  }

  function resetWorld() {
    robot = { x: level.start.x, y: level.start.y, dir: 1, angle: 90 };
    items.forEach(it => it.el.remove());
    items = level.fruit.map(f => {
      const el = document.createElement('div');
      el.className = 'rb-item';
      el.textContent = FRUITS[f.type];
      worldEl.insertBefore(el, robotEl);
      return { x: f.x, y: f.y, type: f.type, el, taken: false };
    });
    counts = {};
    level.fruit.forEach(f => { counts[f.type] = 0; });
    renderFruitBar();
    positionItems();
    placeRobot(0);
    markSlot(-1);
  }

  function positionItems() {
    items.forEach(it => {
      it.el.style.left = it.x * cell + 'px';
      it.el.style.top = it.y * cell + 'px';
    });
  }

  function placeRobot(ms, extra) {
    robotEl.style.transition = ms ? `transform ${ms}ms ease-in-out` : 'none';
    const ox = extra && extra.ox || 0, oy = extra && extra.oy || 0;
    const sc = extra && extra.scale || 1;
    robotEl.style.transform =
      `translate(${(robot.x + ox) * cell}px, ${(robot.y + oy) * cell}px) rotate(${robot.angle}deg) scale(${sc})`;
  }

  function renderFruitBar() {
    fruitsEl.innerHTML = '';
    Object.keys(counts).forEach(type => {
      const d = document.createElement('div');
      d.className = 'rb-fruit-count';
      d.dataset.type = type;
      d.innerHTML = `<span class="em">${FRUITS[type]}</span><span class="n">${counts[type]}</span>`;
      fruitsEl.appendChild(d);
    });
  }

  function bumpFruit(type) {
    const d = fruitsEl.querySelector(`[data-type="${type}"]`);
    if (!d) return;
    d.querySelector('.n').textContent = counts[type];
    d.classList.remove('bump');
    void d.offsetWidth;
    d.classList.add('bump');
  }

  function collect() {
    items.forEach(it => {
      if (it.taken) return;
      if (it.x === robot.x && it.y === robot.y) {
        it.taken = true;
        it.el.classList.add('taken');
        counts[it.type]++;
        bumpFruit(it.type);
      }
    });
  }

  function renderProgram() {
    programEl.innerHTML = '';
    for (let i = 0; i < SLOT_COUNT; i++) {
      const s = document.createElement('div');
      s.className = 'rb-slot';
      s.dataset.slot = i;
      if (program[i]) s.appendChild(makeBlock(program[i], slotSize * 0.7));
      programEl.appendChild(s);
    }
  }

  function makeBlock(cmd, iconSize) {
    const b = document.createElement('div');
    b.className = 'rb-block ' + COMMANDS[cmd].kind;
    b.dataset.cmd = cmd;
    b.innerHTML = svg(COMMANDS[cmd].icon, iconSize);
    return b;
  }

  function renderPalette() {
    paletteEl.innerHTML = '';
    PALETTE_ORDER.forEach(cmd => paletteEl.appendChild(makeBlock(cmd, slotSize * 0.9)));
  }

  function renderButtons() {
    const ic = Math.round(slotSize * 0.6);
    playBtn.innerHTML = svg(running ? ICONS.stop : ICONS.play, ic);
    playBtn.classList.toggle('running', running);
    resetBtn.innerHTML = svg(ICONS.home, ic);
    // Level indicator: one dot per level, current one filled.
    const n = LEVELS.length;
    let dots = '';
    for (let i = 0; i < n; i++) {
      const cx = 12 + (i - (n - 1) / 2) * 6.5;
      dots += `<circle cx="${cx}" cy="12" r="2.6" fill="${i === levelIdx ? '#1177EE' : '#fff'}" stroke="#222" stroke-width="1.6"/>`;
    }
    levelBtn.innerHTML = `<svg width="${ic}" height="${ic}" viewBox="0 0 24 24">
      <rect x="2" y="5" width="20" height="14" rx="2.5" fill="#f0eeea" stroke="#222" stroke-width="1.8"/>${dots}</svg>`;
    levelBtn.classList.toggle('inactive', running);
  }

  function markSlot(i, failed) {
    programEl.querySelectorAll('.rb-slot').forEach(s => s.classList.remove('current', 'failed'));
    if (i < 0) return;
    const s = programEl.children[i];
    if (!s) return;
    s.classList.add('current');
    if (failed) s.classList.add('failed');
  }

  /* ── Layout ── */
  function layout() {
    const W = window.innerWidth, H = window.innerHeight;
    slotSize = Math.floor(Math.min((W - 24) / 11.6, H * 0.085, 84));
    slotSize = Math.max(slotSize, 26);
    app.style.setProperty('--s', slotSize + 'px');
    renderProgram();
    renderPalette();
    renderButtons();
    markSlot(-1);
    layoutWorld();
  }

  function layoutWorld() {
    if (!level) return;
    const aw = worldWrap.clientWidth, ah = worldWrap.clientHeight;
    cell = Math.max(8, Math.floor(Math.min(aw / level.w, ah / level.h)));
    app.style.setProperty('--cell', cell + 'px');
    worldEl.style.width = level.w * cell + 'px';
    worldEl.style.height = level.h * cell + 'px';
    worldEl.querySelectorAll('.rb-wall').forEach(d => {
      d.style.left = d.dataset.x * cell + 'px';
      d.style.top = d.dataset.y * cell + 'px';
      d.style.width = cell + 'px';
      d.style.height = cell + 'px';
    });
    const ex = worldEl.querySelector('.rb-exit');
    ex.style.left = level.exit.x * cell + 'px';
    ex.style.top = level.exit.y * cell + 'px';
    ex.style.width = cell + 'px';
    ex.style.height = cell + 'px';
    positionItems();
    placeRobot(0);
  }

  /* ── Execution ── */
  async function moveCells(n, sign, token) {
    const [dx, dy] = DIRS[robot.dir];
    for (let i = 0; i < n; i++) {
      const nx = robot.x + dx * sign, ny = robot.y + dy * sign;
      if (blocked(nx, ny)) { await bump(dx * sign, dy * sign, token); return false; }
      robot.x = nx; robot.y = ny;
      placeRobot(260);
      await sleep(280);
      if (token !== runToken) return false;
      collect();
    }
    return true;
  }

  async function bump(dx, dy, token) {
    placeRobot(90, { ox: dx * 0.15, oy: dy * 0.15 });
    await sleep(100);
    placeRobot(120);
    await sleep(140);
    return token === runToken;
  }

  async function jump(token) {
    const [dx, dy] = DIRS[robot.dir];
    const nx = robot.x + dx * JUMP, ny = robot.y + dy * JUMP;
    if (blocked(nx, ny)) {
      // Hop in place to show the jump can't land there.
      placeRobot(150, { scale: 1.25 });
      await sleep(160);
      placeRobot(150);
      await sleep(160);
      return false;
    }
    const ox = robot.x, oy = robot.y;
    robot.x = (ox + nx) / 2; robot.y = (oy + ny) / 2;
    placeRobot(220, { scale: 1.45 });
    robotEl.style.zIndex = 5;
    await sleep(230);
    robot.x = nx; robot.y = ny;
    placeRobot(220);
    await sleep(240);
    robotEl.style.zIndex = '';
    if (token !== runToken) return false;
    collect();
    return true;
  }

  async function turn(delta) {
    robot.dir = (robot.dir + delta / 90 + 4) % 4;
    robot.angle += delta;
    placeRobot(Math.abs(delta) > 90 ? 420 : 260);
    await sleep(Math.abs(delta) > 90 ? 440 : 280);
    return true;
  }

  async function celebrate() {
    sparkle();
    robot.angle += 360;
    placeRobot(700, { scale: 1.1 });
    await sleep(720);
    placeRobot(150);
    await sleep(160);
  }

  function sparkle() {
    const cx = (robot.x + 0.5) * cell, cy = (robot.y + 0.5) * cell;
    ['⭐', '✨', '🎉', '⭐', '✨', '🎉'].forEach((e, i) => {
      const s = document.createElement('div');
      s.className = 'rb-sparkle';
      s.textContent = e;
      const a = (i / 6) * Math.PI * 2;
      s.style.left = cx + 'px';
      s.style.top = cy + 'px';
      s.style.setProperty('--dx', Math.cos(a) * cell * 1.2 + 'px');
      s.style.setProperty('--dy', Math.sin(a) * cell * 1.2 + 'px');
      worldEl.appendChild(s);
      setTimeout(() => s.remove(), 1000);
    });
  }

  async function runProgram() {
    const token = ++runToken;
    running = true;
    document.body.classList.add('rb-running');
    renderButtons();
    resetWorld();
    await sleep(250);

    let wasOnExit = onExit();
    for (let i = 0; i < SLOT_COUNT; i++) {
      if (token !== runToken) return;
      const cmd = program[i];
      if (!cmd) continue;
      markSlot(i);
      let ok = true;
      switch (cmd) {
        case 'forward':  ok = await moveCells(STEP, 1, token); break;
        case 'back':     ok = await moveCells(STEP, -1, token); break;
        case 'left':     ok = await turn(-90); break;
        case 'right':    ok = await turn(90); break;
        case 'turnback': ok = await turn(180); break;
        case 'jump':     ok = await jump(token); break;
      }
      if (token !== runToken) return;
      if (!ok) { markSlot(i, true); await sleep(250); }
      const now = onExit();
      if (now && !wasOnExit) await celebrate();
      wasOnExit = now;
      await sleep(120);
    }
    if (token !== runToken) return;
    markSlot(-1);
    if (onExit()) await celebrate();
    if (token !== runToken) return;
    stopRunning();
  }

  function stopRunning() {
    runToken++;
    running = false;
    document.body.classList.remove('rb-running');
    renderButtons();
  }

  /* ── Buttons ── */
  playBtn.addEventListener('click', () => {
    if (running) { stopRunning(); markSlot(-1); }
    else runProgram();
  });
  resetBtn.addEventListener('click', () => {
    if (running) stopRunning();
    resetWorld();
  });
  levelBtn.addEventListener('click', () => {
    if (running) return;
    levelIdx = (levelIdx + 1) % LEVELS.length;
    try { localStorage.setItem('rb-level', levelIdx); } catch (e) { /* ignore */ }
    renderButtons();
    buildWorld();
  });

  /* ── Drag & drop ── */
  let drag = null;   // { cmd, fromSlot, startX, startY, ghost, pointerId, srcEl }

  function slotAt(x, y) {
    const el = document.elementFromPoint(x, y);
    const s = el && el.closest('.rb-slot');
    return s ? parseInt(s.dataset.slot, 10) : -1;
  }

  function onDown(e) {
    if (running || drag) return;
    const block = e.target.closest('.rb-block');
    if (!block) return;
    const slotEl = block.closest('.rb-slot');
    drag = {
      cmd: block.dataset.cmd,
      fromSlot: slotEl ? parseInt(slotEl.dataset.slot, 10) : -1,
      startX: e.clientX, startY: e.clientY,
      ghost: null, pointerId: e.pointerId, srcEl: block,
    };
    e.preventDefault();
  }

  function onMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.ghost) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 8) return;
      drag.ghost = makeBlock(drag.cmd, slotSize * 0.8);
      drag.ghost.classList.add('rb-ghost');
      drag.ghost.style.width = drag.ghost.style.height = slotSize * 1.1 + 'px';
      document.body.appendChild(drag.ghost);
      if (drag.fromSlot >= 0) drag.srcEl.style.visibility = 'hidden';
    }
    drag.ghost.style.left = e.clientX + 'px';
    drag.ghost.style.top = e.clientY + 'px';
    const over = slotAt(e.clientX, e.clientY);
    programEl.querySelectorAll('.rb-slot').forEach((s, i) => s.classList.toggle('drop-hover', i === over));
  }

  function onUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    programEl.querySelectorAll('.drop-hover').forEach(s => s.classList.remove('drop-hover'));

    if (!d.ghost) {
      // Plain tap on a palette block: append to the first empty slot.
      if (d.fromSlot < 0 && e.type === 'pointerup') {
        const i = program.indexOf(null);
        if (i >= 0) { program[i] = d.cmd; saveProgram(); renderProgram(); }
      }
      return;
    }
    d.ghost.remove();
    const target = e.type === 'pointerup' ? slotAt(e.clientX, e.clientY) : -1;
    if (d.fromSlot >= 0) {
      if (target >= 0) {
        // Move: swap with whatever is in the target slot.
        const t = program[target];
        program[target] = d.cmd;
        program[d.fromSlot] = target === d.fromSlot ? d.cmd : t;
      } else if (e.type === 'pointerup') {
        program[d.fromSlot] = null;     // dragged out → removed
      }
    } else if (target >= 0) {
      program[target] = d.cmd;
    }
    saveProgram();
    renderProgram();
  }

  document.addEventListener('pointerdown', onDown);
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
  document.addEventListener('contextmenu', e => e.preventDefault());

  /* ── Init ── */
  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(layout);
  });

  layout();
  buildWorld();
})();
