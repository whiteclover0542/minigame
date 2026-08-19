const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

const GRAVITY = 1800; // px/s^2
const BOUNCE_VELOCITY = -820; // px/s, upward
const MOVE_SPEED = 420; // px/s -- card 3 final: kept at the original default. A slower candidate
// (300) was tested against 4 skill tiers and cleared hazard 1 less often in every tier, not more,
// so lowering speed doesn't help this level's actual challenge (see PROGRESS.md 카드 3 기록).
const BALL_RADIUS = 18;

// per-trait tuning: how each effect bends the base physics while active
const CLOUD_GRAVITY_MULT = 0.32; // falls slowly -> glides farther before landing. raised from 0.28
// (less floaty, lower peak arc) so it clears track 3's gap without sailing so high above it --
// verified by simulation to still clear reliably across varied click timing; anything above ~0.4
// starts falling short of the gap.
const CLOUD_DURATION = 1.6; // s, stays floaty across several bounces, not just one
const IRON_GRAVITY_MULT = 2.6; // falls fast
const IRON_BOUNCE_MULT = 0.15; // barely bounces back -> reads as a heavy thud
const IRON_DURATION = 3; // s, stays heavy across several landings, not just one
const RUBBER_BOUNCE_MULT = 1.7; // next bounce launches much higher
const NORMAL_BOUNCE_SPAN = MOVE_SPEED * ((2 * -BOUNCE_VELOCITY) / GRAVITY); // px covered by one
// ordinary landing-to-landing bounce -- used to hold rubber's boost until the last such bounce
// before a gap (see trackClimb / update()'s landing branch), instead of spending it wherever the
// ball happens to land right after Space is pressed.
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

// per-trait trail look: purely cosmetic (spawnTrail/spawnClearBurst below are gated by reduceMotion
// the same way card 5's screen shake is), so tuning these never touches physics or collision.
const TRAIL_CONFIG = {
  cloud: { interval: 0.03, color: '#ffffff', size: [4, 7], life: 0.9, vx: [-20, 20], vy: [-40, -10], drag: 0.4, shape: 'circle' },
  rubber: { interval: 0.02, color: '#fb7185', size: [3, 5], life: 0.35, vx: [-30, 30], vy: [-30, 30], drag: 2, shape: 'circle' },
  iron: { interval: 0.02, color: '#9ca3af', size: [2, 4], life: 0.4, vx: [-15, 15], vy: [20, 80], drag: 1, shape: 'spark' },
  ice: { interval: 0.015, color: '#a5f3fc', size: [3, 6], life: 0.3, vx: [-10, 10], vy: [-10, 10], drag: 3, shape: 'shard' },
};

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
let pits = [];
let pickups = []; // clickable trait markers -- see pickupRow()
let triggers = [];
let toasts = []; // { text, life }
let particles = []; // { x, y, vx, vy, life, maxLife, color, size, shape, drag }
let trailSpawnTimer = 0;
let levelWidth = 0;
let cameraX = 0;
let startPoint = { x: 0, y: 0 };
let showIntro = true; // frozen title screen shown once before the first run starts

// card 4: bestClearTime survives across runs and reloads (localStorage); everything else in
// runState/ball is per-run and always wiped by resetBall(). loadBest() never throws -- a missing,
// empty, or corrupted save is treated the same as "no record yet" so a bad save can't break startup.
const SAVE_KEY = 'bounceball_save_v1';
let bestClearTime = loadBest();

function loadBest() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null; // no save yet -- default
    const parsed = JSON.parse(raw);
    if (typeof parsed.bestClearTime !== 'number' || !Number.isFinite(parsed.bestClearTime)) return null; // wrong shape -- default
    return parsed.bestClearTime;
  } catch {
    return null; // not valid JSON at all -- default
  }
}

function saveBest() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ bestClearTime }));
  } catch {
    // storage unavailable/full -- the run itself doesn't depend on this succeeding
  }
}

// global leaderboard: the single fastest clear time across every visitor, shared via Firebase
// Realtime Database. entirely optional -- if the SDK script didn't load (network issue, ad
// blocker) or the project isn't reachable, the game still runs fine with just the local record
// above; every call here is guarded so a Firebase failure never breaks gameplay.
const firebaseConfig = {
  apiKey: 'AIzaSyAX43FexJhm10mKsOVFxHahSJlBIou1YEY',
  authDomain: 'minigame-leaderboard-a100f.firebaseapp.com',
  databaseURL: 'https://minigame-leaderboard-a100f-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'minigame-leaderboard-a100f',
  storageBucket: 'minigame-leaderboard-a100f.firebasestorage.app',
  messagingSenderId: '8487419888',
  appId: '1:8487419888:web:9c8d44b1116094e09e2735',
};

let globalBestTime = null; // the fastest time on record, once loaded; stays null if there isn't one yet
let globalBestName = ''; // nickname attached to that time, if any
let globalBestLoaded = false; // distinguishes "still waiting on the first read" from "read back empty"
let globalBestRef = null;

function initGlobalLeaderboard() {
  try {
    if (typeof firebase === 'undefined') return; // SDK script didn't load -- play without it
    firebase.initializeApp(firebaseConfig);
    globalBestRef = firebase.database().ref('leaderboard/best');
    // live updates: if someone else beats the record while this page is open, the HUD picks it up
    globalBestRef.on('value', (snapshot) => {
      const val = snapshot.val();
      if (val && typeof val.time === 'number' && Number.isFinite(val.time)) {
        globalBestTime = val.time;
        globalBestName = typeof val.name === 'string' ? val.name : '';
      } else {
        globalBestTime = null;
        globalBestName = '';
      }
      globalBestLoaded = true;
    });
  } catch {
    globalBestRef = null; // any setup failure -- just don't show/update the global record
  }
}

