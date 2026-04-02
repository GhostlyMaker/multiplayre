const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;

const BAG_LIFETIME_MS = 45000;
const BAG_FADE_START_MS = 35000;
const PROJECTILE_LIFETIME_MS = 1800;
const TICK_MS = 250;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Pixel Paladins multiplayer server running");
});

const wss = new WebSocket.Server({ server });

const players = new Map();
const sockets = new Map();
const bags = new Map();
const projectiles = new Map();

function makeId(prefix = "") {
  return prefix + crypto.randomBytes(5).toString("hex");
}

function safeSend(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(data, excludePlayerId = null) {
  const payload = JSON.stringify(data);
  for (const [playerId, ws] of sockets.entries()) {
    if (excludePlayerId && playerId === excludePlayerId) continue;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

function sanitizeUsername(name) {
  if (typeof name !== "string") return null;
  const cleaned = name.trim().replace(/\s+/g, " ");
  if (!cleaned) return null;
  return cleaned.slice(0, 20);
}

function now() {
  return Date.now();
}

function clampNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function buildPlayersArray() {
  return Array.from(players.values()).map((p) => ({
    id: p.id,
    username: p.username,
    x: p.x,
    y: p.y,
    dirX: p.dirX,
    dirY: p.dirY,
    isMoving: p.isMoving,
  }));
}

function serializeBag(bag) {
  const age = now() - bag.createdAt;
  const timeRemainingMs = Math.max(0, bag.expiresAt - now());

  return {
    id: bag.id,
    x: bag.x,
    y: bag.y,
    ownerId: bag.ownerId,
    createdAt: bag.createdAt,
    expiresAt: bag.expiresAt,
    timeRemainingMs,
    isFading: age >= BAG_FADE_START_MS,
    items: bag.items.map((item) => ({
      instanceId: item.instanceId,
      itemType: item.itemType || "Unknown Item",
      name: item.name || item.itemType || "Unknown Item",
      slot: item.slot || "misc",
      rarity: item.rarity || "common",
      allowedClasses: Array.isArray(item.allowedClasses) ? item.allowedClasses : [],
      stats: item.stats || {},
      description: item.description || "",
      icon: item.icon || null,
      tier: item.tier || null,
    })),
  };
}

function serializeAllBags() {
  return Array.from(bags.values()).map(serializeBag);
}

function createBag({ x, y, ownerId, items }) {
  const bagId = makeId("bag_");
  const createdAt = now();

  const bag = {
    id: bagId,
    x: clampNumber(x, 100),
    y: clampNumber(y, 100),
    ownerId: ownerId || null,
    items: items.map((item) => ({
      instanceId: item.instanceId || makeId("itm_"),
      itemType: item.itemType || "Unknown Item",
      name: item.name || item.itemType || "Unknown Item",
      slot: item.slot || "misc",
      rarity: item.rarity || "common",
      allowedClasses: Array.isArray(item.allowedClasses) ? item.allowedClasses : [],
      stats: item.stats || {},
      description: item.description || "",
      icon: item.icon || null,
      tier: item.tier || null,
    })),
    createdAt,
    expiresAt: createdAt + BAG_LIFETIME_MS,
  };

  bags.set(bagId, bag);
  return bag;
}

function removeBag(bagId) {
  if (!bags.has(bagId)) return;
  bags.delete(bagId);
  broadcast({ type: "bagRemove", bagId });
}

function claimBagItem({ playerId, bagId, instanceId }) {
  const bag = bags.get(bagId);
  if (!bag) {
    return { ok: false, reason: "Bag not found" };
  }

  const itemIndex = bag.items.findIndex((item) => item.instanceId === instanceId);
  if (itemIndex === -1) {
    return { ok: false, reason: "Item not found in bag" };
  }

  const [item] = bag.items.splice(itemIndex, 1);

  broadcast({
    type: "bagUpdate",
    bag: serializeBag(bag),
    claimedBy: playerId,
    claimedItemInstanceId: instanceId,
  });

  if (bag.items.length === 0) {
    removeBag(bagId);
  }

  return { ok: true, item };
}

function createProjectile(owner, data) {
  const createdAt = now();

  const projectile = {
    id: makeId("shot_"),
    ownerId: owner.id,
    ownerName: owner.username,
    x: clampNumber(data.x, owner.x),
    y: clampNumber(data.y, owner.y),
    vx: clampNumber(data.vx, 0),
    vy: clampNumber(data.vy, 0),
    angle: clampNumber(data.angle, 0),
    speed: clampNumber(data.speed, 0),
    createdAt,
    expiresAt: createdAt + PROJECTILE_LIFETIME_MS,
  };

  projectiles.set(projectile.id, projectile);
  return projectile;
}

wss.on("connection", (ws) => {
  const playerId = makeId("p_");

  const player = {
    id: playerId,
    username: `Guest-${playerId.slice(-4)}`,
    x: 100,
    y: 100,
    dirX: 0,
    dirY: 1,
    isMoving: false,
  };

  players.set(playerId, player);
  sockets.set(playerId, ws);

  safeSend(ws, {
    type: "init",
    selfId: playerId,
    players: buildPlayersArray(),
    bags: serializeAllBags(),
  });

  broadcast({ type: "join", player }, playerId);

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const currentPlayer = players.get(playerId);
    if (!currentPlayer || !data || typeof data.type !== "string") return;

    switch (data.type) {
      case "join": {
        const username = sanitizeUsername(data.username);
        if (username) {
          currentPlayer.username = username;
          safeSend(ws, { type: "selfUpdate", player: currentPlayer });
          broadcast({ type: "update", player: currentPlayer });
        }
        break;
      }

      case "move": {
        currentPlayer.x = clampNumber(data.x, currentPlayer.x);
        currentPlayer.y = clampNumber(data.y, currentPlayer.y);
        currentPlayer.dirX = clampNumber(data.dirX, currentPlayer.dirX);
        currentPlayer.dirY = clampNumber(data.dirY, currentPlayer.dirY);
        currentPlayer.isMoving = Boolean(data.isMoving);

        broadcast({ type: "update", player: currentPlayer });
        break;
      }

      case "shoot": {
        const projectile = createProjectile(currentPlayer, data);
        broadcast({ type: "shoot", projectile });
        break;
      }

      case "dropItem": {
        const item = data.item;
        if (!item || typeof item !== "object") {
          safeSend(ws, { type: "dropRejected", reason: "Missing item payload" });
          break;
        }

        const bag = createBag({
          x: clampNumber(data.x, currentPlayer.x),
          y: clampNumber(data.y, currentPlayer.y),
          ownerId: currentPlayer.id,
          items: [item],
        });

        broadcast({ type: "bagCreate", bag: serializeBag(bag) });

        safeSend(ws, {
          type: "dropAccepted",
          bagId: bag.id,
          instanceId: bag.items[0].instanceId,
        });
        break;
      }

      case "claimBagItem": {
        const bagId = typeof data.bagId === "string" ? data.bagId : null;
        const instanceId = typeof data.instanceId === "string" ? data.instanceId : null;

        if (!bagId || !instanceId) {
          safeSend(ws, { type: "claimRejected", reason: "Missing bagId or instanceId" });
          break;
        }

        const result = claimBagItem({ playerId, bagId, instanceId });

        if (!result.ok) {
          safeSend(ws, {
            type: "claimRejected",
            reason: result.reason,
            bagId,
            instanceId,
          });
          break;
        }

        safeSend(ws, {
          type: "claimAccepted",
          bagId,
          instanceId,
          item: result.item,
        });
        break;
      }

      case "syncBagState": {
        const bagId = typeof data.bagId === "string" ? data.bagId : null;
        const bag = bagId ? bags.get(bagId) : null;
        if (bag) {
          safeSend(ws, { type: "bagUpdate", bag: serializeBag(bag) });
        }
        break;
      }

      case "ping": {
        safeSend(ws, { type: "pong", ts: now() });
        break;
      }

      default:
        break;
    }
  });

  ws.on("close", () => {
    players.delete(playerId);
    sockets.delete(playerId);
    broadcast({ type: "leave", id: playerId });
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
  });
});

setInterval(() => {
  const currentTime = now();

  for (const [projectileId, projectile] of projectiles.entries()) {
    if (currentTime >= projectile.expiresAt) {
      projectiles.delete(projectileId);
      broadcast({ type: "projectileRemove", id: projectileId });
    }
  }

  for (const [bagId, bag] of bags.entries()) {
    if (currentTime >= bag.expiresAt) {
      removeBag(bagId);
      continue;
    }

    if (currentTime >= bag.createdAt + BAG_FADE_START_MS) {
      broadcast({
        type: "bagFade",
        bagId,
        timeRemainingMs: Math.max(0, bag.expiresAt - currentTime),
      });
    }
  }
}, TICK_MS);

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
});

server.listen(PORT, () => {
  console.log("Server running on", PORT);
});
