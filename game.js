const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

const GRAVITY = 1800; // px/s^2
const BOUNCE_VELOCITY = -820; // px/s, upward
const MOVE_SPEED = 420; // px/s
const BALL_RADIUS = 18;

// per-trait tuning: how each effect bends the base physics while active
const CLOUD_GRAVITY_MULT = 0.28; // falls slowly -> glides farther before landing
const CLOUD_DURATION = 1.6; // s, stays floaty across several bounces, not just one
const IRON_GRAVITY_MULT = 2.6; // falls fast
const IRON_BOUNCE_MULT = 0.15; // barely bounces back -> reads as a heavy thud
const IRON_DURATION = 3; // s, stays heavy across several landings, not just one
const RUBBER_BOUNCE_MULT = 1.7; // next bounce launches much higher
const ICE_DURATION = 3; // s, how long the slide lasts
const ICE_MOVE_SPEED = MOVE_SPEED * 2.2; // higher top speed while sliding
const ICE_ACCEL_UP = 7; // reaches top speed quickly, so a bounce launched right after activating is already fast
const ICE_ACCEL_DOWN = 1.2; // but sheds speed slowly -- keeps sliding long after the key is released

const TRAIT_LABELS = {
  cloud: '구름',
  rubber: '탱탱볼',
  iron: '철구슬',
  ice: '얼음',
};

const TRAIT_COLORS = {
  cloud: '#ffffff',
  rubber: '#fb7185',
  iron: '#6b7280',
  ice: '#a5f3fc',
};
const BALL_COLOR = '#38bdf8';

const ball = {
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  pendingTrait: null, // trait acquired, consumed on Space press
  activeTrait: null, // trait currently bending physics
  effectTimer: 0, // countdown for duration-based effects (ice, iron)
};

const input = {
  left: false,
  right: false,
};

const runState = { status: 'playing', timer: 0, elapsed: 0 }; // 'playing' | 'won' | 'lost'; elapsed = play time this run, frozen on win

let floorY = 0;
let elevatedY = 0;
let elevatedY2 = 0;
let platforms = [];
let ceilings = [];
let pits = [];
let triggers = [];
let toasts = []; // { text, life }
let levelWidth = 0;
let cameraX = 0;
let startPoint = { x: 0, y: 0 };
let showIntro = true; // frozen title screen shown once before the first run starts

function resizeCanvas() {
  const wrap = document.getElementById('game-wrap');
  const prevFloorY = floorY;
  canvas.width = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  floorY = canvas.height - 40;
  elevatedY = floorY - 260;
  elevatedY2 = elevatedY - 260;

  // platforms/ceilings/pits store absolute y values snapshotted by buildLevel() at the
  // previous canvas height -- without this shift they'd stay put while the canvas resizes around
  // them (e.g. a taller window leaves the ground floating with a dead gap below it). Shifting
  // everything by the same delta keeps the current run's layout and ball position consistent
  // instead of rebuilding (which would reset progress mid-run).
  if (platforms.length) {
    const deltaY = floorY - prevFloorY;
    if (deltaY) {
      for (const p of platforms) p.y += deltaY;
      for (const c of ceilings) c.y += deltaY;
      for (const p of pits) p.y += deltaY;
      ball.y += deltaY;
      startPoint.y += deltaY;
    }
  }
}

const STEP_HEIGHT = 90; // px above the path -- comfortably under a normal bounce's own apex
// (~186.7px), so a single eased-off hop launched from the path reaches it directly.
const ISLAND_HEIGHT = 200; // px above the path -- ABOVE a normal bounce's own apex, so no hop
// launched from the path can ever reach an island in one shot, no matter its timing or x position.
// The only way up is through the step: a hop launched from step height only needs another
// ISLAND_HEIGHT - STEP_HEIGHT = 110px, well inside its own ~186.7px apex, so the second hop clears
// it easily. This makes "land on an island by accident of just holding a direction" physically
// impossible -- it always takes two deliberate hops, never one.
const ZONE_WIDTH = 50; // width of each of the three platforms
const ZONE_GAP = 20; // gap between them -- keeps them visually and physically separate platforms

