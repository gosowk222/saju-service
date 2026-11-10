import type { ReactNode } from "react";

/**
 * 스켈레톤: 내용이 오기 전에 같은 모양과 크기의 면으로 자리를 잡아, 내용이 와도 화면이 흔들리지 않게 한다.
 * 면은 칩·비활성 색(gray-100), 그림 자리는 포스터 자리 색(primary-900)이다.
 * 디자인 시스템이 무한 반복 효과를 금지하므로 반짝이는 움직임은 넣지 않는다.
 */
export function SkeletonBlock({ className }: { className: string }) {
  return <span aria-hidden className={`block bg-gray-100 ${className}`} />;
}

/** 스켈레톤 화면을 감싼다. 화면 읽기 프로그램에는 불러오는 중이라고만 알린다. */
export function SkeletonScreen({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div aria-busy="true" className={className}>
      <span className="sr-only">불러오는 중이에요</span>
      {children}
    </div>
  );
}
