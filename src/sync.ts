// 방(room) 동기화 클라이언트. 주최자가 만든 방에 WebSocket 으로 붙어
// 설정·시드·시작 시각을 받고, 서버 시계와의 차이를 재서 모두 같은 타임라인을 쓴다.

export type WinnerSetting = {
  type: 'first' | 'last' | 'custom' | 'multi';
  /** 1-based, 양끝 포함 */
  start: number;
  end: number;
};

export type RoomConfig = {
  /** 이름 문법(이름/가중치*개수) 그대로 */
  names: string[];
  /** 기본 맵 인덱스 */
  map: number;
  winner: WinnerSetting;
  useSkills: boolean;
};

export type RoomState = RoomConfig & {
  id: string;
  seed: string;
  /** 서버 시각(ms). null 이면 아직 시작 전 */
  startAt: number | null;
  /** 다시 추첨할 때마다 1씩 는다 */
  round: number;
};

type ServerMessage =
  | { t: 'state'; room: RoomState; serverNow: number; count: number }
  | { t: 'count'; count: number }
  | { t: 'pong'; c: number; s: number }
  | { t: 'error'; message: string };

export type RoomEvents = {
  state: RoomState;
  count: number;
  online: boolean;
  error: string;
};

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10000;
const PING_INTERVAL_MS = 15000;

export async function createRoom(
  apiBase: string,
  config: RoomConfig
): Promise<{ id: string; hostKey: string; state: RoomState }> {
  const res = await fetch(`${apiBase}/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `방 만들기 실패 (${res.status})`);
  }
  return res.json();
}

export async function fetchRoom(apiBase: string, id: string): Promise<{ room: RoomState; serverNow: number }> {
  const res = await fetch(`${apiBase}/rooms/${encodeURIComponent(id)}`);
  if (res.status === 404) throw new Error('없는 방이거나 만료된 링크입니다.');
  if (!res.ok) throw new Error(`방 정보를 받지 못했습니다 (${res.status})`);
  return res.json();
}

export class RoomClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempts = 0;
  private pingTimer = 0;
  private reconnectTimer = 0;
  /** 서버 시각 - 내 시각. 왕복 지연이 가장 짧았던 표본을 믿는다 */
  private offset = 0;
  private bestRtt = Infinity;
  private listeners: { [K in keyof RoomEvents]: ((v: RoomEvents[K]) => void)[] } = {
    state: [],
    count: [],
    online: [],
    error: [],
  };

  public state: RoomState | null = null;
  public count = 0;
  public online = false;

  constructor(
    private apiBase: string,
    private roomId: string
  ) {}

  on<K extends keyof RoomEvents>(name: K, fn: (v: RoomEvents[K]) => void): void {
    this.listeners[name].push(fn);
  }

  private emit<K extends keyof RoomEvents>(name: K, v: RoomEvents[K]): void {
    this.listeners[name].forEach((fn) => fn(v));
  }

  /** 서버 기준 현재 시각(ms) */
  serverNow(): number {
    return Date.now() + this.offset;
  }

  connect(): void {
    this.closed = false;
    this.open();
  }

  close(): void {
    this.closed = true;
    window.clearTimeout(this.reconnectTimer);
    window.clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }

  send(msg: object): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private open(): void {
    const url = `${this.apiBase.replace(/^http/, 'ws')}/rooms/${encodeURIComponent(this.roomId)}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.attempts = 0;
      this.online = true;
      this.emit('online', true);
      // 시계 차이는 연결 직후 몇 번 재서 가장 좋은 표본을 쓴다
      this.ping();
      window.setTimeout(() => this.ping(), 300);
      window.setTimeout(() => this.ping(), 1000);
      window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.ping(), PING_INTERVAL_MS);
    });

    ws.addEventListener('message', (e) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      switch (msg.t) {
        case 'state':
          this.state = msg.room;
          this.count = msg.count;
          this.emit('state', msg.room);
          this.emit('count', msg.count);
          break;
        case 'count':
          this.count = msg.count;
          this.emit('count', msg.count);
          break;
        case 'pong': {
          const now = Date.now();
          const rtt = now - msg.c;
          if (rtt < this.bestRtt) {
            this.bestRtt = rtt;
            this.offset = msg.s + rtt / 2 - now;
          }
          break;
        }
        case 'error':
          this.emit('error', msg.message);
          break;
        default: {
          const _exhaustive: never = msg;
          void _exhaustive;
        }
      }
    });

    const onGone = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      window.clearInterval(this.pingTimer);
      if (this.online) {
        this.online = false;
        this.emit('online', false);
      }
      if (this.closed) return;
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.attempts);
      this.attempts++;
      this.reconnectTimer = window.setTimeout(() => this.open(), delay);
    };
    ws.addEventListener('close', onGone);
    ws.addEventListener('error', onGone);
  }

  private ping(): void {
    this.send({ t: 'ping', c: Date.now() });
  }
}