function traitCluster(baseY, xStart, leftTrait, rightTrait) {
  // a plain step (no trait, reachable directly from the path) flanked by one trait island on each
  // side, both a tier higher (reachable only from the step). the step is the easy middle target;
  // from there, easing left or right onto an island is the real choice, both shown by color + label
  // before touching (see render()). picking one grants it immediately and overwrites whatever was
  // already pending, so a wrong pick can still be corrected by bouncing over to the other island.
  const stepY = baseY - STEP_HEIGHT;
  const islandY = baseY - ISLAND_HEIGHT;
  const leftEnd = xStart + ZONE_WIDTH;
  const centerStart = leftEnd + ZONE_GAP;
  const centerEnd = centerStart + ZONE_WIDTH;
  const rightStart = centerEnd + ZONE_GAP;
  const rightEnd = rightStart + ZONE_WIDTH;
  return [
    { xStart, xEnd: leftEnd, y: islandY, trait: leftTrait, used: false },
    { xStart: centerStart, xEnd: centerEnd, y: stepY }, // the step -- no trait
    { xStart: rightStart, xEnd: rightEnd, y: islandY, trait: rightTrait, used: false },
  ];
}

function buildLevel() {
  // world-space layout: two laps of the same four hazards -- rubber ledge -> cloud glide ->
  // iron tunnel -> ice pit -- the second lap one tier higher (elevatedY2), so clearing it means
  // re-applying all four traits again rather than coasting through on lap 1's memorized inputs.
  // the ground path is one continuous, unbroken route -- nothing about picking up a trait
  // interrupts forward progress. each cluster's islands sit a full tier above what any path-launched
  // hop can reach (see ISLAND_HEIGHT above), so grabbing a trait always means physically climbing
  // the step first and hopping again from there -- never an accident of just moving forward, no
  // matter how a run happens to be timed. the correct trait always sits on the right island.
  platforms = [
    { xStart: 0, xEnd: 850, y: floorY }, // start
    ...traitCluster(floorY, 100, 'iron', 'rubber'), // decoy: iron (left island, kills the boost) / correct: rubber (right island, clears the gap ahead)

    { xStart: 1150, xEnd: 2150, y: elevatedY, resetTrait: true, exceptTrait: 'cloud' }, // ledge reached via rubber boost
    ...traitCluster(elevatedY, 1305, 'rubber', 'cloud'), // decoy: rubber (extra height, not glide distance) / correct: cloud (glide)

    { xStart: 2450, xEnd: 3650, y: elevatedY, resetTrait: true, exceptTrait: 'iron' }, // landing after the wide glide -- also clears leftover cloud float (widened left edge: the glide's actual fall crosses back down to elevatedY around x=2536, before the platform used to start at 2650)
    ...traitCluster(elevatedY, 3082, 'cloud', 'iron'), // decoy: cloud (still too tall for the tunnel) / correct: iron (low tunnel)

    { xStart: 3650, xEnd: 3990, y: elevatedY, ceiling: true }, // low tunnel: only iron's tiny bounce fits

    { xStart: 3990, xEnd: 5300, y: elevatedY, resetTrait: true, exceptTrait: 'ice' }, // after tunnel + ice runway -- also clears leftover heavy iron
    ...traitCluster(elevatedY, 4048, 'rubber', 'ice'), // decoy: rubber (height, not the speed needed to clear the pit) / correct: ice (speed)
    // no platform from 5300 to 5700: a real pit, spikes at the bottom (see pits).
    // normal/other bounces fall short and drop in; only ice's speed clears it.

    { xStart: 5700, xEnd: 6800, y: elevatedY, resetTrait: true, exceptTrait: 'rubber' }, // checkpoint after the first pit -- clears leftover ice slide, but must spare rubber (this section's own trait, picked up and re-landed on before it boosts). wide enough that the unboosted carrier bounce launched from the island always lands back on solid ground before the boost can apply on its *next* touchdown.
    ...traitCluster(elevatedY, 6100, 'iron', 'rubber'), // decoy: iron / correct: rubber (climbs to the next tier, elevatedY2)

    { xStart: 6850, xEnd: 7850, y: elevatedY2, resetTrait: true, exceptTrait: 'cloud' }, // upper ledge reached via rubber boost
    ...traitCluster(elevatedY2, 7005, 'rubber', 'cloud'), // decoy: rubber (extra height, not glide distance) / correct: cloud (glide)

    { xStart: 8100, xEnd: 9100, y: elevatedY2, resetTrait: true, exceptTrait: 'iron' }, // landing after the second glide -- also clears leftover cloud float
    ...traitCluster(elevatedY2, 8470, 'cloud', 'iron'), // decoy: cloud (still too tall for the tunnel) / correct: iron (low tunnel)

    { xStart: 9100, xEnd: 9440, y: elevatedY2, ceiling: true }, // second low tunnel: only iron's tiny bounce fits

    { xStart: 9440, xEnd: 10750, y: elevatedY2, resetTrait: true, exceptTrait: 'ice' }, // after tunnel + ice runway -- also clears leftover heavy iron
    ...traitCluster(elevatedY2, 9498, 'rubber', 'ice'), // decoy: rubber (height, not the speed needed to clear the pit) / correct: ice (speed)
    // no platform from 10750 to 11150: a second real pit, spikes at the bottom (see pits).

    { xStart: 11150, xEnd: 12150, y: elevatedY2, goal: true }, // goal — wide, since ice's speed can carry the landing far past the pit
  ];

  ceilings = platforms
    .filter((p) => p.ceiling)
    .map((p) => ({ xStart: p.xStart, xEnd: p.xEnd, y: p.y - 100 }));

  pits = [
    { xStart: 5300, xEnd: 5700, y: elevatedY + 140 },
    { xStart: 10750, xEnd: 11150, y: elevatedY2 + 140 },
  ];

  // trait is shown before touching (color + label, see render()). it's granted only on an actual
  // landing on the platform (see update()), not by flying near it, so grabbing it always means a
  // real detour off the main path, never a flyby.
  triggers = platforms.filter((p) => p.trait);

  const last = platforms[platforms.length - 1];
  levelWidth = last.xEnd + 200;
  startPoint = { x: 60, y: floorY - BALL_RADIUS };
}

