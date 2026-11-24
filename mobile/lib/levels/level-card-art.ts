/**
 * 등급 카드 그림 — 서버가 주는 열쇠(characterKey, 「묶음/성별_단계」)로 앱 안 그림 파일을 고른다.
 * S6-3.8(앱 회원 레벨 카드 화면) · spec FR-169c(레벨 성장 캐릭터) · 계약 14 §5.
 *
 * 그림은 docs/prototype/assets/level-characters/ 의 확정본(6묶음 × 남녀 × 6단계 = 72장)을
 * 가로 480 으로 줄여 assets/level-characters/ 에 넣었다(원본은 장당 최대 680KB 라 앱 크기가 커진다).
 * 열쇠를 만드는 규칙(세부 장르 → 묶음, 레벨 → 단계)은 서버 admin-web/lib/domain/level-card-art.ts 한 곳에만 둔다.
 * 앱은 받은 열쇠를 그대로 찾기만 한다 — 규칙을 두 군데 두면 언젠가 어긋난다.
 *
 * require 를 표로 늘어놓은 까닭: 번들러(Metro)는 글자를 이어 만든 경로를 읽지 못한다. 그림마다 경로가 글자 그대로 있어야 앱에 들어간다.
 */
import type { ImageSourcePropType } from 'react-native';

