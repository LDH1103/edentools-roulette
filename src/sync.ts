// 방(room) 동기화 클라이언트. 주최자가 만든 방의 설정·시드·시작 시각을 받고,
// 서버 시계와의 차이를 재서 모두 같은 타임라인을 쓴다.
// 기본은 WebSocket 이고, 회사 프록시 등으로 막히면 HTTP 폴링으로 같은 상태를 받는다.

export type WinnerSetting = {
  /** custom 은 예전 방 호환용. 지금 화면은 first / last / multi 만 만든다 */
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
  /** Slack 알림 채널 이름. 알림을 안 보내면 null. Webhook 주소는 서버에만 있다 */
  slackChannel: string | null;
};

/** 주최자 브라우저에 저장해 두고 추첨마다 고르는 Slack 알림 대상 */
export type SlackTarget = { channel: string; webhook: string };

/** connecting: 처음 붙는 중, online: 실시간, polling: WebSocket 대신 주기 조회, reconnecting: 끊겨서 다시 붙는 중 */
export type ConnState = 'connecting' | 'online' | 'polling' | 'reconnecting';

type RoomResponse = { room: RoomState; serverNow: number; count?: number };

type ServerMessage =
  | { t: 'state'; room: RoomState; serverNow: number; count: number }
  | { t: 'count'; count: number }
  | { t: 'pong'; c: number; s: number }
  | { t: 'error'; message: string };

export type RoomEvents = {
  state: RoomState;
  count: number;
  conn: ConnState;
  error: string;
};

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10000;
const PING_INTERVAL_MS = 15000;
/** 이 시간 안에 WebSocket 이 안 열리면 폴링을 같이 돌린다 */
const WS_FALLBACK_MS = 4000;
const POLL_INTERVAL_MS = 1500;

/** 서버가 돌려준 { error } 를 읽어 사람이 읽을 메시지로 던진다 */
async function failFrom(res: Response): Promise<never> {
  let message = '';
  try {
    message = ((await res.json()) as { error?: string }).error ?? '';
  } catch {
    // 본문이 JSON 이 아니면 상태 코드만 쓴다
  }
  throw new Error(message || `서버 오류 (${res.status})`);
}

export async function createRoom(
  apiBase: string,
  config: RoomConfig,
  slack: SlackTarget | null
): Promise<{ id: string; hostKey: string; state: RoomState }> {
  const res = await fetch(`${apiBase}/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...config, slack }),
  });
  if (!res.ok) return failFrom(res);
  return res.json();
}

/** 채널을 저장하기 전에 확인 메시지를 보내 Webhook 주소가 맞는지 본다 */
export async function testSlackHook(apiBase: string, target: SlackTarget): Promise<void> {
  const res = await fetch(`${apiBase}/slack/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(target),
  });
  if (!res.ok) return failFrom(res);
}

