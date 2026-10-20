import { Camera } from './camera';
import { canvasHeight, canvasWidth, initialZoom, Skills, Themes, zoomThreshold } from './data/constants';
import { type StageDef, stages } from './data/maps';
import { FastForwader } from './fastForwader';
import type { GameObject } from './gameObject';
import type { IPhysics } from './IPhysics';
import { Marble } from './marble';
import { Minimap } from './minimap';
import options, { type WinnerRange } from './options';
import { ParticleManager } from './particleManager';
import { Box2dPhysics } from './physics-box2d';
import { ProgressMap } from './progressMap';
import { RankRenderer } from './rankRenderer';
import { RouletteRenderer } from './rouletteRenderer';
import { SkillEffect } from './skillEffect';
import type { ColorTheme } from './types/ColorTheme';
import type { MouseEventHandlerName, MouseEventName } from './types/mouseEvents.type';
import type { UIObject } from './UIObject';
import { bound } from './utils/bound.decorator';
import { gameRandom, seedGameRng } from './utils/rng';
import { parseName, shuffle } from './utils/utils';
import { VideoRecorder } from './utils/videoRecorder';
import { drawZoomZones, zoomZoneIntensity } from './zoomZone';

/** 한 프레임에 따라잡는 최대 틱 수(= 6초 분량). 늦게 들어온 사람은 몇 프레임에 걸쳐 현재 시점까지 간다 */
const MAX_TICKS_PER_FRAME = 600;
/** 골인한 구슬을 물리에서 빼기까지의 틱 수 (0.5초) */
const GOAL_REMOVE_TICKS = 50;
/** 출발 후 이 틱(10분)이 지나면 시간을 멈춘다. 한참 뒤에 링크를 연 사람이 끝없이 따라잡지 않도록 */
const RUN_TICK_LIMIT = 60000;

/** 입력 범위를 실제 구슬 수에 맞춰 자른다. 범위를 넘기면 뒤쪽이 잘린다 */
function clipWinnerRange({ start, end }: WinnerRange, marbleCount: number): WinnerRange {
  const last = Math.max(0, marbleCount - 1);
  const clippedStart = Math.min(Math.max(0, start), last);
  return { start: clippedStart, end: Math.min(Math.max(clippedStart, end), last) };
}

/**
 * 순위 흔들림 줄이기. 구슬마다 순위 값(결승까지 남은 거리) 을 이 시간(초) 동안 부드럽게 따라가고,
 * 앞 구슬보다 RANK_MARGIN 넘게 앞서야 자리를 바꾼다
 */
const RANK_EMA_SEC = 0.4;
const RANK_MARGIN = 0.25;

export class Roulette extends EventTarget {
  private _marbles: Marble[] = [];

  private _lastTime: number = 0;
  /** 시작 전 대기 중 장애물·연출만 돌리는 누적 시간(ms) */
  private _idleElapsed = 0;

  private _updateInterval = 10;
  private _timeScale = 1;
  private _speed = 1;

  private _winners: Marble[] = [];
  private _particleManager = new ParticleManager();
  private _stage: StageDef | null = null;
  /** 'builtin:{index}' | 'community:{id}'. 맵 공유마당에서 받은 맵은 stages 에 없어서 인덱스 대신 이 값으로 구분한다 */
  private _mapId = 'builtin:0';

  protected _camera: Camera = new Camera();
  protected _renderer: RouletteRenderer;

  private _effects: GameObject[] = [];

  private _winnerRange: WinnerRange = { start: 0, end: 0 };
  private _goalDist: number = Infinity;
  /** 연출 구역이 있는 맵에서 커트라인을 다투는 두 구슬 중 센 쪽의 연출 강도 (0 ~ 1). 구역이 없으면 null 이고 zoomY 로 판단한다 */
  private _zoomIntensity: number | null = null;
  /** 연출이 _targetIndex 구슬이 아니라 _rivalIndex 구슬 때문에 걸렸는지 */
  private _focusOnRival = false;
  /** 구슬별 평활화한 순위 값 (결승까지 남은 거리) */
  private _rankKeys = new Map<Marble, number>();
  /** 진행도 지도 그림 (setProgressDebug 로 켰을 때 맵마다 한 번 만든다) */
  private _progressImage: { map: ProgressMap; image: HTMLCanvasElement } | null = null;
  private _isRunning: boolean = false;
  /** 진행 중에는 null, 당첨자가 모두 확정되면 당첨자 배열 */
  private _result: Marble[] | null = null;

