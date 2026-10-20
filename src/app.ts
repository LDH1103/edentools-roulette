// 화면 흐름.
// - 주소에 방 번호(#ABC123)가 있으면 방 모드: 모두 같은 설정·시드·시작 시각을 받아 같은 레이스를 본다.
// - 없으면 설정 모드: 참가자와 당첨 방식을 정해 공유 링크를 만들거나(주최자), 방 없이 혼자 돌린다.
import { initMapSelector } from './mapSelector';
import options from './options';
import type { Roulette } from './roulette';
import { createRoom, fetchRoom, RoomClient, type RoomConfig, type RoomState, type WinnerSetting } from './sync';

const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const API_BASE =
  new URLSearchParams(location.search).get('api') ??
  (IS_LOCAL ? 'http://localhost:8787' : 'https://roulette-api.edentools.dev');

const NAMES_KEY = 'er_names';
const ROSTER_KEY = 'er_roster';
const DARK_KEY = 'er_dark';
const WINNER_KEY = 'er_winner';
const hostKeyName = (id: string) => `er_host_${id}`;
const EXAMPLE_NAMES = '수박*2,키위*2,귤*2';
const ROOM_ID = /^[A-Z2-9]{6}$/;

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

function toast(msg: string, ms = 1600): void {
  const el = document.createElement('div');
  el.classList.add('toast');
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

function winnerLabel(w: WinnerSetting): string {
  switch (w.type) {
    case 'first':
      return `먼저 도착한 ${w.end}명`;
    case 'last':
      return `마지막에 도착한 ${w.end}명`;
    case 'custom':
      return `${w.start}등`;
    case 'multi':
      return `${w.start}등 ~ ${w.end}등`;
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

function applyTheme(roulette: Roulette, dark: boolean): void {
  roulette.setTheme(dark ? 'dark' : 'light');
  document.documentElement.classList.toggle('light', !dark);
  $('#btnTheme').textContent = dark ? '☀' : '☾';
  storageSet(DARK_KEY, dark ? '1' : '0');
}

export function initApp(roulette: Roulette): void {
  const boot = () => {
    if (!roulette.isReady) {
      window.setTimeout(boot, 100);
      return;
    }
    let dark = storageGet(DARK_KEY) !== '0';
    applyTheme(roulette, dark);
    $('#btnTheme').addEventListener('click', () => {
      dark = !dark;
      applyTheme(roulette, dark);
    });
    // 주소의 방 번호가 바뀌면 처음부터 다시 시작하는 편이 안전하다
    window.addEventListener('hashchange', () => location.reload());

    const roomId = location.hash.replace(/^#/, '').toUpperCase();
    if (ROOM_ID.test(roomId)) {
      void enterRoom(roulette, roomId);
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
  const winRank = $<HTMLInputElement>('#in_rank');
  const rangeStart = $<HTMLInputElement>('#in_rangeStart');
  const rangeEnd = $<HTMLInputElement>('#in_rangeEnd');
  const chkSkill = $<HTMLInputElement>('#chkSkill');
  const chkRecording = $<HTMLInputElement>('#chkAutoRecording');
  const errorEl = $('#setupError');

  settings.hidden = false;

  let winner: WinnerSetting = { type: 'first', start: 1, end: 1 };
  try {
    const saved = JSON.parse(storageGet(WINNER_KEY) ?? 'null');
    if (saved && ['first', 'last', 'custom', 'multi'].includes(saved.type)) winner = saved;
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

  /** 입력으로 당첨 설정을 읽어 정규화한다 (범위가 뒤집히면 방금 고친 쪽을 존중) */
  function readWinner(edited?: 'start' | 'end'): WinnerSetting {
    const count = Math.max(1, roulette.getCount());
    const clampN = (v: number) => Math.min(count, Math.max(1, v || 1));
    switch (winner.type) {
      case 'first':
      case 'last':
        return { type: winner.type, start: 1, end: clampN(parseInt(winCount.value, 10)) };
      case 'custom': {
        const r = clampN(parseInt(winRank.value, 10));
        return { type: 'custom', start: r, end: r };
      }
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
    document.querySelectorAll<HTMLButtonElement>('.btn-winner').forEach((b) => {
      b.classList.toggle('active', b.dataset.type === winner.type);
    });
    $('#winCountRow').hidden = !(winner.type === 'first' || winner.type === 'last');
    $('#winRankRow').hidden = winner.type !== 'custom';
    $('#winRangeRow').hidden = winner.type !== 'multi';
    if (winner.type === 'first' || winner.type === 'last') winCount.value = String(winner.end);
    if (winner.type === 'custom') winRank.value = String(winner.start);
    if (winner.type === 'multi') {
      rangeStart.value = String(winner.start);
      rangeEnd.value = String(winner.end);
    }
    $('#winnerSummary').textContent = winnerLabel(winner);
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
    storageSet(NAMES_KEY, names.join(','));
    applyWinner();
    renderRoster();
  }

  // ----- 참가자 입력 -----
  const urlNames = new URLSearchParams(location.search).get('names');
  namesInput.value = urlNames ? urlNames.replace(/,/g, '\n') : (storageGet(NAMES_KEY) ?? EXAMPLE_NAMES);
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
  let roster: string[] = [];
  try {
    const v = JSON.parse(storageGet(ROSTER_KEY) ?? '[]');
    if (Array.isArray(v)) roster = v.map(String);
  } catch {
    roster = [];
  }
  function renderRoster() {
    const current = new Set(getNames().map((n) => n.replace(/[/*].*$/, '').trim()));
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
    $('#rosterEmpty').hidden = roster.length > 0;
  }
  function toggleName(name: string) {
    const names = getNames();
    const has = names.some((n) => n.replace(/[/*].*$/, '').trim() === name);
    const next = has ? names.filter((n) => n.replace(/[/*].*$/, '').trim() !== name) : [...names, name];
    namesInput.value = next.join('\n');
    getReady();
  }
  function saveRoster(list: string[]) {
    roster = [...new Set(list.map((s) => s.trim().slice(0, 40)).filter(Boolean))];
    storageSet(ROSTER_KEY, JSON.stringify(roster));
    rosterEdit.value = roster.join('\n');
    renderRoster();
  }
  rosterEdit.value = roster.join('\n');
  $('#rosterSave').addEventListener('click', () => saveRoster(rosterEdit.value.split('\n')));
  $('#rosterFromNames').addEventListener('click', () => {
    saveRoster([...roster, ...getNames().map((n) => n.replace(/[/*].*$/, '').trim())]);
    $<HTMLDetailsElement>('#rosterDetails').open = true;
  });
  $('#rosterAll').addEventListener('click', () => {
    const names = getNames();
    const bare = new Set(names.map((n) => n.replace(/[/*].*$/, '').trim()));
    namesInput.value = [...names, ...roster.filter((r) => !bare.has(r))].join('\n');
    getReady();
  });
  $('#rosterNone').addEventListener('click', () => {
    namesInput.value = getNames()
      .filter((n) => !roster.includes(n.replace(/[/*].*$/, '').trim()))
      .join('\n');
    getReady();
  });

  // ----- 당첨 방식 -----
  document.querySelectorAll<HTMLButtonElement>('.btn-winner').forEach((b) => {
    b.addEventListener('click', () => {
      const type = b.dataset.type as WinnerSetting['type'];
      if (type === 'first' || type === 'last') winner = { type, start: 1, end: Math.max(1, winner.end) };
      else if (type === 'custom') winner = { type, start: Math.max(1, winner.start), end: Math.max(1, winner.start) };
      else winner = { type, start: Math.max(1, winner.start), end: Math.max(winner.start, winner.end, 3) };
      renderWinnerInputs();
      applyWinner();
    });
  });
  winCount.addEventListener('change', () => applyWinner());
  winRank.addEventListener('change', () => applyWinner());
  rangeStart.addEventListener('change', () => applyWinner('start'));
  rangeEnd.addEventListener('change', () => applyWinner('end'));

  // ----- 토글 -----
  chkSkill.checked = options.useSkills;
  chkSkill.addEventListener('change', () => {
    options.useSkills = chkSkill.checked;
  });
  chkRecording.checked = false;
  chkRecording.addEventListener('change', () => roulette.setAutoRecording(chkRecording.checked));

  const toggleBtn = $('#btnToggleSettings');
  const collapsible = $('.collapsible-rows');
  toggleBtn.addEventListener('click', () => {
    collapsible.classList.toggle('collapsed');
    $('.toggle-arrow').textContent = collapsible.classList.contains('collapsed') ? '▲' : '▼';
  });

  // ----- 맵 -----
  initMapSelector(roulette, getReady);

  // ----- 섞기 / 혼자 돌리기 / 공유 링크 -----
  $('#btnShuffle').addEventListener('click', () => {
    previewSeed = newSeed();
    getReady();
  });

  roulette.addEventListener('goal', (e) => {
    const detail = (e as CustomEvent<{ winners: string[] }>).detail;
    toast(`당첨: ${detail.winners.join(', ')}`, 4000);
    window.setTimeout(() => {
      settings.classList.remove('hide');
    }, 3000);
  });

  $('#btnLocal').addEventListener('click', () => {
    const names = getNames();
    if (names.length < 2) {
      showError('참가자를 2명 이상 입력하세요.');
      return;
    }
    showError(null);
    roulette.setMarbles(names, newSeed());
    applyWinner();
    settings.classList.add('hide');
    roulette.start();
  });

  const createBtn = $<HTMLButtonElement>('#btnCreateRoom');
  createBtn.addEventListener('click', async () => {
    const names = getNames();
    if (roulette.getCount() < 2) {
      showError('참가자를 2명 이상 입력하세요.');
      return;
    }
    showError(null);
    const config: RoomConfig = {
      names,
      map: roulette.getCurrentMap()?.index ?? 0,
      winner: readWinner(),
      useSkills: options.useSkills,
    };
    createBtn.disabled = true;
    createBtn.textContent = '만드는 중…';
    try {
      const { id, hostKey } = await createRoom(API_BASE, config);
      storageSet(hostKeyName(id), hostKey);
      location.hash = id;
    } catch (e) {
      showError(`방을 만들지 못했습니다: ${e instanceof Error ? e.message : e}`);
      createBtn.disabled = false;
      createBtn.textContent = '공유 링크 만들기';
    }
  });

  getReady();
  renderWinnerInputs();
}

// ---------------------------------------------------------------------------
// 방 모드
// ---------------------------------------------------------------------------
async function enterRoom(roulette: Roulette, id: string): Promise<void> {
  const roombar = $('#roombar');
  const overlay = $('#overlay');
  const eyebrow = $('#overlayEyebrow');
  const big = $('#overlayBig');
  const text = $('#overlayText');
  const countEl = $('#roomCount');
  const netEl = $('#roomNet');
  const btnStart = $<HTMLButtonElement>('#btnHostStart');
  const btnReset = $<HTMLButtonElement>('#btnHostReset');
  const chkRecord = $<HTMLInputElement>('#chkRoomRecord');

  $('#settings').hidden = true;
  roombar.hidden = false;
  overlay.hidden = false;
  $('#roomId').textContent = id;
  eyebrow.textContent = '연결 중';
  big.textContent = id;
  text.textContent = '방 정보를 받고 있습니다.';

  const hostKey = storageGet(hostKeyName(id));
  const isHost = !!hostKey;

  try {
    await fetchRoom(API_BASE, id);
  } catch (e) {
    eyebrow.textContent = '열 수 없음';
    big.textContent = '—';
    text.textContent = e instanceof Error ? e.message : String(e);
    return;
  }

  const client = new RoomClient(API_BASE, id);
  let lastRound = -1;
  let started = false;
  let result: string[] | null = null;

  const shareUrl = `${location.origin}${location.pathname}#${id}`;

  function summary(s: RoomState): string {
    const mapTitle = roulette.getCurrentMap()?.title ?? '';
    return `참가 ${roulette.getCount()}명 · ${winnerLabel(s.winner)} · ${mapTitle}`;
  }

  function slackText(s: RoomState): string {
    return [
      '🎱 구슬 레이스 추첨',
      `• 참가자 ${roulette.getCount()}명: ${s.names.map((n) => n.replace(/[/*].*$/, '').trim()).join(', ')}`,
      `• 당첨: ${winnerLabel(s.winner)}`,
      `• 링크: ${shareUrl}`,
      '링크를 열고 기다려 주세요. 주최자가 시작을 누르면 모두 동시에 출발하고, 누구 화면에서나 같은 결과가 나옵니다.',
    ].join('\n');
  }

  function applyState(s: RoomState) {
    if (s.round !== lastRound) {
      // 새 라운드(처음 또는 다시 추첨): 설정·시드로 구슬을 놓는다
      lastRound = s.round;
      started = false;
      result = null;
      options.useSkills = s.useSkills;
      roulette.setMap(s.map);
      roulette.setMarbles(s.names, s.seed);
      applyWinnerSetting(roulette, s.winner);
      $('#roomSummary').textContent = summary(s);
    }
    if (s.startAt !== null && !started) {
      started = true;
      roulette.startSynced(s.startAt, () => client.serverNow());
    } else if (s.startAt === null && started) {
      started = false;
      roulette.cancelRun();
    }
    renderHostButtons();
  }

  function renderHostButtons() {
    const s = client.state;
    btnStart.hidden = !(isHost && s && s.startAt === null);
    btnReset.hidden = !(isHost && s && s.startAt !== null);
  }

  function renderOverlay() {
    const s = client.state;
    if (!s) {
      overlay.hidden = false;
      eyebrow.textContent = client.online ? '연결 중' : '연결 끊김';
      big.textContent = id;
      text.textContent = client.online ? '방 정보를 받고 있습니다.' : '다시 연결하는 중입니다.';
      return;
    }
    if (s.startAt === null) {
      overlay.hidden = false;
      eyebrow.textContent = '대기 중';
      big.textContent = `${client.count}명`;
      text.textContent = isHost
        ? '모두 들어오면 아래 "시작" 버튼을 누르세요. 모든 화면에서 동시에 출발합니다.'
        : '주최자가 시작하면 모든 화면에서 동시에 출발합니다.';
      return;
    }
    const remain = s.startAt - client.serverNow();
    if (remain > 0) {
      overlay.hidden = false;
      eyebrow.textContent = '출발까지';
      big.textContent = String(Math.ceil(remain / 1000));
      text.textContent = `${winnerLabel(s.winner)}이 당첨됩니다.`;
      return;
    }
    if (roulette.isCatchingUp) {
      overlay.hidden = false;
      eyebrow.textContent = '따라잡는 중';
      big.textContent = '…';
      text.textContent = '이미 진행된 장면을 빠르게 재생하고 있습니다.';
      return;
    }
    overlay.hidden = true;
  }

  client.on('state', applyState);
  client.on('count', (n) => {
    countEl.textContent = `접속 ${n}명`;
  });
  client.on('online', (ok) => {
    netEl.textContent = ok ? '연결됨' : '연결 끊김';
    netEl.classList.toggle('offline', !ok);
  });
  client.on('error', (msg) => toast(msg, 2500));
  client.connect();
  window.setInterval(renderOverlay, 100);

  roulette.addEventListener('goal', (e) => {
    result = (e as CustomEvent<{ winners: string[] }>).detail.winners;
    toast(`당첨: ${result.join(', ')}`, 5000);
  });

  btnStart.addEventListener('click', () => {
    if (!client.send({ t: 'start', key: hostKey })) toast('서버와 연결되지 않았습니다.');
  });
  btnReset.addEventListener('click', () => {
    const ok = result
      ? window.confirm('결과를 버리고 새 시드로 다시 추첨할까요?')
      : window.confirm('진행 중인 레이스를 멈추고 다시 추첨할까요?');
    if (!ok) return;
    if (!client.send({ t: 'reset', key: hostKey })) toast('서버와 연결되지 않았습니다.');
  });
  $('#btnCopyLink').addEventListener('click', async () => {
    toast((await copyText(shareUrl)) ? '링크를 복사했습니다.' : `복사가 막혀 있습니다: ${shareUrl}`, 3000);
  });
  $('#btnCopySlack').addEventListener('click', async () => {
    const s = client.state;
    if (!s) return;
    toast((await copyText(slackText(s))) ? 'Slack 안내 문구를 복사했습니다.' : '복사가 막혀 있습니다.', 3000);
  });
  chkRecord.addEventListener('change', () => roulette.setAutoRecording(chkRecord.checked));
}
