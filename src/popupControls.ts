// 결과 팝업의 닫기 버튼. 원래 광고 오버레이 모듈에 있던 그리기 도우미만 남겼다.
import type { Rect } from './types/rect.type';

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function closeButtonSize(h: number): number {
  return clamp(h * 0.045, 20, 34);
}

/**
 * 원형 닫기 버튼(동그라미 + X)을 중심 좌표에 그리고 히트 영역을 돌려준다.
 * 기본 채움은 반투명이다. 무언가에 걸쳐놓을 때는 뒤가 비치므로 불투명한 색을 넘겨야 한다.
 */
export function drawCloseCircle(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  fill: string = 'rgba(0, 0, 0, 0.5)'
): Rect {
  const arm = size * 0.22;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.lineWidth = Math.max(1.5, size * 0.07);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - arm, cy - arm);
  ctx.lineTo(cx + arm, cy + arm);
  ctx.moveTo(cx + arm, cy - arm);
  ctx.lineTo(cx - arm, cy + arm);
  ctx.stroke();
  ctx.restore();

  return { x: cx - size / 2, y: cy - size / 2, w: size, h: size };
}