function resetBall() {
  buildLevel();
  ball.x = startPoint.x;
  ball.y = startPoint.y;
  ball.vx = 0;
  ball.vy = BOUNCE_VELOCITY;
  ball.pendingTrait = null;
  ball.activeTrait = null;
  ball.effectTimer = 0;
  toasts = [];
  runState.status = 'playing';
  runState.timer = 0;
  runState.elapsed = 0;
  cameraX = 0;
}

function handleKey(e, isDown) {
  if (e.code === 'ArrowLeft' || e.code === 'KeyA') input.left = isDown;
  if (e.code === 'ArrowRight' || e.code === 'KeyD') input.right = isDown;
}

function useTrait() {
  if (!ball.pendingTrait) return;
  const trait = ball.pendingTrait;
  ball.pendingTrait = null;
  ball.activeTrait = trait;
  ball.effectTimer =
    trait === 'ice' ? ICE_DURATION : trait === 'iron' ? IRON_DURATION : trait === 'cloud' ? CLOUD_DURATION : 0;
  pushToast(`${TRAIT_LABELS[trait]} 효과 발동`);
}

function clearActiveTrait(message) {
  ball.activeTrait = null;
  if (message) pushToast(message);
}

function dismissIntro() {
  if (showIntro) showIntro = false;
}

window.addEventListener('keydown', (e) => {
  if (showIntro) {
    dismissIntro();
    return; // this keypress only dismisses the title screen, not also a game action
  }
  if (e.code === 'Space' && !e.repeat) {
    e.preventDefault();
    if (runState.status === 'playing') useTrait();
  }
  handleKey(e, true);
});
window.addEventListener('keyup', (e) => handleKey(e, false));
canvas.addEventListener('click', dismissIntro);
window.addEventListener('resize', () => {
  resizeCanvas();
});