// two-phase write, deciding whether to prompt from the database's own answer rather than the
// client's cached copy of the current best -- a stale/not-yet-loaded local cache must never be
// the reason a genuine record fails to prompt for a name. phase 1 atomically claims the record
// with a placeholder (empty) name if -- and only if -- this time is actually better; the
// transaction's result tells us whether that claim won. only then do we prompt, and phase 2
// fills the name in behind it (guarded so it can't clobber a time that moved on in the meantime).
function reportGlobalBest(time) {
  if (!globalBestRef) return;
  try {
    globalBestRef.transaction(
      (current) => {
        if (!current || typeof current.time !== 'number' || time < current.time) return { time, name: '' };
        return current; // no change -- someone else already holds a better time
      },
      (error, committed, snapshot) => {
        if (error || !committed) return; // offline, blocked, or not actually an improvement
        const val = snapshot && snapshot.val();
        if (!val || val.time !== time) return; // a concurrent better write won the race meanwhile
        promptGlobalBestName(time);
      }
    );
  } catch {
    // offline or blocked -- the local record above already saved fine either way
  }
}

function promptGlobalBestName(time) {
  let name = '';
  try {
    name = (window.prompt('전체 최고 기록 달성! 닉네임을 입력하세요 (최대 12자)', '') || '').trim().slice(0, 12);
  } catch {
    name = '';
  }
  if (!name) name = '익명';
  try {
    globalBestRef.transaction((current) => {
      if (current && current.time === time) return { time, name };
      return current; // the record moved on before the name landed -- leave it alone
    });
  } catch {
    // offline or blocked -- the time itself is already saved from phase 1 either way
  }
}

initGlobalLeaderboard();

function resizeCanvas() {
  const wrap = document.getElementById('game-wrap');
  const prevFloorY = floorY;
  canvas.width = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  floorY = canvas.height - 40;
  elevatedY = floorY - 260;

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
      for (const p of pickups) p.y += deltaY;
      ball.y += deltaY;
      startPoint.y += deltaY;
    }
  }
}

// trait pickups are clickable HUD-ish markers floating above the path, not physical platforms --
// grabbing one is a mouse click on its icon (see the canvas 'click' handler below), never a
// detour the ball has to fly to. that decouples the ball's forward run entirely from trait
// selection: the ball never has to leave its course, and a marker stays clickable on screen
// however long it's visible, so there's no "already passed it, go back" moment -- if the hazard
// it's for is still ahead, so is the click.
const PICKUP_HEIGHT = 300; // px above the path -- well clear of a normal bounce's own apex
// (~186.7px, see MOVE_SPEED/GRAVITY/BOUNCE_VELOCITY above), so the ball passing underneath never
// covers the icon even at a glance
const PICKUP_WIDTH = 100; // px, used only to place the icon's center
const PICKUP_GAP = 70; // px between adjacent markers in the same cluster
const ICON_SCALE = 4.2; // icons are drawn at a fixed ~9-10px base radius; this scales them up for readability
const PICKUP_ALPHA = 0.8; // slightly translucent so a marker never fully hides the path or hazard behind it
const PICKUP_CLICK_RADIUS = 46; // px, hit area matched to the scaled-up icon itself (no separate ring drawn)

// positions a row of trait markers so the *last* one's right edge lands at endX -- see buildLevel()
// for how each call picks endX (usually centered over the hazard those traits are for).
function pickupRow(baseY, endX, traits) {
  const y = baseY - PICKUP_HEIGHT;
  const markers = [];
  let x = endX;
  for (let i = traits.length - 1; i >= 0; i--) {
    const xStart = x - PICKUP_WIDTH;
    markers.unshift({ xStart, xEnd: x, y, trait: traits[i], used: false });
    x = xStart - PICKUP_GAP;
  }
  return markers;
}

// --- track modules -----------------------------------------------------------------------
// each track* function builds one self-contained hazard in LOCAL coordinates (its own x=0 is
// wherever it gets placed in the level) and returns { platforms, pickups, pits, width } -- always
// entering AND exiting at the same baseY, so any track can follow any other with no height
// mismatch at the seam. that's what makes them independently addable/reorderable (see buildLevel()
// below, which currently just chains them in a fixed list, and the loop that places them).
// every track's approach uses one of two shared lead lengths (see TRACK_LEAD_TALL/
// TRACK_LEAD_SPEED below) so consecutive tracks read at a consistent pace. each marker's exact
// spot within that approach is still individually tuned (see buildLevel()'s trackList) -- ice/
// cloud/rubber's speed or float can still be ramping up or down from whatever the previous track
// left it doing, which shifts exactly where a press has to land relative to the gap.
const TRACK_LEAD_TALL = 500; // approach length for rubber-climb / tunnel tracks
const TRACK_LEAD_SPEED = 450; // approach length for ice/cloud speed-gap tracks
const TRACK_LAND_WIDTH = 400; // landing platform width after every hazard -- generous so the
// exact landing spot (which varies with the trait used) always has solid ground under it