export class RoomClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempts = 0;
  private pingTimer = 0;
  private reconnectTimer = 0;
  private fallbackTimer = 0;
  private pollTimer = 0;
  /** 서버 시각 - 내 시각. 왕복 지연이 가장 짧았던 표본을 믿는다 */
  private offset = 0;
  private bestRtt = Infinity;
  private listeners: { [K in keyof RoomEvents]: ((v: RoomEvents[K]) => void)[] } = {
    state: [],
    count: [],
    conn: [],
    error: [],
  };

  public state: RoomState | null = null;
  public count = 0;
  public conn: ConnState = 'connecting';

  constructor(
    private apiBase: string,
    private roomId: string
  ) {}

  private get roomUrl(): string {
    return `${this.apiBase}/rooms/${encodeURIComponent(this.roomId)}`;
  }

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

  private setConn(c: ConnState): void {
    if (this.conn === c) return;
    this.conn = c;
    this.emit('conn', c);
  }

  /** 시계 차이 표본. t0 보내기 직전, t1 받은 직후의 내 시각 */
  private sampleClock(serverNow: number, t0: number, t1: number): void {
    const rtt = t1 - t0;
    if (rtt < this.bestRtt) {
      this.bestRtt = rtt;
      this.offset = serverNow + rtt / 2 - t1;
    }
  }

  private applyRoom(room: RoomState, count?: number): void {
    this.state = room;
    this.emit('state', room);
    if (count !== undefined) {
      this.count = count;
      this.emit('count', count);
    }
  }

  private async getRoom(): Promise<void> {
    const t0 = Date.now();
    const res = await fetch(this.roomUrl, { cache: 'no-store' });
    const t1 = Date.now();
    if (!res.ok) return failFrom(res);
    const body = (await res.json()) as RoomResponse;
    this.sampleClock(body.serverNow, t0, t1);
    this.applyRoom(body.room, body.count);
  }

  /** 첫 상태를 HTTP 로 받는다. 없는 방이면 예외 */
  async load(): Promise<void> {
    await this.getRoom();
  }

  /**
   * 주최자 동작은 HTTP 로 보낸다. WebSocket 이 막힌 환경에서도 시작할 수 있다.
   * summary 는 Slack 출발 알림에 쓰는 한 줄 요약
   */
  async action(kind: 'start' | 'reset', key: string, summary?: string): Promise<void> {
    await this.post(kind, { key, summary });
  }

  /** 같은 링크에서 설정을 바꾼다. 서버가 새 시드로 대기 상태를 만들어 모두에게 알린다 */
  async updateConfig(key: string, config: RoomConfig, slack: SlackTarget | null): Promise<void> {
    await this.post('config', { key, config, slack });
  }

  /** 추첨 링크를 방의 Slack 채널에 올린다 */
  async notifySlack(key: string, summary: string): Promise<void> {
    const res = await fetch(`${this.roomUrl}/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, summary }),
    });
    if (!res.ok) return failFrom(res);
  }

  /** 결과 캡처와 당첨자를 올린다. 서버가 라운드마다 한 번만 Slack 에 알린다 */
  async reportResult(
    key: string,
    report: { round: number; winners: string[]; summary: string; image: Blob | null }
  ): Promise<void> {
    const form = new FormData();
    form.set('key', key);
    form.set('round', String(report.round));
    form.set('winners', JSON.stringify(report.winners));
    form.set('summary', report.summary);
    if (report.image) form.set('image', report.image, `result-${report.round}.jpg`);
    const res = await fetch(`${this.roomUrl}/result`, { method: 'POST', body: form });
    if (!res.ok) return failFrom(res);
  }

  private async post(path: 'start' | 'reset' | 'config', payload: object): Promise<void> {
    const t0 = Date.now();
    const res = await fetch(`${this.roomUrl}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const t1 = Date.now();
    if (!res.ok) return failFrom(res);
    const body = (await res.json()) as RoomResponse;
    this.sampleClock(body.serverNow, t0, t1);
    this.applyRoom(body.room, body.count);
  }

  connect(): void {
    this.closed = false;
    this.open();
    window.clearTimeout(this.fallbackTimer);
    this.fallbackTimer = window.setTimeout(() => {
      if (this.conn !== 'online') this.startPolling();
    }, WS_FALLBACK_MS);
  }

  close(): void {
    this.closed = true;
    window.clearTimeout(this.reconnectTimer);
    window.clearTimeout(this.fallbackTimer);
    window.clearInterval(this.pingTimer);
    this.stopPolling();
    this.ws?.close();
    this.ws = null;
  }

  private send(msg: object): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private startPolling(): void {
    if (this.pollTimer || this.closed) return;
    this.setConn('polling');
    const tick = async () => {
      try {
        await this.getRoom();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // 방이 사라졌으면 더 물어볼 필요가 없다. 네트워크 오류는 다음 주기에 다시 시도한다
        if (/만료|없는 방/.test(message)) {
          this.stopPolling();
          this.emit('error', message);
        }
      }
    };
    void tick();
    this.pollTimer = window.setInterval(tick, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    window.clearInterval(this.pollTimer);
    this.pollTimer = 0;
  }

  private open(): void {
    const url = `${this.roomUrl.replace(/^http/, 'ws')}/ws`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.startPolling();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.attempts = 0;
      this.stopPolling();
      this.setConn('online');
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
          this.applyRoom(msg.room, msg.count);
          break;
        case 'count':
          this.count = msg.count;
          this.emit('count', msg.count);
          break;
        case 'pong':
          this.sampleClock(msg.s, msg.c, Date.now());
          break;
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
      if (this.closed) return;
      // 두 번 연달아 실패하면 폴링으로 상태를 계속 받으면서 WebSocket 은 뒤에서 다시 시도한다
      if (this.attempts >= 1) this.startPolling();
      else if (!this.pollTimer) this.setConn('reconnecting');
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
