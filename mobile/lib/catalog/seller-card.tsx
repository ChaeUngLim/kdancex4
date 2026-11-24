/**
 * 판매자 정보 카드 — 이 수업을 실제로 파는 학원(FR-248(사업자 정보 표시)). 앱(K-DanceX4)은 중개자라
 * 판매 당사자를 결제 전에 분명히 보여야 한다. 값은 서버 `seller` 6항목 그대로다(계약 02 §2).
 *
 * 수업 상세(M8)와 결제 화면(M9 「판매자 정보 ›」)이 같은 카드를 쓰도록 수업 상세 파일에서 옮겨 왔다.
 */
import { StyleSheet, Text, View } from 'react-native';

import { colors, font, space } from '../theme';
import type { SellerInfo } from './types';
import { Card, SectionTitle } from './ui';

/** 사업자등록번호 10자리 → 「123-45-67890」. 모양이 다르면 받은 그대로 둔다 */
export function formatBusinessNumber(raw: string): string {
  return /^\d{10}$/.test(raw) ? `${raw.slice(0, 3)}-${raw.slice(3, 5)}-${raw.slice(5)}` : raw;
}

export function SellerCard({ seller }: { seller: SellerInfo | undefined }) {
  if (seller === undefined) {
    return null;
  }
  const rows: readonly [string, string][] = [
    ['상호', seller.businessName],
    ['대표자', seller.representativeName],
    ['사업자등록번호', formatBusinessNumber(seller.businessRegistrationNumber)],
    ['통신판매업 신고', seller.mailOrderReportNumber ?? '신고 전'],
    ['주소', seller.businessAddress],
    ['전화', seller.phone],
  ];
  return (
    <Card>
      <SectionTitle>판매자 정보</SectionTitle>
      {rows.map(([label, value]) => (
        <View key={label} style={styles.sellerRow} accessible accessibilityLabel={`${label} ${value}`}>
          <Text style={styles.sellerLabel}>{label}</Text>
          <Text style={styles.sellerValue}>{value}</Text>
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  sellerRow: { flexDirection: 'row', gap: space.md },
  sellerLabel: { width: 96, fontSize: font.small, color: colors.ink3 },
  sellerValue: { flex: 1, fontSize: font.small, color: colors.ink },
});
