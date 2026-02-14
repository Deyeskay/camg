// server.js
// MVP server for Camera Color Shooter
// Run: npm i express socket.io
// Start: node server.js
// Open: http://localhost:3000  (use HTTPS for mobile camera unless localhost)

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname)); // serves index.html in same folder

const rooms = new Map();

function genRoomId() {
  let id = "";
  do {
    id = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms.has(id));
  return id;
}

function now() { return Date.now(); }

// curated palette for limited-mode crafting (easy colors in real world)
const CRAFT_PALETTE = [
  "#ff0000", "#00ff00", "#0000ff", "#ffff00", "#00ffff", "#ff00ff",
  "#ff7a00", "#7a00ff", "#00ff7a", "#ff007a", "#7a7a7a", "#ffffff"
];

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
  if (!m) return { r: 255, g: 0, b: 0 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}
function rgbDist(a, b) {
  const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}
function normalizeHex(hex) {
  hex = (hex || "").trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(hex)) return hex;
  return "#ff0000";
}

function makeDefaultSettings() {
  return {
    gameType: "team",        // team | chaos
    mode: "standard",        // standard | limited
    gameSeconds: 180,

    damagePerHit: 10,
    maxHp: 100,

    initialBullets: 5,
    initialShields: 1,
    shieldDurationSec: 20,
    shieldCap: 2,
  };
}

function roomSnapshot(room) {
  // send minimal safe state to clients (no secrets)
  return {
    id: room.id,
    hostId: room.hostId,
    phase: room.phase,
    settings: room.settings,
    timer: room.timer,
    players: Object.fromEntries(
      Object.entries(room.players).map(([pid, p]) => [pid, {
        id: p.id,
        name: p.name,
        team: p.team,
        assignedColorHex: p.assignedColorHex || null,
        assignedConfidence: p.assignedConfidence ?? null,

        hp: p.hp,
        alive: p.alive,

        bullets: (p.bullets === Infinity ? "INF" : p.bullets),
        shields: p.shields,
        shieldActiveUntil: p.shieldActiveUntil || 0,

        earnTask: p.earnTask ? { type: p.earnTask.type, colorHex: p.earnTask.colorHex, expiresAt: p.earnTask.expiresAt } : null,

        stats: p.stats
      }])
    )
  };
}

function isHost(room, socket) {
  return room && room.hostId === socket.id;
}

function autoAssignTeams(room) {
  if (!room) return;
  const ids = Object.keys(room.players);
  if (room.settings.gameType !== "team") {
    for (const id of ids) room.players[id].team = null;
    return;
  }
  // stable assignment by join order timestamp
  ids.sort((a, b) => room.players[a].joinedAt - room.players[b].joinedAt);
  for (let i = 0; i < ids.length; i++) {
    room.players[ids[i]].team = (i % 2 === 0) ? "A" : "B";
  }
}

function allPlayersAssignedColors(room) {
  const ids = Object.keys(room.players);
  if (ids.length < 2) return false;
  return ids.every(id => !!room.players[id].assignedColorHex);
}

function aliveCount(room) {
  return Object.values(room.players).filter(p => p.alive).length;
}
function aliveTeams(room) {
  const set = new Set();
  for (const p of Object.values(room.players)) {
    if (!p.alive) continue;
    if (room.settings.gameType === "chaos") set.add("solo");
    else set.add(p.team || "X");
  }
  return set;
}

function endGame(room, reason = "time") {
  if (!room || room.phase !== "playing") return;
  room.phase = "results";
  room.timer = { ...room.timer, endedAt: now(), reason };

  io.to(room.id).emit("room:state", roomSnapshot(room));
}

