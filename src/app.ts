// 화면 흐름.
// - 주소에 방 번호(#ABC123)가 있으면 방 모드: 모두 같은 설정·시드·시작 시각을 받아 같은 레이스를 본다.
// - 없으면 설정 모드: 참가자와 당첨 방식을 정해 공유 링크를 만들거나(주최자), 방 없이 혼자 돌린다.
import { translate } from './localization';
import { initMapSelector } from './mapSelector';
import options from './options';
import type { Roulette } from './roulette';
import {
  type ConnState,
  createRoom,
  RoomClient,
  type RoomConfig,
  type RoomState,
  type SlackTarget,
  testSlackHook,
  type WinnerSetting,
} from './sync';

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
/** 결과 팝업이 그려진 뒤에 캡처하도록 기다리는 시간(ms) */
const RESULT_CAPTURE_DELAY_MS = 1500;
const SLACK_HOOKS_KEY = 'er_slack_hooks';
const SLACK_LAST_KEY = 'er_slack_last';

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
// 설정 폼: 처음 링크를 만들 때와 방에서 설정을 고칠 때 같이 쓴다
// ---------------------------------------------------------------------------
type EditHandlers = {
  save: (config: RoomConfig, slack: SlackTarget | null) => Promise<void>;
  cancel: () => void;
};

type SettingsForm = {
  getConfig: () => RoomConfig;
  /** 고른 Slack 알림 채널. 알림을 안 보내면 null */
  getSlack: () => SlackTarget | null;
  getNames: () => string[];
  showError: (msg: string | null) => void;
  /** 입력값으로 당첨 범위를 다시 계산해 구슬에 반영한다 */
  applyWinner: () => void;
  /** 방 설정을 폼에 채우고 미리보기 구슬을 놓는다 */
  load: (config: RoomConfig, slackChannel: string | null) => void;
  /** setup: 혼자 돌리기·공유 링크 만들기, edit: 취소·변경 저장 */
  setMode: (mode: 'setup' | 'edit', handlers?: EditHandlers) => void;
};

let settingsForm: SettingsForm | null = null;

/** 폼은 이벤트를 한 번만 걸어야 하므로 처음 필요할 때 한 번 만든다 */
function getSettingsForm(roulette: Roulette): SettingsForm {
  settingsForm ??= initSettingsForm(roulette);
  return settingsForm;
}

