/**
 * 정원 좌석 칸 — 홈 카드(보드 M7)와 수업 상세(M8·C13A)가 함께 쓴다.
 *
 * 한 줄 막대 대신 「자리 수만큼 칸」을 그린다(spec 변경 이력 2026-10-05 「정원 표시를 남·여 좌석 칸으로」).
 *  - 남녀 정원(gender_split): 왼쪽 남 · 오른쪽 여 두 덩어리. 찬 칸은 남·여 색, 위에 「남 5/6」·「여 6/6 · 마감」
 *  - 단일 정원(single): 정원 수만큼 한 줄, 찬 칸은 플럼. 「9/12 · 3자리 남았어요」(FR-092c(성별 구분 없는 단일 정원), 보드 C13A)
 *
 * 숫자는 서버가 준 값만 쓴다 — 신청 인원(enrolled)은 확정 수만 센 값이다(S3-2.3(수업 상세 API)).
 * 색만으로 마감을 알리지 않도록 언제나 글자(「마감」·「n자리 남았어요」)를 함께 둔다.
 */
import { StyleSheet, Text, View } from 'react-native';

import { colors, font, radius, space } from '../theme';
import type { SeatKind, SeatPool } from './types';

/** 칸이 너무 많으면 한 칸이 선처럼 가늘어진다 — 그 이상은 비율로 줄여 그린다(숫자 글자는 그대로) */
const MAX_CELLS = 30;

const FILL_COLOR: Readonly<Record<SeatKind, string>> = {
  male: colors.seatMale,
  female: colors.seatFemale,
  any: colors.brown,
};

const POOL_NAME: Readonly<Record<SeatKind, string>> = { male: '남', female: '여', any: '정원' };

/** 정원·신청 수를 그릴 칸 수로 줄인다. 정원이 MAX_CELLS 이하면 그대로다 */
function cellCounts(pool: SeatPool): { cells: number; filled: number } {
  if (pool.capacity <= MAX_CELLS) {
    return { cells: pool.capacity, filled: Math.min(pool.enrolled, pool.capacity) };
  }
  return { cells: MAX_CELLS, filled: Math.round((Math.min(pool.enrolled, pool.capacity) / pool.capacity) * MAX_CELLS) };
}

/** 칸 한 줄. 왼쪽부터 찬 칸, 나머지는 빈 칸 */
function Cells({ pool, size }: { pool: SeatPool; size: 'small' | 'large' }) {
  const { cells, filled } = cellCounts(pool);
  const fill = FILL_COLOR[pool.seatKind] ?? colors.brown;
  return (
    <View style={styles.cells}>
      {Array.from({ length: cells }, (_, index) => (
        <View
          key={index}
          style={[size === 'large' ? styles.cellLarge : styles.cellSmall, { backgroundColor: index < filled ? fill : colors.line }]}
        />
      ))}
    </View>
  );
}

/** 「남 5/6」 · 「여 6/6 · 마감」 */
function poolCountText(pool: SeatPool): string {
  const base = `${POOL_NAME[pool.seatKind] ?? pool.seatKind} ${pool.enrolled}/${pool.capacity}`;
  return pool.remaining <= 0 ? `${base} · 마감` : base;
}

/** 단일 정원 문구 — 「9/12 · 3자리 남았어요」 또는 「12/12 · 마감됐어요」 */
export function singleRemainText(pool: SeatPool): string {
  const count = `${pool.enrolled}/${pool.capacity}`;
  return pool.remaining <= 0 ? `${count} · 마감됐어요` : `${count} · ${pool.remaining}자리 남았어요`;
}

export interface SeatGridProps {
  pools: readonly SeatPool[];
  /** small = 홈 카드, large = 수업 상세 */
  size?: 'small' | 'large';
}

/** 자리 묶음을 칸으로 그린다. 남녀 정원은 두 덩어리를 나란히, 단일 정원은 한 줄 */
export function SeatGrid({ pools, size = 'small' }: SeatGridProps) {
  if (pools.length === 0) {
    return null;
  }
  const single = pools.length === 1 && pools[0]?.seatKind === 'any';
  if (single && pools[0] !== undefined) {
    const pool = pools[0];
    return (
      <View style={styles.block} accessible accessibilityLabel={`정원 ${pool.capacity}명 중 ${pool.enrolled}명 신청, ${singleRemainText(pool)}`}>
        <Text style={[styles.count, size === 'large' && styles.countLarge, pool.remaining <= 0 && styles.closed]}>
          {singleRemainText(pool)}
        </Text>
        <Cells pool={pool} size={size} />
      </View>
    );
  }
  return (
    <View style={styles.split}>
      {pools.map((pool) => (
        <View key={pool.seatKind} style={styles.half} accessible accessibilityLabel={poolCountText(pool)}>
          <Text style={[styles.count, size === 'large' && styles.countLarge, pool.remaining <= 0 && styles.closed]}>
            {poolCountText(pool)}
          </Text>
          <Cells pool={pool} size={size} />
        </View>
      ))}
    </View>
  );
}

/** 「남녀 구분 없음」 칩 — 단일 정원 수업의 정원 옆에 단다(보드 C13A) */
export function NoGenderChip() {
  return <Text style={styles.chip}>남녀 구분 없음</Text>;
}

const styles = StyleSheet.create({
  block: { gap: space.xs },
  split: { flexDirection: 'row', gap: space.md },
  half: { flex: 1, gap: space.xs },
  cells: { flexDirection: 'row', gap: 3 },
  cellSmall: { flex: 1, height: 8, borderRadius: 2 },
  cellLarge: { flex: 1, height: 18, borderRadius: 4 },
  count: { fontSize: font.small, fontWeight: '700', color: colors.ink },
  countLarge: { fontSize: font.body },
  closed: { color: colors.seatFemale },
  chip: {
    alignSelf: 'flex-start',
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.brownSoft,
    color: colors.brown,
    fontSize: font.small,
    fontWeight: '700',
    overflow: 'hidden',
  },
});
