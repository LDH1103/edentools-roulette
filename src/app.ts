// 화면 흐름.
// - 주소에 방 번호(#ABC123)가 있으면 방 모드: 모두 같은 설정·시드·시작 시각을 받아 같은 레이스를 본다.
// - 없으면 설정 모드: 참가자와 당첨 방식을 정해 공유 링크를 만들거나(주최자), 방 없이 혼자 돌린다.
import { translate } from './localization';
import { initMapSelector } from './mapSelector';
import options from './options';
import { flushPrefs, initPrefs, prefGet, prefSet, sharedChannels, storageGet, storageSet } from './prefs';
import type { Roulette } from './roulette';
import {
  addSharedChannel,
  type ConnState,
  createRoom,
  RoomClient,
  type RoomConfig,
  type RoomState,
  removeSharedChannel,
  type SharedChannel,
  type SlackChoice,
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
const WINNER_KEY = 'er_winner';
const hostKeyName = (id: string) => `er_host_${id}`;
const EXAMPLE_NAMES = '수박*2\n키위*2\n귤*2';
const ROOM_ID = /^[A-Z2-9]{6}$/;
/** 서버 validateConfig 의 구슬 수 한도와 같다 */
const MAX_MARBLES = 1000;
/** 결과가 나온 뒤 방 패널을 다시 띄우기까지(ms). 원작처럼 당첨 연출을 먼저 보여 준다 */
const RESULT_PANEL_DELAY_MS = 2500;
/** 결과 팝업이 그려진 뒤에 캡처하도록 기다리는 시간(ms) */
const RESULT_CAPTURE_DELAY_MS = 1500;
const SLACK_LAST_KEY = 'er_slack_last';

function $<T extends HTMLElement = HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing element ${selector}`);
  return el;
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

/** 이름 한 줄을 "이름(/가중치)" 키와 구슬 수로 나눈다. 문법에 안 맞으면 null */
function parseNameLine(raw: string): { key: string; count: number } | null {
  const m = /^\s*([^/*]+?)\s*(?:\/(\d+))?\s*(?:\*(\d+))?\s*$/.exec(raw);
  if (!m) return null;
  return { key: m[2] ? `${m[1]}/${m[2]}` : m[1], count: m[3] ? parseInt(m[3], 10) : 1 };
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

export function initApp(roulette: Roulette): void {
  const boot = () => {
    if (!roulette.isReady) {
      window.setTimeout(boot, 100);
      return;
    }
    // 주소의 방 번호를 손으로 바꾸거나 뒤로 가기를 누르면 처음부터 다시 그린다
    window.addEventListener('hashchange', () => location.reload());
    window.addEventListener('popstate', () => location.reload());

    const roomId = location.hash.replace(/^#/, '').toUpperCase();
    const isRoom = ROOM_ID.test(roomId);
    const hostKey = isRoom ? storageGet(hostKeyName(roomId)) : null;
    // 설정 폼을 쓰는 화면(처음 설정, 주최자의 설정 수정)만 공용 저장값을 먼저 받아 둔다
    const needsPrefs = !isRoom || hostKey !== null;
    void (needsPrefs ? loadPrefs() : Promise.resolve()).then(() => {
      if (isRoom) void enterRoom(roulette, roomId, hostKey);
      else setupMode(roulette);
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}

/** 공용 저장값을 받아 둔다. 못 받으면 이번 화면에서는 바꿔도 저장하지 않는다 */
async function loadPrefs(): Promise<void> {
  try {
    await initPrefs(API_BASE, (e) => toast(`저장하지 못했습니다. ${friendlyError(e)}`, 4000));
  } catch (e) {
    toast(`이름 보관함과 채널을 불러오지 못했습니다. 이번에는 바꿔도 저장되지 않습니다. ${friendlyError(e)}`, 6000);
  }
}

// ---------------------------------------------------------------------------
// 설정 폼: 처음 링크를 만들 때와 방에서 설정을 고칠 때 같이 쓴다
// ---------------------------------------------------------------------------
type EditHandlers = {
  save: (config: RoomConfig, slack: SlackChoice | null) => Promise<void>;
  cancel: () => void;
};

type SettingsForm = {
  getConfig: () => RoomConfig;
  /** 고른 Slack 알림 채널. 알림을 안 보내면 null */
  getSlack: () => SlackChoice | null;
  getNames: () => string[];
  /** 안내를 띄운다. names 는 참가자 칸 아래, 기본은 만들기 버튼 위 */
  showError: (msg: string | null, where?: 'names' | 'actions') => void;
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
  const namesErrorEl = $('#namesError');
  const countEl = $('#marbleCount');
  /** 방에서 설정을 고치는 중인지. 확인 줄 문구가 달라진다 */
  let editing = false;
  const slackSelect = $<HTMLSelectElement>('#sltSlack');
  // Slack 채널: 공용 저장소의 채널(주소 없이 id·이름)
  let slackChannels: SharedChannel[] = sharedChannels();

  let winner: WinnerSetting = { type: 'first', start: 1, end: 1 };
  try {
    const saved = JSON.parse(prefGet(WINNER_KEY) ?? 'null');
    if (saved && ['first', 'last', 'custom', 'multi'].includes(saved.type)) winner = normalizeWinner(saved);
  } catch {
    // 저장값이 깨졌으면 기본값
  }
  /** 미리보기용 시드. 섞기를 누르면 바뀐다. 실제 추첨 시드는 방을 만들 때 서버가 새로 정한다 */
  let previewSeed = newSeed();

  const getNames = () => splitNames(namesInput.value);

  /** 안내를 문제가 난 자리에 띄운다: names 는 참가자 칸 아래, actions 는 만들기 버튼 위 */
  function showError(msg: string | null, where: 'names' | 'actions' = 'actions') {
    const el = where === 'names' ? namesErrorEl : errorEl;
    el.textContent = msg ?? '';
    el.hidden = !msg;
    // 참가자 안내 표시 여부: 폰에서는 참가자 칸이 화면 밖일 수 있어 보이게 끌어온다
    const showsNames = !!msg && where === 'names';
    if (showsNames) el.scrollIntoView({ block: 'nearest' });
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
    // 폰에서 접힌 설정 줄. 채널 이름은 중간에서 줄이 바뀌지 않게 묶는다
    const summary = $('#settingsSummary');
    summary.replaceChildren(`맵·당첨·알림 · ${winnerShort(winner)}${mapTitle ? ` · ${mapTitle}` : ''}`);
    if (slack) {
      const tag = document.createElement('span');
      tag.className = 'nowrap';
      tag.textContent = `알림 ${slack.channel}`;
      summary.append(' · ', tag);
    }
    renderConfirm();
  }

  /** 만들기 버튼 위 확인 줄: 몇 명, 구슬 몇 개 중 몇 명 당첨, 어느 채널에 알리는지 */
  function renderConfirm() {
    const slack = getSlack();
    let notice = '알림 없음';
    if (slack) notice = editing ? `알림 ${slack.channel}` : `${slack.channel}에 바로 알림`;
    const people = readEntries().size;
    $('#confirmLine').textContent =
      `${people}명 · 구슬 ${roulette.getCount()}개 중 ${winnerShort(winner)} 당첨 · ${notice}`;
  }

  function applyWinner(edited?: 'start' | 'end') {
    winner = readWinner(edited);
    applyWinnerSetting(roulette, winner);
    prefSet(WINNER_KEY, JSON.stringify(winner));
    renderWinnerInputs();
  }

  /** 이름 칸의 참가자로 구슬을 다시 놓는다. 참가자가 바뀌면 참가자 칸의 안내는 지운다 */
  function getReady() {
    const names = getNames();
    roulette.setMarbles(names, previewSeed);
    prefSet(NAMES_KEY, names.join('\n'));
    countEl.textContent = `${readEntries().size}명 · 구슬 ${roulette.getCount()}개`;
    showError(null, 'names');
    renderRoster();
    applyWinner();
  }

  // ----- 참가자: 이름 칸(직접 입력)이 원본이다. 칩·이름 추가·구슬 수 조절은 이름 칸을 고쳐 쓴다 -----
  const urlNames = new URLSearchParams(location.search).get('names');
  const savedNames = prefGet(NAMES_KEY);
  namesInput.value = urlNames ? urlNames.replace(/,/g, '\n') : (savedNames ?? EXAMPLE_NAMES).replace(/,/g, '\n');
  namesInput.addEventListener('input', getReady);
  namesInput.addEventListener('blur', () => {
    // 같은 이름은 개수로 합친다: 홍길동,홍길동 → 홍길동*2
    const merged = entriesText(readEntries());
    if (merged !== namesInput.value) {
      namesInput.value = merged;
      getReady();
    }
  });

  /** 지금 참가자. 키는 "이름" 또는 "이름/가중치", 값은 구슬 수. 같은 이름 줄은 합친다 */
  function readEntries(): Map<string, number> {
    const entries = new Map<string, number>();
    for (const raw of getNames()) {
      const parsed = parseNameLine(raw);
      if (!parsed) continue;
      entries.set(parsed.key, (entries.get(parsed.key) ?? 0) + parsed.count);
    }
    return entries;
  }

  /** 참가자를 이름 칸 문법으로: 구슬이 2개 이상이면 이름*n */
  function entriesText(entries: Map<string, number>): string {
    return [...entries].map(([key, n]) => (n > 1 ? `${key}*${n}` : key)).join('\n');
  }

  /** 참가자를 이름 칸에 쓰고 구슬을 다시 놓는다. 구슬이 서버 한도를 넘으면 바꾸지 않고 안내한다 */
  function commit(entries: Map<string, number>): boolean {
    const total = [...entries.values()].reduce((sum, n) => sum + n, 0);
    // 구슬 수 한도 초과 여부
    const tooMany = total > MAX_MARBLES;
    if (tooMany) {
      showError(`구슬은 ${MAX_MARBLES}개까지입니다. 이대로면 ${total}개가 됩니다.`, 'names');
      return false;
    }
    namesInput.value = entriesText(entries);
    getReady();
    return true;
  }

  /** 이름(이름 문법을 뗀 것)에 해당하는 참가자 키 */
  const keyOf = (entries: Map<string, number>, name: string) => [...entries.keys()].find((k) => bareName(k) === name);

  // ----- 한 사람당 구슬: 새로 넣는 사람의 구슬 수이고, 바꾸면 지금 참가자 모두에게 적용한다 -----
  const perPersonEl = $('#perPerson');
  let perPerson = 1;
  /** 참가자 모두의 구슬 수가 같으면 그 값을 보여 준다. 섞여 있으면 마지막 값을 둔다 */
  function syncPerPerson(entries: Map<string, number>) {
    const counts = new Set(entries.values());
    // 모두 같은 구슬 수 여부
    const allSame = counts.size === 1;
    if (allSame) perPerson = [...counts][0];
    perPersonEl.textContent = String(perPerson);
  }
  function changePerPerson(delta: number) {
    const next = Math.max(1, perPerson + delta);
    const entries = readEntries();
    for (const key of entries.keys()) entries.set(key, next);
    if (!commit(entries)) return;
    perPerson = next;
    perPersonEl.textContent = String(perPerson);
  }
  $('#btnPerMinus').addEventListener('click', () => changePerPerson(-1));
  $('#btnPerPlus').addEventListener('click', () => changePerPerson(1));

  // ----- 이번 추첨 칩과 이름 보관함 -----
  // 위: 이번 추첨 참가자. 이름을 누르면 빼고, −/+ 로 구슬 수를 바꾼다. 보관함에 없는 이름은 점선에 "보관"(그룹 고르기)
  // 아래: 이름 보관함(서버 공용). 평소에는 아직 안 넣은 이름만 그룹별로 보여 주고, 누르면 위로 들어간다.
  //       "보관함 편집"을 누르면 그 자리에서 그룹 이름·이름을 고치고 옮긴다. 글로 한꺼번에 고칠 수도 있다
  const pickedChips = $('#pickedChips');
  const vaultGroups = $('#rosterChips');
  const rosterEdit = $<HTMLTextAreaElement>('#rosterEdit');
  const rosterEditor = $('#rosterEditor');
  const rosterToggle = $('#rosterToggleEdit');
  const rosterTextBtn = $('#btnRosterText');
  /** 보관함은 줄 목록으로 저장한다. "[그룹 이름]" 줄 아래 이름이 그 그룹이고, 그 앞의 이름은 그룹 없음 */
  const GROUP_LINE = /^\[(.+)\]$/;
  let roster: string[] = [];
  try {
    const v = JSON.parse(prefGet(ROSTER_KEY) ?? '[]');
    if (Array.isArray(v)) roster = v.map(String);
  } catch {
    roster = [];
  }
  /** 보관함 편집 모드인지 */
  let vaultEditing = false;
  /** 다시 그린 뒤 초점을 둘 칸: 그룹 번호와 칸 종류 */
  let focusAfterRender: { group: number; field: 'title' | 'add' } | null = null;

  type RosterGroup = { title: string | null; names: string[] };

  /** 보관함을 그룹 목록으로. 0번은 그룹 없음(title null)이고 비어 있을 수 있다 */
  function rosterModel(): RosterGroup[] {
    const groups: RosterGroup[] = [{ title: null, names: [] }];
    for (const line of roster) {
      const header = GROUP_LINE.exec(line);
      if (header) groups.push({ title: header[1].trim(), names: [] });
      else groups[groups.length - 1].names.push(line);
    }
    return groups;
  }

  /** 그룹 목록을 줄 목록으로 바꿔 저장한다. 그룹 없음 이름이 맨 앞에 온다 */
  function saveModel(groups: RosterGroup[]) {
    const lines: string[] = [];
    for (const group of groups) {
      if (group.title !== null) lines.push(`[${group.title}]`);
      lines.push(...group.names);
    }
    saveRoster(lines);
  }

  /** 그룹 이름 정리: 대괄호는 그룹 줄 표시와 겹치므로 뺀다 */
  const cleanTitle = (raw: string) => raw.replace(/[[\]]/g, '').trim().slice(0, 38);

  /** 보관함의 모든 이름. 여러 그룹에 있는 사람은 한 번만 */
  const rosterNames = () => [...new Set(roster.filter((line) => !GROUP_LINE.test(line)))];

  /**
   * 편집 칸 글을 저장할 줄 목록으로 바꾼다. "[그룹 이름]" 줄 다음에 이름을 쉼표나 줄바꿈으로 적는다.
   * "[개발팀] A, B" 처럼 그룹 줄 뒤에 이어 적어도 된다
   */
  function parseRosterText(text: string): string[] {
    const lines: string[] = [];
    for (const raw of text.split('\n')) {
      const header = /^\s*\[([^\]]+)\]\s*(.*)$/.exec(raw);
      if (header) lines.push(`[${header[1].trim()}]`);
      const rest = header ? header[2] : raw;
      lines.push(...rest.split(/[,，]/));
    }
    return lines;
  }

  /** 편집 칸에 보일 글: 그룹 줄 다음 줄에 그 그룹 이름들을 쉼표로 잇는다 */
  function rosterEditorText(): string {
    const out: string[] = [];
    let names: string[] = [];
    const flushNames = () => {
      if (names.length > 0) out.push(names.join(', '));
      names = [];
    };
    for (const line of roster) {
      if (GROUP_LINE.test(line)) {
        flushNames();
        out.push(line);
      } else {
        names.push(line);
      }
    }
    flushNames();
    return out.join('\n');
  }

  /** 저장할 줄 정리: 빈 줄을 빼고, 같은 그룹 안에서 겹치는 이름만 합친다 */
  function normalizeRoster(lines: string[]): string[] {
    const out: string[] = [];
    let seen = new Set<string>();
    for (const raw of lines) {
      const line = raw.trim().slice(0, 40);
      if (!line) continue;
      if (GROUP_LINE.test(line)) {
        seen = new Set();
        out.push(line);
        continue;
      }
      if (seen.has(line)) continue;
      seen.add(line);
      out.push(line);
    }
    return out;
  }

  function chipButton(text: string, className: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  /** 한 번 더 눌러야 실행되는 버튼. 첫 누름은 확인 상태로 바꾸고, 4초 안에 다시 누르면 실행한다 */
  function confirmButton(label: string, confirmLabel: string, onConfirm: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'small';
    b.textContent = label;
    let disarmTimer = 0;
    b.addEventListener('click', () => {
      // 확인 상태 여부
      const armed = b.classList.contains('confirming');
      if (!armed) {
        b.classList.add('confirming');
        b.textContent = confirmLabel;
        disarmTimer = window.setTimeout(() => {
          b.classList.remove('confirming');
          b.textContent = label;
        }, 4000);
        return;
      }
      window.clearTimeout(disarmTimer);
      onConfirm();
    });
    return b;
  }

  /** 고르는 목록. 첫 줄은 안내 문구라 고를 수 없다 */
  function pickList(
    className: string,
    placeholder: string,
    choices: { label: string; value: number }[]
  ): HTMLSelectElement {
    const select = document.createElement('select');
    select.className = className;
    const first = new Option(placeholder, '', true, true);
    first.disabled = true;
    select.append(first, ...choices.map((c) => new Option(c.label, String(c.value))));
    return select;
  }

  /** "보관": 그룹을 만들었으면 넣을 그룹을 고르는 목록, 아니면 버튼 */
  function keepControl(name: string): HTMLElement {
    const groups = rosterModel();
    const hasGroups = groups.some((g) => g.title !== null);
    if (!hasGroups) {
      const keep = chipButton('보관', 'chip-keep', () => {
        keepInRoster([name]);
        toast(`${name} 이름을 보관함에 넣었습니다.`);
      });
      keep.setAttribute('aria-label', `${name} 이름 보관함에 저장`);
      return keep;
    }
    const select = pickList(
      'chip-keep',
      '보관',
      groups.map((g, i) => ({ label: g.title ?? '그룹 없음', value: i }))
    );
    select.setAttribute('aria-label', `${name} 이름을 보관할 그룹`);
    select.addEventListener('change', () => {
      const index = Number(select.value);
      keepInRoster([name], index);
      toast(`${name} 이름을 ${groups[index]?.title ?? '그룹 없음'}에 보관했습니다.`);
    });
    return select;
  }

  /** 이번 추첨 칩: 이름(누르면 빼기), −, 구슬 수, +. 보관함에 없는 이름이면 "보관" */
  function pickedChip(name: string, key: string, count: number, inRoster: boolean): HTMLElement {
    const chip = document.createElement('span');
    chip.className = inRoster ? 'chip on' : 'chip on extra';
    chip.dataset.name = name;
    chip.setAttribute('role', 'group');
    chip.setAttribute('aria-label', `${name} 구슬 ${count}개`);
    if (!inRoster) chip.title = '이름 보관함에 없는 이름';
    const nameBtn = chipButton(key, 'chip-name', () => changeCount(key, -count));
    nameBtn.setAttribute('aria-pressed', 'true');
    nameBtn.title = `${name} 빼기`;
    const minus = chipButton('−', 'chip-step', () => changeCount(key, -1));
    minus.setAttribute('aria-label', `${name} 구슬 하나 빼기`);
    const countText = document.createElement('span');
    countText.className = 'chip-count';
    countText.textContent = String(count);
    const plus = chipButton('+', 'chip-step', () => changeCount(key, 1));
    plus.setAttribute('aria-label', `${name} 구슬 하나 더`);
    chip.append(nameBtn, minus, countText, plus);
    if (!inRoster) chip.append(keepControl(name));
    return chip;
  }

  /** 보관함 칩: 누르면 이번 추첨에 한 사람당 구슬 수로 넣는다 */
  function vaultChip(name: string): HTMLButtonElement {
    const b = chipButton(name, 'chip', () => addNames([name]));
    b.dataset.name = name;
    b.setAttribute('aria-label', `${name} 넣기`);
    return b;
  }

  /** 그룹 하나: 그룹 이름·인원과 "모두 넣기", 아직 안 넣은 이름 칩 */
  function groupBlock(group: RosterGroup, picked: Set<string>, withTitle: boolean): HTMLElement {
    const block = document.createElement('div');
    block.className = 'vault-group';
    const waiting = group.names.filter((name) => !picked.has(name));
    if (withTitle) {
      const head = document.createElement('div');
      head.className = 'vault-group-head';
      const title = document.createElement('span');
      title.className = 'vault-group-title';
      title.textContent = group.title ?? '그룹 없음';
      const inCount = group.names.length - waiting.length;
      const count = document.createElement('span');
      count.className = 'vault-group-count';
      count.textContent = inCount > 0 ? `${group.names.length}명 · ${inCount}명 넣음` : `${group.names.length}명`;
      head.append(title, count);
      if (waiting.length > 0) head.append(chipButton('모두 넣기', 'small', () => addNames(waiting)));
      block.append(head);
    }
    const chips = document.createElement('div');
    chips.className = 'chips';
    chips.append(...waiting.map(vaultChip));
    block.append(chips);
    return block;
  }

  /** 편집 모드의 칩: 이름, 다른 그룹으로 옮기기, ×. 컴퓨터에서는 끌어다 다른 그룹에 놓을 수 있다 */
  function editChip(groups: RosterGroup[], index: number, name: string): HTMLElement {
    const chip = document.createElement('span');
    chip.className = 'chip edit-chip';
    chip.dataset.name = name;
    chip.draggable = true;
    chip.addEventListener('dragstart', (e) =>
      e.dataTransfer?.setData('text/plain', JSON.stringify({ name, from: index }))
    );
    const label = document.createElement('span');
    label.textContent = name;
    chip.append(label);
    const others = groups
      .map((g, i) => ({ label: g.title ?? '그룹 없음', value: i }))
      .filter((choice) => choice.value !== index);
    if (others.length > 0) {
      const move = pickList('chip-move', '옮기기', others);
      move.setAttribute('aria-label', `${name} 다른 그룹으로 옮기기`);
      move.addEventListener('change', () => moveName(index, name, Number(move.value)));
      chip.append(move);
    }
    const del = chipButton('×', 'chip-del', () => removeName(index, name));
    del.setAttribute('aria-label', `${name} 보관함에서 빼기`);
    chip.append(del);
    return chip;
  }

  /** 편집 모드의 그룹: 이름 칸(그룹 없음은 글자), 삭제, 칩, 이름 추가 칸. 끌어다 놓은 칩을 받는다 */
  function editGroupBlock(groups: RosterGroup[], index: number): HTMLElement {
    const group = groups[index];
    const block = document.createElement('div');
    block.className = 'vault-group editing';
    block.dataset.groupIndex = String(index);
    const head = document.createElement('div');
    head.className = 'vault-group-head';
    if (group.title === null) {
      const title = document.createElement('span');
      title.className = 'vault-group-title';
      title.textContent = '그룹 없음';
      head.append(title);
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'vault-group-name';
      input.value = group.title;
      input.maxLength = 38;
      input.setAttribute('aria-label', '그룹 이름');
      input.addEventListener('change', () => renameGroup(index, input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
      });
      head.append(input);
    }
    const count = document.createElement('span');
    count.className = 'vault-group-count';
    count.textContent = `${group.names.length}명`;
    head.append(count);
    if (group.title !== null) {
      head.append(confirmButton('그룹 삭제', `정말 삭제 (${group.names.length}명 포함)`, () => removeGroup(index)));
    }
    const chips = document.createElement('div');
    chips.className = 'chips';
    chips.append(...group.names.map((name) => editChip(groups, index, name)));
    const add = document.createElement('form');
    add.className = 'group-add';
    add.noValidate = true;
    const addInput = document.createElement('input');
    addInput.type = 'text';
    addInput.placeholder = '이름 추가, 쉼표로 여러 명';
    addInput.setAttribute('aria-label', `${group.title ?? '그룹 없음'}에 이름 추가`);
    const addBtn = document.createElement('button');
    addBtn.type = 'submit';
    addBtn.className = 'small';
    addBtn.textContent = '추가';
    add.append(addInput, addBtn);
    add.addEventListener('submit', (e) => {
      e.preventDefault();
      addToGroup(index, addInput.value);
    });
    block.addEventListener('dragover', (e) => {
      e.preventDefault();
      block.classList.add('drop-target');
    });
    block.addEventListener('dragleave', () => block.classList.remove('drop-target'));
    block.addEventListener('drop', (e) => {
      e.preventDefault();
      block.classList.remove('drop-target');
      try {
        const { name, from } = JSON.parse(e.dataTransfer?.getData('text/plain') ?? '');
        // 다른 칩에서 온 값 여부
        const fromChip = typeof name === 'string' && Number.isInteger(from);
        if (fromChip) moveName(from, name, index);
      } catch {
        // 칩이 아닌 것을 놓으면 무시
      }
    });
    block.append(head, chips, add);
    return block;
  }

  function renameGroup(index: number, raw: string) {
    const groups = rosterModel();
    const title = cleanTitle(raw);
    // 빈 이름이면 바꾸지 않고 원래 이름으로 다시 그린다
    if (title) groups[index].title = title;
    saveModel(groups);
  }

  function removeGroup(index: number) {
    const groups = rosterModel();
    groups.splice(index, 1);
    saveModel(groups);
  }

  function addGroup() {
    const groups = rosterModel();
    const titles = new Set(groups.map((g) => g.title));
    let title = '새 그룹';
    for (let n = 2; titles.has(title); n++) title = `새 그룹 ${n}`;
    groups.push({ title, names: [] });
    focusAfterRender = { group: groups.length - 1, field: 'title' };
    saveModel(groups);
  }

  function addToGroup(index: number, text: string) {
    const names = splitNames(text);
    if (names.length === 0) return;
    const groups = rosterModel();
    groups[index].names.push(...names);
    focusAfterRender = { group: index, field: 'add' };
    saveModel(groups);
  }

  function removeName(index: number, name: string) {
    const groups = rosterModel();
    groups[index].names = groups[index].names.filter((n) => n !== name);
    saveModel(groups);
  }

  function moveName(from: number, name: string, to: number) {
    const groups = rosterModel();
    // 옮길 수 없는 경우: 같은 그룹이거나 없는 그룹
    const invalid = from === to || groups[from] === undefined || groups[to] === undefined;
    if (invalid) return;
    groups[from].names = groups[from].names.filter((n) => n !== name);
    if (!groups[to].names.includes(name)) groups[to].names.push(name);
    saveModel(groups);
  }

  function renderRoster() {
    const entries = readEntries();
    syncPerPerson(entries);
    const inRoster = new Set(rosterNames());
    pickedChips.replaceChildren(
      ...[...entries].map(([key, count]) => pickedChip(bareName(key), key, count, inRoster.has(bareName(key))))
    );
    const picked = new Set([...entries.keys()].map(bareName));
    const groups = rosterModel();
    // 그룹 이름 표시 여부: 그룹을 하나라도 만들었을 때만 그룹 이름을 단다
    const withTitles = groups.some((g) => g.title !== null);
    if (vaultEditing) {
      // 편집에서 보일 그룹: 이름 있는 그룹 전부, 그룹 없음은 이름이 있거나 그룹이 하나도 없을 때
      const shown = groups
        .map((_, i) => i)
        .filter((i) => groups[i].title !== null || groups[i].names.length > 0 || !withTitles);
      vaultGroups.replaceChildren(...shown.map((i) => editGroupBlock(groups, i)));
    } else {
      const filled = groups.filter((g) => g.names.length > 0);
      vaultGroups.replaceChildren(...filled.map((g) => groupBlock(g, picked, withTitles)));
    }
    const waitingCount = [...inRoster].filter((name) => !picked.has(name)).length;
    const hasRoster = inRoster.size > 0;
    // 보관함 이름이 모두 이번 추첨에 들어감 여부
    const allIn = hasRoster && waitingCount === 0;
    $('#pickedEmpty').hidden = entries.size > 0;
    $('#btnClearPicked').hidden = entries.size === 0;
    $('#rosterEmpty').hidden = hasRoster || vaultEditing;
    $('#rosterAllIn').hidden = !allIn || vaultEditing;
    $('#rosterAll').hidden = waitingCount === 0 || vaultEditing;
    $('#vaultEditTools').hidden = !vaultEditing;
    if (focusAfterRender) {
      const { group, field } = focusAfterRender;
      focusAfterRender = null;
      const selector = field === 'title' ? '.vault-group-name' : '.group-add input';
      const el = vaultGroups.querySelector<HTMLInputElement>(`[data-group-index="${group}"] ${selector}`);
      el?.focus();
      if (field === 'title') el?.select();
    }
  }

  /** 구슬 수를 delta 만큼 바꾼다. 0 이하가 되면 참가자에서 뺀다 */
  function changeCount(key: string, delta: number) {
    const entries = readEntries();
    const next = (entries.get(key) ?? 0) + delta;
    if (next > 0) entries.set(key, next);
    else entries.delete(key);
    commit(entries);
  }

  /** 이름들을 참가자에 넣는다. 이미 있는 사람은 그대로 두고, 이름*n 으로 쓰면 그 개수로 넣는다 */
  function addNames(lines: string[]): boolean {
    const entries = readEntries();
    for (const raw of lines) {
      const parsed = parseNameLine(raw);
      if (!parsed) continue;
      // 이미 참가 중 여부
      const already = keyOf(entries, bareName(parsed.key)) !== undefined;
      if (already) continue;
      // 개수를 적었는지 여부
      const hasCount = /\*\s*\d+\s*$/.test(raw);
      entries.set(parsed.key, hasCount ? parsed.count : perPerson);
    }
    return commit(entries);
  }

  const addNameInput = $<HTMLInputElement>('#in_addName');
  $('#addNameForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const lines = splitNames(addNameInput.value);
    if (lines.length === 0) return;
    if (addNames(lines)) addNameInput.value = '';
    addNameInput.focus();
  });
  $('#btnClearPicked').addEventListener('click', () => commit(new Map()));

  function saveRoster(lines: string[]) {
    roster = normalizeRoster(lines);
    prefSet(ROSTER_KEY, JSON.stringify(roster));
    // 보관함은 누르는 순간 서버에 보낸다
    void flushPrefs();
    rosterEdit.value = rosterEditorText();
    renderRoster();
  }

  /** 보관함에 없는 이름을 고른 그룹(기본은 그룹 없음)에 넣어 저장한다. 넣은 수를 돌려준다 */
  function keepInRoster(names: string[], groupIndex = 0): number {
    const known = new Set(rosterNames());
    const fresh = [...new Set(names)].filter((name) => !known.has(name));
    const groups = rosterModel();
    // 넣을 수 있는지: 새 이름이 있고 그룹이 있어야 한다
    const canKeep = fresh.length > 0 && groups[groupIndex] !== undefined;
    if (!canKeep) return 0;
    groups[groupIndex].names.push(...fresh);
    saveModel(groups);
    return fresh.length;
  }

  function setTextEditorOpen(open: boolean) {
    rosterEditor.hidden = !open;
    rosterTextBtn.setAttribute('aria-expanded', String(open));
    rosterTextBtn.textContent = open ? '글 편집 닫기' : '글로 한 번에 고치기';
    if (!open) return;
    rosterEdit.value = rosterEditorText();
    rosterEdit.focus();
  }

  function setVaultEditing(on: boolean) {
    vaultEditing = on;
    rosterToggle.textContent = on ? '편집 끝내기' : '보관함 편집';
    rosterToggle.setAttribute('aria-pressed', String(on));
    if (!on) setTextEditorOpen(false);
    renderRoster();
  }

  rosterEdit.value = rosterEditorText();
  rosterToggle.addEventListener('click', () => setVaultEditing(!vaultEditing));
  rosterTextBtn.addEventListener('click', () => setTextEditorOpen(rosterEditor.hidden));
  $('#btnAddGroup').addEventListener('click', addGroup);
  $('#rosterSave').addEventListener('click', () => {
    saveRoster(parseRosterText(rosterEdit.value));
    setVaultEditing(false);
    const count = rosterNames().length;
    toast(count ? `이름 보관함에 ${count}명을 저장했습니다.` : '이름 보관함을 비웠습니다.');
  });
  $('#rosterFromNames').addEventListener('click', () => {
    // 편집 중인 내용을 먼저 저장하고, 거기에 없는 이번 참가자를 그룹 없음에 넣는다
    saveRoster(parseRosterText(rosterEdit.value));
    const added = keepInRoster(getNames().map(bareName));
    toast(added > 0 ? `이번 참가자 ${added}명을 보관함에 넣었습니다.` : '이번 참가자가 모두 보관함에 있습니다.');
  });
  $('#rosterAll').addEventListener('click', () => addNames(rosterNames()));

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

  // ----- Slack 알림 채널: 채널 이름과 Webhook 주소를 공용 저장소에 두고 추첨마다 고른다 -----
  const slackDialog = $<HTMLDialogElement>('#slackDialog');
  const slackName = $<HTMLInputElement>('#slackChannelName');
  const slackUrl = $<HTMLInputElement>('#slackWebhook');
  const slackUrlField = $('#slackWebhookField');
  const slackUrlHelp = $('#slackWebhookHelp');
  const slackStatus = $('#slackStatus');
  const slackTestBtn = $<HTMLButtonElement>('#btnSlackTest');
  const channelList = $('#slackChannelList');

  /** 고를 수 있는 알림 채널. 서버가 방에 붙일 때 id 로 Webhook 주소를 찾는다 */
  function slackChoices(): SlackChoice[] {
    return slackChannels.map((c) => ({ channel: c.channel, channelId: c.id }));
  }

  function getSlack(): SlackChoice | null {
    const i = Number(slackSelect.value);
    const picked = slackSelect.value !== '' && Number.isInteger(i);
    return picked ? (slackChoices()[i] ?? null) : null;
  }

  function syncSlackControls() {
    const chosen = getSlack();
    $('#slackSummary').hidden = !chosen;
    prefSet(SLACK_LAST_KEY, chosen?.channel ?? '');
    renderWinnerInputs();
  }

  function renderSlack(selectedChannel: string | null) {
    const choices = slackChoices();
    slackSelect.replaceChildren(
      new Option('보내지 않음', ''),
      ...choices.map((h, i) => new Option(h.channel, String(i)))
    );
    const index = selectedChannel === null ? -1 : choices.findIndex((h) => h.channel === selectedChannel);
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

  /** 창 안의 저장된 채널 목록 */
  function renderChannelList() {
    $('#slackListWrap').hidden = slackChannels.length === 0;
    channelList.replaceChildren(...slackChannels.map(channelRow));
  }

  /** 채널 한 줄. 같이 쓰는 목록이라 삭제는 한 번 더 눌러야 지운다 */
  function channelRow(c: SharedChannel): HTMLLIElement {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'channel-name';
    name.textContent = c.channel;
    const del = confirmButton('삭제', '정말 삭제', async () => {
      del.disabled = true;
      const selected = getSlack()?.channel ?? null;
      try {
        slackChannels = await removeSharedChannel(API_BASE, c.id);
      } catch (err) {
        setSlackStatus('error', `지우지 못했습니다. ${friendlyError(err)}`);
        del.disabled = false;
        return;
      }
      renderChannelList();
      renderSlack(selected === c.channel ? null : selected);
      setSlackStatus('ok', `${c.channel} 채널을 지웠습니다.`);
    });
    del.dataset.channelId = c.id;
    li.append(name, del);
    return li;
  }

  $('#btnSlackManage').addEventListener('click', () => {
    slackName.value = '';
    slackUrl.value = '';
    checkWebhookInput();
    setSlackStatus(null);
    // 처음 추가하는 사람에게는 만드는 법을 펼쳐 둔다
    $<HTMLDetailsElement>('#slackGuide').open = slackChoices().length === 0;
    renderChannelList();
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
  $('#slackForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!checkWebhookInput(true)) {
      slackUrl.focus();
      return;
    }
    const target = draftTarget();
    const saveBtn = $<HTMLButtonElement>('#btnSlackSave');
    saveBtn.disabled = true;
    try {
      // 같은 이름으로 다시 넣으면 서버가 주소를 바꾼다
      slackChannels = await addSharedChannel(API_BASE, target);
    } catch (err) {
      setSlackStatus('error', `저장하지 못했습니다. ${friendlyError(err)}`);
      return;
    } finally {
      saveBtn.disabled = false;
    }
    slackDialog.close();
    renderSlack(target.channel);
    toast(`${target.channel} 채널을 저장했습니다. 이 추첨의 알림 채널로 골라 두었습니다.`, 3000);
  });
  slackSelect.addEventListener('change', syncSlackControls);
  renderSlack(prefGet(SLACK_LAST_KEY) || null);

  // ----- 방에서 설정 수정 -----
  let editHandlers: EditHandlers | null = null;
  const editSave = $<HTMLButtonElement>('#btnEditSave');
  $('#btnEditCancel').addEventListener('click', () => editHandlers?.cancel());
  editSave.addEventListener('click', async () => {
    if (!editHandlers) return;
    if (roulette.getCount() < 2) {
      showError('참가자를 2명 이상 넣으세요.', 'names');
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
    editing = mode === 'edit';
    editHandlers = editing ? (handlers ?? null) : null;
    $('#btnLocal').hidden = editing;
    $('#btnCreateRoom').hidden = editing;
    $('#btnEditCancel').hidden = !editing;
    editSave.hidden = !editing;
    $('#editNote').hidden = !editing;
    // 방에서는 녹화를 방 카드의 "내 화면 녹화"로 켠다
    $('#setupRecordWrap').hidden = editing;
    renderConfirm();
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
      form.showError('참가자를 2명 이상 넣으세요.', 'names');
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
      form.showError('참가자를 2명 이상 넣으세요.', 'names');
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
      void enterRoom(roulette, id, hostKey, true);
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
/** announce: 방을 막 만든 주최자 화면이면 고른 Slack 채널에 추첨 링크를 바로 올린다 */
async function enterRoom(roulette: Roulette, id: string, hostKey: string | null, announce = false): Promise<void> {
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
  // 보는 사람 화면은 보기만: 새 추첨 같은 버튼을 두지 않는다
  $('#lnkNewRoom').hidden = !isHost;

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
  /** 이 화면에서 추첨 링크를 올린 채널. 같은 채널이면 버튼을 "다시 보내기"로 둔다 */
  let linkSentTo: string | null = null;
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
    // 이미 올린 채널 여부
    const alreadySent = s.slackChannel !== null && s.slackChannel === linkSentTo;
    notifyBtn.textContent = s.slackChannel
      ? `${s.slackChannel}에 ${alreadySent ? '다시 ' : ''}보내기`
      : 'Slack에 보내기';
    renderShareState(alreadySent ? s.slackChannel : null);
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

  /** 링크를 채널에 올렸으면 공유 칸을 "올렸습니다"로 바꾸고 복사 칸은 보조로 둔다. 안 올렸으면 null */
  function renderShareState(sentTo: string | null) {
    $('#hostShare').classList.toggle('sent', sentTo !== null);
    $('#shareLabel').textContent = sentTo
      ? `✓ ${sentTo}에 링크를 올렸습니다. 다른 곳에도 나누려면 복사하세요.`
      : '이 링크를 Slack에 올리세요';
  }

  /** 추첨 링크를 방의 Slack 채널에 올린다. 채널을 안 골랐으면 하지 않는다 */
  async function sendLinkToSlack() {
    const s = client.state;
    if (!hostKey || !s?.slackChannel) return;
    btnSlackNotify.disabled = true;
    try {
      await client.notifySlack(hostKey, currentMapTitle());
      linkSentTo = s.slackChannel;
      btnSlackNotify.textContent = `${s.slackChannel}에 다시 보내기`;
      renderShareState(s.slackChannel);
      toast(`${s.slackChannel}에 추첨 링크를 보냈습니다.`, 3000);
    } catch (e) {
      toast(`Slack 에 보내지 못했습니다. ${friendlyError(e)}`, 4500);
    } finally {
      btnSlackNotify.disabled = false;
    }
  }
  btnSlackNotify.addEventListener('click', () => void sendLinkToSlack());
  // 링크를 막 만들었으면 고른 채널에 바로 올린다
  if (announce) void sendLinkToSlack();

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
