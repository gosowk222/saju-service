import Image from "next/image";
import type { ImageAsset } from "@/domain/images";

/**
 * 그림의 정사각 영역(image.square)만 작은 정사각·원형 칸에 채운다. 칸의 크기와 모양은 className이 정한다.
 * square가 없으면 그림 전체를 가운데 기준으로 칸에 맞춘다.
 * displayPx는 화면에 보이는 칸의 한 변이며, Next가 알맞은 크기의 파일을 고르는 데만 쓴다.
 */
export function SquareArt({ image, displayPx, className = "" }: { image: ImageAsset; displayPx: number; className?: string }) {
  const crop = image.square;
  if (!crop) {
    return (
      <span className={`relative block shrink-0 overflow-hidden ${className}`}>
        <Image src={image.src} alt={image.alt} fill sizes={`${displayPx}px`} className="object-cover" />
      </span>
    );
  }
  // 영역의 한 변이 칸의 한 변이 되도록 그림을 키우고, 영역의 왼쪽 위가 칸의 왼쪽 위에 오도록 옮긴다.
  const scale = 1 / crop.size;
  const ratio = image.height / image.width;
  return (
    <span className={`relative block shrink-0 overflow-hidden ${className}`}>
      <Image
        src={image.src}
        alt={image.alt}
        width={image.width}
        height={image.height}
        sizes={`${Math.ceil(displayPx * scale)}px`}
        className="absolute max-w-none"
        style={{
          width: `${scale * 100}%`,
          height: "auto",
          left: `${-crop.x * scale * 100}%`,
          top: `${-crop.y * ratio * scale * 100}%`,
        }}
      />
    </span>
  );
}
