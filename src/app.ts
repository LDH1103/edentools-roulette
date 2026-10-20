// 화면 흐름.
// - 주소에 방 번호(#ABC123)가 있으면 방 모드: 모두 같은 설정·시드·시작 시각을 받아 같은 레이스를 본다.
// - 없으면 설정 모드: 참가자와 당첨 방식을 정해 공유 링크를 만들거나(주최자), 방 없이 혼자 돌린다.
import { translate } from './localization';
import { initMapSelector } from './mapSelector';
import options from './options';
import type { Roulette } from './roulette';
import { type ConnState, createRoom, RoomClient, type RoomConfig, type RoomState, type WinnerSetting } from './sync';

const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const API_BASE =
  new URLSearchParams(location.search).get('api') ??
  (IS_LOCAL ? 'http://localhost:8787' : 'https://roulette-api.edentools.dev');

const NAMES_KEY = 'er_names';
const ROSTER_KEY = 'er_roster';
const DARK_KEY = 'er_dark';
const WINNER_KEY = 'er_winner';
const hostKeyName = (id: string) => `er_host_${id}`;
const EXAMPLE_NAMES = '수박*2\n키위*2\n귤*2';
const ROOM_ID = /^[A-Z2-9]{6}$/;
/** 결과가 나온 뒤 방 패널을 다시 띄우기까지(ms). 원작처럼 당첨 연출을 먼저 보여 준다 */
const RESULT_PANEL_DELAY_MS = 2500;