function pushToast(text) {
  toasts.push({ text, life: 3.5 });
}

function getSupportPlatform(x, prevBottom, nextBottom) {
  // topmost platform under this x that the ball is actually crossing into this frame (prevBottom
  // was still above it, nextBottom has reached or passed it). picking the topmost platform at this
  // x regardless of height -- as a plain overlap test -- would make a two-tier island's platform
  // permanently shadow the ground below it: a ball passing under the island at ground height would
  // never be offered the ground as a candidate, and would fall straight through with no landing at
  // all. requiring an actual crossing lets a lower, unrelated platform still catch the ball.
  let best = null;
  for (const p of platforms) {
    if (x < p.xStart || x > p.xEnd) continue;
    if (prevBottom > p.y || nextBottom < p.y) continue;
    if (!best || p.y < best.y) best = p;
  }
  return best;
}

function failRun(message) {
  runState.status = 'lost';
  runState.timer = 1.4;
  pushToast(message);
}

function winRun() {
  runState.status = 'won';
  runState.timer = 2;
  pushToast('목표 도달! 클리어');
}

function update(dt) {
  if (showIntro) return; // nothing moves until the player dismisses the title screen

  if (runState.status !== 'playing') {
    runState.timer -= dt;
    toasts = toasts.filter((t) => (t.life -= dt) > 0);
    if (runState.timer <= 0) resetBall();
    return;
  }

  runState.elapsed += dt;

  if (ball.activeTrait === 'ice') {
    const target = (input.right ? ICE_MOVE_SPEED : 0) - (input.left ? ICE_MOVE_SPEED : 0);
    const rate = Math.abs(target) > Math.abs(ball.vx) ? ICE_ACCEL_UP : ICE_ACCEL_DOWN;
    ball.vx += (target - ball.vx) * Math.min(1, rate * dt);
  } else {
    ball.vx = (input.right ? MOVE_SPEED : 0) - (input.left ? MOVE_SPEED : 0);
  }

  if (ball.activeTrait === 'ice' || ball.activeTrait === 'iron' || ball.activeTrait === 'cloud') {
    ball.effectTimer -= dt;
    if (ball.effectTimer <= 0) {
      const messages = { ice: '얼음 효과 종료', iron: '철구슬 효과 종료', cloud: '구름 효과 종료' };
      clearActiveTrait(messages[ball.activeTrait]);
    }
  }

  const gravityMult =
    ball.activeTrait === 'cloud' ? CLOUD_GRAVITY_MULT : ball.activeTrait === 'iron' ? IRON_GRAVITY_MULT : 1;
  ball.vy += GRAVITY * gravityMult * dt;

  const prevBottom = ball.y + BALL_RADIUS;
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  if (ball.x - BALL_RADIUS < 0) ball.x = BALL_RADIUS;

  // ceiling collision: only iron's tiny bounce stays low enough to avoid this
  for (const c of ceilings) {
    if (ball.x >= c.xStart && ball.x <= c.xEnd && ball.y - BALL_RADIUS <= c.y) {
      failRun('천장에 부딪혔다 — 철구슬로 낮게 통과해야 한다');
      return;
    }
  }

  for (const pit of pits) {
    if (ball.x >= pit.xStart && ball.x <= pit.xEnd && ball.y + BALL_RADIUS >= pit.y) {
      failRun('가시밭에 떨어졌다 — 얼음으로 건너뛰어야 한다');
      return;
    }
  }

  const support = ball.vy >= 0 ? getSupportPlatform(ball.x, prevBottom, ball.y + BALL_RADIUS) : null;
  if (support) {
    ball.y = support.y - BALL_RADIUS;

    // trait is only granted by actually landing on its island -- flying near it at height doesn't
    // count, so picking one up always means a deliberate detour off the main path, not a flyby.
    // touching it overwrites whatever was already pending, same as before.
    if (support.trait && !support.used) {
      support.used = true;
      ball.pendingTrait = support.trait;
      pushToast(`${TRAIT_LABELS[support.trait]} 획득 — Space로 사용`);
    }

    // landing zones right after a hazard neutralize any leftover duration-based effect (cloud/iron
    // stay active across several bounces) -- otherwise a stray float/heavy landing here would carry
    // into the next island's expected normal-bounce height as an unpredictably huge or short bounce.
    // exceptTrait guards this section's own trait: the ball also lands on this same ground after
    // visiting this section's own island, and that one must survive to actually get used.
    if (support.resetTrait && ball.activeTrait && ball.activeTrait !== support.exceptTrait) clearActiveTrait();

    if (support.goal) {
      winRun();
      return;
    }

    if (ball.activeTrait === 'rubber') {
      ball.vy = BOUNCE_VELOCITY * RUBBER_BOUNCE_MULT;
      clearActiveTrait('탱탱볼 효과로 높이 튀어올랐다');
    } else if (ball.activeTrait === 'iron') {
      ball.vy = BOUNCE_VELOCITY * IRON_BOUNCE_MULT; // stays heavy until the duration timer clears it
    } else if (ball.activeTrait === 'cloud') {
      ball.vy = BOUNCE_VELOCITY; // stays floaty across several bounces until the duration timer clears it
    } else {
      ball.vy = BOUNCE_VELOCITY;
    }
  } else if (ball.y > floorY + 400) {
    failRun('떨어졌다 — 다시 시작한다');
    return;
  }

  const targetCamera = ball.x - canvas.width * 0.4;
  cameraX = Math.max(0, Math.min(targetCamera, Math.max(0, levelWidth - canvas.width)));

  toasts = toasts.filter((t) => (t.life -= dt) > 0);
}