  /** 골인한 구슬을 물리에서 빼는 예약 (틱 기준). 벽시계 타이머를 쓰면 보는 환경마다 결과가 달라진다 */
  private _pendingRemovals: { id: number; atTick: number }[] = [];

  /** 시작 이후 진행한 물리 틱 수. 결과는 이 숫자와 시드만으로 정해진다 */
  private _tick = 0;
  /** 시작 시각(ms). 동기 모드면 서버 시각, 로컬 모드면 내 시각. null 이면 아직 출발 전 */
  private _startAt: number | null = null;
  /** 카운트다운 중인 시작 예정 시각 */
  private _pendingStartAt: number | null = null;
  /** 동기 모드: 시계가 정한 목표 틱까지 따라간다. 로컬 모드: 배속·빨리감기가 먹는 누적 시간을 쓴다 */
  private _syncMode = false;
  /** 현재 시각을 돌려주는 시계. 동기 모드에서는 서버 시각으로 바꿔 끼운다 */
  private _clock: () => number = () => Date.now();
  private _localElapsed = 0;
  private _catchingUp = false;
  /** 마지막으로 setMarbles 에 넘긴 이름(문법 포함)과 시드. 출발할 때 같은 조건으로 다시 만든다 */
  private _names: string[] = [];
  private _seed = '';

  private _uiObjects: UIObject[] = [];

  private _autoRecording: boolean = false;
  private _recorder!: VideoRecorder;

  private physics!: IPhysics;

  private _isReady: boolean = false;
  protected fastForwarder!: FastForwader;
  protected _theme: ColorTheme = Themes.dark;

  get isReady() {
    return this._isReady;
  }

  protected createRenderer(): RouletteRenderer {
    return new RouletteRenderer();
  }

  protected createFastForwader(): FastForwader {
    return new FastForwader();
  }

  constructor() {
    super();
    this._renderer = this.createRenderer();
    this._renderer.init().then(() => {
      this._init().then(() => {
        this._isReady = true;
        this._update();
      });
    });
  }

  public getZoom() {
    return initialZoom * this._camera.zoom;
  }

  private addUiObject(obj: UIObject) {
    this._uiObjects.push(obj);
    if (obj.onWheel) {
      this._renderer.canvas.addEventListener('wheel', obj.onWheel);
    }
    if (obj.onMessage) {
      obj.onMessage((msg) => {
        console.log('onMessage', msg);
        this.dispatchEvent(new CustomEvent('message', { detail: msg }));
      });
    }
  }

  @bound
  private _update() {
    const now = Date.now();
    if (!this._lastTime) this._lastTime = now;
    const frameMs = Math.min(1000, now - this._lastTime);
    this._lastTime = now;

    // 카운트다운이 끝나면 같은 조건으로 구슬을 다시 만들고 틱 0 에서 출발한다
    if (this._pendingStartAt !== null && this._clock() >= this._pendingStartAt) {
      this._beginRun(this._pendingStartAt);
    }

    if (this._startAt !== null) {
      // 목표 틱 = 출발 후 흐른 시간 / 10ms. 모두가 같은 시계를 보므로 같은 틱에 있다.
      // 늦게 들어온 사람은 한 프레임에 MAX_TICKS_PER_FRAME 씩 따라잡는다
      let targetTick: number;
      if (this._syncMode) {
        targetTick = Math.floor((this._clock() - this._startAt) / this._updateInterval);
      } else {
        this._localElapsed += frameMs * this._speed * this.fastForwarder.speed;
        targetTick = Math.floor(this._localElapsed / this._updateInterval);
      }
      targetTick = Math.min(targetTick, RUN_TICK_LIMIT);
      let n = 0;
      while (this._tick < targetTick && n < MAX_TICKS_PER_FRAME) {
        this._step();
        n++;
      }
      this._catchingUp = this._tick < targetTick;
    } else {
      // 출발 전: 장애물과 연출만 돌린다. 구슬은 비활성이라 움직이지 않고, 출발할 때 맵을 새로 만들므로 결과에도 영향이 없다
      this._idleElapsed += frameMs;
      while (this._idleElapsed >= this._updateInterval) {
        this._idleStep();
        this._idleElapsed -= this._updateInterval;
      }
    }

    if (this._stage) {
      const cameraTargetIndex = this._winners.length > 0 ? this._targetIndex : 0;
      this._camera.update({
        marbles: this._marbles,
        stage: this._stage,
        intensity: this._zoomIntensity ?? Math.max(0, 1 - this._goalDist / zoomThreshold),
        targetIndex: cameraTargetIndex,
        // 첫 골인 전에는 카메라가 커트라인 대신 선두를 따라가므로 커트라인 쪽 판단을 넘기지 않는다
        focusOnRival: cameraTargetIndex === this._targetIndex && this._focusOnRival,
        viewSize: { x: this._renderer.width / initialZoom, y: this._renderer.height / initialZoom },
      });
    }

    this._render();
    window.requestAnimationFrame(this._update);
  }