/* eslint-disable @typescript-eslint/no-require-imports */
const ART: Readonly<Record<string, ImageSourcePropType>> = {
  'samba/m_l01': require('../../assets/level-characters/samba/m_l01.jpg'),
  'samba/m_l23': require('../../assets/level-characters/samba/m_l23.jpg'),
  'samba/m_l45': require('../../assets/level-characters/samba/m_l45.jpg'),
  'samba/m_l67': require('../../assets/level-characters/samba/m_l67.jpg'),
  'samba/m_l89': require('../../assets/level-characters/samba/m_l89.jpg'),
  'samba/m_l10': require('../../assets/level-characters/samba/m_l10.jpg'),
  'samba/f_l01': require('../../assets/level-characters/samba/f_l01.jpg'),
  'samba/f_l23': require('../../assets/level-characters/samba/f_l23.jpg'),
  'samba/f_l45': require('../../assets/level-characters/samba/f_l45.jpg'),
  'samba/f_l67': require('../../assets/level-characters/samba/f_l67.jpg'),
  'samba/f_l89': require('../../assets/level-characters/samba/f_l89.jpg'),
  'samba/f_l10': require('../../assets/level-characters/samba/f_l10.jpg'),
  'viennese/m_l01': require('../../assets/level-characters/viennese/m_l01.jpg'),
  'viennese/m_l23': require('../../assets/level-characters/viennese/m_l23.jpg'),
  'viennese/m_l45': require('../../assets/level-characters/viennese/m_l45.jpg'),
  'viennese/m_l67': require('../../assets/level-characters/viennese/m_l67.jpg'),
  'viennese/m_l89': require('../../assets/level-characters/viennese/m_l89.jpg'),
  'viennese/m_l10': require('../../assets/level-characters/viennese/m_l10.jpg'),
  'viennese/f_l01': require('../../assets/level-characters/viennese/f_l01.jpg'),
  'viennese/f_l23': require('../../assets/level-characters/viennese/f_l23.jpg'),
  'viennese/f_l45': require('../../assets/level-characters/viennese/f_l45.jpg'),
  'viennese/f_l67': require('../../assets/level-characters/viennese/f_l67.jpg'),
  'viennese/f_l89': require('../../assets/level-characters/viennese/f_l89.jpg'),
  'viennese/f_l10': require('../../assets/level-characters/viennese/f_l10.jpg'),
  'tango/m_l01': require('../../assets/level-characters/tango/m_l01.jpg'),
  'tango/m_l23': require('../../assets/level-characters/tango/m_l23.jpg'),
  'tango/m_l45': require('../../assets/level-characters/tango/m_l45.jpg'),
  'tango/m_l67': require('../../assets/level-characters/tango/m_l67.jpg'),
  'tango/m_l89': require('../../assets/level-characters/tango/m_l89.jpg'),
  'tango/m_l10': require('../../assets/level-characters/tango/m_l10.jpg'),
  'tango/f_l01': require('../../assets/level-characters/tango/f_l01.jpg'),
  'tango/f_l23': require('../../assets/level-characters/tango/f_l23.jpg'),
  'tango/f_l45': require('../../assets/level-characters/tango/f_l45.jpg'),
  'tango/f_l67': require('../../assets/level-characters/tango/f_l67.jpg'),
  'tango/f_l89': require('../../assets/level-characters/tango/f_l89.jpg'),
  'tango/f_l10': require('../../assets/level-characters/tango/f_l10.jpg'),
  'swing/m_l01': require('../../assets/level-characters/swing/m_l01.jpg'),
  'swing/m_l23': require('../../assets/level-characters/swing/m_l23.jpg'),
  'swing/m_l45': require('../../assets/level-characters/swing/m_l45.jpg'),
  'swing/m_l67': require('../../assets/level-characters/swing/m_l67.jpg'),
  'swing/m_l89': require('../../assets/level-characters/swing/m_l89.jpg'),
  'swing/m_l10': require('../../assets/level-characters/swing/m_l10.jpg'),
  'swing/f_l01': require('../../assets/level-characters/swing/f_l01.jpg'),
  'swing/f_l23': require('../../assets/level-characters/swing/f_l23.jpg'),
  'swing/f_l45': require('../../assets/level-characters/swing/f_l45.jpg'),
  'swing/f_l67': require('../../assets/level-characters/swing/f_l67.jpg'),
  'swing/f_l89': require('../../assets/level-characters/swing/f_l89.jpg'),
  'swing/f_l10': require('../../assets/level-characters/swing/f_l10.jpg'),
  'salsa/m_l01': require('../../assets/level-characters/salsa/m_l01.jpg'),
  'salsa/m_l23': require('../../assets/level-characters/salsa/m_l23.jpg'),
  'salsa/m_l45': require('../../assets/level-characters/salsa/m_l45.jpg'),
  'salsa/m_l67': require('../../assets/level-characters/salsa/m_l67.jpg'),
  'salsa/m_l89': require('../../assets/level-characters/salsa/m_l89.jpg'),
  'salsa/m_l10': require('../../assets/level-characters/salsa/m_l10.jpg'),
  'salsa/f_l01': require('../../assets/level-characters/salsa/f_l01.jpg'),
  'salsa/f_l23': require('../../assets/level-characters/salsa/f_l23.jpg'),
  'salsa/f_l45': require('../../assets/level-characters/salsa/f_l45.jpg'),
  'salsa/f_l67': require('../../assets/level-characters/salsa/f_l67.jpg'),
  'salsa/f_l89': require('../../assets/level-characters/salsa/f_l89.jpg'),
  'salsa/f_l10': require('../../assets/level-characters/salsa/f_l10.jpg'),
  'bachata/m_l01': require('../../assets/level-characters/bachata/m_l01.jpg'),
  'bachata/m_l23': require('../../assets/level-characters/bachata/m_l23.jpg'),
  'bachata/m_l45': require('../../assets/level-characters/bachata/m_l45.jpg'),
  'bachata/m_l67': require('../../assets/level-characters/bachata/m_l67.jpg'),
  'bachata/m_l89': require('../../assets/level-characters/bachata/m_l89.jpg'),
  'bachata/m_l10': require('../../assets/level-characters/bachata/m_l10.jpg'),
  'bachata/f_l01': require('../../assets/level-characters/bachata/f_l01.jpg'),
  'bachata/f_l23': require('../../assets/level-characters/bachata/f_l23.jpg'),
  'bachata/f_l45': require('../../assets/level-characters/bachata/f_l45.jpg'),
  'bachata/f_l67': require('../../assets/level-characters/bachata/f_l67.jpg'),
  'bachata/f_l89': require('../../assets/level-characters/bachata/f_l89.jpg'),
  'bachata/f_l10': require('../../assets/level-characters/bachata/f_l10.jpg'),
};
/* eslint-enable @typescript-eslint/no-require-imports */

/** 열쇠에 맞는 그림. 모르는 열쇠(서버가 새 묶음을 더했는데 앱이 옛 판)면 null — 화면은 빈 자리로 둔다 */
export function levelCardArt(characterKey: string): ImageSourcePropType | null {
  return ART[characterKey] ?? null;
}