// rubber only: needs height (climbHeight) *and* distance together, since a normal bounce's own
// apex (~186.7px) can't reach any climb worth doing regardless of gap width. lands on a raised
// plateau, then free-falls back to baseY (no trait needed to go back down -- gravity does that
// part for free), so the track still exits at baseY like every other track.
function trackClimb(baseY, climbHeight, gapWidth, decoyTrait, markerX = 700) {
  const gapStart = TRACK_LEAD_TALL;
  const plateauStart = gapStart + gapWidth;
  const plateauEnd = plateauStart + 400;
  const landEnd = plateauEnd + TRACK_LAND_WIDTH;
  return {
    platforms: [
      // holdBoostUntilGap: rubber's boost only resolves at a landing, and a click can happen the
      // instant the marker scrolls into view -- long before the ball is anywhere near it. without
      // this, an early press launches the boost from wherever the ball happens to land right after,
      // which is often too far from the gap to clear it. see update()'s landing branch: it holds
      // the boost through ordinary bounces on this platform until the *last* one before xEnd, so
      // the launch point is always right at the gap regardless of when Space was actually pressed.
      { xStart: 0, xEnd: gapStart, y: baseY, holdBoostUntilGap: true },
      { xStart: plateauStart, xEnd: plateauEnd, y: baseY - climbHeight, resetTrait: true },
      { xStart: plateauEnd, xEnd: landEnd, y: baseY, resetTrait: true },
    ],
    pickups: pickupRow(baseY, markerX, [decoyTrait, 'rubber']),
    pits: [],
    width: landEnd,
  };
}

// ice: raw sustained speed across a flat gap (or, with usePit, the same gap dressed as a spike
// pit instead of open air -- physically identical, just fails a beat sooner and reads as a
// different hazard). a normal or iron-slowed bounce always falls short; only ice's boosted speed
// carries far enough.
function trackSpeedGap(baseY, gapWidth, decoyTrait, usePit, markerX = 500) {
  const gapStart = TRACK_LEAD_SPEED;
  const gapEnd = gapStart + gapWidth;
  const landEnd = gapEnd + TRACK_LAND_WIDTH;
  return {
    platforms: [
      { xStart: 0, xEnd: gapStart, y: baseY },
      { xStart: gapEnd, xEnd: landEnd, y: baseY, resetTrait: true },
    ],
    pickups: pickupRow(baseY, markerX, [decoyTrait, 'ice']),
    pits: usePit ? [{ xStart: gapStart, xEnd: gapEnd, y: baseY + 140 }] : [],
    width: landEnd,
  };
}

// cloud: a gap too wide for even rubber's single boosted leap (~650px, one shot, no continuous
// speed) but within reach of cloud's much longer per-bounce hang time.
function trackFloatGap(baseY, gapWidth, decoyTrait, markerX = 500) {
  const gapStart = TRACK_LEAD_SPEED;
  const gapEnd = gapStart + gapWidth;
  const landEnd = gapEnd + TRACK_LAND_WIDTH;
  return {
    platforms: [
      { xStart: 0, xEnd: gapStart, y: baseY },
      { xStart: gapEnd, xEnd: landEnd, y: baseY, resetTrait: true },
    ],
    pickups: pickupRow(baseY, markerX, [decoyTrait, 'cloud']),
    pits: [],
    width: landEnd,
  };
}

// iron: a low ceiling only its tiny, heavy bounce fits under -- any other trait's apex is well
// above it. tunnelWidth just varies how long iron's duration has to keep covering it.
function trackTunnel(baseY, tunnelWidth, decoyTrait, markerX = 700) {
  const tunnelStart = TRACK_LEAD_TALL;
  const tunnelEnd = tunnelStart + tunnelWidth;
  const landEnd = tunnelEnd + TRACK_LAND_WIDTH;
  return {
    platforms: [
      { xStart: 0, xEnd: tunnelStart, y: baseY },
      { xStart: tunnelStart, xEnd: tunnelEnd, y: baseY, ceiling: true },
      { xStart: tunnelEnd, xEnd: landEnd, y: baseY, resetTrait: true },
    ],
    pickups: pickupRow(baseY, markerX, [decoyTrait, 'iron']),
    pits: [],
    width: landEnd,
  };
}

const TRACKS_TO_CLEAR = 10; // how many random tracks make up one run, goal platform after the last

// the pool of track *types* to draw from -- each entry's marker x was tuned in ISOLATION (fresh
// launch at local x=0), not against any specific predecessor, and verified by simulating hundreds
// of random 15-track runs. each track's own approach is long enough that the exact bounce phase
// left over from whatever track came before it washes out well before its own marker/gap -- no
// per-transition tuning or forced phase reset needed for that to hold up.
function trackPool(baseY) {
  return [
    () => trackClimb(baseY, 260, 300, 'iron', 180), // rubber: climb + distance -- decoy iron kills the boost
    () => trackSpeedGap(baseY, 450, 'iron', false, 370), // ice: flat speed gap -- decoy iron barely moves
    () => trackFloatGap(baseY, 750, 'rubber', 350), // cloud: wide floaty gap -- decoy rubber's one leap falls short
    () => trackTunnel(baseY, 340, 'cloud', 190), // iron: low tunnel -- decoy cloud floats straight into the ceiling
    () => trackSpeedGap(baseY, 450, 'rubber', true, 370), // ice: spike pit -- decoy rubber's one leap isn't sustained speed
    () => trackClimb(baseY, 400, 200, 'ice', 180), // rubber: taller climb -- decoy ice has speed but no height
    () => trackTunnel(baseY, 550, 'cloud', 190), // iron: longer tunnel -- same decoy, needs iron's duration to last the whole stretch
  ];
}

const START_LEN = 400;
const GOAL_LEN = 1000;

