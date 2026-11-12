"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { SquareArt } from "@/components/ui/art";
import { Badge } from "@/components/ui/layout";
import type { PersonaFace } from "@/domain/personas";
import type { SceneMode } from "./scroll-model";

/**
 * 상담 장면. 사용자가 무진의 책상 맞은편에 앉아 바라보는 자리를 화면 맨 위에 둔다.
 *
 * 지금은 임시 장면이다. B01 상담 장면 그림과 B02~B04 반복 영상이 아직 없어서, 캐릭터 설정화의 얼굴 크롭(캐릭터 설정의 avatar)을
 * 밤 인디고 면 위에 두고 무진의 말풍선과 책상 위 종이로 장면을 대신한다 (docs/implementation/mujin/00_START_HERE.md 결정 14).
 * 최종 아트가 아니다.
 *
 * 영상을 받으면 SCENE_VIDEOS에 상태별 파일을 넣는다. 영상은 소리 없이 화면 안에서 재생하고(muted, playsInline),
 * 재생 전과 실패했을 때, 움직임을 줄이는 설정, 숨긴 탭에서는 정지 그림을 보여 준다.
 * public에 영상을 두면 src/proxy.ts의 matcher에서 영상 확장자를 빼야 한다 (화면 담당 밖).
 */

export interface SceneVideo {
  readonly src: string;
  readonly type: "video/webm" | "video/mp4";
  /** 재생 전·실패 때 보여 줄 정지 그림 (같은 구도의 첫 장면). */
  readonly poster: string;
}

/** B02 대기(idle), B03 계산(computing), B04 집필(writing). 받기 전까지 비워 둔다. */
const SCENE_VIDEOS: Partial<Readonly<Record<SceneMode, SceneVideo>>> = {};

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/** 움직임을 줄이는 설정이 꺼져 있고 탭이 보일 때만 영상을 돌린다. 서버 렌더와 첫 화면에서는 정지 그림을 쓴다. */
function useMotionAllowed(): boolean {
  const reduced = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => true,
  );
  const hidden = useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === "hidden",
    () => true,
  );
  return !reduced && !hidden;
}

/** 정지 그림. 얼굴 크롭이 없으면 이름 글자를 큰 칸에 쓴다. 바로 옆에 이름이 있어 장식용이다. */
function SceneStill({ face }: { face: PersonaFace }) {
  if (face.avatar) {
    return <SquareArt image={face.avatar} displayPx={120} className="h-11 w-11 rounded-lg bg-primary-100" />;
  }
  return (
    <span aria-hidden className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary-100 font-serif type-h1 text-primary-700">
      {face.avatarGlyph}
    </span>
  );
}

/** 영상 자리. 영상이 없거나 재생할 수 없으면 정지 그림이다. 영상 오류가 나면 이 화면에서는 다시 시도하지 않는다. */
function SceneMedia({ face, mode }: { face: PersonaFace; mode: SceneMode }) {
  const video = SCENE_VIDEOS[mode];
  const motionAllowed = useMotionAllowed();
  const [failed, setFailed] = useState<string | null>(null);
  if (!video || !motionAllowed || failed === video.src) return <SceneStill face={face} />;
  return (
    <video
      key={video.src}
      className="aspect-video w-full rounded-lg bg-primary-900 object-cover"
      muted
      playsInline
      autoPlay
      loop
      preload="metadata"
      poster={video.poster}
      aria-hidden
      onError={() => setFailed(video.src)}
    >
      <source src={video.src} type={video.type} />
    </video>
  );
}

/**
 * 상담 장면과 무진의 말. line이 바뀌면 화면 읽기 프로그램에 알린다(aria-live). 상태 표시(badge)는 자주 바뀌므로 알리지 않는다.
 * paper: 책상 위 종이. resting은 놓여 있는 종이, lifting은 족자로 펼쳐지는 순간(globals.css의 paper-lift), null은 없음.
 * onPaperLifted: 종이가 다 펼쳐져 사라진 뒤 부른다 (화면이 종이 자리를 치운다).
 */
export function ConsultScene({
  face,
  name,
  mode,
  line,
  badge = null,
  paper = null,
  onPaperLifted,
  children,
}: {
  face: PersonaFace;
  name: string;
  mode: SceneMode;
  line: string | null;
  badge?: string | null;
  paper?: "resting" | "lifting" | null;
  onPaperLifted?: () => void;
  children?: ReactNode;
}) {
  return (
    <section aria-label="상담 장면" className="flex flex-col gap-4 overflow-hidden rounded-xl bg-primary-900 p-5">
      <div className="flex items-end gap-4">
        <SceneMedia face={face} mode={mode} />
        <div className="flex min-w-0 flex-1 flex-col items-start gap-2 pb-1">
          <p className="type-label font-semibold text-white">{name}</p>
          {badge ? <Badge tone={mode === "reading" ? "neutral" : "progress"}>{badge}</Badge> : null}
        </div>
      </div>
      <div aria-live="polite">
        {line ? (
          <p className="whitespace-pre-line wrap-break-word rounded-b-lg rounded-tr-lg rounded-tl-(--space-2) bg-gray-100 px-4 py-4 type-body text-gray-900">
            {line}
          </p>
        ) : null}
      </div>
      {children}
      {paper ? (
        <div aria-hidden className="flex justify-center border-t border-gray-700 pt-4">
          <span
            className={`block h-7 w-11 origin-bottom rounded-sm bg-white ${paper === "lifting" ? "animate-paper-lift" : ""}`}
            onAnimationEnd={paper === "lifting" ? onPaperLifted : undefined}
          />
        </div>
      ) : null}
    </section>
  );
}
