// 설정창의 맵 선택. 기본 맵만 보여주고 선택을 localStorage 에 기억한다
import { stages } from './data/maps';
import { translate } from './localization';
import type { Roulette } from './roulette';

const STORAGE_KEY = 'er_map';

export function initMapSelector(roulette: Roulette, onMapChange: () => void) {
  const select = document.querySelector<HTMLSelectElement>('#sltMap');
  if (!select) return;

  select.replaceChildren(
    ...stages.map((stage, index) => {
      const el = document.createElement('option');
      el.value = String(index);
      el.textContent = translate(stage.title);
      return el;
    })
  );

  select.addEventListener('change', () => {
    const index = Number(select.value);
    roulette.setMap(index);
    try {
      localStorage.setItem(STORAGE_KEY, String(index));
    } catch {
      // 저장 불가 환경은 무시
    }
    onMapChange();
  });

  // 기억해 둔 맵이 있으면 그 맵으로
  let saved = 0;
  try {
    saved = Number(localStorage.getItem(STORAGE_KEY) ?? 0);
  } catch {
    saved = 0;
  }
  if (Number.isInteger(saved) && saved > 0 && saved < stages.length) {
    roulette.setMap(saved);
  }
  select.value = String(roulette.getCurrentMap()?.index ?? 0);
}
