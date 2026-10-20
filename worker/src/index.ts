// 구슬 레이스 동기화 서버. 방 하나가 Durable Object 하나다.
// 주최자가 방을 만들고(설정·시드), 보는 사람은 WebSocket(막히면 HTTP 폴링)으로 같은 상태를 받는다.
// 주최자가 "시작"을 누르면 서버 시각 기준 시작 시각을 정해 모두에게 알린다.
// 방에 Slack Incoming Webhook 이 있으면 링크·출발·결과(화면 캡처 포함)를 그 채널에 알린다.
// 공용 저장소(SharedStore)에 명단·마지막 설정·Slack 채널을 두고 쓰는 사람 모두가 같이 쓴다.
import { DurableObject } from 'cloudflare:workers';

type WinnerSetting = { type: 'first' | 'last' | 'custom' | 'multi'; start: number; end: number };
type RoomConfig = { names: string[]; map: number; winner: WinnerSetting; useSkills: boolean };
type RoomState = RoomConfig & {
  id: string;
  seed: string;
  startAt: number | null;
  round: number;
  /** 알림 채널 이름(표시용). Webhook 주소는 상태에 넣지 않고 따로 보관한다 */
  slackChannel: string | null;
};
type SlackTarget = { channel: string; webhook: string };
/** 공용 저장소의 채널. webhook 은 저장소 밖으로 내보내지 않는다 */
type StoredChannel = { id: string; channel: string; webhook: string };
type HostAction = 'start' | 'reset' | 'config';
type ActionResult = { ok: true; state: RoomState } | { ok: false; status: number; message: string };

type Env = {
  ROOM: DurableObjectNamespace<Room>;
  STORE: DurableObjectNamespace<SharedStore>;
  ALLOWED_ORIGINS: string;
  /** 결과 이미지 주소에 쓰는 이 서버의 공개 주소 */
  API_ORIGIN: string;
  /** Slack 메시지에 넣는 추첨 페이지 주소 */
  SITE_URL: string;
  /** 로컬 검증용: Slack 대신 받아 줄 가짜 Webhook 주소 접두사 (운영에서는 비워 둔다) */
  EXTRA_HOOK_PREFIX?: string;
};

const COUNTDOWN_MS = 3000;
/** 마지막 활동 뒤 30일 보관. Slack 에 올린 결과 이미지가 그동안 계속 보이도록 */
const ROOM_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_NAMES = 300;
const MAX_MARBLES = 1000;
const MAX_MAP_INDEX = 4;
/** SQLite Durable Object 한 행은 2MB 까지. 여유를 둔다 */
const MAX_IMAGE_BYTES = 1_500_000;
/** Slack 메시지에 이름을 이만큼만 나열한다 */
const MAX_LISTED_NAMES = 40;
/** Slack 카드 왼쪽 띠 색: 링크 파랑, 출발 초록, 결과 주황 */
const CARD_COLOR = { link: '#378ADD', start: '#1D9E75', result: '#EF9F27' } as const;
/** Slack 블록 글자 수 한도: header 150자, section 3000자 */
const MAX_HEADER_CHARS = 150;
const MAX_SECTION_CHARS = 3000;
/** 공용 저장소에 둘 수 있는 값의 키. 클라이언트 prefs.ts 의 PREF_KEYS 와 같다 */
const STORE_VALUE_KEYS: readonly string[] = ['er_names', 'er_roster', 'er_winner', 'er_map', 'er_slack_last'];
/** 값 하나의 길이 한도. 이름 300줄 × 40자가 들어간다 */
const MAX_STORE_VALUE_CHARS = 20000;
const MAX_STORE_CHANNELS = 30;

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

/** 이름 문법(이름/가중치*개수)대로 센 구슬 수. 클라이언트 parseName 과 같은 규칙 */
function countMarbles(names: string[]): number {
  return names.reduce((sum, n) => {
    const m = /\*(\d+)/.exec(n);
    return sum + (m ? parseInt(m[1], 10) : 1);
  }, 0);
}