function computeWinner(room) {
  // basic winner logic
  const players = Object.values(room.players);

  if (room.settings.gameType === "chaos") {
    // winner is highest kills, tie by damage
    const sorted = players.slice().sort((a, b) => {
      if ((b.stats.kills || 0) !== (a.stats.kills || 0)) return (b.stats.kills || 0) - (a.stats.kills || 0);
      if ((b.stats.damageDealt || 0) !== (a.stats.damageDealt || 0)) return (b.stats.damageDealt || 0) - (a.stats.damageDealt || 0);
      return (b.stats.hits || 0) - (a.stats.hits || 0);
    });
    return { type: "player", id: sorted[0]?.id || null, name: sorted[0]?.name || null };
  }

  // team mode: team with most kills (tie by damage)
  const teamAgg = { A: { kills: 0, damage: 0 }, B: { kills: 0, damage: 0 } };
  for (const p of players) {
    const t = p.team;
    if (!t || !teamAgg[t]) continue;
    teamAgg[t].kills += (p.stats.kills || 0);
    teamAgg[t].damage += (p.stats.damageDealt || 0);
  }
  const A = teamAgg.A, B = teamAgg.B;
  let win = "A";
  if (B.kills > A.kills) win = "B";
  else if (B.kills === A.kills && B.damage > A.damage) win = "B";
  return { type: "team", team: win };
}

function resolveTargetByColor(room, shooterId, obs) {
  // obs: { rgb:{r,g,b}, confidence:number, kind:"torso" }
  // returns playerId or null
  if (!obs || !obs.rgb) return null;

  const shooter = room.players[shooterId];
  if (!shooter) return null;

  const candidates = [];
  for (const [pid, p] of Object.entries(room.players)) {
    if (!p.assignedColorHex) continue;
    if (!p.alive) continue;
    if (pid === shooterId) continue;
    // friendly fire off in team mode
    if (room.settings.gameType === "team" && shooter.team && p.team && shooter.team === p.team) continue;

    const d = rgbDist(obs.rgb, p.assignedRgb);
    candidates.push({ pid, d });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.d - b.d);

  // dynamic threshold based on confidence
  const conf = clamp(obs.confidence ?? 0.3, 0, 1);
  // High confidence => strict. Low confidence => looser but capped.
  const threshold = clamp(55 - conf * 20, 35, 60);

  const best = candidates[0];
  if (best.d > threshold) return null;
  return best.pid;
}

function canShoot(room, player) {
  if (!player.alive) return { ok: false, reason: "dead" };
  if (room.settings.mode === "standard") return { ok: true };
  // limited:
  if (player.bullets <= 0) return { ok: false, reason: "no_bullets" };
  return { ok: true };
}

function applyDamage(room, shooterId, targetId) {
  const shooter = room.players[shooterId];
  const target = room.players[targetId];
  if (!shooter || !target) return;

  const dmg = clamp(Number(room.settings.damagePerHit || 10), 1, 999);
  const nowTs = now();

  const shieldActive = (target.shieldActiveUntil || 0) > nowTs;

  if (!shieldActive) {
    target.hp -= dmg;
    if (target.hp < 0) target.hp = 0;
  }
  // stats
  shooter.stats.hits += 1;
  shooter.stats.damageDealt += dmg;
  shooter.stats.hitLog.push({
    t: nowTs,
    targetId,
    targetName: target.name,
    dmg,
    shielded: shieldActive
  });

  if (!shieldActive && target.hp <= 0 && target.alive) {
    target.alive = false;
    shooter.stats.kills += 1;
  }
}

function tickRoomTimers() {
  const ts = now();
  for (const room of rooms.values()) {
    if (room.phase !== "playing") continue;
    if (room.timer?.endAt && ts >= room.timer.endAt) {
      endGame(room, "time");
    } else {
      // elimination
      if (room.settings.gameType === "chaos") {
        if (aliveCount(room) <= 1) endGame(room, "elimination");
      } else {
        const teams = aliveTeams(room);
        if (teams.size <= 1) endGame(room, "elimination");
      }
    }
  }
}
setInterval(tickRoomTimers, 500);

