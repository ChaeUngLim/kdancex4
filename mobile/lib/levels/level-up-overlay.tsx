/**
 * 홈 위에 덮는 등급 연출(보드 M25 → M25B → M25C → 토스트) — S6-3.10(앱 등급 알림·카드 받기·카드 공개 연출).
 *   요구: spec FR-169e 「앱을 열었을 때 받지 않은 카드가 있으면 홈 위에 어두운 막을 덮고 연출을 보여 준다」
 *   API(계약 14 §5): GET /api/me/levels(차례 읽기) · POST /api/me/level-offers/{id}/accept|decline(M25B 답) ·
 *                    POST /api/me/level-cards/{id}/reveal(연출을 봤다고 적기)
 *
 * 흐름(한 차례씩):
 *   카드(reveal) — 등급 알림 → (누름) 카드 공개 → 확인 = reveal 기록 → 「모음에 추가됨」 토스트 → 다음 차례
 *   안내(offer) — 등급 알림 → (누름) 카드 받기 선택
 *                  예 → accept → 새 카드를 levels 에서 다시 읽어 카드 공개 → 확인 = reveal → 토스트
 *                  아니오 → decline → 「지금 레벨 N 그대로예요」 토스트
 * 모든 다음 단계는 사용자가 누른 이벤트 처리기 안에서 바로 정한다(효과 훅으로 상태 변화를 지켜보지 않는다).
 * 토스트만 시간이 지나면 닫히는데, 그 시계도 토스트를 띄우는 처리기 안에서 건다.
 */
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ApiError, apiFetch } from '../api';
import { useApiResource } from '../catalog/use-api-resource';
import { alertText, buildLevelUpQueue, cardFace, chooseText, keptToast, type MeLevels, type PendingReveal } from './level-up-flow';
import { AlertScene, ChooseScene, LevelToast, RevealScene } from './level-up-scenes';

/** 토스트가 떠 있는 시간 */
const TOAST_MS = 3000;
const DIM = 'rgba(20,18,22,0.82)'; // 보드 「#141216 80%」 막

type Scene =
  | { name: 'alert' }
  | { name: 'choose' }
  | { name: 'reveal'; card: PendingReveal }
  | { name: 'toast'; text: string; characterKey: string | null };

const FAIL = '저장하지 못했어요. 잠시 뒤 다시 눌러 주세요.';

export function LevelUpOverlay() {
  // 앱을 열어 홈이 처음 그려질 때 한 번 읽는다. 읽지 못하면 연출 없이 홈만 보인다(연출이 홈을 막으면 안 된다)
  const { state } = useApiResource<MeLevels>('/api/me/levels');
  const [index, setIndex] = useState(0);
  const [scene, setScene] = useState<Scene>({ name: 'alert' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (state.status !== 'ready') return null;
  // 차례는 렌더 중에 계산한다 — 처음 읽은 응답 기준. 처리한 만큼 index 가 앞으로 간다
  const queue = buildLevelUpQueue(state.data);
  const step = queue[index];
  if (step === undefined) return null;

  const goNext = () => {
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    toastTimer.current = null;
    setError(null);
    setScene({ name: 'alert' });
    setIndex((i) => i + 1);
  };

  const showToast = (text: string, characterKey: string | null) => {
    setBusy(false);
    setError(null);
    setScene({ name: 'toast', text, characterKey });
    toastTimer.current = setTimeout(goNext, TOAST_MS);
  };

  // M25 을 누름 — 강사 안내면 받을지 묻고(M25B), 이미 발급된 카드면 바로 공개(M25C). 본인 레벨업은 묻지 않는다
  const onAlertNext = () => {
    setScene(step.kind === 'offer' ? { name: 'choose' } : { name: 'reveal', card: step.card });
  };

  // M25B 「예, 받을게요」 — 승급 → 새 카드를 levels 에서 다시 읽어(그림 열쇠·발급일이 거기 있다) 공개로 간다
  const onYes = async () => {
    if (step.kind !== 'offer') return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ level: number; card: { cardId: string; level: number } | null }>(
        `/api/me/level-offers/${encodeURIComponent(step.offer.offerId)}/accept`,
        { method: 'POST' },
      );
      if (res.card === null) {
        // 그사이 출석으로 이미 그 레벨 이상이 됐다 — 새 카드 없이 안내만 닫혔다
        showToast(keptToast(res.level), null);
        return;
      }
      const issued = res.card;
      const fresh = await apiFetch<MeLevels>('/api/me/levels');
      const card = fresh.pendingReveal.find((c) => c.cardId === issued.cardId);
      setBusy(false);
      if (card === undefined) showToast('카드 모음에 들어갔어요', null);
      else setScene({ name: 'reveal', card });
    } catch (e: unknown) {
      handleAnswerError(e);
    }
  };

  // M25B 「아니오」 — 레벨·카드는 그대로. 「지금 레벨 N 그대로예요」
  const onNo = async () => {
    if (step.kind !== 'offer') return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ level: number }>(`/api/me/level-offers/${encodeURIComponent(step.offer.offerId)}/decline`, {
        method: 'POST',
      });
      showToast(keptToast(res.level), null);
    } catch (e: unknown) {
      handleAnswerError(e);
    }
  };

  // 이미 답한 안내(다른 기기에서 눌렀거나 강사가 새로 보냄)는 409 — 막지 않고 다음 차례로 넘어간다
  const handleAnswerError = (e: unknown) => {
    if (e instanceof ApiError && e.status === 409) {
      showToast('이미 답한 안내예요', null);
      return;
    }
    setBusy(false);
    setError(e instanceof ApiError && e.status !== 0 ? e.detail : FAIL);
  };

  // M25C 「확인」 — 봤다고 적어야 다음에 앱을 열 때 같은 연출이 다시 뜨지 않는다. 적은 뒤 「모음에 추가됨」 토스트
  const onConfirm = async (card: PendingReveal) => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/me/level-cards/${encodeURIComponent(card.cardId)}/reveal`, { method: 'POST' });
      const face = cardFace(card);
      showToast(face.toastLine, face.characterKey);
    } catch (e: unknown) {
      setBusy(false);
      setError(e instanceof ApiError && e.status !== 0 ? e.detail : FAIL);
    }
  };

  // 장면마다 key 를 달리 줘서 움직임 값이 새로 만들어지게 한다(같은 장면 종류가 다음 차례에 다시 와도 처음부터)
  const key = `${index}-${scene.name}`;
  if (scene.name === 'toast') {
    return (
      <View style={styles.layer} pointerEvents="box-none">
        <LevelToast key={key} text={scene.text} characterKey={scene.characterKey} onDone={goNext} />
      </View>
    );
  }
  return (
    <View style={[styles.layer, styles.dim]}>
      {scene.name === 'alert' && <AlertScene key={key} text={alertText(step)} onNext={onAlertNext} />}
      {scene.name === 'choose' && step.kind === 'offer' && (
        <ChooseScene
          key={key}
          text={chooseText(step.offer, step.fromLevel)}
          busy={busy}
          error={error}
          onNo={() => void onNo()}
          onYes={() => void onYes()}
        />
      )}
      {scene.name === 'reveal' && (
        <RevealScene key={key} face={cardFace(scene.card)} busy={busy} error={error} onConfirm={() => void onConfirm(scene.card)} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 20 },
  dim: { backgroundColor: DIM },
});