/** 이름 문법을 뗀 이름 */
function bareName(nameStr: string): string {
  return nameStr.replace(/[/*].*$/, '').trim();
}

/** Slack mrkdwn 에서 특수한 의미를 갖는 문자를 바꾼다 */
function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 당첨 방식 짧은 표기. 클라이언트 winnerShort 와 같은 규칙 */
function winnerLabel(w: WinnerSetting): string {
  switch (w.type) {
    case 'first':
      return `앞에서 ${w.end}명`;
    case 'last':
      return `뒤에서 ${w.end}명`;
    case 'custom':
      return `${w.start}등`;
    case 'multi':
      return w.start === w.end ? `${w.start}등` : `${w.start}~${w.end}등`;
    default: {
      const _exhaustive: never = w.type;
      return _exhaustive;
    }
  }
}

/** 참가자 줄: 같은 이름은 구슬 수를 합쳐 "이름 ×2" 로 쓰고, 처음 나온 순서로 MAX_LISTED_NAMES 명까지 */
function participantsText(names: string[]): string {
  // 이름별 구슬 수 = 그 이름 줄들을 이름 문법(*N)으로 센 수의 합
  const counts = new Map<string, number>();
  for (const n of names) {
    const name = bareName(n);
    counts.set(name, (counts.get(name) ?? 0) + countMarbles([n]));
  }
  const entries = [...counts];
  const listed = entries
    .slice(0, MAX_LISTED_NAMES)
    .map(([name, count]) => (count > 1 ? `${esc(name)} ×${count}` : esc(name)))
    .join(' · ');
  const more = entries.length > MAX_LISTED_NAMES ? ` 외 ${entries.length - MAX_LISTED_NAMES}명` : '';
  return listed + more;
}

/** 주최자 화면이 보낸 맵 이름. 없으면 빈 문자열이고 알림에서 맵 칸을 뺀다 */
function mapTitleOf(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().slice(0, 40) : '';
}

/** 왼쪽에 색 띠가 있는 카드 메시지. text 는 알림 미리보기에 쓰인다 */
function card(color: string, text: string, blocks: object[]): object {
  return { text, attachments: [{ color, blocks }] };
}

/** 큰 제목. plain_text 라 이름을 escape 하지 않는다 */
function headerBlock(text: string): object {
  return { type: 'header', text: { type: 'plain_text', text: text.slice(0, MAX_HEADER_CHARS), emoji: true } };
}

/** 작은 회색 글씨 줄 */
function contextBlock(mrkdwn: string): object {
  return { type: 'context', elements: [{ type: 'mrkdwn', text: mrkdwn }] };
}

/** 설정 검증. 잘못됐으면 이유 문자열 */
function validateConfig(body: unknown): RoomConfig | string {
  if (!body || typeof body !== 'object') return '본문이 없습니다';
  const b = body as Record<string, unknown>;
  const names = Array.isArray(b.names)
    ? b.names.filter((n) => typeof n === 'string').map((n) => (n as string).trim().slice(0, 40))
    : [];
  const nonEmpty = names.filter((n) => n.length > 0);
  if (nonEmpty.length > MAX_NAMES) return `이름은 ${MAX_NAMES}줄까지입니다`;
  const total = countMarbles(nonEmpty);
  if (total < 2) return '참가자가 2명 이상이어야 합니다';
  if (total > MAX_MARBLES) return `구슬은 ${MAX_MARBLES}개까지입니다`;
  const map = Number(b.map);
  if (!Number.isInteger(map) || map < 0 || map > MAX_MAP_INDEX) return '맵 번호가 잘못됐습니다';
  const w = (b.winner ?? {}) as Record<string, unknown>;
  const type = w.type;
  if (type !== 'first' && type !== 'last' && type !== 'custom' && type !== 'multi') return '당첨 방식이 잘못됐습니다';
  const start = Number(w.start);
  const end = Number(w.end);
  const rangeOk = Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start && end <= total;
  if (!rangeOk) return '당첨 범위가 잘못됐습니다';
  return { names: nonEmpty, map, winner: { type, start, end }, useSkills: b.useSkills !== false };
}

/** Slack Incoming Webhook 주소인지. 아무 주소로나 요청을 보내는 중계기가 되지 않도록 이것만 받는다 */
function isSlackWebhook(value: string, env: Env): boolean {
  const extra = env.EXTRA_HOOK_PREFIX ?? '';
  if (extra !== '' && value.startsWith(extra)) return true;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === 'hooks.slack.com' && u.pathname.startsWith('/services/');
  } catch {
    return false;
  }
}

/** Slack 알림 대상 검증. undefined 는 "바꾸지 않음", null 은 "알림 끔" */
function validateSlack(raw: unknown, env: Env): SlackTarget | null | undefined | string {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'object') return 'Slack 설정이 잘못됐습니다';
  const s = raw as Record<string, unknown>;
  const webhook = typeof s.webhook === 'string' ? s.webhook.trim() : '';
  if (!isSlackWebhook(webhook, env)) return 'Slack Webhook 주소가 아닙니다. Slack 앱 설정의 Incoming Webhooks 에서 복사한 주소를 넣어 주세요';
  const channel = (typeof s.channel === 'string' ? s.channel.trim() : '').slice(0, 40) || 'Slack';
  return { channel, webhook };
}

/** 공용 저장소. 사내 몇 명이 같이 쓰므로 하나만 둔다 */
function storeStub(env: Env) {
  return env.STORE.get(env.STORE.idFromName('shared'));
}

/** 공용 저장소에 요청을 넘기고 CORS 헤더를 붙여 돌려준다 */
async function forwardToStore(env: Env, action: string, payload: object, cors: Record<string, string>): Promise<Response> {
  const res = await storeStub(env).fetch(`https://store/${action}`, { method: 'POST', body: JSON.stringify(payload) });
  return new Response(res.body, { status: res.status, headers: { ...Object.fromEntries(res.headers), ...cors } });
}

/** 공용 저장소에 둘 값 검증: 정해 둔 키의 문자열만 받고(null 은 지우기), 모르는 키는 버린다 */
function validateStoreValues(raw: unknown): Record<string, string | null> | string {
  if (!raw || typeof raw !== 'object') return '저장할 값이 없습니다';
  const out: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!STORE_VALUE_KEYS.includes(key)) continue;
    if (value !== null && typeof value !== 'string') return '저장할 값의 모양이 잘못됐습니다';
    if (typeof value === 'string' && value.length > MAX_STORE_VALUE_CHARS) return '저장할 값이 너무 큽니다';
    out[key] = value;
  }
  return out;
}