  /**
   * 10ms 물리 틱 하나. 틱 번호만으로 결과가 정해지도록 슬로모션 비율·순위 정렬·골인 제거를 모두 틱 안에서 처리한다.
   * (원본은 프레임마다 처리해 프레임 속도에 따라 결과가 달라졌다)
   */
  private _step() {
    // 슬로모션 비율은 이전 틱 끝에 계산된 값. 구슬 정지 판정도 같은 값을 써야 실제 진행된 물리 시간과 맞는다
    const timeScale = this._timeScale;
    const interval = (this._updateInterval / 1000) * timeScale;

    while (this._pendingRemovals.length > 0 && this._pendingRemovals[0].atTick <= this._tick) {
      this.physics.removeMarble(this._pendingRemovals.shift()!.id);
    }

    this.physics.step(interval);
    this._updateMarbles(this._updateInterval, timeScale);
    this._particleManager.update(this._updateInterval);
    this._updateEffects(this._updateInterval);
    this._uiObjects.forEach((obj) => obj.update(this._updateInterval));
    if (this._marbles.length > 1) {
      this._sortMarbles(interval);
    }
    this._tick++;
  }

  /** 출발 전 대기 틱: 장애물 회전과 연출만 */
  private _idleStep() {
    this.physics.step(this._updateInterval / 1000);
    this._particleManager.update(this._updateInterval);
    this._updateEffects(this._updateInterval);
    this._uiObjects.forEach((obj) => obj.update(this._updateInterval));
  }

  /** 출발. 대기 중 돌아간 장애물 각도를 되돌리기 위해 같은 시드로 맵과 구슬을 다시 만든다 */
  private _beginRun(startAt: number) {
    this._pendingStartAt = null;
    this.setMarbles(this._names, this._seed);
    this._startAt = startAt;
    this._isRunning = true;
    this._winnerRange = clipWinnerRange(options.winnerRange, this._marbles.length);
    this._camera.startFollowingMarbles();
    if (this._autoRecording) {
      this._recorder.start().catch((e) => console.error('recording failed to start', e));
    }
    this.physics.start();
    this._marbles.forEach((marble) => (marble.isActive = true));
    this.dispatchEvent(new CustomEvent('run'));
  }