// lays out one candidate random track list into absolute platforms/pickups/pits/ceilings --
// shared by the build-time trial run (simulateClear below) and the real build in buildLevel(), so
// there's exactly one place that turns a track list into level geometry.
function assembleLevel(trackList, baseY) {
  const platforms = [{ xStart: 0, xEnd: START_LEN, y: baseY }];
  const pickups = [];
  const pits = [];
  let cursor = START_LEN;
  for (const track of trackList) {
    for (const p of track.platforms) platforms.push({ ...p, xStart: p.xStart + cursor, xEnd: p.xEnd + cursor });
    for (const p of track.pickups) pickups.push({ ...p, xStart: p.xStart + cursor, xEnd: p.xEnd + cursor });
    for (const p of track.pits) pits.push({ ...p, xStart: p.xStart + cursor, xEnd: p.xEnd + cursor });
    cursor += track.width;
  }
  platforms.push({ xStart: cursor, xEnd: cursor + GOAL_LEN, y: baseY, goal: true });
  const ceilings = platforms.filter((p) => p.ceiling).map((p) => ({ xStart: p.xStart, xEnd: p.xEnd, y: p.y - 100 }));
  return { platforms, pickups, pits, ceilings };
}

// runs a self-contained physics trial against one candidate level: hold right the whole way,
// click+activate each correct trait's marker the instant the ball reaches it (the same rule real
// play follows), and report whether that actually reaches the goal. this is what replaces trying
// to make every track robust to *any* bounce phase a random predecessor could hand it (which
// turned out to still fail routinely even for tracks verified safe in isolation -- see PROGRESS)
// or visibly correcting the ball's position at every track boundary (visible as a stutter). instead
// buildLevel() below just keeps rolling a new random order until one of them, played this exact
// way, provably reaches the goal with zero position correction -- so the level the player actually
// gets was already proven completable before the run even starts.
function simulateClear(level, baseY) {
  const correctPickups = level.pickups.filter((p, i) => i % 2 === 1);
  let x = 60,
    y = baseY - BALL_RADIUS,
    vx = 0,
    vy = BOUNCE_VELOCITY;
  let activeTrait = null,
    effectTimer = 0,
    pickupIdx = 0;
  const dt = 1 / 60;
  for (let t = 0; t < 90; t += dt) {
    if (pickupIdx < correctPickups.length && x >= correctPickups[pickupIdx].xEnd) {
      const trait = correctPickups[pickupIdx].trait;
      pickupIdx++;
      activeTrait = trait;
      effectTimer = trait === 'ice' ? ICE_DURATION : trait === 'iron' ? IRON_DURATION : trait === 'cloud' ? CLOUD_DURATION : 0;
    }
    if (activeTrait === 'ice') {
      const rate = ICE_MOVE_SPEED > Math.abs(vx) ? ICE_ACCEL_UP : ICE_ACCEL_DOWN;
      vx += (ICE_MOVE_SPEED - vx) * Math.min(1, rate * dt);
    } else {
      vx = MOVE_SPEED;
    }
    if (activeTrait === 'ice' || activeTrait === 'iron' || activeTrait === 'cloud') {
      effectTimer -= dt;
      if (effectTimer <= 0) activeTrait = null;
    }
    const gravityMult = activeTrait === 'cloud' ? CLOUD_GRAVITY_MULT : activeTrait === 'iron' ? IRON_GRAVITY_MULT : 1;
    vy += GRAVITY * gravityMult * dt;
    const prevBottom = y + BALL_RADIUS;
    const prevX = x;
    x += vx * dt;
    y += vy * dt;
    if (x - BALL_RADIUS < 0) x = BALL_RADIUS;
    // matches update()'s position-based resetTrait crossing check exactly (see there for why it's
    // entry-triggered, not "currently inside")
    for (const p of level.platforms) {
      if (p.resetTrait && prevX < p.xStart && x >= p.xStart && x <= p.xEnd && activeTrait && activeTrait !== p.exceptTrait) {
        activeTrait = null;
        break;
      }
    }
    for (const c of level.ceilings) if (x >= c.xStart && x <= c.xEnd && y - BALL_RADIUS <= c.y) return false;
    for (const p of level.pits) if (x >= p.xStart && x <= p.xEnd && y + BALL_RADIUS >= p.y) return false;
    const nextBottom = y + BALL_RADIUS;
    let support = null;
    if (vy >= 0) {
      for (const p of level.platforms) {
        if (x < p.xStart || x > p.xEnd) continue;
        if (prevBottom > p.y || nextBottom < p.y) continue;
        if (!support || p.y < support.y) support = p;
      }
    }
    if (support) {
      y = support.y - BALL_RADIUS;
      if (support.goal) return true;
      if (activeTrait === 'rubber') {
        if (support.holdBoostUntilGap && x + NORMAL_BOUNCE_SPAN <= support.xEnd) {
          vy = BOUNCE_VELOCITY;
        } else {
          vy = BOUNCE_VELOCITY * RUBBER_BOUNCE_MULT;
          activeTrait = null;
        }
      } else if (activeTrait === 'iron') {
        vy = BOUNCE_VELOCITY * IRON_BOUNCE_MULT;
      } else {
        vy = BOUNCE_VELOCITY;
      }
    } else if (y > baseY + 400) {
      return false;
    }
  }
  return false; // timed out -- treat like a fail rather than risk an infinite level
}

