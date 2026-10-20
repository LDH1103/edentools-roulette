// 구슬 레이스 동기화 서버. 방 하나가 Durable Object 하나다.
// 주최자가 방을 만들고(설정·시드), 참가자는 WebSocket 으로 붙어 같은 상태를 받는다.
// 주최자가 "시작"을 누르면 서버 시각 기준 시작 시각을 정해 모두에게 알린다.
import { DurableObject } from 'cloudflare:workers';

type WinnerSetting = { type: 'first' | 'last' | 'custom' | 'multi'; start: number; end: number };
type RoomConfig = { names: string[]; map: number; winner: WinnerSetting; useSkills: boolean };
type RoomState = RoomConfig & { id: string; seed: string; startAt: number | null; round: number };

type Env = {
  ROOM: DurableObjectNamespace<Room>;
  ALLOWED_ORIGINS: string;
};

const COUNTDOWN_MS = 3000;
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_NAMES = 300;
const MAX_MAP_INDEX = 4;

function randomToken(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  const ok = allowed.includes(origin);
  return {
    'access-control-allow-origin': ok ? origin : allowed[0],
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

/** 설정 검증. 잘못됐으면 이유 문자열 */
function validateConfig(body: unknown): RoomConfig | string {
  if (!body || typeof body !== 'object') return '본문이 없습니다';
  const b = body as Record<string, unknown>;
  const names = Array.isArray(b.names) ? b.names.filter((n) => typeof n === 'string').map((n) => (n as string).trim().slice(0, 40)) : [];
  const nonEmpty = names.filter((n) => n.length > 0);
  if (nonEmpty.length < 2) return '참가자가 2명 이상이어야 합니다';
  if (nonEmpty.length > MAX_NAMES) return `참가자는 ${MAX_NAMES}명까지입니다`;
  const map = Number(b.map);
  if (!Number.isInteger(map) || map < 0 || map > MAX_MAP_INDEX) return '맵 번호가 잘못됐습니다';
  const w = (b.winner ?? {}) as Record<string, unknown>;
  const type = w.type;
  if (type !== 'first' && type !== 'last' && type !== 'custom' && type !== 'multi') return '당첨 방식이 잘못됐습니다';
  const start = Number(w.start);
  const end = Number(w.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return '당첨 범위가 잘못됐습니다';
  return { names: nonEmpty, map, winner: { type, start, end }, useSkills: b.useSkills !== false };
}

export class Room extends DurableObject<Env> {
  private async load(): Promise<{ state: RoomState; hostKey: string } | null> {
    const [state, hostKey] = await Promise.all([
      this.ctx.storage.get<RoomState>('state'),
      this.ctx.storage.get<string>('hostKey'),
    ]);
    if (!state || !hostKey) return null;
    return { state, hostKey };
  }

  private async touch(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
  }

  private broadcast(msg: object): void {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        // 끊긴 소켓은 close 이벤트에서 정리된다
      }
    }
  }

  private stateMessage(state: RoomState) {
    return { t: 'state', room: state, serverNow: Date.now(), count: this.ctx.getWebSockets().length };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // 워커가 /rooms/:id/<action> 중 <action> 만 넘긴다
    const action = url.pathname.replace(/^\/+/, '');

    if (request.method === 'POST' && action === 'init') {
      if (await this.ctx.storage.get('state')) return json({ error: 'exists' }, 409);
      const { id, config } = (await request.json()) as { id: string; config: RoomConfig };
      const state: RoomState = { ...config, id, seed: randomToken(8), startAt: null, round: 1 };
      const hostKey = randomToken(20);
      await this.ctx.storage.put({ state, hostKey });
      await this.touch();
      return json({ id, hostKey, state });
    }

    const loaded = await this.load();
    if (!loaded) return json({ error: 'not found' }, 404);

    if (request.method === 'GET' && action === '') {
      return json({ room: loaded.state, serverNow: Date.now() });
    }

    if (request.method === 'GET' && action === 'ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected websocket' }, 426);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify(this.stateMessage(loaded.state)));
      this.broadcast({ t: 'count', count: this.ctx.getWebSockets().length });
      await this.touch();
      return new Response(null, { status: 101, webSocket: client });
    }

    return json({ error: 'not found' }, 404);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    let msg: { t?: string; c?: number; key?: string };
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    if (msg.t === 'ping') {
      ws.send(JSON.stringify({ t: 'pong', c: msg.c, s: Date.now() }));
      return;
    }

    const loaded = await this.load();
    if (!loaded) {
      ws.send(JSON.stringify({ t: 'error', message: '방이 만료됐습니다' }));
      return;
    }
    // 주최자 확인: 방을 만들 때 받은 키가 있어야 시작·다시 추첨을 할 수 있다
    const isHost = typeof msg.key === 'string' && msg.key === loaded.hostKey;
    if (msg.t === 'start' || msg.t === 'reset') {
      if (!isHost) {
        ws.send(JSON.stringify({ t: 'error', message: '주최자만 할 수 있습니다' }));
        return;
      }
      const state = loaded.state;
      if (msg.t === 'start') {
        // 이미 시작했으면 무시한다. 카운트다운 3초 뒤에 모두 동시에 출발한다
        if (state.startAt !== null) return;
        state.startAt = Date.now() + COUNTDOWN_MS;
      } else {
        state.seed = randomToken(8);
        state.startAt = null;
        state.round += 1;
      }
      await this.ctx.storage.put('state', state);
      await this.touch();
      this.broadcast(this.stateMessage(state));
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code, 'closed');
    } catch {
      // 이미 닫힘
    }
    this.broadcast({ t: 'count', count: this.ctx.getWebSockets().length });
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'error');
    } catch {
      // 이미 닫힘
    }
    this.broadcast({ t: 'count', count: this.ctx.getWebSockets().length });
  }

  /** 마지막 활동 뒤 24시간이 지나면 방을 지운다 */
  async alarm(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, 'expired');
      } catch {
        // 무시
      }
    }
    await this.ctx.storage.deleteAll();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts[0] !== 'rooms') return json({ error: 'not found' }, 404, cors);

    // POST /rooms : 방 만들기. 아이디가 겹치면(드물다) 다시 뽑는다
    if (parts.length === 1 && request.method === 'POST') {
      const config = validateConfig(await request.json().catch(() => null));
      if (typeof config === 'string') return json({ error: config }, 400, cors);
      for (let attempt = 0; attempt < 3; attempt++) {
        const id = randomToken(6);
        const stub = env.ROOM.get(env.ROOM.idFromName(id));
        const res = await stub.fetch('https://room/init', {
          method: 'POST',
          body: JSON.stringify({ id, config }),
          headers: { 'content-type': 'application/json' },
        });
        if (res.status === 409) continue;
        return new Response(res.body, { status: res.status, headers: { ...Object.fromEntries(res.headers), ...cors } });
      }
      return json({ error: '방 아이디 생성 실패' }, 500, cors);
    }

    // GET /rooms/:id , GET /rooms/:id/ws
    if (parts.length >= 2 && request.method === 'GET') {
      const id = parts[1].toUpperCase();
      if (!/^[A-Z2-9]{6}$/.test(id)) return json({ error: 'not found' }, 404, cors);
      const action = parts[2] ?? '';
      const stub = env.ROOM.get(env.ROOM.idFromName(id));
      const res = await stub.fetch(`https://room/${action}`, request);
      if (res.status === 101) return res;
      return new Response(res.body, { status: res.status, headers: { ...Object.fromEntries(res.headers), ...cors } });
    }

    return json({ error: 'not found' }, 404, cors);
  },
};
