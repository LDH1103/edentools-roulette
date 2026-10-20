var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
import { DurableObject } from "cloudflare:workers";
var COUNTDOWN_MS = 3e3;
var ROOM_TTL_MS = 24 * 60 * 60 * 1e3;
var ID_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
var MAX_NAMES = 300;
var MAX_MAP_INDEX = 4;
function randomToken(len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
}
__name(randomToken, "randomToken");
function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
  const ok = allowed.includes(origin);
  return {
    "access-control-allow-origin": ok ? origin : allowed[0],
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin"
  };
}
__name(corsHeaders, "corsHeaders");
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra }
  });
}
__name(json, "json");
function validateConfig(body) {
  if (!body || typeof body !== "object") return "\uBCF8\uBB38\uC774 \uC5C6\uC2B5\uB2C8\uB2E4";
  const b = body;
  const names = Array.isArray(b.names) ? b.names.filter((n) => typeof n === "string").map((n) => n.trim().slice(0, 40)) : [];
  const nonEmpty = names.filter((n) => n.length > 0);
  if (nonEmpty.length < 2) return "\uCC38\uAC00\uC790\uAC00 2\uBA85 \uC774\uC0C1\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4";
  if (nonEmpty.length > MAX_NAMES) return `\uCC38\uAC00\uC790\uB294 ${MAX_NAMES}\uBA85\uAE4C\uC9C0\uC785\uB2C8\uB2E4`;
  const map = Number(b.map);
  if (!Number.isInteger(map) || map < 0 || map > MAX_MAP_INDEX) return "\uB9F5 \uBC88\uD638\uAC00 \uC798\uBABB\uB410\uC2B5\uB2C8\uB2E4";
  const w = b.winner ?? {};
  const type = w.type;
  if (type !== "first" && type !== "last" && type !== "custom" && type !== "multi") return "\uB2F9\uCCA8 \uBC29\uC2DD\uC774 \uC798\uBABB\uB410\uC2B5\uB2C8\uB2E4";
  const start = Number(w.start);
  const end = Number(w.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return "\uB2F9\uCCA8 \uBC94\uC704\uAC00 \uC798\uBABB\uB410\uC2B5\uB2C8\uB2E4";
  return { names: nonEmpty, map, winner: { type, start, end }, useSkills: b.useSkills !== false };
}
__name(validateConfig, "validateConfig");
var Room = class extends DurableObject {
  static {
    __name(this, "Room");
  }
  async load() {
    const [state, hostKey] = await Promise.all([
      this.ctx.storage.get("state"),
      this.ctx.storage.get("hostKey")
    ]);
    if (!state || !hostKey) return null;
    return { state, hostKey };
  }
  async touch() {
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
  }
  broadcast(msg) {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
      }
    }
  }
  stateMessage(state) {
    return { t: "state", room: state, serverNow: Date.now(), count: this.ctx.getWebSockets().length };
  }
  async fetch(request) {
    const url = new URL(request.url);
    const action = url.pathname.replace(/^\/+/, "");
    if (request.method === "POST" && action === "init") {
      if (await this.ctx.storage.get("state")) return json({ error: "exists" }, 409);
      const { id, config } = await request.json();
      const state = { ...config, id, seed: randomToken(8), startAt: null, round: 1 };
      const hostKey = randomToken(20);
      await this.ctx.storage.put({ state, hostKey });
      await this.touch();
      return json({ id, hostKey, state });
    }
    const loaded = await this.load();
    if (!loaded) return json({ error: "not found" }, 404);
    if (request.method === "GET" && action === "") {
      return json({ room: loaded.state, serverNow: Date.now() });
    }
    if (request.method === "GET" && action === "ws") {
      if (request.headers.get("Upgrade") !== "websocket") return json({ error: "expected websocket" }, 426);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify(this.stateMessage(loaded.state)));
      this.broadcast({ t: "count", count: this.ctx.getWebSockets().length });
      await this.touch();
      return new Response(null, { status: 101, webSocket: client });
    }
    return json({ error: "not found" }, 404);
  }
  async webSocketMessage(ws, message) {
    if (typeof message !== "string") return;
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (msg.t === "ping") {
      ws.send(JSON.stringify({ t: "pong", c: msg.c, s: Date.now() }));
      return;
    }
    const loaded = await this.load();
    if (!loaded) {
      ws.send(JSON.stringify({ t: "error", message: "\uBC29\uC774 \uB9CC\uB8CC\uB410\uC2B5\uB2C8\uB2E4" }));
      return;
    }
    const isHost = typeof msg.key === "string" && msg.key === loaded.hostKey;
    if (msg.t === "start" || msg.t === "reset") {
      if (!isHost) {
        ws.send(JSON.stringify({ t: "error", message: "\uC8FC\uCD5C\uC790\uB9CC \uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4" }));
        return;
      }
      const state = loaded.state;
      if (msg.t === "start") {
        if (state.startAt !== null) return;
        state.startAt = Date.now() + COUNTDOWN_MS;
      } else {
        state.seed = randomToken(8);
        state.startAt = null;
        state.round += 1;
      }
      await this.ctx.storage.put("state", state);
      await this.touch();
      this.broadcast(this.stateMessage(state));
    }
  }
  async webSocketClose(ws, code) {
    try {
      ws.close(code, "closed");
    } catch {
    }
    this.broadcast({ t: "count", count: this.ctx.getWebSockets().length });
  }
  async webSocketError(ws) {
    try {
      ws.close(1011, "error");
    } catch {
    }
    this.broadcast({ t: "count", count: this.ctx.getWebSockets().length });
  }
  /** 마지막 활동 뒤 24시간이 지나면 방을 지운다 */
  async alarm() {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1e3, "expired");
      } catch {
      }
    }
    await this.ctx.storage.deleteAll();
  }
};
var src_default = {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "rooms") return json({ error: "not found" }, 404, cors);
    if (parts.length === 1 && request.method === "POST") {
      const config = validateConfig(await request.json().catch(() => null));
      if (typeof config === "string") return json({ error: config }, 400, cors);
      for (let attempt = 0; attempt < 3; attempt++) {
        const id = randomToken(6);
        const stub = env.ROOM.get(env.ROOM.idFromName(id));
        const res = await stub.fetch("https://room/init", {
          method: "POST",
          body: JSON.stringify({ id, config }),
          headers: { "content-type": "application/json" }
        });
        if (res.status === 409) continue;
        return new Response(res.body, { status: res.status, headers: { ...Object.fromEntries(res.headers), ...cors } });
      }
      return json({ error: "\uBC29 \uC544\uC774\uB514 \uC0DD\uC131 \uC2E4\uD328" }, 500, cors);
    }
    if (parts.length >= 2 && request.method === "GET") {
      const id = parts[1].toUpperCase();
      if (!/^[A-Z2-9]{6}$/.test(id)) return json({ error: "not found" }, 404, cors);
      const action = parts[2] ?? "";
      const stub = env.ROOM.get(env.ROOM.idFromName(id));
      const res = await stub.fetch(`https://room/${action}`, request);
      if (res.status === 101) return res;
      return new Response(res.body, { status: res.status, headers: { ...Object.fromEntries(res.headers), ...cors } });
    }
    return json({ error: "not found" }, 404, cors);
  }
};

// ../../../../npm-cache/_npx/c943b712072b77c4/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../npm-cache/_npx/c943b712072b77c4/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-niwetU/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../../../npm-cache/_npx/c943b712072b77c4/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-niwetU/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  Room,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