function buildLevel() {
  const baseY = elevatedY; // every track enters and exits at this one height (see the track*
  // functions above) -- that shared contract is what lets them be listed/chained in any order.
  const pool = trackPool(baseY);

  // keep rolling a random order until simulateClear proves it's actually completable end to end --
  // see that function's comment for why this replaces per-boundary position correction. the odds
  // of any single random order clearing are low (much of the search space fails), so this typically
  // takes dozens of tries, but each is only a simulated run, not a real one -- the cap is sized
  // generously (a failure to find any working order in this many tries would be astronomically
  // unlikely, not a realistic case to hit) rather than tuned tight to the typical attempt count.
  let trackList, level;
  for (let attempt = 0; attempt < 3000; attempt++) {
    trackList = Array.from({ length: TRACKS_TO_CLEAR }, () => pool[Math.floor(Math.random() * pool.length)]());
    level = assembleLevel(trackList, baseY);
    if (simulateClear(level, baseY)) break;
  }

  platforms = level.platforms;
  pickups = level.pickups;
  pits = level.pits;
  ceilings = level.ceilings;

  // trait is shown before clicking (color + label, see render()) and stays clickable for as long
  // as it's on screen -- clicking it grants it immediately, overwriting whatever was already
  // pending, so a wrong pick is corrected with another click, never a walk back to fix it.
  triggers = pickups;

  const last = platforms[platforms.length - 1];
  levelWidth = last.xEnd + 200;
  startPoint = { x: 60, y: baseY - BALL_RADIUS };
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
  particles = [];
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

// finds the closest un-used pickup whose icon center is within click range of a world-space
// point, or null if none qualify -- shared by the click handler below and the hover cursor.
function findPickupAt(worldX, worldY) {
  let best = null;
  let bestDist = PICKUP_CLICK_RADIUS;
  for (const p of pickups) {
    if (p.used) continue;
    const cx = (p.xStart + p.xEnd) / 2;
    const cy = p.y - 16;
    const dist = Math.hypot(worldX - cx, worldY - cy);
    if (dist <= bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  return best;
}

// mouse coordinates are screen-space; the world is shifted left by cameraX (see render()), so
// adding it back maps a click to the same world x the icon was drawn at. y isn't camera-shifted
// (only the shake offset touches it, and that's small enough to ignore for a click hit-test).
function screenToWorld(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left + cameraX, y: e.clientY - rect.top };
}

function handleCanvasClick(e) {
  if (showIntro) {
    dismissIntro();
    return; // this click only dismisses the title screen, not also a pickup
  }
  if (paused || runState.status !== 'playing') return;
  const { x, y } = screenToWorld(e);
  const hit = findPickupAt(x, y);
  if (hit) {
    hit.used = true;
    ball.pendingTrait = hit.trait;
    pushToast(`${TRAIT_LABELS[hit.trait]} 획득 — Space로 사용`);
  }
}

function handleCanvasMouseMove(e) {
  if (showIntro || paused || runState.status !== 'playing') {
    canvas.style.cursor = 'default';
    return;
  }
  const { x, y } = screenToWorld(e);
  canvas.style.cursor = findPickupAt(x, y) ? 'pointer' : 'default';
}

let paused = false;

// card 5: a felt event (screen shake on failure) plus a way to turn it down. reduceMotion only ever
// gates whether the shake OFFSET gets applied in render() -- the timer itself still counts down and
// failRun()/collision detection are completely untouched, so turning motion down never changes what
// counts as a hit, only whether the camera visibly jolts about it.
const SHAKE_DURATION = 0.35; // s
const SHAKE_MAGNITUDE = 10; // px, at full strength (t=1), decaying to 0 by the end
let shakeTimer = 0;
let reduceMotion = false;

const motionToggleBtn = document.getElementById('motion-toggle');
motionToggleBtn.addEventListener('click', () => {
  reduceMotion = !reduceMotion;
  motionToggleBtn.textContent = `움직임 감소: ${reduceMotion ? '켬' : '끔'}`;
  motionToggleBtn.setAttribute('aria-pressed', String(reduceMotion));
});

// re-shows the intro screen's controls/rules text from inside the pause menu, for anyone who
// dismissed it too fast at the start and wants another look mid-run without losing their run.
let showHelp = false;
const gameWrapEl = document.getElementById('game-wrap');
const helpToggleBtn = document.getElementById('help-toggle');
const helpCloseBtn = document.getElementById('help-close');

function setShowHelp(next) {
  showHelp = next;
  gameWrapEl.classList.toggle('is-help', showHelp);
}

helpToggleBtn.addEventListener('click', () => setShowHelp(true));
helpCloseBtn.addEventListener('click', () => setShowHelp(false));

function togglePause() {
  paused = !paused;
  if (!paused) setShowHelp(false); // never leave the help screen showing over an unpaused game
  pushToast(paused ? '일시정지 — Esc로 재개' : '재개');
  gameWrapEl.classList.toggle('is-paused', paused);
}

// pause-menu escape hatch for "I want a fresh run right now" -- same reset resetBall() already
// does on a normal fail/restart cycle, just triggered manually instead of by the fail timer, and
// closes the pause overlay behind it so the player lands straight back in a playing run.
const restartToggleBtn = document.getElementById('restart-toggle');
restartToggleBtn.addEventListener('click', () => {
  resetBall();
  paused = false;
  setShowHelp(false);
  gameWrapEl.classList.remove('is-paused');
});

window.addEventListener('keydown', (e) => {
  if (showIntro) {
    dismissIntro();
    return; // this keypress only dismisses the title screen, not also a game action
  }
  if (e.code === 'Escape' && !e.repeat) {
    e.preventDefault();
    if (showHelp) {
      setShowHelp(false); // step back to the plain pause menu, not straight to resuming play
    } else {
      togglePause();
    }
    return; // pausing/resuming/closing help is the only thing this keypress should do
  }
  if (e.code === 'Space' && !e.repeat) {
    e.preventDefault();
    if (runState.status === 'playing' && !paused) useTrait();
  }
  handleKey(e, true);
});
window.addEventListener('keyup', (e) => handleKey(e, false));
canvas.addEventListener('click', handleCanvasClick);
canvas.addEventListener('mousemove', handleCanvasMouseMove);
window.addEventListener('resize', () => {
  resizeCanvas();
});

// losing focus (alt-tab, clicking outside the page) never fires keyup for whatever was held --
// without this, a key held at the moment of blur stays "down" forever, so the ball keeps drifting
// on its own after focus returns even though nothing is physically pressed anymore.
function releaseHeldInput() {
  input.left = false;
  input.right = false;
}
window.addEventListener('blur', releaseHeldInput);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) releaseHeldInput();
});