io.on("connection", (socket) => {
  socket.on("room:create", ({ name }) => {
    const roomId = genRoomId();
    const room = {
      id: roomId,
      hostId: socket.id,
      phase: "lobby",
      settings: makeDefaultSettings(),
      players: {},
      timer: null,
    };
    rooms.set(roomId, room);

    room.players[socket.id] = {
      id: socket.id,
      name: (name || "Host").trim().slice(0, 24),
      joinedAt: now(),
      team: "A",
      assignedColorHex: null,
      assignedRgb: null,
      assignedConfidence: null,

      hp: room.settings.maxHp,
      alive: true,

      bullets: Infinity,
      shields: room.settings.initialShields,
      shieldActiveUntil: 0,

      earnTask: null,

      stats: { hits: 0, kills: 0, damageDealt: 0, hitLog: [] }
    };

    socket.join(roomId);
    autoAssignTeams(room);
    io.to(roomId).emit("room:state", roomSnapshot(room));
  });

  socket.on("room:join", ({ roomId, name }) => {
    roomId = String(roomId || "").trim();
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit("room:error", { message: "Room not found" });
      return;
    }
    if (room.phase !== "lobby") {
      socket.emit("room:error", { message: "Game already started" });
      return;
    }

    room.players[socket.id] = {
      id: socket.id,
      name: (name || "Player").trim().slice(0, 24),
      joinedAt: now(),
      team: null,
      assignedColorHex: null,
      assignedRgb: null,
      assignedConfidence: null,

      hp: room.settings.maxHp,
      alive: true,

      bullets: (room.settings.mode === "limited") ? room.settings.initialBullets : Infinity,
      shields: room.settings.initialShields,
      shieldActiveUntil: 0,

      earnTask: null,

      stats: { hits: 0, kills: 0, damageDealt: 0, hitLog: [] }
    };

    socket.join(roomId);
    autoAssignTeams(room);
    io.to(roomId).emit("room:state", roomSnapshot(room));
  });

  socket.on("lobby:updateSettings", ({ roomId, settings }) => {
    const room = rooms.get(String(roomId || "").trim());
    if (!room) return;
    if (!isHost(room, socket)) return;
    if (room.phase !== "lobby") return;

    // merge and validate
    const s = room.settings;

    if (settings.gameType === "team" || settings.gameType === "chaos") s.gameType = settings.gameType;
    if (settings.mode === "standard" || settings.mode === "limited") s.mode = settings.mode;

    const gs = Number(settings.gameSeconds);
    if (Number.isFinite(gs)) s.gameSeconds = clamp(gs, 30, 3600);

    const dmg = Number(settings.damagePerHit);
    if (Number.isFinite(dmg)) s.damagePerHit = clamp(dmg, 1, 200);

    const hp = Number(settings.maxHp);
    if (Number.isFinite(hp)) s.maxHp = clamp(hp, 10, 500);

    const ib = Number(settings.initialBullets);
    if (Number.isFinite(ib)) s.initialBullets = clamp(ib, 0, 999);

    const is = Number(settings.initialShields);
    if (Number.isFinite(is)) s.initialShields = clamp(is, 0, 2);

    const sd = Number(settings.shieldDurationSec);
    if (Number.isFinite(sd)) s.shieldDurationSec = clamp(sd, 5, 60);

    const sc = Number(settings.shieldCap);
    if (Number.isFinite(sc)) s.shieldCap = clamp(sc, 0, 2);

    // apply team assignment rule
    autoAssignTeams(room);

    io.to(room.id).emit("room:state", roomSnapshot(room));
  });

  socket.on("lobby:assignColor", ({ roomId, playerId, colorHex, confidence }) => {
    const room = rooms.get(String(roomId || "").trim());
    if (!room) return;
    if (!isHost(room, socket)) return;
    if (room.phase !== "lobby") return;

    const p = room.players[playerId];
    if (!p) return;

    const hex = normalizeHex(colorHex);
    p.assignedColorHex = hex;
    p.assignedRgb = hexToRgb(hex);
    p.assignedConfidence = clamp(Number(confidence ?? 0.4), 0, 1);

    io.to(room.id).emit("room:state", roomSnapshot(room));
  });

  socket.on("game:start", ({ roomId }) => {
    const room = rooms.get(String(roomId || "").trim());
    if (!room) return;
    if (!isHost(room, socket)) return;
    if (room.phase !== "lobby") return;

    if (!allPlayersAssignedColors(room)) {
      socket.emit("room:error", { message: "Assign colors for all players (min 2 players)." });
      return;
    }

    // initialize players
    room.phase = "playing";
    const s = room.settings;
    const ts = now();
    room.timer = { startAt: ts, endAt: ts + s.gameSeconds * 1000, endedAt: 0, reason: null };

    autoAssignTeams(room);

    for (const p of Object.values(room.players)) {
      p.hp = s.maxHp;
      p.alive = true;
      p.shieldActiveUntil = 0;
      p.earnTask = null;
      p.stats = { hits: 0, kills: 0, damageDealt: 0, hitLog: [] };

      if (s.mode === "standard") {
        p.bullets = Infinity;
        p.shields = s.initialShields;
      } else {
        p.bullets = s.initialBullets;
        p.shields = clamp(s.initialShields, 0, s.shieldCap);
      }
    }

    io.to(room.id).emit("room:state", roomSnapshot(room));
  });

  socket.on("game:shieldActivate", ({ roomId }) => {
    const room = rooms.get(String(roomId || "").trim());
    if (!room) return;
    if (room.phase !== "playing") return;

    const p = room.players[socket.id];
    if (!p) return;
    if (!p.alive) return;

    const ts = now();
    if ((p.shieldActiveUntil || 0) > ts) {
      socket.emit("game:toast", { type: "warn", message: "Shield already active." });
      return;
    }

    // consume shield only when activating
    if (p.shields <= 0) {
      socket.emit("game:toast", { type: "warn", message: "No shields. Earn one first." });
      return;
    }

    p.shields -= 1;
    p.shieldActiveUntil = ts + room.settings.shieldDurationSec * 1000;

    io.to(room.id).emit("room:state", roomSnapshot(room));
  });

  socket.on("game:earnStart", ({ roomId, type }) => {
    const room = rooms.get(String(roomId || "").trim());
    if (!room) return;
    if (room.phase !== "playing") return;

    const p = room.players[socket.id];
    if (!p) return;
    if (!p.alive) return;

    if (room.settings.mode !== "limited") {
      socket.emit("game:toast", { type: "warn", message: "Crafting only in Limited mode." });
      return;
    }

    if (type !== "bullet" && type !== "shield") return;

    if (type === "shield" && p.shields >= room.settings.shieldCap) {
      socket.emit("game:toast", { type: "warn", message: `Shield cap reached (${room.settings.shieldCap}).` });
      return;
    }

    const colorHex = CRAFT_PALETTE[Math.floor(Math.random() * CRAFT_PALETTE.length)];
    p.earnTask = { type, colorHex, expiresAt: now() + 20000 }; // 20s to complete
    io.to(room.id).emit("room:state", roomSnapshot(room));
  });

  socket.on("game:shoot", ({ roomId, shootType, hasTarget, torsoObs, crossObs }) => {
    const room = rooms.get(String(roomId || "").trim());
    if (!room) return;
    if (room.phase !== "playing") return;

    const shooter = room.players[socket.id];
    if (!shooter) return;
    if (!shooter.alive) {
      socket.emit("game:toast", { type: "warn", message: "You are dead." });
      return;
    }

    // If limited mode: resolve whether this shot is for earning or attacking
    const limited = room.settings.mode === "limited";

    // EARN shot
    if (shootType === "earn") {
      if (!limited) {
        socket.emit("game:toast", { type: "warn", message: "Not in Limited mode." });
        return;
      }
      if (!shooter.earnTask) {
        socket.emit("game:toast", { type: "warn", message: "No active earn task. Tap Earn Bullet/Shield." });
        return;
      }
      if (now() > shooter.earnTask.expiresAt) {
        shooter.earnTask = null;
        socket.emit("game:toast", { type: "warn", message: "Earn task expired. Try again." });
        io.to(room.id).emit("room:state", roomSnapshot(room));
        return;
      }
      if (!crossObs || !crossObs.rgb) {
        socket.emit("game:toast", { type: "warn", message: "No color sample." });
        return;
      }

      // validate confidence
      const conf = clamp(Number(crossObs.confidence ?? 0.3), 0, 1);
      if (conf < 0.25) {
        socket.emit("game:toast", { type: "warn", message: "Low confidence sample. Get closer / better light." });
        return;
      }

      const reqHex = shooter.earnTask.colorHex;
      const reqRgb = hexToRgb(reqHex);
      const d = rgbDist(crossObs.rgb, reqRgb);

      // threshold depends on confidence (higher conf => stricter)
      const threshold = clamp(55 - conf * 25, 28, 55);

      if (d <= threshold) {
        if (shooter.earnTask.type === "bullet") {
          shooter.bullets += 1;
          socket.emit("game:toast", { type: "ok", message: "+1 bullet earned!" });
        } else {
          shooter.shields = clamp(shooter.shields + 1, 0, room.settings.shieldCap);
          socket.emit("game:toast", { type: "ok", message: "+1 shield earned!" });
        }
        shooter.earnTask = null;
        io.to(room.id).emit("room:state", roomSnapshot(room));
      } else {
        socket.emit("game:toast", { type: "warn", message: "Color not close enough. Try again." });
      }
      return;
    }

    // ATTACK shot
    // must have a target under crosshair (client-side)
    if (!hasTarget) {
      socket.emit("game:toast", { type: "warn", message: "MISS (no target)" });
      return;
    }

    // ammo check
    const shootCheck = canShoot(room, shooter);
    if (!shootCheck.ok) {
      if (shootCheck.reason === "no_bullets") socket.emit("game:toast", { type: "warn", message: "No bullets. Earn bullets first." });
      else socket.emit("game:toast", { type: "warn", message: "Cannot shoot." });
      return;
    }

    if (!torsoObs || !torsoObs.rgb) {
      socket.emit("game:toast", { type: "warn", message: "Could not read target color." });
      return;
    }

    // reduce bullets in limited mode
    if (limited) shooter.bullets -= 1;

    // resolve target player by color observation
    const targetId = resolveTargetByColor(room, socket.id, torsoObs);
    if (!targetId) {
      socket.emit("game:toast", { type: "warn", message: "HIT? (unknown color) — no damage" });
      io.to(room.id).emit("room:state", roomSnapshot(room));
      return;
    }

    applyDamage(room, socket.id, targetId);

    // broadcast state
    io.to(room.id).emit("room:state", roomSnapshot(room));
  });

  socket.on("room:leave", ({ roomId }) => {
    const room = rooms.get(String(roomId || "").trim());
    if (!room) return;
    socket.leave(room.id);
    delete room.players[socket.id];

    if (Object.keys(room.players).length === 0) {
      rooms.delete(room.id);
      return;
    }

    if (room.hostId === socket.id) {
      // promote oldest
      const ids = Object.keys(room.players).sort((a, b) => room.players[a].joinedAt - room.players[b].joinedAt);
      room.hostId = ids[0];
    }

    autoAssignTeams(room);
    io.to(room.id).emit("room:state", roomSnapshot(room));
  });

  socket.on("disconnect", () => {
    // remove from any room that contains this socket
    for (const room of rooms.values()) {
      if (!room.players[socket.id]) continue;

      delete room.players[socket.id];

      if (Object.keys(room.players).length === 0) {
        rooms.delete(room.id);
        continue;
      }

      if (room.hostId === socket.id) {
        const ids = Object.keys(room.players).sort((a, b) => room.players[a].joinedAt - room.players[b].joinedAt);
        room.hostId = ids[0];
      }

      autoAssignTeams(room);
      io.to(room.id).emit("room:state", roomSnapshot(room));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log("For mobile camera: use HTTPS or open from the phone as http://<your-lan-ip>:3000 with HTTPS proxy/tunnel.");
});

 