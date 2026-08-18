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
let platforms = [];
let ceilings = [];
let pitSpikes = null;
let triggers = [];
let toasts = []; // { text, life }
let levelWidth = 0;
let cameraX = 0;
let startPoint = { x: 0, y: 0 };

function resizeCanvas() {
  const wrap = document.getElementById('game-wrap');
  canvas.width = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  floorY = canvas.height - 40;
  elevatedY = floorY - 260;
}

const STEP_HEIGHT = 90; // px above the ground a normal bounce (~186px apex) comfortably clears
// a normal bounce's max apex from ground level is ~186.7px, so 200 is unreachable in a single
// bounce no matter the timing -- the island can only be reached by bouncing again from the step,
// never directly from the ground, which is what actually makes this a two-tier staircase.
const ISLAND_HEIGHT = 200; // px above the ground -- reached via the step, not directly

function buildLevel() {
  // world-space layout. sections: rubber ledge -> cloud glide -> iron tunnel -> ice hazard -> goal.
  // the ground path is one continuous, unbroken route -- nothing about picking up a trait
  // interrupts forward progress. each trait sits two tiers above that path: a low step first,
  // then the trait island above the step. holding right at a steady pace carries the ball's
  // bounce apex past each tier before it's descended into pickup range, so neither the step nor
  // the island is ever touched by accident -- reaching the island takes two deliberate detours in
  // a row (ease off early to catch the step, then again to climb from the step to the island).
  platforms = [
    { xStart: 0, xEnd: 850, y: floorY }, // start
    { xStart: 120, xEnd: 200, y: floorY - STEP_HEIGHT }, // step up from the ground
    { xStart: 260, xEnd: 340, y: floorY - ISLAND_HEIGHT, trait: 'rubber', used: false }, // correct island, reached from the step
    { xStart: 400, xEnd: 480, y: floorY - ISLAND_HEIGHT, trait: 'iron', used: false }, // decoy: kills the bounce needed to reach the ledge
    // a two-tier launch falls for longer than a ground launch (it has extra height to lose before
    // reaching the ground below), so it covers more distance before its first landing -- but the
    // ground can't run too far past that landing spot either, since rubber's boost then has to
    // launch from there and still clear the gap ahead in one shot.

    { xStart: 1250, xEnd: 2250, y: elevatedY, resetTrait: true, exceptTrait: 'cloud' }, // ledge reached via rubber boost
    { xStart: 1360, xEnd: 1440, y: elevatedY - STEP_HEIGHT }, // step
    { xStart: 1510, xEnd: 1590, y: elevatedY - ISLAND_HEIGHT, trait: 'cloud', used: false }, // correct island
    { xStart: 1650, xEnd: 1730, y: elevatedY - ISLAND_HEIGHT, trait: 'rubber', used: false }, // decoy: extra height, not the glide distance the gap needs

    { xStart: 2750, xEnd: 3750, y: elevatedY, resetTrait: true, exceptTrait: 'iron' }, // landing after the wide glide -- also clears leftover cloud float
    { xStart: 2860, xEnd: 2940, y: elevatedY - STEP_HEIGHT }, // step
    { xStart: 3010, xEnd: 3090, y: elevatedY - ISLAND_HEIGHT, trait: 'iron', used: false }, // correct island
    { xStart: 3150, xEnd: 3230, y: elevatedY - ISLAND_HEIGHT, trait: 'cloud', used: false }, // decoy: normal-height bounce still hits the low ceiling
    // the island sits above the ceiling's own height threshold, so the ball needs real room
    // after it to actually fall low enough (not just return to island height) before the low
    // ceiling begins -- same reasoning as the rubber ground above, extra margin here too.

    { xStart: 3750, xEnd: 4090, y: elevatedY, ceiling: true }, // low tunnel: only iron's tiny bounce fits

    { xStart: 4090, xEnd: 5400, y: elevatedY, resetTrait: true, exceptTrait: 'ice' }, // after tunnel + ice runway -- also clears leftover heavy iron
    { xStart: 4200, xEnd: 4280, y: elevatedY - STEP_HEIGHT }, // step
    { xStart: 4350, xEnd: 4430, y: elevatedY - ISLAND_HEIGHT, trait: 'ice', used: false }, // correct island
    { xStart: 4490, xEnd: 4570, y: elevatedY - ISLAND_HEIGHT, trait: 'rubber', used: false }, // decoy: more height, not the speed needed to clear the pit
    // no platform from 5400 to 5800: a real pit, spikes at the bottom (see pitSpikes).
    // normal/other bounces (~383px) fall short and drop in; only ice's speed clears it.
    { xStart: 5800, xEnd: 6800, y: elevatedY, goal: true }, // goal — wide, since ice's speed can carry the landing far past the pit
  ];

  ceilings = platforms
    .filter((p) => p.ceiling)
    .map((p) => ({ xStart: p.xStart, xEnd: p.xEnd, y: p.y - 100 }));

  pitSpikes = { xStart: 5400, xEnd: 5800, y: elevatedY + 140 };

  // trait is shown before touching (color + label) on the island only -- steps are plain, unmarked
  // stairs. the trait is granted only on an actual landing on the island (see update()), not by
  // flying near it, so grabbing it always means physically climbing both tiers above the path.
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

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat) {
    e.preventDefault();
    if (runState.status === 'playing') useTrait();
  }
  handleKey(e, true);
});
window.addEventListener('keyup', (e) => handleKey(e, false));
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

  if (pitSpikes && ball.x >= pitSpikes.xStart && ball.x <= pitSpikes.xEnd && ball.y + BALL_RADIUS >= pitSpikes.y) {
    failRun('가시밭에 떨어졌다 — 얼음으로 건너뛰어야 한다');
    return;
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

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(-cameraX, 0);

  for (const p of platforms) {
    ctx.fillStyle = p.goal ? '#4ade80' : p.ceiling ? '#a3a3a3' : '#3a4059';
    ctx.fillRect(p.xStart, p.y, p.xEnd - p.xStart, 6);
  }

  if (pitSpikes) drawSpikes(pitSpikes.xStart, pitSpikes.xEnd, pitSpikes.y, -1);

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
