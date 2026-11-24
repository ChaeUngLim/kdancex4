/**
 * 강사 마이 → 소속 학원 · 학원 색(보드 I9E) — S2-1.10. 주소 `/instructor/academy-colors`.
 * 마이(I9)의 「소속 학원 N곳」과 학원 탭(I12) 카드의 「학원 색」에서 들어온다.
 *
 * 맥 Finder 태그처럼 소속 학원마다 색 하나를 고른다(spec 「학원 색은 강사가 고른다」, 2026-10-11).
 * 고른 색은 강사 본인 화면(캘린더 블록·홈 표·필터)에만 쓰이고 학원·회원에게는 보이지 않는다.
 *  - 소속됨(active) 학원만 줄로 보인다. 승인 대기 학원은 색을 바꿀 수 없다(서버도 409)
 *  - 줄의 「색 ▾」를 누르면 12색이 처음부터 모두 무지개 순으로 펼쳐진다(접기는 줄을 한 번 더 누를 때만)
 *  - 색을 누르면 바로 `PUT /api/instructor/affiliations/{id}/color`(11 §3-2) 로 저장한다. 따로 저장 버튼이 없다
 *
 * 처음 상태: 카드의 `calendarColorIndex`(계약 08 §2, 2026-11-21 사용자 결정 — 별도 API 없음)로 지금 고른 색을 그린다.
 *   서버는 승인 때 겹치지 않는 색을 자동으로 붙이므로(S2-1.9) 보통은 처음부터 색이 있다. 아직 없으면(null) 빈 점.
 *
 * 효과 훅 없음: 펼친 줄·이번에 고른 색은 useState, 저장은 색 버튼 핸들러 안에서 한다.
 */
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useApiResource } from '../../lib/catalog/use-api-resource';
import { LoadingView } from '../../lib/catalog/ui';
import { ACADEMY_COLORS, setAffiliationColor } from '../../lib/instructor/affiliation-api';
import type { AffiliationCard } from '../../lib/instructor/staff-api';
import { goBack, InstructorShell, StaffErrorView, staffStyles, useAction } from '../../lib/instructor/staff-ui';
import { colors, font, MIN_TOUCH, radius, space } from '../../lib/theme';

/** 아무 줄도 펼치지 않았다는 표시(처음에는 첫 학원을 펼친다 — 보드 I9E) */
const NONE = '__none__';