function drawSpikes(xStart, xEnd, y, dir) {
  // dir: -1 = spikes point up (floor hazard), 1 = spikes point down (ceiling hazard)
  const SPIKE_W = 22;
  const count = Math.max(1, Math.round((xEnd - xStart) / SPIKE_W));
  const w = (xEnd - xStart) / count;
  ctx.fillStyle = '#ef4444';
  for (let i = 0; i < count; i++) {
    const x0 = xStart + i * w;
    const x1 = x0 + w;
    const xm = x0 + w / 2;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.lineTo(xm, y + dir * 18);
    ctx.closePath();
    ctx.fill();
  }
}

function drawIntro() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#232837';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const lines = [
    '방향키(←/→) 또는 A/D로 공을 움직인다',
    '발판 위 특성(색+이름표)을 밟아 얻고, Space로 발동한다',
    '초록 발판에 닿으면 성공, 천장·구덩이에 닿으면 실패한다',
    '',
    '아무 키나 누르거나 화면을 클릭하면 시작',
  ];

  ctx.textAlign = 'center';
  ctx.fillStyle = '#4ade80';
  ctx.font = 'bold 26px sans-serif';
  ctx.fillText('바운스볼 트리거 퍼즐', cx, cy - 90);

  ctx.fillStyle = '#e8eaf2';
  ctx.font = '16px sans-serif';
  lines.forEach((line, i) => ctx.fillText(line, cx, cy - 30 + i * 28));
  ctx.textAlign = 'left';
}