  /**
   * 순위대로 정렬한다. 순위 값은 진행도 지도의 "결승까지 남은 거리" (progressMap.ts).
   * dt = 이번 프레임에 진행된 물리 시간(초)
   */
  private _sortMarbles(dt: number) {
    if (!this._stage) return;
    const map = ProgressMap.for(this._stage);

    /** 지난 프레임 기록이 있는 구슬 수. 구슬을 새로 넣은 직후면 0 */
    let known = 0;
    const alpha = 1 - Math.exp(-dt / RANK_EMA_SEC);
    const keys = new Map<Marble, number>();
    for (const m of this._marbles) {
      const raw = map.distanceAt(m.x, m.y);
      const prev = this._rankKeys.get(m);
      if (prev !== undefined) known++;
      keys.set(m, prev !== undefined ? prev + (raw - prev) * alpha : raw);
    }
    this._rankKeys = keys;

    // 구슬을 막 넣었을 때는 지난 순서가 없으니 그냥 정렬한다
    if (known < this._marbles.length / 2) {
      this._marbles.sort((a, b) => keys.get(a)! - keys.get(b)! || b.y - a.y);
      return;
    }
    // 지난 프레임 순서에서 출발해, 앞 구슬보다 RANK_MARGIN 넘게 앞설 때만 앞으로 보낸다 (여유를 둔 삽입 정렬).
    // 순서가 거의 그대로라 일반 정렬보다 빠르다
    const list = this._marbles;
    for (let i = 1; i < list.length; i++) {
      const m = list[i];
      const k = keys.get(m)! + RANK_MARGIN;
      let j = i;
      while (j > 0 && k < keys.get(list[j - 1])!) {
        list[j] = list[j - 1];
        j--;
      }
      list[j] = m;
    }
  }

  /** 진행도 지도(순위 계산에 쓰는 남은 거리), 일방통행 선, 연출 구역, 카메라 구역을 맵 위에 그린다 (테스트 플레이에서 확인용) */
  public setProgressDebug(on: boolean) {
    this._renderer.debugDraw = on
      ? (ctx) => {
          if (!this._stage) return;
          const map = ProgressMap.for(this._stage);
          if (this._progressImage?.map !== map) this._progressImage = { map, image: map.toCanvas() };
          map.drawDebug(ctx, this._progressImage.image);
          if (this._stage.zoomZones?.length) drawZoomZones(ctx, this._stage.zoomZones);
          if (this._stage.cameraZones?.length) drawZoomZones(ctx, this._stage.cameraZones, '200, 60, 255');
        }
      : null;
  }

  private _updateMarbles(deltaTime: number, timeScale: number) {
    if (!this._stage) return;

    for (let i = 0; i < this._marbles.length; i++) {
      const marble = this._marbles[i];
      marble.update(deltaTime, timeScale);
      if (marble.skill === Skills.Impact) {
        this._effects.push(new SkillEffect(marble.x, marble.y));
        this.physics.impact(marble.id);
      }
      if (marble.y > this._stage.goalY) {
        this._winners.push(marble);
        if (this._isRunning && this._isWinningRank(this._winners.length - 1)) {
          this._particleManager.shot(this._renderer.width, this._renderer.height);
        }
        // 0.5초 동안은 뒤따르는 구슬과 부딪칠 수 있으므로 틱 기준으로 빼야 모두 같은 결과가 나온다
        this._pendingRemovals.push({ id: marble.id, atTick: this._tick + GOAL_REMOVE_TICKS });
      }
    }

    // 연출(줌인, 슬로모션) 은 커트라인을 다투는 두 구슬 중 연출이 더 센 쪽을 기준으로 건다.
    // 예: 꼴찌를 뽑을 때는 바로 앞 구슬이 골인하는 순간 꼴찌가 정해진다
    const stage = this._stage;
    const zones = stage.zoomZones?.length ? stage.zoomZones : null;
    const intensityOf = (m: Marble) =>
      zones ? zoomZoneIntensity(zones, m.x, m.y) : Math.max(0, 1 - Math.abs(stage.zoomY - m.y) / zoomThreshold);
    const target = this._marbles[this._targetIndex];
    const rival = this._marbles[this._rivalIndex];
    this._focusOnRival = !!target && !!rival && intensityOf(rival) > intensityOf(target);
    const focus = this._focusOnRival ? rival : target;
    this._goalDist = Math.abs(stage.zoomY - (focus ? focus.y : 0));
    this._zoomIntensity = zones ? (focus ? intensityOf(focus) : 0) : null;
    this._timeScale = this._calcTimeScale();

    this._marbles = this._marbles.filter((marble) => marble.y <= stage.goalY);

    this._checkFinish();
  }

  /** 카메라와 슬로우모션이 주목할 구슬 = 당첨 커트라인에 걸쳐있는 구슬 */
  private get _targetIndex() {
    return this._winnerRange.end - this._winners.length;
  }

