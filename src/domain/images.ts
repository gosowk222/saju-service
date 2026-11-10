/**
 * public/ 아래에 둔 정적 그림. 화면은 이 값으로 next/image를 그린다 (크기별 변환과 WebP는 Next가 맡는다).
 * width·height는 원본 픽셀 크기다. 화면에서 비율을 지키고, 그림이 오기 전에 자리를 미리 잡는 데 쓴다.
 */
export interface ImageAsset {
  readonly src: string;
  readonly width: number;
  readonly height: number;
  /** 화면 읽기 프로그램이 읽을 설명. 바로 옆에 같은 내용의 글자가 있는 장식용 그림이면 빈 문자열로 둔다. */
  readonly alt: string;
  /**
   * 작은 정사각·원형 칸에 넣을 때 보여 줄 영역. x는 원본 너비, y는 원본 높이에 대한 왼쪽 위 위치의 비율이고,
   * size는 원본 너비에 대한 한 변의 비율이다. 없으면 그림 전체를 칸에 맞춘다.
   */
  readonly square?: { readonly x: number; readonly y: number; readonly size: number };
}