/** 브라우저에서 옮겨 온 채널 목록. Slack 주소 형식이 맞는 것만 받고, 같은 이름은 나중 것이 이긴다 */
function validateImportChannels(raw: unknown, env: Env): SlackTarget[] {
  const byName = new Map<string, SlackTarget>();
  for (const item of Array.isArray(raw) ? raw : []) {
    const target = validateSlack(item, env);
    // 형식이 맞는 채널 여부
    const isTarget = typeof target === 'object' && target !== null;
    if (isTarget) byName.set(target.channel, target);
  }
  return [...byName.values()].slice(0, MAX_STORE_CHANNELS);
}

/** 명단 두 개(JSON 배열 문자열)를 처음 나온 순서대로 합친다. 깨진 값은 빈 명단으로 본다 */
function mergeRoster(current: string | undefined, incoming: string): string {
  const parse = (value: string | undefined): string[] => {
    try {
      const v = JSON.parse(value ?? '[]');
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  return JSON.stringify([...new Set([...parse(current), ...parse(incoming)])].slice(0, MAX_NAMES));
}

/**
 * 방에 붙일 알림 채널을 Webhook 주소가 있는 모양으로 바꾼다.
 * 공용 채널({ channel, channelId })이면 공용 저장소에서 주소를 꺼내고,
 * 그 밖의 값(예전 화면이 보내는 { channel, webhook } 등)은 그대로 돌려 validateSlack 에 맡긴다.
 */
async function resolveStoredSlack(raw: unknown, env: Env): Promise<{ slack: unknown } | { error: string }> {
  // 공용 채널 선택 여부
  const isStoredChoice = !!raw && typeof raw === 'object' && 'channelId' in raw;
  if (!isStoredChoice) return { slack: raw };
  const { channelId } = raw as { channelId?: unknown };
  const res = await storeStub(env).fetch('https://store/secret', {
    method: 'POST',
    body: JSON.stringify({ channelId: String(channelId ?? '') }),
  });
  const data = (await res.json()) as { channel?: string; webhook?: string; error?: string };
  if (!res.ok) return { error: data.error ?? '알림 채널을 찾을 수 없습니다' };
  return { slack: { channel: data.channel, webhook: data.webhook } };
}

async function postSlack(webhook: string, payload: object): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) return { ok: true };
    const text = (await res.text().catch(() => '')).slice(0, 200);
    return { ok: false, message: `Slack 이 거절했습니다 (${res.status} ${text})` };
  } catch (e) {
    return { ok: false, message: `Slack 에 연결하지 못했습니다 (${e instanceof Error ? e.message : e})` };
  }
}