function render() {
  if (showIntro) {
    drawIntro();
    return;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(-cameraX, 0);

  for (const p of platforms) {
    ctx.fillStyle = p.goal ? '#4ade80' : p.ceiling ? '#a3a3a3' : '#3a4059';
    ctx.fillRect(p.xStart, p.y, p.xEnd - p.xStart, 6);
  }

  for (const pit of pits) drawSpikes(pit.xStart, pit.xEnd, pit.y, -1);

  for (const c of ceilings) {
    // a thick solid slab reaching off the top of the screen, not a thin line -- reads unmistakably
    // as a real ceiling you cannot fly up past, not open space with decoration hanging in it.
    const slabTop = -2000;
    ctx.fillStyle = '#4b5163';
    ctx.fillRect(c.xStart, slabTop, c.xEnd - c.xStart, c.y - slabTop);
    ctx.strokeStyle = '#1c1f2e';
    ctx.lineWidth = 3;
    ctx.strokeRect(c.xStart, slabTop, c.xEnd - c.xStart, c.y - slabTop);
    // diagonal hatching along the underside to further sell "solid mass", not a floating bar
    ctx.save();
    ctx.beginPath();
    ctx.rect(c.xStart, slabTop, c.xEnd - c.xStart, c.y - slabTop);
    ctx.clip();
    ctx.strokeStyle = '#2f3444';
    ctx.lineWidth = 2;
    for (let hx = c.xStart - 40; hx < c.xEnd + 40; hx += 24) {
      ctx.beginPath();
      ctx.moveTo(hx, c.y);
      ctx.lineTo(hx + 40, c.y - 40);
      ctx.stroke();
    }
    ctx.restore();
    drawSpikes(c.xStart, c.xEnd, c.y, 1);
  }

  for (const trigger of triggers) {
    const cx = (trigger.xStart + trigger.xEnd) / 2;
    ctx.save();
    ctx.translate(cx, trigger.y - 16);
    ctx.rotate(Math.PI / 4);
    if (trigger.used) {
      ctx.strokeStyle = '#3a4059';
      ctx.lineWidth = 2;
      ctx.strokeRect(-10, -10, 20, 20);
    } else {
      // trait is shown before touching, so there's nothing to misread up on the island
      ctx.fillStyle = TRAIT_COLORS[trigger.trait];
      ctx.strokeStyle = '#1c1f2e';
      ctx.lineWidth = 2;
      ctx.fillRect(-10, -10, 20, 20);
      ctx.strokeRect(-10, -10, 20, 20);
    }
    ctx.restore();

    if (!trigger.used) {
      ctx.fillStyle = '#e8eaf2';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(TRAIT_LABELS[trigger.trait], cx, trigger.y - 42);
      ctx.textAlign = 'left';
    }
  }

  ctx.fillStyle = TRAIT_COLORS[ball.activeTrait || ball.pendingTrait] || BALL_COLOR;
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, BALL_RADIUS, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();

  ctx.fillStyle = '#e8eaf2';
  ctx.font = '16px sans-serif';
  ctx.fillText(`보유 특성: ${ball.pendingTrait ? TRAIT_LABELS[ball.pendingTrait] : '없음'}`, 16, 28);
  if (ball.activeTrait) {
    ctx.fillText(`발동 중: ${TRAIT_LABELS[ball.activeTrait]}`, 16, 48);
  }
  ctx.fillText(`시간: ${runState.elapsed.toFixed(1)}초`, 16, 68);
  if (runState.status === 'won') {
    ctx.font = 'bold 28px sans-serif';
    ctx.fillStyle = '#4ade80';
    ctx.fillText(`클리어! ${runState.elapsed.toFixed(1)}초`, canvas.width / 2 - 90, canvas.height / 2);
  } else if (runState.status === 'lost') {
    ctx.font = 'bold 28px sans-serif';
    ctx.fillStyle = '#ef4444';
    ctx.fillText('실패', canvas.width / 2 - 30, canvas.height / 2);
  }

  ctx.font = '14px sans-serif';
  ctx.fillStyle = '#e8eaf2';
  toasts.forEach((toast, i) => {
    ctx.globalAlpha = Math.min(1, toast.life);
    ctx.fillText(toast.text, 16, 96 + i * 20);
    ctx.globalAlpha = 1;
  });
}

let lastTime = null;

function loop(timestamp) {
  if (lastTime === null) lastTime = timestamp;
  const dt = Math.min((timestamp - lastTime) / 1000, 1 / 30);
  lastTime = timestamp;

  update(dt);
  render();

  requestAnimationFrame(loop);
}

resizeCanvas();
resetBall();
requestAnimationFrame(loop);
