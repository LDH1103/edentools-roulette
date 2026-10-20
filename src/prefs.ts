// 설정 화면이 기억하는 값(명단, Slack 채널, 마지막 참가자·당첨 방식·맵·알림 채널)은
// 서버의 공용 저장소에 두고 쓰는 사람 모두가 같이 쓴다.
// 테마·주최자 키는 기기마다 다른 값이라 브라우저에 둔다.
import { importToShared, loadShared, type SharedChannel, type SlackTarget, saveSharedValues } from './sync';

/** 공용 저장소에 두는 값의 키. 서버(worker)의 STORE_VALUE_KEYS 와 같다 */
const PREF_KEYS = ['er_names', 'er_roster', 'er_winner', 'er_map', 'er_slack_last'] as const;
export type PrefKey = (typeof PREF_KEYS)[number];
/** 예전에 브라우저에 Slack 채널(Webhook 주소 포함)을 두던 키. 공용 저장소로 옮긴 뒤 지운다 */
const BROWSER_HOOKS_KEY = 'er_slack_hooks';
/** 입력이 멈추고 이만큼 지나면 서버에 보낸다 */
const SAVE_DELAY_MS = 800;

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 저장 불가 환경은 무시
  }
}

function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // 저장 불가 환경은 무시
  }
}

let apiBase = '';
let values: Record<string, string> = {};
let channels: SharedChannel[] = [];
/** 서버 값을 받았는지. 못 받은 화면은 기본값으로 서버를 덮어쓰지 않도록 저장하지 않는다 */
let loaded = false;
/** 아직 서버에 못 보낸 값 */
let pending: Record<string, string> = {};
let saveTimer = 0;
let onSaveError: (e: unknown) => void = () => {};

/** 예전에 이 브라우저에 저장한 값. 없으면 null */
function readBrowserValues(): { values: Record<string, string>; channels: SlackTarget[] } | null {
  const found: Record<string, string> = {};
  for (const key of PREF_KEYS) {
    const value = storageGet(key);
    if (value !== null) found[key] = value;
  }
  let hooks: SlackTarget[] = [];
  try {
    const v = JSON.parse(storageGet(BROWSER_HOOKS_KEY) ?? '[]');
    if (Array.isArray(v)) hooks = v.filter((h) => h && typeof h.channel === 'string' && typeof h.webhook === 'string');
  } catch {
    hooks = [];
  }
  // 옮길 값 있음 여부
  const hasAny = Object.keys(found).length > 0 || hooks.length > 0;
  return hasAny ? { values: found, channels: hooks } : null;
}

/**
 * 공용 저장값을 받아 둔다. 설정 폼을 만들기 전에 한 번 부른다.
 * 이 브라우저에 예전 값이 남아 있으면 공용 저장소로 한 번 옮기고 지운다. 네트워크 오류는 던진다
 */
export async function initPrefs(base: string, onError: (e: unknown) => void): Promise<void> {
  apiBase = base;
  onSaveError = onError;
  window.addEventListener('pagehide', () => void flushPrefs(true));
  const local = readBrowserValues();
  const shared = local ? await importToShared(base, local.values, local.channels) : await loadShared(base);
  if (local) {
    for (const key of PREF_KEYS) storageRemove(key);
    storageRemove(BROWSER_HOOKS_KEY);
  }
  values = shared.values;
  channels = shared.channels;
  loaded = true;
}

/** 공용 Slack 채널(이름·id) */
export function sharedChannels(): SharedChannel[] {
  return channels;
}

export function prefGet(key: PrefKey): string | null {
  return values[key] ?? null;
}

/** 값이 바뀌었을 때만 저장한다. 입력이 멈춘 뒤 모아서 서버에 보낸다 */
export function prefSet(key: PrefKey, value: string): void {
  // 값 그대로 여부: 화면을 다시 그릴 때마다 서버에 쓰지 않는다
  const unchanged = values[key] === value;
  if (unchanged) return;
  values[key] = value;
  if (!loaded) return;
  pending[key] = value;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void flushPrefs(), SAVE_DELAY_MS);
}

/** 모아 둔 값을 바로 보낸다. 실패한 값은 다음 저장 때 다시 보낸다 */
export async function flushPrefs(keepalive = false): Promise<void> {
  window.clearTimeout(saveTimer);
  // 보낼 값 있음 여부
  const hasPending = Object.keys(pending).length > 0;
  if (!hasPending) return;
  const sending = pending;
  pending = {};
  try {
    await saveSharedValues(apiBase, sending, keepalive);
  } catch (e) {
    pending = { ...sending, ...pending };
    onSaveError(e);
  }
}