export class Room extends DurableObject<Env> {
  private async load(): Promise<{ state: RoomState; hostKey: string } | null> {
    const [state, hostKey] = await Promise.all([
      this.ctx.storage.get<RoomState>('state'),
      this.ctx.storage.get<string>('hostKey'),
    ]);
    if (!state || !hostKey) return null;
    // 알림 기능 전에 만든 방에는 slackChannel 이 없다
    return { state: { ...state, slackChannel: state.slackChannel ?? null }, hostKey };
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

  private viewerCount(): number {
    return this.ctx.getWebSockets().length;
  }

  private stateMessage(state: RoomState) {
    return { t: 'state', room: state, serverNow: Date.now(), count: this.viewerCount() };
  }

  private roomUrl(id: string): string {
    return `${this.env.SITE_URL}#${id}`;
  }

  /** 알림 대상을 저장하거나 지우고, 상태에는 채널 이름만 남긴다 */
  private async applySlack(state: RoomState, slack: SlackTarget | null | undefined): Promise<void> {
    if (slack === undefined) return;
    if (slack === null) {
      await this.ctx.storage.delete('slackWebhook');
      state.slackChannel = null;
    } else {
      await this.ctx.storage.put('slackWebhook', slack.webhook);
      state.slackChannel = slack.channel;
    }
  }

  private async notify(payload: object): Promise<{ ok: true } | { ok: false; message: string }> {
    const webhook = await this.ctx.storage.get<string>('slackWebhook');
    if (!webhook) return { ok: false, message: '이 방에는 Slack 알림 채널이 없습니다' };
    return postSlack(webhook, payload);
  }

  /** 주최자 동작. WebSocket 과 HTTP 가 같은 규칙을 쓴다. config 는 검증을 마친 새 설정 */
  private async applyAction(
    kind: HostAction,
    hostKeyGiven: unknown,
    config?: RoomConfig,
    slack?: SlackTarget | null
  ): Promise<ActionResult> {
    const loaded = await this.load();
    if (!loaded) return { ok: false, status: 404, message: '방이 만료됐습니다' };
    // 주최자 확인: 방을 만들 때 받은 키가 있어야 시작·다시 추첨을 할 수 있다
    const isHost = typeof hostKeyGiven === 'string' && hostKeyGiven === loaded.hostKey;
    if (!isHost) return { ok: false, status: 403, message: '주최자만 할 수 있습니다' };

    const state = loaded.state;
    switch (kind) {
      case 'start':
        // 이미 시작했으면 그대로 둔다. 카운트다운 3초 뒤에 모두 동시에 출발한다
        if (state.startAt !== null) return { ok: true, state };
        state.startAt = Date.now() + COUNTDOWN_MS;
        break;
      case 'reset':
        state.seed = randomToken(8);
        state.startAt = null;
        state.round += 1;
        break;
      case 'config':
        // 설정을 바꾸면 같은 링크에서 새 라운드로 대기한다. 진행 중이던 레이스는 버린다
        if (!config) return { ok: false, status: 400, message: '설정이 없습니다' };
        Object.assign(state, config);
        await this.applySlack(state, slack);
        state.seed = randomToken(8);
        state.startAt = null;
        state.round += 1;
        break;
      default: {
        const _exhaustive: never = kind;
        return _exhaustive;
      }
    }
    await this.ctx.storage.put('state', state);
    await this.touch();
    this.broadcast(this.stateMessage(state));
    return { ok: true, state };
  }

  /** 출발 알림. 시작 응답을 늦추지 않도록 뒤에서 보낸다 */
  private notifyStart(state: RoomState): void {
    if (!state.slackChannel) return;
    const link = this.roomUrl(state.id);
    this.ctx.waitUntil(
      this.notify(
        card(CARD_COLOR.start, '🏁 구슬 레이스 출발!', [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `🏁 *출발!* 지금 열면 진행 중인 장면부터 볼 수 있어요 · <${link}|보러 가기>` },
          },
        ])
      ).then(() => undefined)
    );
  }

  /** 링크 알림: 주최자가 "Slack 에 보내기"를 눌렀을 때 */
  private async notifyLink(state: RoomState, mapTitle: string): Promise<Response> {
    const link = this.roomUrl(state.id);
    const label = winnerLabel(state.winner);
    const total = countMarbles(state.names);
    const fields = [
      { type: 'mrkdwn', text: `*당첨*\n${label}` },
      { type: 'mrkdwn', text: `*참가*\n${total}명` },
    ];
    if (mapTitle) fields.push({ type: 'mrkdwn', text: `*맵*\n${esc(mapTitle)}` });
    const sent = await this.notify(
      card(CARD_COLOR.link, `🎱 구슬 레이스 추첨이 열렸어요 · ${total}명 중 ${label}`, [
        headerBlock('🎱 구슬 레이스 추첨이 열렸어요'),
        { type: 'section', fields },
        { type: 'section', text: { type: 'mrkdwn', text: participantsText(state.names) } },
        { type: 'section', text: { type: 'mrkdwn', text: `👉 *<${link}|추첨 보러 가기>*` } },
        contextBlock('링크를 열어 두면 주최자가 시작할 때 다 같이 출발해요'),
      ])
    );
    return sent.ok ? json({ ok: true }) : json({ error: sent.message }, 502);
  }

  /** 결과 알림: 주최자 화면이 올린 캡처를 보관하고 라운드마다 한 번만 알린다 */
  private async notifyResult(state: RoomState, form: FormData): Promise<Response> {
    const round = Number(form.get('round'));
    if (round !== state.round || state.startAt === null) return json({ error: '지난 라운드의 결과입니다' }, 409);
    if (!state.slackChannel) return json({ ok: true, skipped: true });
    const postedKey = `posted:${round}`;
    if (await this.ctx.storage.get(postedKey)) return json({ ok: true, already: true });

    let winners: string[] = [];
    try {
      const parsed = JSON.parse(String(form.get('winners') ?? '[]'));
      if (Array.isArray(parsed)) winners = parsed.filter((w) => typeof w === 'string').slice(0, 100);
    } catch {
      winners = [];
    }
    const known = new Set(state.names.map(bareName));
    const winnersOk = winners.length > 0 && winners.every((w) => known.has(bareName(w)));
    if (!winnersOk) return json({ error: '당첨자가 참가자 명단에 없습니다' }, 400);

    const image = form.get('image');
    let imageUrl: string | null = null;
    if (image instanceof File && image.size > 0) {
      if (image.size > MAX_IMAGE_BYTES) return json({ error: '결과 이미지가 너무 큽니다' }, 413);
      const isPng = image.type === 'image/png';
      await this.ctx.storage.put(`img:${round}`, {
        type: isPng ? 'image/png' : 'image/jpeg',
        bytes: await image.arrayBuffer(),
      });
      imageUrl = `${this.env.API_ORIGIN}/rooms/${state.id}/result/${round}.${isPng ? 'png' : 'jpg'}`;
    }

    const link = this.roomUrl(state.id);
    const winnerText = winners.join(', ');
    const headline = `🏆 당첨: ${winnerText}`;
    // 제목 한도 안에 들어감 여부: 넘치면 제목에는 인원만, 이름은 본문에 쓴다
    const headlineFits = headline.length <= MAX_HEADER_CHARS;
    const blocks: object[] = headlineFits
      ? [headerBlock(headline)]
      : [
          headerBlock(`🏆 당첨 ${winners.length}명`),
          { type: 'section', text: { type: 'mrkdwn', text: winners.map(esc).join(', ').slice(0, MAX_SECTION_CHARS) } },
        ];
    // 요약 줄: "7명 중 뒤에서 2명 · 맵 이름 · 2번째 추첨". 맵 이름이 없거나 첫 추첨이면 그 칸을 뺀다
    const meta = [`${countMarbles(state.names)}명 중 ${winnerLabel(state.winner)}`];
    const mapTitle = mapTitleOf(form.get('mapTitle'));
    if (mapTitle) meta.push(esc(mapTitle));
    if (round > 1) meta.push(`${round}번째 추첨`);
    blocks.push(contextBlock(meta.join(' · ')));
    if (imageUrl) blocks.push({ type: 'image', image_url: imageUrl, alt_text: `당첨: ${winnerText}`.slice(0, 2000) });
    blocks.push(contextBlock(`<${link}|같은 링크에서 다시 보기>`));

    // 먼저 표시해 두어 동시에 들어온 보고가 두 번 알리지 않게 하고, 실패하면 되돌린다
    await this.ctx.storage.put(postedKey, true);
    const sent = await this.notify(card(CARD_COLOR.result, headline, blocks));
    if (!sent.ok) {
      await this.ctx.storage.delete(postedKey);
      return json({ error: sent.message }, 502);
    }
    await this.touch();
    return json({ ok: true });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // 워커가 /rooms/:id/<action> 중 <action> 만 넘긴다
    const action = url.pathname.replace(/^\/+/, '');

    if (request.method === 'POST' && action === 'init') {
      if (await this.ctx.storage.get('state')) return json({ error: 'exists' }, 409);
      const { id, config, slack } = (await request.json()) as {
        id: string;
        config: RoomConfig;
        slack: SlackTarget | null;
      };
      const state: RoomState = { ...config, id, seed: randomToken(8), startAt: null, round: 1, slackChannel: null };
      await this.applySlack(state, slack);
      const hostKey = randomToken(20);
      await this.ctx.storage.put({ state, hostKey });
      await this.touch();
      return json({ id, hostKey, state });
    }

    if (request.method === 'POST' && (action === 'start' || action === 'reset' || action === 'config')) {
      const body = (await request.json().catch(() => ({}))) as {
        key?: unknown;
        config?: unknown;
        slack?: unknown;
      };
      const { key: hostKeyGiven } = body;
      let config: RoomConfig | undefined;
      let slack: SlackTarget | null | undefined;
      if (action === 'config') {
        const checked = validateConfig(body.config);
        if (typeof checked === 'string') return json({ error: checked }, 400);
        config = checked;
        const checkedSlack = validateSlack(body.slack, this.env);
        if (typeof checkedSlack === 'string') return json({ error: checkedSlack }, 400);
        slack = checkedSlack;
      }
      const wasWaiting = action === 'start' && (await this.load())?.state.startAt === null;
      const result = await this.applyAction(action, hostKeyGiven, config, slack);
      if (!result.ok) return json({ error: result.message }, result.status);
      if (wasWaiting) this.notifyStart(result.state);
      return json({ room: result.state, serverNow: Date.now(), count: this.viewerCount() });
    }

    if (request.method === 'POST' && action === 'notify') {
      const { key: hostKeyGiven, mapTitle } = (await request.json().catch(() => ({}))) as {
        key?: unknown;
        mapTitle?: unknown;
      };
      const loaded = await this.load();
      if (!loaded) return json({ error: '방이 만료됐습니다' }, 404);
      if (hostKeyGiven !== loaded.hostKey) return json({ error: '주최자만 할 수 있습니다' }, 403);
      return this.notifyLink(loaded.state, mapTitleOf(mapTitle));
    }

    if (request.method === 'POST' && action === 'result') {
      const form = await request.formData().catch(() => null);
      if (!form) return json({ error: '본문이 없습니다' }, 400);
      const loaded = await this.load();
      if (!loaded) return json({ error: '방이 만료됐습니다' }, 404);
      if (form.get('key') !== loaded.hostKey) return json({ error: '주최자만 할 수 있습니다' }, 403);
      return this.notifyResult(loaded.state, form);
    }

    // 결과 이미지: Slack 이 메시지를 그릴 때 가져간다
    const imageMatch = /^result\/(\d+)\.(jpg|png)$/.exec(action);
    if (request.method === 'GET' && imageMatch) {
      const stored = await this.ctx.storage.get<{ type: string; bytes: ArrayBuffer }>(`img:${imageMatch[1]}`);
      if (!stored) return new Response('not found', { status: 404 });
      return new Response(stored.bytes, {
        headers: { 'content-type': stored.type, 'cache-control': 'public, max-age=86400' },
      });
    }

    const loaded = await this.load();
    if (!loaded) return json({ error: '없는 방이거나 만료된 링크입니다' }, 404);

    if (request.method === 'GET' && action === '') {
      return json({ room: loaded.state, serverNow: Date.now(), count: this.viewerCount() });
    }

    if (request.method === 'GET' && action === 'ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected websocket' }, 426);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify(this.stateMessage(loaded.state)));
      this.broadcast({ t: 'count', count: this.viewerCount() });
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

    // 예전 클라이언트는 시작·다시 추첨을 WebSocket 으로 보낸다
    if (msg.t === 'start' || msg.t === 'reset') {
      const result = await this.applyAction(msg.t, msg.key);
      if (!result.ok) ws.send(JSON.stringify({ t: 'error', message: result.message }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code, 'closed');
    } catch {
      // 이미 닫힘
    }
    this.broadcast({ t: 'count', count: this.viewerCount() });
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'error');
    } catch {
      // 이미 닫힘
    }
    this.broadcast({ t: 'count', count: this.viewerCount() });
  }

  /** 마지막 활동 뒤 보관 기간이 지나면 방과 결과 이미지를 지운다 */
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