function $<T extends HTMLElement = HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing element ${selector}`);
  return el;
}

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 저장 불가 환경은 무시
  }
}

function newSeed(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function toast(msg: string, ms = 1800): void {
  const el = document.createElement('div');
  el.classList.add('toast');
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), ms);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 쉼표·줄바꿈으로 나눈 이름 목록 (이름 문법 그대로) */
function splitNames(value: string): string[] {
  return value
    .split(/[,\r\n]/g)
    .map((v) => v.trim())
    .filter((v) => !!v);
}

/** 이름 문법(이름/가중치*개수)을 뗀 이름 */
function bareName(nameStr: string): string {
  return nameStr.replace(/[/*].*$/, '').trim();
}

/** 네트워크 오류를 사람이 읽을 문장으로 */
function friendlyError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return '서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 잠시 후 다시 시도하세요.';
  }
  return message;
}

/** 예전 방의 custom(특정 등수)은 등수 범위로 바꿔 다룬다 */
function normalizeWinner(w: WinnerSetting): WinnerSetting {
  return w.type === 'custom' ? { type: 'multi', start: w.start, end: w.start } : w;
}

function winnerShort(w: WinnerSetting): string {
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

function winnerSentence(w: WinnerSetting): string {
  switch (w.type) {
    case 'first':
      return `먼저 도착한 ${w.end}명이 당첨됩니다.`;
    case 'last':
      return `마지막에 도착한 ${w.end}명이 당첨됩니다.`;
    case 'custom':
      return `${w.start}등으로 도착한 1명이 당첨됩니다.`;
    case 'multi':
      return w.start === w.end
        ? `${w.start}등으로 도착한 1명이 당첨됩니다.`
        : `${w.start}등부터 ${w.end}등까지 당첨됩니다.`;
    default: {
      const _exhaustive: never = w.type;
      return _exhaustive;
    }
  }
}

/** 당첨 설정을 실제 구슬 수에 맞춘 0-based 범위로 바꿔 넣는다 */
function applyWinnerSetting(roulette: Roulette, w: WinnerSetting): void {
  const count = roulette.getCount();
  switch (w.type) {
    case 'first':
      roulette.setWinnerRange(0, w.end - 1);
      break;
    case 'last':
      roulette.setWinnerRange(Math.max(0, count - w.end), Math.max(0, count - 1));
      break;
    case 'custom':
      roulette.setWinnerRange(w.start - 1, w.start - 1);
      break;
    case 'multi':
      roulette.setWinnerRange(w.start - 1, w.end - 1);
      break;
    default: {
      const _exhaustive: never = w.type;
      void _exhaustive;
    }
  }
}

function initTheme(roulette: Roulette): void {
  let dark = storageGet(DARK_KEY) !== '0';
  const buttons = document.querySelectorAll<HTMLButtonElement>('.btn-theme');
  const apply = () => {
    roulette.setTheme(dark ? 'dark' : 'light');
    document.documentElement.classList.toggle('light', !dark);
    buttons.forEach((b) => {
      b.textContent = dark ? '☀' : '☾';
      b.title = dark ? '밝은 테마로' : '어두운 테마로';
    });
    storageSet(DARK_KEY, dark ? '1' : '0');
  };
  buttons.forEach((b) =>
    b.addEventListener('click', () => {
      dark = !dark;
      apply();
    })
  );
  apply();
}

export function initApp(roulette: Roulette): void {
  const boot = () => {
    if (!roulette.isReady) {
      window.setTimeout(boot, 100);
      return;
    }
    initTheme(roulette);
    // 주소의 방 번호를 손으로 바꾸거나 뒤로 가기를 누르면 처음부터 다시 그린다
    window.addEventListener('hashchange', () => location.reload());
    window.addEventListener('popstate', () => location.reload());

    const roomId = location.hash.replace(/^#/, '').toUpperCase();
    if (ROOM_ID.test(roomId)) {
      void enterRoom(roulette, roomId, storageGet(hostKeyName(roomId)));
    } else {
      setupMode(roulette);
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}

// ---------------------------------------------------------------------------
// 설정 모드
// ---------------------------------------------------------------------------
function setupMode(roulette: Roulette): void {
  const settings = $('#settings');
  const namesInput = $<HTMLTextAreaElement>('#in_names');
  const winCount = $<HTMLInputElement>('#in_winCount');
  const rangeStart = $<HTMLInputElement>('#in_rangeStart');
  const rangeEnd = $<HTMLInputElement>('#in_rangeEnd');
  const chkSkill = $<HTMLInputElement>('#chkSkill');
  const chkRecording = $<HTMLInputElement>('#chkAutoRecording');
  const errorEl = $('#setupError');
  const countEl = $('#marbleCount');

  settings.hidden = false;

  let winner: WinnerSetting = { type: 'first', start: 1, end: 1 };
  try {
    const saved = JSON.parse(storageGet(WINNER_KEY) ?? 'null');
    if (saved && ['first', 'last', 'custom', 'multi'].includes(saved.type)) winner = normalizeWinner(saved);
  } catch {
    // 저장값이 깨졌으면 기본값
  }
  /** 미리보기용 시드. 섞기를 누르면 바뀐다. 실제 추첨 시드는 방을 만들 때 서버가 새로 정한다 */
  let previewSeed = newSeed();

  const getNames = () => splitNames(namesInput.value);

  function showError(msg: string | null) {
    errorEl.textContent = msg ?? '';
    errorEl.hidden = !msg;
  }

  /** 입력으로 당첨 설정을 읽어 구슬 수에 맞게 자른다 (범위가 뒤집히면 방금 고친 쪽을 존중) */
  function readWinner(edited?: 'start' | 'end'): WinnerSetting {
    const count = Math.max(1, roulette.getCount());
    const clampN = (v: number) => Math.min(count, Math.max(1, v || 1));
    switch (winner.type) {
      case 'first':
      case 'last':
        return { type: winner.type, start: 1, end: clampN(parseInt(winCount.value, 10)) };
      case 'custom':
      case 'multi': {
        let s = clampN(parseInt(rangeStart.value, 10));
        let e = clampN(parseInt(rangeEnd.value, 10));
        if (e < s) {
          if (edited === 'end') s = e;
          else e = s;
        }
        return { type: 'multi', start: s, end: e };
      }
      default: {
        const _exhaustive: never = winner.type;
        return _exhaustive;
      }
    }
  }

  function renderWinnerInputs() {
    const count = Math.max(1, roulette.getCount());
    document.querySelectorAll<HTMLButtonElement>('.btn-winner').forEach((b) => {
      const active = b.dataset.type === winner.type;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    const byCount = winner.type === 'first' || winner.type === 'last';
    $('#winCountRow').hidden = !byCount;
    $('#winRangeRow').hidden = byCount;
    winCount.max = rangeStart.max = rangeEnd.max = String(count);
    if (byCount) {
      winCount.value = String(winner.end);
    } else {
      rangeStart.value = String(winner.start);
      rangeEnd.value = String(winner.end);
    }
    $('#winnerSummary').textContent = winnerSentence(winner);
    const mapTitle = $<HTMLSelectElement>('#sltMap').selectedOptions[0]?.textContent ?? '';
    $('#settingsSummary').textContent = `설정 · ${winnerShort(winner)}${mapTitle ? ` · ${mapTitle}` : ''}`;
  }

  function applyWinner(edited?: 'start' | 'end') {
    winner = readWinner(edited);
    applyWinnerSetting(roulette, winner);
    storageSet(WINNER_KEY, JSON.stringify(winner));
    renderWinnerInputs();
  }

  /** 입력창의 이름으로 구슬을 다시 놓는다 */
  function getReady() {
    const names = getNames();
    roulette.setMarbles(names, previewSeed);
    storageSet(NAMES_KEY, names.join('\n'));
    countEl.textContent = `구슬 ${roulette.getCount()}개`;
    applyWinner();
    renderRoster();
  }

  // ----- 참가자 입력 -----
  const urlNames = new URLSearchParams(location.search).get('names');
  const savedNames = storageGet(NAMES_KEY);
  namesInput.value = urlNames ? urlNames.replace(/,/g, '\n') : (savedNames ?? EXAMPLE_NAMES).replace(/,/g, '\n');
  namesInput.addEventListener('input', getReady);
  namesInput.addEventListener('blur', () => {
    // 같은 이름은 개수로 합친다: 홍길동,홍길동 → 홍길동*2
    const counts = new Map<string, number>();
    for (const raw of getNames()) {
      const m = /^\s*([^/*]+?)\s*(?:\/(\d+))?\s*(?:\*(\d+))?\s*$/.exec(raw);
      if (!m) continue;
      const key = m[2] ? `${m[1]}/${m[2]}` : m[1];
      counts.set(key, (counts.get(key) ?? 0) + (m[3] ? parseInt(m[3], 10) : 1));
    }
    const merged = [...counts].map(([key, n]) => (n > 1 ? `${key}*${n}` : key)).join('\n');
    if (merged !== namesInput.value) {
      namesInput.value = merged;
      getReady();
    }
  });

  // ----- 저장된 명단 (칩) -----
  const chips = $('#rosterChips');
  const rosterEdit = $<HTMLTextAreaElement>('#rosterEdit');
  const rosterEditor = $('#rosterEditor');
  const rosterToggle = $('#rosterToggleEdit');
  let roster: string[] = [];
  try {
    const v = JSON.parse(storageGet(ROSTER_KEY) ?? '[]');
    if (Array.isArray(v)) roster = v.map(String);
  } catch {
    roster = [];
  }
  function renderRoster() {
    const current = new Set(getNames().map(bareName));
    chips.replaceChildren(
      ...roster.map((name) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.textContent = name;
        b.setAttribute('aria-pressed', String(current.has(name)));
        b.addEventListener('click', () => toggleName(name));
        return b;
      })
    );
    const hasRoster = roster.length > 0;
    $('#rosterEmpty').hidden = hasRoster;
    $('#rosterAll').hidden = !hasRoster;
    $('#rosterNone').hidden = !hasRoster;
  }
  function toggleName(name: string) {
    const names = getNames();
    const has = names.some((n) => bareName(n) === name);
    const next = has ? names.filter((n) => bareName(n) !== name) : [...names, name];
    namesInput.value = next.join('\n');
    getReady();
  }
  function saveRoster(list: string[]) {
    roster = [...new Set(list.map((s) => s.trim().slice(0, 40)).filter(Boolean))];
    storageSet(ROSTER_KEY, JSON.stringify(roster));
    rosterEdit.value = roster.join('\n');
    renderRoster();
  }
  function setEditorOpen(open: boolean) {
    rosterEditor.hidden = !open;
    rosterToggle.setAttribute('aria-expanded', String(open));
    rosterToggle.textContent = open ? '편집 닫기' : '편집';
  }
  rosterEdit.value = roster.join('\n');
  rosterToggle.addEventListener('click', () => {
    setEditorOpen(rosterEditor.hidden);
    if (!rosterEditor.hidden) rosterEdit.focus();
  });
  $('#rosterSave').addEventListener('click', () => {
    saveRoster(rosterEdit.value.split('\n'));
    setEditorOpen(false);
    toast(roster.length ? `명단 ${roster.length}명을 저장했습니다.` : '명단을 비웠습니다.');
  });
  $('#rosterFromNames').addEventListener('click', () => {
    const merged = [...new Set([...splitNames(rosterEdit.value), ...getNames().map(bareName)])];
    rosterEdit.value = merged.join('\n');
  });
  $('#rosterAll').addEventListener('click', () => {
    const names = getNames();
    const bare = new Set(names.map(bareName));
    namesInput.value = [...names, ...roster.filter((r) => !bare.has(r))].join('\n');
    getReady();
  });
  $('#rosterNone').addEventListener('click', () => {
    namesInput.value = getNames()
      .filter((n) => !roster.includes(bareName(n)))
      .join('\n');
    getReady();
  });

  // ----- 당첨 방식 -----
  document.querySelectorAll<HTMLButtonElement>('.btn-winner').forEach((b) => {
    b.addEventListener('click', () => {
      const type = b.dataset.type as WinnerSetting['type'];
      if (type === 'first' || type === 'last') {
        winner = { type, start: 1, end: winner.type === 'first' || winner.type === 'last' ? winner.end : 1 };
      } else {
        winner = { type: 'multi', start: 1, end: Math.min(3, Math.max(1, roulette.getCount())) };
      }
      renderWinnerInputs();
      applyWinner();
    });
  });
  winCount.addEventListener('change', () => applyWinner());
  rangeStart.addEventListener('change', () => applyWinner('start'));
  rangeEnd.addEventListener('change', () => applyWinner('end'));

  // ----- 토글 -----
  chkSkill.checked = options.useSkills;
  chkSkill.addEventListener('change', () => {
    options.useSkills = chkSkill.checked;
  });
  chkRecording.checked = false;
  roulette.setAutoRecording(false);
  chkRecording.addEventListener('change', () => roulette.setAutoRecording(chkRecording.checked));

  // 좁은 화면에서는 설정을 접어 둔다 (넓은 화면에서는 버튼이 숨고 항상 펼쳐져 있다)
  const toggleBtn = $('#btnToggleSettings');
  const collapsible = $('.collapsible-rows');
  toggleBtn.addEventListener('click', () => {
    const collapsed = collapsible.classList.toggle('collapsed');
    toggleBtn.setAttribute('aria-expanded', String(!collapsed));
    $('.toggle-arrow').textContent = collapsed ? '▲' : '▼';
  });

  // ----- 맵 -----
  initMapSelector(roulette, getReady);

  // ----- 섞기 / 혼자 돌리기 / 공유 링크 -----
  $('#btnShuffle').addEventListener('click', () => {
    previewSeed = newSeed();
    getReady();
  });

  const onGoal = (e: Event) => {
    const detail = (e as CustomEvent<{ winners: string[] }>).detail;
    toast(`당첨: ${detail.winners.join(', ')}`, 4000);
    window.setTimeout(() => {
      settings.classList.remove('hide');
    }, 3000);
  };
  roulette.addEventListener('goal', onGoal);

  $('#btnLocal').addEventListener('click', () => {
    if (roulette.getCount() < 2) {
      showError('참가자를 2명 이상 입력하세요.');
      return;
    }
    showError(null);
    roulette.setMarbles(getNames(), newSeed());
    applyWinner();
    settings.classList.add('hide');
    roulette.start();
  });

  const createBtn = $<HTMLButtonElement>('#btnCreateRoom');
  createBtn.addEventListener('click', async () => {
    if (roulette.getCount() < 2) {
      showError('참가자를 2명 이상 입력하세요.');
      return;
    }
    showError(null);
    const config: RoomConfig = {
      names: getNames(),
      map: roulette.getCurrentMap()?.index ?? 0,
      winner: readWinner(),
      useSkills: options.useSkills,
    };
    createBtn.disabled = true;
    createBtn.textContent = '링크 만드는 중…';
    try {
      const { id, hostKey } = await createRoom(API_BASE, config);
      storageSet(hostKeyName(id), hostKey);
      // 새로고침 없이 방 화면으로 넘어간다. 주소창에는 공유할 링크가 남는다
      roulette.removeEventListener('goal', onGoal);
      history.pushState(null, '', `#${id}`);
      void enterRoom(roulette, id, hostKey);
    } catch (e) {
      showError(`링크를 만들지 못했습니다. ${friendlyError(e)}`);
      createBtn.disabled = false;
      createBtn.textContent = '공유 링크 만들기';
    }
  });

  getReady();
}