function pushToast(text) {
  toasts.push({ text, life: 3.5 });
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

// trail behind the ball, styled per active trait -- reads as an extra cue for which effect is
// live, on top of the HUD text. reduceMotion gates spawning only (same as the shake in card 5):
// particles already in flight still finish fading instead of vanishing abruptly on toggle.
function spawnTrail(dt) {
  if (reduceMotion || !ball.activeTrait) return;
  const cfg = TRAIL_CONFIG[ball.activeTrait];
  trailSpawnTimer -= dt;
  while (trailSpawnTimer <= 0) {
    trailSpawnTimer += cfg.interval;
    particles.push({
      x: ball.x + rand(-6, 6),
      y: ball.y + rand(-6, 6),
      vx: rand(cfg.vx[0], cfg.vx[1]) - ball.vx * 0.15, // slight pull opposite the ball's own motion so it reads as being left behind, not carried along
      vy: rand(cfg.vy[0], cfg.vy[1]),
      life: cfg.life,
      maxLife: cfg.life,
      color: cfg.color,
      size: rand(cfg.size[0], cfg.size[1]),
      shape: cfg.shape,
      drag: cfg.drag,
    });
  }
}

// clear-time payoff: a burst radiating from the goal landing spot. cosmetic only -- winRun()'s
// record check/save above it is unaffected either way.
function spawnClearBurst() {
  if (reduceMotion) return;
  const count = 28;
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + rand(-0.15, 0.15);
    const speed = rand(120, 260);
    particles.push({
      x: ball.x,
      y: ball.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: rand(0.5, 0.9),
      maxLife: 0.9,
      color: '#4ade80',
      size: rand(3, 6),
      shape: 'circle',
      drag: 1.5,
    });
  }
}

function updateParticles(dt) {
  if (!particles.length) return;
  for (const p of particles) {
    p.life -= dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const dragMult = Math.max(0, 1 - p.drag * dt);
    p.vx *= dragMult;
    p.vy *= dragMult;
  }
  particles = particles.filter((p) => p.life > 0);
}