  /** 커트라인을 두고 _targetIndex 구슬과 다투는 구슬 = 바로 뒤, 없으면 바로 앞 구슬 */
  private get _rivalIndex() {
    const i = this._targetIndex;
    return this._marbles[i + 1] ? i + 1 : i - 1;
  }

  private _isWinningRank(rank: number) {
    return rank >= this._winnerRange.start && rank <= this._winnerRange.end;
  }

  private _checkFinish() {
    if (!this._isRunning) return;
    const { start, end } = this._winnerRange;

    // 남은 구슬이 1개면 그 등수는 골인하지 않아도 확정된다. 2개 이상 남았다면 그들 사이의
    // 순위는 물리로만 정해지므로 예측하지 않는다 (당첨 범위 안에서도 순위는 의미를 가진다)
    const early = this._winners.length > 0 && this._marbles.length === 1;
    const ranked = early ? [...this._winners, this._marbles[0]] : this._winners;
    if (ranked.length <= end) return;

    if (early && this._isWinningRank(this._winners.length)) {
      this._particleManager.shot(this._renderer.width, this._renderer.height);
    }

    this._result = ranked.slice(start, end + 1);
    this._isRunning = false;
    this.dispatchEvent(
      new CustomEvent('goal', {
        detail: { winner: this._result[0].name, winners: this._result.map((m) => m.name) },
      })
    );
    setTimeout(() => {
      this._recorder.stop();
    }, 1000);
  }

  private _calcTimeScale(): number {
    if (!this._stage) return 1;
    const targetIndex = this._targetIndex;
    // 연출 구역: 커트라인 구슬이 구역 가운데로 갈수록 느려진다. 경쟁하는 구슬이 있을 때만
    if (this._zoomIntensity !== null) {
      if (
        this._winners.length < this._winnerRange.end + 1 &&
        this._zoomIntensity > 0 &&
        (this._marbles[targetIndex - 1] || this._marbles[targetIndex + 1])
      ) {
        return Math.max(0.2, 1 - this._zoomIntensity);
      }
      return 1;
    }
    if (this._winners.length < this._winnerRange.end + 1 && this._goalDist < zoomThreshold) {
      if (
        this._marbles[this._focusOnRival ? this._rivalIndex : targetIndex].y >
          this._stage.zoomY - zoomThreshold * 1.2 &&
        (this._marbles[targetIndex - 1] || this._marbles[targetIndex + 1])
      ) {
        return Math.max(0.2, this._goalDist / zoomThreshold);
      }
    }
    return 1;
  }

  private _updateEffects(deltaTime: number) {
    this._effects.forEach((effect) => effect.update(deltaTime));
    this._effects = this._effects.filter((effect) => !effect.isDestroy);
  }

  private _render() {
    if (!this._stage) return;
    const renderParams = {
      camera: this._camera,
      stage: this._stage,
      entities: this.physics.getEntities(),
      marbles: this._marbles,
      winners: this._winners,
      particleManager: this._particleManager,
      effects: this._effects,
      winnerRange: this._winnerRange,
      result: this._result,
      size: { x: this._renderer.width, y: this._renderer.height },
      theme: this._theme,
    };
    this._renderer.render(renderParams, this._uiObjects);
  }

  private async _init() {
    this._recorder = new VideoRecorder(this._renderer.canvas);

    this.physics = new Box2dPhysics();
    await this.physics.init();

    this.addUiObject(new RankRenderer());
    this.attachEvent();
    const minimap = new Minimap();
    minimap.onViewportChange((pos) => {
      if (pos) {
        this._camera.setPosition(pos, false);
        this._camera.lock(true);
      } else {
        this._camera.lock(false);
      }
    });
    this.addUiObject(minimap);
    this.fastForwarder = this.createFastForwader();
    this.addUiObject(this.fastForwarder);
    this._stage = stages[0];
    this._loadMap();
  }

