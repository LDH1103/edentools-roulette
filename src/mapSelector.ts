// 설정창의 맵 선택. 기본 맵만 보여주고 선택을 공용 저장소에 기억한다
import { stages } from './data/maps';
import { translate } from './localization';
import { prefGet, prefSet } from './prefs';
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
    prefSet(STORAGE_KEY, String(index));
    onMapChange();
  });

  // 기억해 둔 맵이 있으면 그 맵으로
  const saved = Number(prefGet(STORAGE_KEY) ?? 0);
  if (Number.isInteger(saved) && saved > 0 && saved < stages.length) {
    roulette.setMap(saved);
  }
  select.value = String(roulette.getCurrentMap()?.index ?? 0);
}