/**
 * 공용 저장소. 사이트 전체에 하나만 있고, 쓰는 사람 모두가 명단·마지막 설정(values)과 Slack 채널을 같이 쓴다.
 * 채널의 Webhook 주소는 워커가 방에 붙일 때만 꺼내고 화면에는 내보내지 않는다.
 * 워커가 검증을 마친 값만 넘기므로 여기서는 저장만 한다.
 */
export class SharedStore extends DurableObject<Env> {
  private async values(): Promise<Record<string, string>> {
    return (await this.ctx.storage.get<Record<string, string>>('values')) ?? {};
  }

  private async channels(): Promise<StoredChannel[]> {
    return (await this.ctx.storage.get<StoredChannel[]>('channels')) ?? [];
  }

  /** 화면에 보낼 모양: 채널은 id·이름만 */
  private async view() {
    const channels = (await this.channels()).map(({ id, channel }) => ({ id, channel }));
    return { values: await this.values(), channels };
  }

  async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname.replace(/^\/+/, '');
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    switch (action) {
      case 'load':
        return json(await this.view());
      case 'values': {
        // 받은 키만 바꾸고 null 은 지운다. 다른 키는 그대로 둔다
        const values = await this.values();
        for (const [key, value] of Object.entries(body.values as Record<string, string | null>)) {
          if (value === null) delete values[key];
          else values[key] = value;
        }
        await this.ctx.storage.put('values', values);
        return json({ ok: true });
      }
      case 'import': {
        // 예전에 브라우저에 저장한 값 옮기기: 명단은 합치고, 다른 값과 같은 이름의 채널은 이미 있으면 그대로 둔다
        const values = await this.values();
        for (const [key, value] of Object.entries(body.values as Record<string, string>)) {
          if (key === 'er_roster') values[key] = mergeRoster(values[key], value);
          else values[key] ??= value;
        }
        const channels = await this.channels();
        const known = new Set(channels.map((c) => c.channel));
        for (const target of body.channels as SlackTarget[]) {
          // 처음 보는 채널이고 한도 안 여부
          const canAdd = !known.has(target.channel) && channels.length < MAX_STORE_CHANNELS;
          if (canAdd) channels.push({ id: randomToken(8), ...target });
        }
        await this.ctx.storage.put({ values, channels });
        return json(await this.view());
      }
      case 'channels/add': {
        const target = body as SlackTarget;
        // 같은 이름으로 다시 넣으면 주소를 바꾼다
        const others = (await this.channels()).filter((c) => c.channel !== target.channel);
        // 채널 수 한도 도달 여부
        const isFull = others.length >= MAX_STORE_CHANNELS;
        if (isFull) return json({ error: `채널은 ${MAX_STORE_CHANNELS}개까지입니다` }, 400);
        const added = { id: randomToken(8), channel: target.channel, webhook: target.webhook };
        await this.ctx.storage.put('channels', [...others, added]);
        return json({ channels: (await this.view()).channels });
      }
      case 'channels/remove': {
        const left = (await this.channels()).filter((c) => c.id !== body.id);
        await this.ctx.storage.put('channels', left);
        return json({ channels: (await this.view()).channels });
      }
      case 'secret': {
        // 워커만 부른다: 방에 붙일 채널의 주소
        const found = (await this.channels()).find((c) => c.id === body.channelId);
        if (!found) return json({ error: '알림 채널을 찾을 수 없습니다. 설정에서 알림 채널을 다시 골라 주세요' }, 404);
        return json({ channel: found.channel, webhook: found.webhook });
      }
      default:
        return json({ error: 'not found' }, 404);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    // POST /slack/test : 채널을 저장하기 전에 Webhook 주소가 맞는지 확인 메시지를 보내 본다
    if (parts[0] === 'slack' && parts[1] === 'test' && parts.length === 2 && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      const target = validateSlack(body ?? null, env);
      if (typeof target === 'string') return json({ error: target }, 400, cors);
      if (!target) return json({ error: 'Webhook 주소가 없습니다' }, 400, cors);
      const sent = await postSlack(target.webhook, {
        text: `✅ 구슬 레이스 알림이 연결됐습니다. 앞으로 ${target.channel} 추첨의 링크·출발·결과를 이 채널로 보냅니다.`,
      });
      return sent.ok ? json({ ok: true }, 200, cors) : json({ error: sent.message }, 502, cors);
    }

    // GET /store : 공용 저장값. 채널은 이름·id 만 내보낸다
    if (parts[0] === 'store' && parts.length === 1 && request.method === 'GET') {
      return forwardToStore(env, 'load', {}, cors);
    }

    // POST /store/values|import|channels/add|channels/remove : 저장소에는 워커가 검증한 값만 넘긴다. secret 은 밖에서 부를 수 없다
    if (parts[0] === 'store' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      const action = parts.slice(1).join('/');
      let payload: object;
      switch (action) {
        case 'values': {
          const values = validateStoreValues(body?.values);
          if (typeof values === 'string') return json({ error: values }, 400, cors);
          payload = { values };
          break;
        }
        case 'import': {
          const values = validateStoreValues(body?.values ?? {});
          if (typeof values === 'string') return json({ error: values }, 400, cors);
          // 옮기는 값에서 지우기(null)는 뺀다
          const kept = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null));
          payload = { values: kept, channels: validateImportChannels(body?.channels, env) };
          break;
        }
        case 'channels/add': {
          const target = validateSlack(body?.target ?? null, env);
          if (typeof target === 'string') return json({ error: target }, 400, cors);
          if (!target) return json({ error: 'Webhook 주소가 없습니다' }, 400, cors);
          payload = target;
          break;
        }
        case 'channels/remove':
          payload = { id: String(body?.id ?? '') };
          break;
        default:
          return json({ error: 'not found' }, 404, cors);
      }
      return forwardToStore(env, action, payload, cors);
    }

    if (parts[0] !== 'rooms') return json({ error: 'not found' }, 404, cors);

    // POST /rooms : 방 만들기. 아이디가 겹치면(드물다) 다시 뽑는다
    if (parts.length === 1 && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      const config = validateConfig(body);
      if (typeof config === 'string') return json({ error: config }, 400, cors);
      const resolved = await resolveStoredSlack(body?.slack ?? null, env);
      if ('error' in resolved) return json({ error: resolved.error }, 400, cors);
      const slack = validateSlack(resolved.slack, env);
      if (typeof slack === 'string') return json({ error: slack }, 400, cors);
      for (let attempt = 0; attempt < 3; attempt++) {
        const id = randomToken(6);
        const stub = env.ROOM.get(env.ROOM.idFromName(id));
        const res = await stub.fetch('https://room/init', {
          method: 'POST',
          body: JSON.stringify({ id, config, slack: slack ?? null }),
          headers: { 'content-type': 'application/json' },
        });
        if (res.status === 409) continue;
        return new Response(res.body, { status: res.status, headers: { ...Object.fromEntries(res.headers), ...cors } });
      }
      return json({ error: '방 아이디 생성 실패' }, 500, cors);
    }

    // GET /rooms/:id , GET /rooms/:id/ws , GET /rooms/:id/result/:round.jpg
    // POST /rooms/:id/start|reset|config|notify|result
    if (parts.length >= 2 && parts.length <= 4) {
      const id = parts[1].toUpperCase();
      const action = parts.slice(2).join('/');
      const isImage = /^result\/\d+\.(jpg|png)$/.test(action);
      const routeOk =
        (request.method === 'GET' && (action === '' || action === 'ws' || isImage)) ||
        (request.method === 'POST' && ['start', 'reset', 'config', 'notify', 'result'].includes(action));
      if (!routeOk || !/^[A-Z2-9]{6}$/.test(id)) return json({ error: 'not found' }, 404, cors);
      const stub = env.ROOM.get(env.ROOM.idFromName(id));
      // 설정 수정에서 공용 채널을 고르면 방에 넘기기 전에 Webhook 주소로 바꾼다
      let forward = request;
      if (request.method === 'POST' && action === 'config') {
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
        const resolved = await resolveStoredSlack(body?.slack, env);
        if ('error' in resolved) return json({ error: resolved.error }, 400, cors);
        forward = new Request(request.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, slack: resolved.slack }),
        });
      }
      const res = await stub.fetch(`https://room/${action}`, forward);
      if (res.status === 101) return res;
      return new Response(res.body, { status: res.status, headers: { ...Object.fromEntries(res.headers), ...cors } });
    }

    return json({ error: 'not found' }, 404, cors);
  },
};