export default function InstructorAcademyColorsScreen() {
  const cards = useApiResource<{ items: AffiliationCard[] }>('/api/instructor/affiliations');
  // 펼친 줄의 소속 id. null = 아직 누르지 않음 → 첫 학원을 펼친다
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 이번에 고른 색(소속 id → 색 번호). 저장에 성공한 값만 넣는다 — 서버에서 읽은 카드 색보다 앞선다
  const [chosen, setChosen] = useState<Readonly<Record<string, number>>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const save = useAction();

  const handlePick = async (affiliationId: string, colorIndex: number) => {
    setSavingId(affiliationId);
    const saved = await save.run(() => setAffiliationColor(affiliationId, colorIndex));
    setSavingId(null);
    // 새 객체로 바꿔 끼운다 — 서버가 돌려준 번호를 그대로 쓴다
    if (saved !== null) setChosen((prev) => ({ ...prev, [saved.affiliationId]: saved.colorIndex }));
  };

  let body;
  if (cards.state.status === 'loading') {
    body = <LoadingView label="소속 학원을 불러오고 있어요" />;
  } else if (cards.state.status === 'error') {
    body = <StaffErrorView error={cards.state.error} onRetry={cards.reload} />;
  } else {
    // 렌더 중 계산: 소속됨만 · 펼친 줄(누른 적 없으면 첫 학원)
    const active = cards.state.data.items.filter((card) => card.status === 'active');
    const openId = expandedId ?? active[0]?.affiliationId ?? NONE;
    body = (
      <View style={staffStyles.card}>
        {active.length === 0 && <Text style={staffStyles.muted}>소속이 승인된 학원이 생기면 여기서 학원 색을 골라요.</Text>}
        {active.map((card, index) => (
          <AcademyColorRow
            key={card.affiliationId}
            card={card}
            divided={index > 0}
            open={openId === card.affiliationId}
            // 렌더 중 계산: 이번에 고른 색이 있으면 그것, 없으면 서버 카드에 실린 지금 색
            colorIndex={chosen[card.affiliationId] ?? card.calendarColorIndex ?? null}
            saving={savingId === card.affiliationId}
            onToggle={() => setExpandedId(openId === card.affiliationId ? NONE : card.affiliationId)}
            onPick={(colorIndex) => handlePick(card.affiliationId, colorIndex)}
          />
        ))}
        <Pressable
          style={[styles.applyRow, active.length > 0 && styles.divider]}
          onPress={() => router.push('/instructor/affiliations/apply')}
          accessibilityRole="button"
          accessibilityLabel="학원 소속 신청"
        >
          <Text style={styles.applyText}>+ 학원 소속 신청</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <InstructorShell title="소속 학원 · 학원 색" active="my" onBack={() => goBack('/instructor/my')}>
      {save.error !== null && (
        <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">
          {save.error}
        </Text>
      )}
      {body}
      <Text style={staffStyles.muted}>
        색은 캘린더 블록·홈 표·필터에 똑같이 쓰여요. 결석(진한 빨강)·결제 대기(진한 주황)와 헷갈리지 않게 빨강·주황 쪽은 연한 로즈·코랄만 있어요. 내 화면에만 보여요.
      </Text>
    </InstructorShell>
  );
}

interface RowProps {
  card: AffiliationCard;
  divided: boolean;
  open: boolean;
  /** 지금 색 번호(이번에 고른 색 또는 카드의 calendarColorIndex). 색이 없으면 null */
  colorIndex: number | null;
  saving: boolean;
  onToggle: () => void;
  onPick: (colorIndex: number) => void;
}

function AcademyColorRow({ card, divided, open, colorIndex, saving, onToggle, onPick }: RowProps) {
  const color = colorIndex !== null ? ACADEMY_COLORS[colorIndex] ?? null : null;
  return (
    <View style={divided ? styles.divider : undefined}>
      <Pressable
        style={styles.row}
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={`${card.academyName} 학원 색${color !== null ? ` ${color.label}` : ''}, ${open ? '접기' : '펼치기'}`}
        accessibilityState={{ expanded: open }}
      >
        {/* 학원 점 — 고른 색. 아직 모르면 테두리만 있는 빈 점 */}
        <View style={[styles.dot, color !== null ? { backgroundColor: color.hex } : styles.dotEmpty]} />
        <View style={styles.flex}>
          <Text style={styles.name}>{card.academyName}</Text>
          <Text style={staffStyles.muted}>{saving ? '색을 저장하고 있어요…' : color !== null ? `소속 승인 · ${color.label}` : '소속 승인'}</Text>
        </View>
        <Text style={styles.toggle}>{open ? '색 ▴' : '색 ▾'}</Text>
      </Pressable>
      {open && (
        <View style={styles.palette}>
          <Text style={styles.paletteHead}>이 학원 색</Text>
          <Text style={staffStyles.muted}>{color === null ? '색 12가지 · 무지개 순 · 누르면 바로 저장돼요' : '색 12가지 · 무지개 순'}</Text>
          <View style={styles.grid} accessibilityRole="radiogroup">
            {ACADEMY_COLORS.map((swatch, index) => {
              const on = colorIndex === index;
              return (
                <Pressable
                  key={swatch.key}
                  style={styles.swatch}
                  onPress={() => onPick(index)}
                  disabled={saving}
                  accessibilityRole="radio"
                  accessibilityLabel={swatch.label}
                  accessibilityState={{ checked: on, disabled: saving }}
                  // 웹(react-native-web)은 accessibilityState 의 checked 를 읽어 주지 않아 aria-checked 를 함께 준다 — 화면 읽기 프로그램이 고른 색을 알게
                  aria-checked={on}
                >
                  {/* 고른 색은 검은 테두리 고리로 표시한다 — 색만으로 고름을 말하지 않게 이름도 굵게 */}
                  <View style={[styles.ring, on && styles.ringOn]}>
                    <View style={[styles.circle, { backgroundColor: swatch.hex }]} />
                  </View>
                  <Text style={[styles.swatchLabel, on && styles.swatchLabelOn]}>{swatch.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      )}
    </View>
  );
}

const SWATCH = 30;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: MIN_TOUCH + 8, paddingVertical: space.sm },
  dot: { width: 12, height: 12, borderRadius: 6 },
  dotEmpty: { borderWidth: 1.5, borderColor: colors.ink3 },
  name: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  toggle: { color: colors.ink, fontSize: font.small, fontWeight: '700' },
  palette: { paddingBottom: space.md, gap: space.xs },
  paletteHead: { color: colors.ink3, fontSize: font.small, fontWeight: '700' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: space.md, marginTop: space.sm },
  swatch: { width: '16.66%', alignItems: 'center', gap: 4, minHeight: MIN_TOUCH },
  ring: {
    width: SWATCH + 8,
    height: SWATCH + 8,
    borderRadius: (SWATCH + 8) / 2,
    borderWidth: 2,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringOn: { borderColor: colors.ink },
  circle: { width: SWATCH, height: SWATCH, borderRadius: SWATCH / 2 },
  swatchLabel: { color: colors.ink3, fontSize: font.tiny },
  swatchLabelOn: { color: colors.ink, fontWeight: '800' },
  applyRow: { minHeight: MIN_TOUCH, justifyContent: 'center' },
  applyText: { color: colors.ink, fontSize: font.body, fontWeight: '800' },
  error: { color: colors.danger, fontSize: font.body, lineHeight: 20 },
});
