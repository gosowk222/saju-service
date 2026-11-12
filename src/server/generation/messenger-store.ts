import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MessengerDraftUnit, MessengerFinalUnit } from "@/domain/reading/two-pass";
import type { StoredMessage } from "@/domain/reading/types";
import { createUnitStore, type SupabaseUnitStore } from "./unit-store";

/**
 * 메신저 2-pass 실행기의 저장소. 단위 저장(초안·최종 단위·실패·호출 기록)은 무진과 같은 공통 저장소를 쓰고,
 * 화면에 보내는 말풍선은 기존 묘묘와 같은 reading_messages에 순서대로 넣는다.
 * - reading_units(초안)는 서버 전용이라 사용자에게 Pass 1 초안이 보이지 않는다.
 * - reading_sections(최종 단위)는 검사를 통과한 Pass 2 결과의 보관 자리다. 순서가 아직 안 된 단위도 여기 저장해 두므로,
 *   요청이 끊기거나 앞 단위가 실패해도 이미 통과한 단위를 다시 만들지 않는다. 화면은 reading_messages만 읽는다.
 */
export interface MessengerStore extends SupabaseUnitStore<MessengerDraftUnit, MessengerFinalUnit> {
  /** 이미 화면에 보낸 말풍선 (순번 순서). */
  loadMessages(readingId: string): Promise<{ readonly seq: number; readonly topicId: string | null; readonly text: string }[]>;
  /**
   * 이 실행이 점유 중일 때만(generation_jobs가 running이고 같은 시도 번호) 말풍선을 넣는다. 같은 순번이 이미 있으면
   * 다른 요청이 이어받아 쓰는 중이므로 false다 (기존 묘묘 생성의 commit과 같은 확인).
   */
  appendMessages(input: { readonly readingId: string; readonly userId: string; readonly attempt: number; readonly messages: readonly StoredMessage[] }): Promise<boolean>;
}

export function createMessengerStore(admin: SupabaseClient): MessengerStore {
  const units = createUnitStore<MessengerDraftUnit, MessengerFinalUnit>(admin);
  return {
    ...units,
    async loadMessages(readingId) {
      const { data, error } = await admin.from("reading_messages").select("seq, topic_id, text").eq("reading_id", readingId).order("seq", { ascending: true });
      if (error) throw new Error("messages_load_failed");
      return ((data ?? []) as { seq: number; topic_id: string | null; text: string }[]).map((row) => ({ seq: row.seq, topicId: row.topic_id, text: row.text }));
    },
    async appendMessages({ readingId, userId, attempt, messages }) {
      const { data: job } = await admin.from("generation_jobs").select("status, attempts").eq("reading_id", readingId).maybeSingle();
      if (!job || job.status !== "running" || job.attempts !== attempt) return false;
      const { error } = await admin.from("reading_messages").insert(
        messages.map((message) => ({
          reading_id: readingId,
          user_id: userId,
          seq: message.seq,
          topic_id: message.topicId,
          kind: message.kind,
          text: message.text,
          refs: message.refs,
        })),
      );
      return !error;
    },
  };
}
