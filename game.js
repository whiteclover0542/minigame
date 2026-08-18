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

const runState = { status: 'playing', timer: 0 }; // 'playing' | 'won' | 'lost'

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

function buildLevel() {
  // world-space layout. sections: rubber ledge -> cloud glide -> iron tunnel -> ice hazard -> goal.
  platforms = [
    { xStart: 0, xEnd: 500, y: floorY }, // start — wide enough that the boosted bounce still lands before the edge
    { xStart: 900, xEnd: 1300, y: elevatedY }, // ledge reached via rubber boost
    { xStart: 1800, xEnd: 2050, y: elevatedY }, // landing after the wide glide
    { xStart: 2050, xEnd: 2390, y: elevatedY, ceiling: true }, // low tunnel: only iron's tiny bounce fits
    // after the tunnel: long enough that the first ice-boosted bounce (up to ~840px) lands
    // back on solid ground instead of landing mid-pit -- the *next* bounce launches right at
    // the edge with vx already maxed, which is what actually needs to clear the pit.
    { xStart: 2390, xEnd: 3490, y: elevatedY }, // after tunnel + ice runway
    // no platform from 3490 to 3890: a real pit, spikes at the bottom (see pitSpikes).
    // normal/other bounces (~383px) fall short and drop in; only ice's speed clears it.
    { xStart: 3890, xEnd: 4890, y: elevatedY, goal: true }, // goal — wide, since ice's speed can carry the landing far past the pit
  ];

  ceilings = platforms
    .filter((p) => p.ceiling)
    .map((p) => ({ xStart: p.xStart, xEnd: p.xEnd, y: p.y - 100 }));

  pitSpikes = { xStart: 3490, xEnd: 3890, y: elevatedY + 140 };

  triggers = [
    { xStart: 100, xEnd: 180, y: floorY, trait: 'rubber', used: false },
    { xStart: 950, xEnd: 1030, y: elevatedY, trait: 'cloud', used: false },
    { xStart: 1850, xEnd: 1930, y: elevatedY, trait: 'iron', used: false },
    { xStart: 2440, xEnd: 2520, y: elevatedY, trait: 'ice', used: false },
  ];

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

function checkTriggerPickup() {
  if (ball.pendingTrait) return; // already carrying an unused trait
  for (const trigger of triggers) {
    if (trigger.used) continue;
    const inX = ball.x + BALL_RADIUS >= trigger.xStart && ball.x - BALL_RADIUS <= trigger.xEnd;
    const inY = ball.y >= trigger.y - 220 && ball.y <= trigger.y + BALL_RADIUS;
    if (inX && inY) {
      trigger.used = true;
      ball.pendingTrait = trigger.trait;
      pushToast(`${TRAIT_LABELS[trigger.trait]} 획득 — Space로 사용`);
      break;
    }
  }
}

function getSupportPlatform(x) {
  // topmost platform under this x. direction is handled by the vy>=0 guard at the call site,
  // not here -- filtering on the ball's current y would let a fast fall (e.g. iron's gravity)
  // tunnel through a platform whenever one frame's step lands past its y.
  let best = null;
  for (const p of platforms) {
    if (x < p.xStart || x > p.xEnd) continue;
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

  checkTriggerPickup();

  if (pitSpikes && ball.x >= pitSpikes.xStart && ball.x <= pitSpikes.xEnd && ball.y + BALL_RADIUS >= pitSpikes.y) {
    failRun('가시밭에 떨어졌다 — 얼음으로 건너뛰어야 한다');
    return;
  }

  const support = getSupportPlatform(ball.x);
  if (support && ball.vy >= 0 && prevBottom <= support.y && ball.y + BALL_RADIUS >= support.y) {
    ball.y = support.y - BALL_RADIUS;

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
    ctx.fillStyle = '#6b6b6b';
    ctx.fillRect(c.xStart, c.y - 6, c.xEnd - c.xStart, 6);
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
      ctx.fillStyle = '#8b93ab'; // neutral — identical for every trait until touched
      ctx.fillRect(-10, -10, 20, 20);
    }
    ctx.restore();
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
  if (runState.status === 'won') {
    ctx.font = 'bold 28px sans-serif';
    ctx.fillStyle = '#4ade80';
    ctx.fillText('클리어!', canvas.width / 2 - 50, canvas.height / 2);
  } else if (runState.status === 'lost') {
    ctx.font = 'bold 28px sans-serif';
    ctx.fillStyle = '#ef4444';
    ctx.fillText('실패', canvas.width / 2 - 30, canvas.height / 2);
  }

  ctx.font = '14px sans-serif';
  ctx.fillStyle = '#e8eaf2';
  toasts.forEach((toast, i) => {
    ctx.globalAlpha = Math.min(1, toast.life);
    ctx.fillText(toast.text, 16, 76 + i * 20);
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