function drawParticles() {
  for (const p of particles) {
    const t = Math.max(0, p.life / p.maxLife);
    const s = p.size * (0.5 + 0.5 * t);
    ctx.globalAlpha = t;
    ctx.fillStyle = p.color;
    if (p.shape === 'shard') {
      // elongated sliver oriented along its own velocity -- reads as ice speed, not generic dust
      const angle = Math.atan2(p.vy, p.vx);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(angle);
      ctx.fillRect(-s * 1.6, -s * 0.4, s * 3.2, s * 0.8);
      ctx.restore();
    } else if (p.shape === 'spark') {
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, s, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
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
  shakeTimer = SHAKE_DURATION; // always set regardless of reduceMotion -- render() decides whether it's felt
}

function winRun() {
  runState.status = 'won';
  runState.timer = 2;
  // best record is the one thing that survives resetBall() -- it's compared and saved here, once,
  // rather than continuously, so a run that never finishes can't affect it.
  if (bestClearTime === null || runState.elapsed < bestClearTime) {
    bestClearTime = runState.elapsed;
    saveBest();
    pushToast('목표 도달! 최고 기록 갱신');
  } else {
    pushToast('목표 도달! 클리어');
  }
  reportGlobalBest(runState.elapsed); // separate from the local record above -- only takes effect
  // if this run also beats whatever every other visitor has managed so far
  spawnClearBurst();
}

function update(dt) {
  if (showIntro) return; // nothing moves until the player dismisses the title screen
  if (paused) return; // fully frozen -- no physics, no toast countdown, no win/lose auto-restart timer

  if (shakeTimer > 0) shakeTimer = Math.max(0, shakeTimer - dt);
  updateParticles(dt); // keeps animating through the win/lose freeze window too, same as shakeTimer above

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
  const prevX = ball.x;
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  if (ball.x - BALL_RADIUS < 0) ball.x = BALL_RADIUS;

  // no per-track-boundary position correction here -- buildLevel() only ever commits to a random
  // order after simulateClear() has already proven that exact order reaches the goal with vanilla
  // physics, so there's nothing to silently patch up at runtime. see PROGRESS for what was tried
  // before this (forcing a clean bounce at every boundary) and why it always read as a stutter.

  // each track's landing zone neutralizes any leftover duration-based effect (ice/cloud/iron stay
  // active across several bounces) the moment the ball *enters* it -- not gated to an actual
  // touchdown there, because a still-boosted bounce (ice right after clearing its own gap, say)
  // can be going fast/far enough to sail clean over a merely-landed-on check and carry its effect
  // into the next track, which was tuned assuming a normal entry. this only fires on the crossing
  // (prevX outside, current x inside), not for every frame already inside -- otherwise clicking a
  // *new* trait for the next hazard while still standing in an earlier track's landing zone would
  // wipe it out the instant it's activated, since a click doesn't require having left first.
  // exceptTrait guards a track's own trait on its own landing zone (picked up and re-landed on
  // before it's actually used).
  for (const p of platforms) {
    if (
      p.resetTrait &&
      prevX < p.xStart &&
      ball.x >= p.xStart &&
      ball.x <= p.xEnd &&
      ball.activeTrait &&
      ball.activeTrait !== p.exceptTrait
    ) {
      clearActiveTrait();
      break;
    }
  }

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

    if (support.goal) {
      winRun();
      return;
    }

    if (ball.activeTrait === 'rubber') {
      if (support.holdBoostUntilGap && ball.x + NORMAL_BOUNCE_SPAN <= support.xEnd) {
        // another ordinary bounce still fits on this platform before the gap starts -- hold the
        // boost rather than spend it here, so an early press doesn't launch short (see trackClimb).
        ball.vy = BOUNCE_VELOCITY;
      } else {
        ball.vy = BOUNCE_VELOCITY * RUBBER_BOUNCE_MULT;
        clearActiveTrait('탱탱볼 효과로 높이 튀어올랐다');
      }
    } else if (ball.activeTrait === 'iron') {
      ball.vy = BOUNCE_VELOCITY * IRON_BOUNCE_MULT; // stays heavy until the duration timer clears it
    } else {
      ball.vy = BOUNCE_VELOCITY; // cloud stays floaty via reduced gravity above, not a different bounce velocity
    }
  } else if (ball.y > floorY + 400) {
    failRun('떨어졌다 — 다시 시작한다');
    return;
  }

  spawnTrail(dt);

  // ball sits at 35% from the left edge (was 40%) so more of what's coming stays on screen --
  // a first-time player standing at a trait island can actually see the hazard it's for, instead
  // of only discovering it after passing the pickup and having to double back for the right trait.
  const targetCamera = ball.x - canvas.width * 0.35;
  cameraX = Math.max(0, Math.min(targetCamera, Math.max(0, levelWidth - canvas.width)));

  toasts = toasts.filter((t) => (t.life -= dt) > 0);
}

// trigger icons: one shape per trait, not just a recolored diamond, so an island reads as its
// trait even before the label text is legible. `filled` is false for an already-used island --
// same silhouette, drawn as a faint outline only, so it still reads as "this was a cloud spot".
function drawCloudIcon(cx, cy, filled) {
  const puffs = [
    { dx: 0, dy: -4, r: 8 },
    { dx: -8, dy: 2, r: 6 },
    { dx: 8, dy: 2, r: 6 },
    { dx: 0, dy: 4, r: 7 },
  ];
  ctx.lineWidth = filled ? 1.5 : 2;
  ctx.strokeStyle = filled ? '#c7d2e0' : '#3a4059';
  for (const p of puffs) {
    ctx.beginPath();
    ctx.arc(cx + p.dx, cy + p.dy, p.r, 0, Math.PI * 2);
    if (filled) {
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }
    ctx.stroke();
  }
}

function drawRubberIcon(cx, cy, filled) {
  ctx.beginPath();
  ctx.arc(cx, cy, 9, 0, Math.PI * 2);
  if (filled) {
    ctx.fillStyle = '#fb7185';
    ctx.fill();
  }
  ctx.strokeStyle = filled ? '#7f1d3a' : '#3a4059';
  ctx.lineWidth = filled ? 1.5 : 2;
  ctx.stroke();
  if (filled) {
    // shine highlight -- sells "bouncy rubber ball" over a flat disc
    ctx.beginPath();
    ctx.ellipse(cx - 3, cy - 3, 3, 2, -0.6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.fill();
  }
}

function drawIronIcon(cx, cy, filled) {
  ctx.beginPath();
  ctx.arc(cx, cy, 9, 0, Math.PI * 2);
  if (filled) {
    const grad = ctx.createRadialGradient(cx - 3, cy - 3, 1, cx, cy, 10);
    grad.addColorStop(0, '#d1d5db');
    grad.addColorStop(0.55, '#6b7280');
    grad.addColorStop(1, '#374151');
    ctx.fillStyle = grad; // metallic sphere shading, not a flat gray disc
    ctx.fill();
  }
  ctx.strokeStyle = filled ? '#1f2430' : '#3a4059';
  ctx.lineWidth = filled ? 1.5 : 2;
  ctx.stroke();
}

function drawIceIcon(cx, cy, filled) {
  const pts = [
    [0, -10],
    [7, -3],
    [5, 8],
    [-5, 8],
    [-7, -3],
  ];
  ctx.beginPath();
  pts.forEach(([dx, dy], i) => (i === 0 ? ctx.moveTo(cx + dx, cy + dy) : ctx.lineTo(cx + dx, cy + dy)));
  ctx.closePath();
  if (filled) {
    ctx.fillStyle = '#a5f3fc';
    ctx.fill();
  }
  ctx.strokeStyle = filled ? '#0e7490' : '#3a4059';
  ctx.lineWidth = filled ? 1.5 : 2;
  ctx.stroke();
  if (filled) {
    // one facet line down the middle -- reads as a cut crystal, not a plain pentagon
    ctx.beginPath();
    ctx.moveTo(cx, cy - 10);
    ctx.lineTo(cx, cy + 8);
    ctx.stroke();
  }
}

const TRAIT_ICONS = { cloud: drawCloudIcon, rubber: drawRubberIcon, iron: drawIronIcon, ice: drawIceIcon };

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

// shared with the pause menu's "게임 설명 보기" so both places show the same rules text --
// anyone who dismissed the intro too fast can pull this same explanation back up mid-run.
const CONTROL_LINES = [
  '방향키(←/→) 또는 A/D로 공을 움직인다',
  '떠 있는 특성 아이콘(색+이름표)을 클릭해 얻고, Space로 발동한다',
  '초록 발판에 닿으면 성공, 천장·구덩이에 닿으면 실패한다',
];

function drawIntro() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#232837';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const lines = [...CONTROL_LINES, '', '아무 키나 누르거나 화면을 클릭하면 시작'];

  ctx.textAlign = 'center';
  ctx.fillStyle = '#4ade80';
  ctx.font = 'bold 26px sans-serif';
  ctx.fillText('트리거 공 게임', cx, cy - 90);

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
  // shake only ever touches this offset -- HUD text and the 실패/클리어 overlay are drawn after
  // ctx.restore() below, in screen space, so they (and the underlying fail/win logic) never jitter
  // regardless of this setting; only the world itself visibly shakes.
  let shakeX = 0;
  let shakeY = 0;
  if (shakeTimer > 0 && !reduceMotion) {
    const t = shakeTimer / SHAKE_DURATION;
    shakeX = (Math.random() * 2 - 1) * SHAKE_MAGNITUDE * t;
    shakeY = (Math.random() * 2 - 1) * SHAKE_MAGNITUDE * t;
  }
  ctx.translate(-cameraX + shakeX, shakeY);

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
    const cy = trigger.y - 16;
    // trait is shown before clicking, so there's nothing to misread up in the air. no separate
    // ring anymore -- the icon itself is scaled up to fill that space instead. drawn at
    // PICKUP_ALPHA so a marker never fully hides the hazard it's hovering above.
    // icon functions draw around their own (cx, cy) argument at a fixed ~9-10px base radius --
    // scaling around that same point enlarges the icon without having to touch each shape's coords
    ctx.save();
    ctx.globalAlpha = PICKUP_ALPHA;
    ctx.translate(cx, cy);
    ctx.scale(ICON_SCALE, ICON_SCALE);
    TRAIT_ICONS[trigger.trait](0, 0, !trigger.used);
    ctx.restore();

    if (!trigger.used) {
      ctx.fillStyle = '#e8eaf2';
      ctx.font = 'bold 19px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(TRAIT_LABELS[trigger.trait], cx, trigger.y - 85);
      ctx.textAlign = 'left';
    }
  }

  drawParticles();

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
  ctx.fillText(`최고 기록: ${bestClearTime === null ? '없음' : bestClearTime.toFixed(1) + '초'}`, 16, 88);

  // card 3: current difficulty rule + tuned value, always visible (not just in a debug panel)
  ctx.font = '13px sans-serif';
  ctx.fillStyle = '#8b93a7';
  ctx.textAlign = 'right';
  ctx.fillText(`난이도 — 이동 속도: ${MOVE_SPEED}px/s`, canvas.width - 16, 24);
  ctx.textAlign = 'left';

  // global record: bottom-right, bigger than the rest of the HUD so it reads as the game's headline
  // stat rather than another status line -- includes the holder's nickname once one exists.
  const globalBestText = !globalBestLoaded
    ? '불러오는 중'
    : globalBestTime === null
    ? '아직 없음'
    : `${globalBestTime.toFixed(1)}초${globalBestName ? ' - ' + globalBestName : ''}`;
  ctx.font = 'bold 22px sans-serif';
  ctx.fillStyle = '#facc15';
  ctx.textAlign = 'right';
  ctx.fillText(`전체 최고 기록: ${globalBestText}`, canvas.width - 16, canvas.height - 20);
  ctx.textAlign = 'left';

  if (runState.status === 'won') {
    ctx.font = 'bold 28px sans-serif';
    ctx.fillStyle = '#4ade80';
    ctx.fillText(`클리어! ${runState.elapsed.toFixed(1)}초`, canvas.width / 2 - 90, canvas.height / 2);
  } else if (runState.status === 'lost') {
    ctx.font = 'bold 28px sans-serif';
    ctx.fillStyle = '#ef4444';
    ctx.fillText('실패', canvas.width / 2 - 30, canvas.height / 2);
  }

  if (paused) {
    // dims everything underneath so it reads as "frozen", not just another HUD line
    ctx.fillStyle = 'rgba(15, 17, 25, 0.6)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = 'center';

    if (showHelp) {
      ctx.font = 'bold 22px sans-serif';
      ctx.fillStyle = '#4ade80';
      ctx.fillText('게임 설명', canvas.width / 2, canvas.height / 2 - 70);
      ctx.font = '16px sans-serif';
      ctx.fillStyle = '#e8eaf2';
      CONTROL_LINES.forEach((line, i) => ctx.fillText(line, canvas.width / 2, canvas.height / 2 - 24 + i * 28));
    } else {
      ctx.font = 'bold 28px sans-serif';
      ctx.fillStyle = '#e8eaf2';
      ctx.fillText('일시정지', canvas.width / 2, canvas.height / 2 - 12);
      ctx.font = '15px sans-serif';
      ctx.fillStyle = '#8b93a7';
      ctx.fillText('Esc를 누르면 재개', canvas.width / 2, canvas.height / 2 + 18);
    }
    ctx.textAlign = 'left';
  }

  ctx.font = '14px sans-serif';
  ctx.fillStyle = '#e8eaf2';
  toasts.forEach((toast, i) => {
    ctx.globalAlpha = Math.min(1, toast.life);
    ctx.fillText(toast.text, 16, 136 + i * 20);
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
