# 구슬 레이스

링크 하나로 모두가 **같은** 구슬 레이스를 보는 추첨기입니다. Slack 채널에 링크만 올리면 화면공유 없이 함께 볼 수 있습니다.

- 사이트: https://roulette.edentools.dev
- 동기화 서버: https://roulette-api.edentools.dev (Cloudflare Worker + Durable Object, `worker/`)

[Marble Roulette](https://github.com/lazygyu/roulette) by lazygyu 를 바탕으로 만들었습니다 (소스 코드 MIT). 원작의 이름 "마블 룰렛"/"Marble Roulette" 은 원작자의 상표이므로 쓰지 않습니다.

## 사용법

1. 사이트를 열고 참가자를 입력합니다. 자주 쓰는 이름은 "명단 편집"으로 저장해 두면 다음부터 칩을 클릭해 고를 수 있습니다.
2. 맵, 스킬, 당첨 방식(먼저 N명 / 마지막 N명 / 특정 등수 / 범위)을 정하고 **공유 링크 만들기**를 누릅니다.
3. 링크(또는 "Slack 문구 복사")를 채널에 올립니다. 참가자들은 링크를 열고 기다립니다.
4. 주최자가 **시작**을 누르면 3초 카운트다운 뒤 모든 화면에서 동시에 출발합니다. 늦게 들어온 사람도 현재 시점까지 빠르게 따라잡습니다.
5. 결과가 나오면 주최자는 **다시 추첨**으로 새 시드로 돌릴 수 있습니다.

방 없이 바로 돌려보려면 **혼자 돌리기**를 누르면 됩니다.

## 원작과 다른 점

- **결정론**: 시드 난수(`src/utils/rng.ts`)로 구슬 배치·밀도·스킬·흔들기를 정하고, 물리 틱(10ms)마다 슬로모션 비율·순위 정렬·골인 제거를 처리해 프레임 속도와 무관하게 같은 결과가 나옵니다. Box2D wasm 은 비SIMD 빌드 하나로 고정합니다.
- **동시 시작**: 서버 시각 기준 시작 시각을 받아 모두 같은 틱을 봅니다 (`src/sync.ts`, `worker/`).
- 광고, 상점, 맵 공유마당, 키워드 스프라이트, 분석, 서비스워커는 뺐습니다. 원작의 특정 인물 이미지도 넣지 않습니다.

## 개발

```bash
yarn            # 의존성 설치 (corepack yarn)
yarn dev        # http://localhost:1235  (동기화 서버는 http://localhost:8787 을 본다)
yarn build      # dist/
```

동기화 서버:

```bash
cd worker
npx wrangler dev        # 로컬
npx wrangler deploy     # 배포 (Cloudflare 로그인 필요)
```

`main` 에 push 하면 GitHub Actions 가 빌드해 GitHub Pages 로 배포합니다 (`.github/workflows/deploy.yml`).

## License

소스 코드는 [MIT License](./LICENSE) 입니다. 원작 저작권 표시: Copyright (c) 2022 LazyGyu.