function initSettingsForm(roulette: Roulette): SettingsForm {
  const namesInput = $<HTMLTextAreaElement>('#in_names');
  const winCount = $<HTMLInputElement>('#in_winCount');
  const rangeStart = $<HTMLInputElement>('#in_rangeStart');
  const rangeEnd = $<HTMLInputElement>('#in_rangeEnd');
  const chkSkill = $<HTMLInputElement>('#chkSkill');
  const chkRecording = $<HTMLInputElement>('#chkAutoRecording');
  const errorEl = $('#setupError');
  const countEl = $('#marbleCount');
  const slackSelect = $<HTMLSelectElement>('#sltSlack');
  let slackHooks: SlackTarget[] = [];
  try {
    const v = JSON.parse(storageGet(SLACK_HOOKS_KEY) ?? '[]');
    if (Array.isArray(v)) {
      slackHooks = v.filter((h) => h && typeof h.channel === 'string' && typeof h.webhook === 'string');
    }
  } catch {
    slackHooks = [];
  }

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
    const slack = getSlack();
    $('#settingsSummary').textContent =
      `설정 · ${winnerShort(winner)}${mapTitle ? ` · ${mapTitle}` : ''}${slack ? ` · 알림 ${slack.channel}` : ''}`;
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

  // ----- 섞기 (미리보기 배치만 바뀐다) -----
  $('#btnShuffle').addEventListener('click', () => {
    previewSeed = newSeed();
    getReady();
  });

  // ----- Slack 알림 채널: Webhook 주소를 채널 이름과 함께 이 브라우저에 저장해 두고 추첨마다 고른다 -----
  const slackDialog = $<HTMLDialogElement>('#slackDialog');
  const slackName = $<HTMLInputElement>('#slackChannelName');
  const slackUrl = $<HTMLInputElement>('#slackWebhook');
  const slackUrlField = $('#slackWebhookField');
  const slackUrlHelp = $('#slackWebhookHelp');
  const slackStatus = $('#slackStatus');
  const slackTestBtn = $<HTMLButtonElement>('#btnSlackTest');
  const slackRemove = $('#btnSlackRemove');

  function getSlack(): SlackTarget | null {
    const i = Number(slackSelect.value);
    const picked = slackSelect.value !== '' && Number.isInteger(i);
    return picked ? (slackHooks[i] ?? null) : null;
  }

  function syncSlackControls() {
    const chosen = getSlack();
    slackRemove.hidden = !chosen;
    $('#slackSummary').hidden = !chosen;
    storageSet(SLACK_LAST_KEY, chosen?.channel ?? '');
    renderWinnerInputs();
  }

  function renderSlack(selectedChannel: string | null) {
    slackSelect.replaceChildren(
      new Option('보내지 않음', ''),
      ...slackHooks.map((h, i) => new Option(h.channel, String(i)))
    );
    const index = selectedChannel === null ? -1 : slackHooks.findIndex((h) => h.channel === selectedChannel);
    slackSelect.value = index >= 0 ? String(index) : '';
    syncSlackControls();
  }

  /** 입력 중인 Webhook 주소 모양을 칸 아래에 바로 알려 준다. showEmpty 면 빈 칸도 오류로 본다 */
  function checkWebhookInput(showEmpty = false): boolean {
    const value = slackUrl.value.trim();
    // 로컬 개발에서는 가짜 Slack 서버(127.0.0.1)로도 시험할 수 있다
    const looksRight =
      /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_\-/]+$/.test(value) ||
      (IS_LOCAL && /^http:\/\/127\.0\.0\.1:\d+\//.test(value));
    const showError = !looksRight && (value !== '' || showEmpty);
    slackUrlField.classList.toggle('valid', looksRight);
    slackUrlField.classList.toggle('invalid', showError);
    if (looksRight) slackUrlHelp.textContent = '✓ Slack Webhook 주소 형식입니다.';
    else if (showError) slackUrlHelp.textContent = 'https://hooks.slack.com/services/ 로 시작하는 주소여야 합니다.';
    else slackUrlHelp.textContent = 'Slack 에서 복사한 주소를 그대로 붙여 넣으세요.';
    return looksRight;
  }

  function setSlackStatus(kind: 'ok' | 'error' | null, message = '') {
    slackStatus.hidden = kind === null;
    slackStatus.className = `dialog-status ${kind ?? ''}`;
    slackStatus.textContent = message;
  }

  /** 입력값으로 만든 알림 대상. 채널 이름을 비우면 '알림 채널' 로 저장한다 */
  function draftTarget(): SlackTarget {
    return { channel: slackName.value.trim().slice(0, 40) || '알림 채널', webhook: slackUrl.value.trim() };
  }

  $('#btnSlackAdd').addEventListener('click', () => {
    slackName.value = '';
    slackUrl.value = '';
    checkWebhookInput();
    setSlackStatus(null);
    // 처음 추가하는 사람에게는 만드는 법을 펼쳐 둔다
    $<HTMLDetailsElement>('#slackGuide').open = slackHooks.length === 0;
    slackDialog.showModal();
    slackName.focus();
  });
  slackUrl.addEventListener('input', () => {
    checkWebhookInput();
    setSlackStatus(null);
  });
  $('#btnSlackClose').addEventListener('click', () => slackDialog.close());
  $('#btnSlackCancel').addEventListener('click', () => slackDialog.close());
  slackTestBtn.addEventListener('click', async () => {
    if (!checkWebhookInput(true)) {
      slackUrl.focus();
      return;
    }
    const target = draftTarget();
    slackTestBtn.disabled = true;
    slackTestBtn.textContent = '보내는 중…';
    try {
      await testSlackHook(API_BASE, target);
      setSlackStatus('ok', `✓ ${target.channel}에 확인 메시지를 보냈습니다. Slack 에서 받았는지 확인해 보세요.`);
    } catch (e) {
      setSlackStatus('error', `보내지 못했습니다. ${friendlyError(e)}`);
    } finally {
      slackTestBtn.disabled = false;
      slackTestBtn.textContent = '테스트 보내기';
    }
  });
  $('#slackForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!checkWebhookInput(true)) {
      slackUrl.focus();
      return;
    }
    const target = draftTarget();
    // 같은 이름으로 다시 넣으면 주소를 바꾼다
    slackHooks = [...slackHooks.filter((h) => h.channel !== target.channel), target];
    storageSet(SLACK_HOOKS_KEY, JSON.stringify(slackHooks));
    slackDialog.close();
    renderSlack(target.channel);
    toast(`${target.channel} 채널을 저장했습니다. 이 추첨의 알림 채널로 골라 두었습니다.`, 3000);
  });
  slackSelect.addEventListener('change', syncSlackControls);
  slackRemove.addEventListener('click', () => {
    const chosen = getSlack();
    if (!chosen || !window.confirm(`${chosen.channel} 채널을 목록에서 지울까요?`)) return;
    slackHooks = slackHooks.filter((h) => h.channel !== chosen.channel);
    storageSet(SLACK_HOOKS_KEY, JSON.stringify(slackHooks));
    renderSlack(null);
  });
  renderSlack(storageGet(SLACK_LAST_KEY) || null);

  // ----- 방에서 설정 수정 -----
  let editHandlers: EditHandlers | null = null;
  const editSave = $<HTMLButtonElement>('#btnEditSave');
  $('#btnEditCancel').addEventListener('click', () => editHandlers?.cancel());
  editSave.addEventListener('click', async () => {
    if (!editHandlers) return;
    if (roulette.getCount() < 2) {
      showError('참가자를 2명 이상 입력하세요.');
      return;
    }
    showError(null);
    editSave.disabled = true;
    editSave.textContent = '저장 중…';
    try {
      await editHandlers.save(getConfig(), getSlack());
    } catch (e) {
      showError(`저장하지 못했습니다. ${friendlyError(e)}`);
    } finally {
      editSave.disabled = false;
      editSave.textContent = '변경 저장';
    }
  });

  function getConfig(): RoomConfig {
    return {
      names: getNames(),
      map: roulette.getCurrentMap()?.index ?? 0,
      winner: readWinner(),
      useSkills: options.useSkills,
    };
  }

  function load(config: RoomConfig, slackChannel: string | null) {
    namesInput.value = config.names.join('\n');
    namesInput.scrollTop = 0;
    $<HTMLSelectElement>('#sltMap').value = String(config.map);
    roulette.setMap(config.map);
    options.useSkills = config.useSkills;
    chkSkill.checked = config.useSkills;
    winner = normalizeWinner(config.winner);
    renderSlack(slackChannel);
    getReady();
    showError(null);
  }

  function setMode(mode: 'setup' | 'edit', handlers?: EditHandlers) {
    const editing = mode === 'edit';
    editHandlers = editing ? (handlers ?? null) : null;
    $('#btnLocal').hidden = editing;
    $('#btnCreateRoom').hidden = editing;
    $('#btnEditCancel').hidden = !editing;
    editSave.hidden = !editing;
    $('#editNote').hidden = !editing;
    // 방에서는 녹화를 방 카드의 "내 화면 녹화"로 켠다
    $('#setupRecordWrap').hidden = editing;
  }

  getReady();
  return { getConfig, getSlack, getNames, showError, applyWinner: () => applyWinner(), load, setMode };
}