  @bound
  private mouseHandler(eventName: MouseEventName, e: MouseEvent) {
    const handlerName = `on${eventName}` as MouseEventHandlerName;

    const sizeFactor = this._renderer.sizeFactor;
    const pos = { x: e.offsetX * sizeFactor, y: e.offsetY * sizeFactor };
    this._uiObjects.forEach((obj) => {
      if (!obj[handlerName]) return;
      const bounds = obj.getBoundingBox();
      if (!bounds) {
        obj[handlerName]({ ...pos, button: e.button });
      } else if (
        bounds &&
        pos.x >= bounds.x &&
        pos.y >= bounds.y &&
        pos.x <= bounds.x + bounds.w &&
        pos.y <= bounds.y + bounds.h
      ) {
        obj[handlerName]({ x: pos.x - bounds.x, y: pos.y - bounds.y, button: e.button });
      } else {
        obj[handlerName](undefined);
      }
    });
  }

  private attachEvent() {
    const canvas = this._renderer.canvas;
    const onPointerRelease = (e: Event) => {
      this.mouseHandler('MouseUp', e as MouseEvent);
      window.removeEventListener('pointerup', onPointerRelease);
      window.removeEventListener('pointercancel', onPointerRelease);
    };

    canvas.addEventListener('pointerdown', (e: Event) => {
      this.mouseHandler('MouseDown', e as MouseEvent);
      window.addEventListener('pointerup', onPointerRelease);
      window.addEventListener('pointercancel', onPointerRelease);
    });

    ['MouseMove', 'DblClick'].forEach((ev) => {
      // @ts-expect-error
      canvas.addEventListener(ev.toLowerCase().replace('mouse', 'pointer'), this.mouseHandler.bind(this, ev));
    });
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });

    canvas.addEventListener('click', (e) => {
      if (this.resultCloseHitAt(e)) {
        this._renderer.closeResultPopup();
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      canvas.style.cursor = this.resultCloseHitAt(e) ? 'pointer' : '';
    });
  }

  private _loadMap() {
    if (!this._stage) {
      throw new Error('No map has been selected');
    }

    this.physics.createStage(this._stage);
    this._camera.initializePosition();
  }

  public clearMarbles() {
    this._pendingRemovals = [];
    this.physics.clearMarbles();
    this._result = null;
    this._winners = [];
    this._marbles = [];
  }

  /** 로컬 모드: 방 없이 혼자 돌린다. 지금 바로 출발하고 배속·빨리감기가 먹는다 */
  public start() {
    this._syncMode = false;
    this._clock = () => Date.now();
    this._pendingStartAt = Date.now();
  }

  /**
   * 동기 모드: 서버 시각 startAt 에 출발한다. clock 은 서버 시각을 돌려주는 함수.
   * 이미 지난 시각이면 그만큼의 틱을 빠르게 따라잡아 다른 사람과 같은 장면을 보여준다
   */
  public startSynced(startAt: number, clock: () => number) {
    this._syncMode = true;
    this._clock = clock;
    this._pendingStartAt = startAt;
  }

  /** 출발을 취소하고 구슬을 출발선으로 되돌린다 (다시 추첨) */
  public cancelRun() {
    this._pendingStartAt = null;
    this._recorder.stop();
    this.setMarbles(this._names, this._seed);
  }

  /** 늦게 들어와 현재 시점까지 빠르게 따라가는 중인지 */
  public get isCatchingUp() {
    return this._catchingUp;
  }

  public get hasStarted() {
    return this._startAt !== null;
  }

  public getTick() {
    return this._tick;
  }

  public setSpeed(value: number) {
    if (value <= 0) {
      throw new Error('Speed multiplier must larger than 0');
    }
    this._speed = value;
  }

  private resultCloseHitAt(e: MouseEvent): boolean {
    const sizeFactor = this._renderer.sizeFactor;
    return this._renderer.getResultCloseHitAt(e.offsetX * sizeFactor, e.offsetY * sizeFactor);
  }

  public setTheme(themeName: keyof typeof Themes) {
    this._theme = Themes[themeName];
  }

  public getSpeed() {
    return this._speed;
  }

  public setWinningRank(rank: number) {
    this.setWinnerRange(rank, rank);
  }

  public setWinnerRange(start: number, end: number) {
    options.winnerRange = { start, end };
    this._winnerRange = clipWinnerRange(options.winnerRange, this._marbles.length);
  }

  /** 실제 구슬 수에 맞춰 잘린 범위 (0-based, 양끝 포함) */
  public getWinnerRange(): WinnerRange {
    return { ...this._winnerRange };
  }

  public setAutoRecording(value: boolean) {
    this._autoRecording = value;
  }

  /**
   * 구슬을 만든다. 같은 names 와 seed 면 배치 순서·밀도·스킬 타이밍이 같아 어디서 돌려도 같은 결과가 나온다.
   * seed 를 생략하면 마지막 시드를 다시 쓴다
   */
  public setMarbles(names: string[], seed: string = this._seed) {
    this._names = names.slice();
    this._seed = seed;
    this.reset();
    seedGameRng(seed);
    const arr = names.slice();

    let maxWeight = -Infinity;
    let minWeight = Infinity;

    const members = arr
      .map((nameString) => {
        const result = parseName(nameString);
        if (!result) return null;
        const { name, weight, count } = result;
        if (weight > maxWeight) maxWeight = weight;
        if (weight < minWeight) minWeight = weight;
        return { name, weight, count };
      })
      .filter((member) => !!member);

    const gap = maxWeight - minWeight;

    let totalCount = 0;
    members.forEach((member) => {
      if (member) {
        member.weight = 0.1 + (gap ? (member.weight - minWeight) / gap : 0);
        totalCount += member.count;
      }
    });

    const orders = shuffle(
      Array(totalCount)
        .fill(0)
        .map((_, i) => i),
      gameRandom
    );
    members.forEach((member) => {
      if (member) {
        for (let j = 0; j < member.count; j++) {
          const order = orders.pop() || 0;
          this._marbles.push(new Marble(this.physics, order, totalCount, member.name, member.weight));
        }
      }
    });

    // 카메라를 구슬 생성 위치 중앙으로 이동 + 줌인
    if (totalCount > 0) {
      const cols = Math.min(totalCount, 10);
      const rows = Math.ceil(totalCount / 10);
      const lineDelta = -Math.max(0, Math.ceil(rows - 5));
      const centerX = 10.25 + (cols - 1) * 0.3;
      const centerY = (1 + rows) / 2 + lineDelta;

      const spawnWidth = Math.max((cols - 1) * 0.6, 1);
      const spawnHeight = Math.max(rows - 1, 1);
      const margin = 3;
      const viewW = canvasWidth / initialZoom;
      const viewH = canvasHeight / initialZoom;
      const zoom = Math.max(
        1.5,
        Math.min(Math.min(viewW / (spawnWidth + margin * 2), viewH / (spawnHeight + margin * 2)), 3)
      );

      this._camera.initializePosition({ x: centerX, y: centerY }, zoom);
    }
  }

  private _clearMap() {
    this.physics.clear();
    this._marbles = [];
  }

  public reset() {
    this.clearMarbles();
    this._clearMap();
    this._loadMap();
    this._goalDist = Infinity;
    this._focusOnRival = false;
    // 틱 기준 상태도 처음으로. 지난 라운드의 슬로모션 비율이 첫 틱에 섞이면 결과가 달라진다
    this._timeScale = 1;
    this._zoomIntensity = null;
    this._rankKeys = new Map();
    this._tick = 0;
    this._startAt = null;
    this._localElapsed = 0;
    this._isRunning = false;
    this._catchingUp = false;
  }

  public getCount() {
    return this._marbles.length;
  }

  public getMaps() {
    return stages.map((stage, index) => {
      return {
        index,
        title: stage.title,
      };
    });
  }

  /** index 는 기본 맵의 인덱스, 다운로드한 맵이면 -1 */
  public getCurrentMap() {
    if (!this._stage) return null;
    return {
      index: stages.indexOf(this._stage),
      title: this._stage.title,
      id: this._mapId,
    };
  }

  public setMap(index: number) {
    if (index < 0 || index > stages.length - 1) {
      throw new Error('Incorrect map number');
    }
    this.setStage(stages[index], `builtin:${index}`);
  }

  public setStage(stage: StageDef, id: string) {
    this._stage = stage;
    this._mapId = id;
    // 이름 문법(가중치·개수)이 보존되도록 구슬 이름이 아니라 마지막 입력을 다시 쓴다
    this.setMarbles(this._names, this._seed);
    this._camera.initializePosition();
  }
}
