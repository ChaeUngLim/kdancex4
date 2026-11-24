/**
 * 강사 회차 화면(I6B · I13 · I14) 공용 부품 — S2-3.8(앱 변경·대타·공지 화면).
 *
 *  - `useSessionContext`: 주소의 classId·sessionId 로 수업 상세와 회차 목록을 읽어 「그 회차 하나」를 돌려준다.
 *    효과 훅을 새로 쓰지 않고 공용 `useApiResource` 두 개를 렌더 중에 합친다
 *  - `SessionGate`: 읽는 중·오류·없는 회차를 한 곳에서 그린다. 다 읽었으면 children(그 회차)을 그린다
 *  - `SessionCard`: 「11/18 (수) 20:30–21:30 · 쌈바(입문)」 + 「라틴하우스 강남 A홀 · 수강생 남 4 · 여 6」 카드(보드 I14 · I14B)
 *  - `Notice`: 옅은 바탕 안내 상자(보드 I14 「이 회차의 정산은 실제로 수업한 강사 몫으로 잡혀요」)
 */
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { ApiError } from '../api';
import { EmptyView, LoadingView } from '../catalog/ui';
import { readRouteId, useApiResource } from '../catalog/use-api-resource';
import { classPath, type ClassRegistration } from './class-api';
import { sessionsPath, sessionWhen, type ClassSession } from './session-api';
import { StaffErrorView } from './staff-ui';
import { colors, font, radius, space } from '../theme';

export interface SessionContext {
  cls: ClassRegistration;
  session: ClassSession;
}

type ContextState =
  | { status: 'bad-route' }
  | { status: 'loading' }
  | { status: 'error'; error: ApiError; retry: () => void }
  | { status: 'missing' }
  | { status: 'ready'; data: SessionContext; reload: () => void };

/** 주소 값 두 개를 검사하고, 수업 상세 + 회차 목록을 읽어 그 회차를 찾는다(렌더 중 계산) */
export function useSessionContext(rawClassId: string | string[] | undefined, rawSessionId: string | string[] | undefined): ContextState {
  const classId = readRouteId(rawClassId);
  const sessionId = readRouteId(rawSessionId);
  const ok = classId !== null && sessionId !== null;
  const cls = useApiResource<ClassRegistration>(ok ? classPath(classId) : null);
  const sessions = useApiResource<{ items: ClassSession[] }>(ok ? sessionsPath(classId) : null);
  if (!ok) return { status: 'bad-route' };
  if (cls.state.status === 'error') return { status: 'error', error: cls.state.error, retry: cls.reload };
  if (sessions.state.status === 'error') return { status: 'error', error: sessions.state.error, retry: sessions.reload };
  if (cls.state.status === 'loading' || sessions.state.status === 'loading') return { status: 'loading' };
  const session = sessions.state.data.items.find((item) => item.sessionId === sessionId);
  if (session === undefined) return { status: 'missing' };
  const reload = () => {
    cls.reload();
    sessions.reload();
  };
  return { status: 'ready', data: { cls: cls.state.data, session }, reload };
}

/** 회차를 다 읽기 전의 상태를 그린다. 다 읽었으면 children 에 그 회차를 넘긴다 */
export function SessionGate({ state, children }: { state: ContextState; children: (ctx: SessionContext, reload: () => void) => ReactNode }) {
  if (state.status === 'bad-route') return <EmptyView title="회차 주소가 올바르지 않아요" />;
  if (state.status === 'missing') return <EmptyView title="이 회차를 찾지 못했어요" hint="수업 일정이 바뀌었을 수 있어요. 캘린더에서 다시 열어 주세요." />;
  if (state.status === 'error') return <StaffErrorView error={state.error} onRetry={state.retry} />;
  if (state.status === 'loading') return <LoadingView label="회차를 불러오고 있어요" />;
  return <>{children(state.data, state.reload)}</>;
}

/** 회차 요약 카드(보드 I14 · I14B · I14C 의 머리 카드) */
export function SessionCard({ title, startsAt, endsAt, sub }: { title: string; startsAt: string; endsAt: string; sub: string }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{`${sessionWhen(startsAt, endsAt)} · ${title}`}</Text>
      <Text style={styles.cardSub}>{sub}</Text>
    </View>
  );
}

/** 옅은 바탕 안내 상자. tone=accent 는 정산 안내 같은 강조, muted 는 일반 */
export function Notice({ children, tone = 'accent' }: { children: string; tone?: 'accent' | 'muted' }) {
  return (
    <View style={[styles.notice, tone === 'muted' && styles.noticeMuted]}>
      <Text style={[styles.noticeText, tone === 'muted' && styles.noticeTextMuted]}>{children}</Text>
    </View>
  );
}

export const sessionStyles = StyleSheet.create({
  caption: { color: colors.ink3, fontSize: font.small, fontWeight: '700' },
  hint: { color: colors.ink3, fontSize: font.small, lineHeight: 18 },
  sectionTitle: { color: colors.ink, fontSize: 16, fontWeight: '800' },
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.lg,
    gap: 4,
  },
  cardTitle: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  cardSub: { color: colors.ink3, fontSize: font.small },
  notice: { backgroundColor: colors.brownSoft, borderRadius: radius.md, padding: space.md },
  noticeMuted: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  noticeText: { color: colors.brown, fontSize: font.small, fontWeight: '700', lineHeight: 18 },
  noticeTextMuted: { color: colors.ink, fontWeight: '400' },
});