// ---------------------------------------------------------------------------
// 설정 모드
// ---------------------------------------------------------------------------
function setupMode(roulette: Roulette): void {
  const settings = $('#settings');
  const form = getSettingsForm(roulette);
  form.setMode('setup');
  roulette.setAutoRecording(false);
  settings.hidden = false;

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
      form.showError('참가자를 2명 이상 입력하세요.');
      return;
    }
    form.showError(null);
    roulette.setMarbles(form.getNames(), newSeed());
    form.applyWinner();
    settings.classList.add('hide');
    roulette.start();
  });

  const createBtn = $<HTMLButtonElement>('#btnCreateRoom');
  createBtn.addEventListener('click', async () => {
    if (roulette.getCount() < 2) {
      form.showError('참가자를 2명 이상 입력하세요.');
      return;
    }
    form.showError(null);
    const config = form.getConfig();
    createBtn.disabled = true;
    createBtn.textContent = '링크 만드는 중…';
    try {
      const { id, hostKey } = await createRoom(API_BASE, config, form.getSlack());
      storageSet(hostKeyName(id), hostKey);
      // 새로고침 없이 방 화면으로 넘어간다. 주소창에는 공유할 링크가 남는다
      roulette.removeEventListener('goal', onGoal);
      history.pushState(null, '', `#${id}`);
      void enterRoom(roulette, id, hostKey);
    } catch (e) {
      form.showError(`링크를 만들지 못했습니다. ${friendlyError(e)}`);
      createBtn.disabled = false;
      createBtn.textContent = '공유 링크 만들기';
    }
  });
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
  // 방에서는 모두 같은 시계를 따르므로 캔버스를 눌러도 빨리 감기 아이콘이 뜨지 않게 한다
  roulette.setFastForwardAllowed(false);
  // 보는 사람 화면은 보기만: 새 추첨·테마 같은 버튼을 두지 않는다
  $('#lnkNewRoom').hidden = !isHost;
  $<HTMLElement>('#roomPanel .btn-theme').hidden = !isHost;

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

  /** 지금 맵의 한국어 이름. 방 요약과 Slack 알림에 쓴다 */
  function currentMapTitle(): string {
    return translate(roulette.getCurrentMap()?.title ?? '');
  }

  /** 방 화면의 한 줄 요약 */
  function summaryText(s: RoomState): string {
    return `${roulette.getCount()}명 중 ${winnerShort(s.winner)} 당첨 · ${currentMapTitle()}`;
  }

  /** 새 라운드(처음, 다시 추첨, 설정 수정): 설정·시드로 구슬을 놓는다 */
  function setupRound(s: RoomState) {
    lastRound = s.round;
    started = false;
    resultShown = false;
    window.clearTimeout(resultTimer);
    options.useSkills = s.useSkills;
    roulette.setMap(s.map);
    roulette.setMarbles(s.names, s.seed);
    applyWinnerSetting(roulette, s.winner);
    const summaryEl = $('#roomSummary');
    summaryEl.textContent = summaryText(s);
    // 알림 채널은 주최자에게만 보인다. "#채널" 이 중간에서 줄바꿈되지 않게 묶는다
    if (isHost && s.slackChannel) {
      const tag = document.createElement('span');
      tag.className = 'nowrap';
      tag.textContent = `알림 ${s.slackChannel}`;
      summaryEl.append(' · ', tag);
    }
    const notifyBtn = $('#btnSlackNotify');
    notifyBtn.textContent = s.slackChannel ? `${s.slackChannel}에 보내기` : 'Slack에 보내기';
  }

  function applyState(s: RoomState) {
    if (s.round !== lastRound) setupRound(s);
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
  const btnEdit = $<HTMLButtonElement>('#btnHostEdit');
  const btnSlackNotify = $<HTMLButtonElement>('#btnSlackNotify');
  const settingsEl = $('#settings');

  // ----- 설정 수정: 같은 폼을 방 설정으로 채워 연다. 저장하면 서버가 새 라운드를 모두에게 보낸다 -----
  function closeEditor() {
    settingsEl.hidden = true;
    panel.hidden = false;
    render();
  }
  btnEdit.addEventListener('click', () => {
    const s = client.state;
    if (!s || !hostKey) return;
    const form = getSettingsForm(roulette);
    form.setMode('edit', {
      save: async (config, slack) => {
        await client.updateConfig(hostKey, config, slack);
        closeEditor();
        toast('설정을 바꿨습니다. 보는 사람 화면에도 바로 적용됩니다.', 3000);
      },
      cancel: () => {
        closeEditor();
        // 미리보기로 바뀐 구슬을 방 상태로 되돌린다. 결과가 나온 방이면 끝 장면까지 다시 따라잡는다
        lastRound = -1;
        if (client.state) applyState(client.state);
      },
    });
    form.load(s, s.slackChannel);
    panel.hidden = true;
    overlay.hidden = true;
    settingsEl.classList.remove('hide');
    settingsEl.hidden = false;
  });

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

    // 원작 설정창처럼 레이스 중에는 숨긴다. 카운트다운 중에는 주최자가 잘못 누른 시작을 멈출 수 있게 둔다
    panel.classList.toggle('hide', !(waiting || countdown || resultShown));
    hostShare.hidden = !(isHost && waiting);
    btnSlackNotify.hidden = !s.slackChannel;
    // 링크 복사·녹화는 주최자만. 링크 복사는 큰 공유 칸이 사라진 뒤(출발 후)에만 작게 둔다
    btnCopyLinkSmall.hidden = !isHost || waiting;
    recordWrap.hidden = !(isHost && waiting);
    btnStart.hidden = !(isHost && waiting);
    btnReset.hidden = !(isHost && !waiting);
    // 레이스 중에는 고치지 않는다. 기다릴 때와 결과가 나온 뒤에만 연다
    btnEdit.hidden = !(isHost && (waiting || resultShown));

    let note = '';
    if (waiting) {
      note = isHost
        ? '보는 사람이 다 들어오지 않아도 시작할 수 있습니다. 늦게 들어온 사람도 같은 장면을 따라잡습니다.'
        : '주최자가 시작하면 자동으로 출발합니다.';
    } else if (countdown) {
      note = isHost ? '곧 출발합니다. 잘못 눌렀다면 "다시 추첨"으로 멈출 수 있습니다.' : '곧 출발합니다.';
    } else if (resultShown) {
      note = isHost
        ? '추첨이 끝났습니다. "다시 추첨"은 같은 설정으로, "설정 수정"은 바꾼 설정으로 같은 링크에서 다시 돌립니다.'
        : '추첨이 끝났습니다.';
    }
    noteEl.textContent = note;
  }

  const renderCount = (n: number) => {
    countEl.textContent = n > 0 ? `${n}명 보는 중` : '';
  };
  client.on('state', applyState);
  client.on('count', renderCount);
  renderCount(client.count);
  const roomHead = $('#roomHead');
  const renderConn = (c: ConnState) => {
    netEl.dataset.state = c;
    netEl.textContent = NET_TEXT[c];
    netEl.title = c === 'polling' ? '실시간 연결이 막혀 있어 1.5초마다 상태를 받고 있습니다.' : '';
    // 보는 사람에게는 방 번호·인원 줄을 숨기고, 연결이 불안할 때만 보여 준다
    roomHead.hidden = !isHost && (c === 'online' || c === 'polling');
  };
  client.on('conn', renderConn);
  renderConn(client.conn);
  client.on('error', (msg) => toast(msg, 3000));
  if (client.state) applyState(client.state);
  client.connect();
  window.setInterval(render, 100);

  /** Slack 에 결과를 보낸 라운드. 수정 취소로 같은 라운드를 다시 따라잡아도 두 번 보내지 않는다 */
  const reportedRounds = new Set<number>();

  /** 결과 팝업이 그려진 뒤 화면을 찍어 당첨자와 함께 올린다. 서버가 Slack 에 알린다 */
  async function reportResult(round: number, winners: string[]) {
    const s = client.state;
    if (!hostKey || !s?.slackChannel || reportedRounds.has(round)) return;
    reportedRounds.add(round);
    await new Promise((resolve) => window.setTimeout(resolve, RESULT_CAPTURE_DELAY_MS));
    try {
      const image = await roulette.captureFrame();
      await client.reportResult(hostKey, { round, winners, mapTitle: currentMapTitle(), image });
      toast(`${s.slackChannel}에 결과를 보냈습니다.`, 3000);
    } catch (e) {
      reportedRounds.delete(round);
      toast(`Slack 에 결과를 보내지 못했습니다. ${friendlyError(e)}`, 4500);
    }
  }

  roulette.addEventListener('goal', (e) => {
    const winners = (e as CustomEvent<{ winners: string[] }>).detail.winners;
    toast(`당첨: ${winners.join(', ')}`, 5000);
    void reportResult(lastRound, winners);
    window.clearTimeout(resultTimer);
    resultTimer = window.setTimeout(() => {
      resultShown = true;
      render();
    }, RESULT_PANEL_DELAY_MS);
  });

  btnSlackNotify.addEventListener('click', async () => {
    const s = client.state;
    if (!hostKey || !s?.slackChannel) return;
    btnSlackNotify.disabled = true;
    try {
      await client.notifySlack(hostKey, currentMapTitle());
      toast(`${s.slackChannel}에 추첨 링크를 보냈습니다.`, 3000);
    } catch (e) {
      toast(`Slack 에 보내지 못했습니다. ${friendlyError(e)}`, 4500);
    } finally {
      btnSlackNotify.disabled = false;
    }
  });

  btnStart.addEventListener('click', async () => {
    const s = client.state;
    if (!hostKey || !s) return;
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
