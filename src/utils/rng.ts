// 시드 난수. 같은 시드면 어느 브라우저에서나 같은 수열이 나온다.
// 물리 결과에 영향을 주는 난수(구슬 배치 순서, 밀도, 스킬 발동, 정지 구슬 흔들기)에만 쓴다.
// 입자·연출처럼 보기만 하는 난수는 Math.random 을 그대로 쓴다.

// cyrb53: 문자열을 53비트 해시로. 시드 문자열을 숫자 시드로 바꾼다
function hash53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// mulberry32: 32비트 정수 연산만 쓰는 난수. 부동소수점 구현 차이가 끼어들 틈이 없다
function mulberry32(a: number): () => number {
  let s = a >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let current: () => number = Math.random;

/** 게임 난수를 시드로 되감는다. 구슬을 만들기 직전에 부른다 */
export function seedGameRng(seed: string): void {
  current = mulberry32(hash53(seed) >>> 0);
}

/** 물리에 영향을 주는 자리에서 쓰는 난수 */
export function gameRandom(): number {
  return current();
}