// ---------------------------------------------------------------------------
// 방 모드
// ---------------------------------------------------------------------------
async function enterRoom(roulette: Roulette, id: string, hostKey: string | null): Promise<void> {
  const panel = $('#roomPanel');
  const overlay = $('#overlay');
  const eyebrow = $('#overlayEyebrow');
  const big = $('#overlayBig');
  const text = $('#overlayText');
  const overlayActions = $('#overlayActions');
  const netEl = $('#roomNet');
  const countEl = $('#roomCount');
  const btnStart = $<HTMLButtonElement>('#btnHostStart');
  const btnReset = $<HTMLButtonElement>('#btnHostReset');
  const chkRecord = $<HTMLInputElement>('#chkRoomRecord');
  const isHost = !!hostKey;
  const shareUrl = `${location.origin}${location.pathname}#${id}`;

  $('#settings').hidden = true;
  $('#roomId').textContent = id;
  $<HTMLInputElement>('#shareUrl').value = shareUrl;
  roulette.setAutoRecording(false);
  chkRecord.checked = false;

  function showOverlay(eyebrowText: string, bigText: string, bodyText: string, withActions = false) {
    overlay.hidden = false;
    eyebrow.textContent = eyebrowText;
    big.textContent = bigText;
    text.textContent = bodyText;
    overlayActions.hidden = !withActions;
  }

  showOverlay('불러오는 중', id, '방 정보를 받고 있습니다.');

  const client = new RoomClient(API_BASE, id);
  try {
    await client.load();
  } catch (e) {
    showOverlay('열 수 없음', id, friendlyError(e), true);
    $('#btnOverlayRetry').addEventListener('click', () => location.reload(), { once: true });
    return;
  }
  overlay.hidden = true;
  panel.hidden = false;

  let lastRound = -1;
  let started = false;
  /** 결과가 나왔고 연출을 보여 준 뒤라 패널을 다시 띄워도 되는지 */
  let resultShown = false;
  let resultTimer = 0;

  function slackText(s: RoomState): string {
    const people = s.names.map(bareName).join(', ');
    return [
      '🎱 구슬 레이스 추첨',
      `• 참가자 ${roulette.getCount()}명: ${people}`,
      `• 당첨: ${winnerSentence(s.winner)}`,
      `• 링크: ${shareUrl}`,
      '링크를 열어 두면 주최자가 시작할 때 모두 같이 출발하고, 누구 화면에서나 같은 결과가 나옵니다.',
    ].join('\n');
  }

  function applyState(s: RoomState) {
    if (s.round !== lastRound) {
      // 새 라운드(처음 또는 다시 추첨): 설정·시드로 구슬을 놓는다
      lastRound = s.round;
      started = false;
      resultShown = false;
      window.clearTimeout(resultTimer);
      options.useSkills = s.useSkills;
      roulette.setMap(s.map);
      roulette.setMarbles(s.names, s.seed);
      applyWinnerSetting(roulette, s.winner);
      const mapTitle = translate(roulette.getCurrentMap()?.title ?? '');
      $('#roomSummary').textContent = `${roulette.getCount()}명 중 ${winnerShort(s.winner)} 당첨 · ${mapTitle}`;
    }
    if (s.startAt !== null && !started) {
      started = true;
      roulette.startSynced(s.startAt, () => client.serverNow());
    } else if (s.startAt === null && started) {
      started = false;
      roulette.cancelRun();
    }
    render();
  }

  const NET_TEXT: Record<ConnState, string> = {
    connecting: '연결 중',
    online: '연결됨',
    polling: '연결됨',
    reconnecting: '다시 연결 중',
  };

  const hostShare = $('#hostShare');
  const btnCopyLinkSmall = $('#btnCopyLinkSmall');
  const recordWrap = $('#roomRecordWrap');
  const noteEl = $('#roomNote');

  function render() {
    const s = client.state;
    if (!s) return;
    const now = client.serverNow();
    const waiting = s.startAt === null;
    const countdown = s.startAt !== null && s.startAt > now;
    const catchingUp = !waiting && !countdown && roulette.isCatchingUp;

    if (countdown) {
      showOverlay('출발까지', String(Math.ceil((s.startAt! - now) / 1000)), winnerSentence(s.winner));
    } else if (catchingUp) {
      showOverlay('따라잡는 중', '…', '이미 진행된 장면을 빠르게 재생하고 있습니다.');
    } else {
      overlay.hidden = true;
    }

    // 원작 설정창처럼 레이스 중에는 숨기고, 기다릴 때와 결과가 나온 뒤에만 보인다
    panel.classList.toggle('hide', !(waiting || resultShown));
    hostShare.hidden = !(isHost && waiting);
    btnCopyLinkSmall.hidden = isHost && waiting;
    recordWrap.hidden = !waiting;
    btnStart.hidden = !(isHost && waiting);
    btnReset.hidden = !(isHost && !waiting);

    let note = '';
    if (waiting) {
      note = isHost
        ? '보는 사람이 다 들어오지 않아도 시작할 수 있습니다. 늦게 들어온 사람도 같은 장면을 따라잡습니다.'
        : '링크를 열어 두기만 하면 됩니다. 주최자가 시작하면 모두 같이 출발합니다.';
    } else if (resultShown) {
      note = isHost ? '추첨이 끝났습니다. "다시 추첨"을 누르면 새 시드로 모두 다시 봅니다.' : '추첨이 끝났습니다.';
    }
    noteEl.textContent = note;
  }

  const renderCount = (n: number) => {
    countEl.textContent = n > 0 ? `${n}명 보는 중` : '';
  };
  client.on('state', applyState);
  client.on('count', renderCount);
  renderCount(client.count);
  client.on('conn', (c) => {
    netEl.dataset.state = c;
    netEl.textContent = NET_TEXT[c];
    netEl.title = c === 'polling' ? '실시간 연결이 막혀 있어 1.5초마다 상태를 받고 있습니다.' : '';
  });
  client.on('error', (msg) => toast(msg, 3000));
  if (client.state) applyState(client.state);
  client.connect();
  window.setInterval(render, 100);

  roulette.addEventListener('goal', (e) => {
    const winners = (e as CustomEvent<{ winners: string[] }>).detail.winners;
    toast(`당첨: ${winners.join(', ')}`, 5000);
    window.clearTimeout(resultTimer);
    resultTimer = window.setTimeout(() => {
      resultShown = true;
      render();
    }, RESULT_PANEL_DELAY_MS);
  });

  btnStart.addEventListener('click', async () => {
    if (!hostKey) return;
    btnStart.disabled = true;
    try {
      await client.action('start', hostKey);
    } catch (e) {
      toast(`시작하지 못했습니다. ${friendlyError(e)}`, 3500);
    } finally {
      btnStart.disabled = false;
    }
  });
  btnReset.addEventListener('click', async () => {
    if (!hostKey) return;
    const question = resultShown
      ? '결과를 버리고 새 시드로 다시 추첨할까요?'
      : '진행 중인 레이스를 멈추고 다시 추첨할까요?';
    if (!window.confirm(question)) return;
    btnReset.disabled = true;
    try {
      await client.action('reset', hostKey);
    } catch (e) {
      toast(`다시 추첨하지 못했습니다. ${friendlyError(e)}`, 3500);
    } finally {
      btnReset.disabled = false;
    }
  });

  const copyLink = async () => {
    toast(
      (await copyText(shareUrl)) ? '링크를 복사했습니다.' : `복사가 막혀 있습니다. 주소를 직접 복사하세요: ${shareUrl}`,
      3000
    );
  };
  $('#btnCopyLink').addEventListener('click', copyLink);
  $('#btnCopyLinkSmall').addEventListener('click', copyLink);
  $('#shareUrl').addEventListener('focus', (e) => (e.target as HTMLInputElement).select());
  $('#btnCopySlack').addEventListener('click', async () => {
    const s = client.state;
    if (!s) return;
    toast((await copyText(slackText(s))) ? 'Slack 안내 문구를 복사했습니다.' : '복사가 막혀 있습니다.', 3000);
  });
  chkRecord.addEventListener('change', () => roulette.setAutoRecording(chkRecord.checked));
}
