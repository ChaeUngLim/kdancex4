/**
 * 회원 문의 화면(보드 M22) — S7-2.8(앱 문의 화면). 주소 `/my/inquiries`, 마이(M12)의 「고객센터 · 문의」에서 들어온다.
 *
 * 무엇을 읽나(둘 다 화면을 열 때 `useApiResource` 로 한 번):
 *  - `GET /api/me/calendar` — 「내 예약에서 고르기」 목록. 한 예약이 회차마다 여러 줄이라 예약 하나로 묶는다
 *  - `GET /api/inquiries` — 「내 문의」 탭(상태 · 기한을 넘기면 「답변 대기 중」)
 * 보내기는 `InquiryPanel` 의 버튼 핸들러가 `POST /api/inquiries` 로 한다(lib/me/inquiry-ui.tsx).
 *
 * 예약에 없는 학원·수업을 검색해 묻는 칸(보드 M22 「예약에 없을 때 학원·수업 검색」)은 회원용 학원 검색 경로가
 * 아직 없어 이번에는 두지 않았다 — 「추천안·사후 확인」(증거 S7-2.8).
 */
import { DetailScreen, ErrorView } from '../../lib/catalog/ui';
import type { CalendarEntry } from '../../lib/catalog/types';
import { useApiResource } from '../../lib/catalog/use-api-resource';
import { InquiryPanel, type InquiryTarget } from '../../lib/me/inquiry-ui';
import { kstDatePlus, kstDateTimeLabel, MY_INQUIRIES_PATH, type MyInquiryList } from '../../lib/me/inquiries';

// 캘린더 경로는 한 번에 62일까지 — 지난 30일(막 끝난 수업 문의)과 앞으로 31일을 본다
const now = new Date();
const CALENDAR_PATH = `/api/me/calendar?from=${kstDatePlus(now, -30)}&to=${kstDatePlus(now, 31)}`;

/** 회차 줄들을 예약 하나에 한 줄로 묶는다. 다음 회차(가장 이른 시각)를 보조 글자로 쓴다 */
function reservationTargets(entries: readonly CalendarEntry[]): InquiryTarget[] {
  const byReservation = new Map<string, CalendarEntry>();
  for (const entry of entries) {
    if (!byReservation.has(entry.reservationId)) byReservation.set(entry.reservationId, entry);
  }
  return [...byReservation.values()].map((entry) => ({
    key: entry.reservationId,
    title: entry.title,
    sub: `${entry.academyName} · ${kstDateTimeLabel(entry.startsAt)}`,
    academyId: null, // 캘린더 줄에는 학원 id 가 없다 — 보낼 때 수업 상세로 얻는다
    offeringId: entry.offeringId,
    reservationId: entry.reservationId,
    academyName: entry.academyName,
  }));
}

export default function MemberInquiriesScreen() {
  const calendar = useApiResource<{ items: CalendarEntry[] }>(CALENDAR_PATH);
  const inquiries = useApiResource<MyInquiryList>(MY_INQUIRIES_PATH);

  // 로그인이 풀렸거나 가입이 덜 됐으면 둘 다 같은 오류가 난다 — 목록 쪽 오류를 먼저 보인다
  const fatal = inquiries.state.status === 'error' ? inquiries.state.error : null;
  return (
    <DetailScreen title="문의하기" tab="my">
      {fatal !== null ? (
        <ErrorView error={fatal} onRetry={inquiries.reload} />
      ) : (
        <InquiryPanel
          asker="member"
          targets={calendar.state.status === 'ready' ? reservationTargets(calendar.state.data.items) : calendar.state.status === 'error' ? [] : null}
          emptyTargetsText="고를 수 있는 예약이 없어요. 학원·수업 검색은 준비 중이에요 — 앱 이용 문의는 위에서 「앱 이용」을 골라 주세요."
          targetQuestion="내 예약에서 고르기"
          items={inquiries.state.status === 'ready' ? inquiries.state.data.items : null}
          onSent={inquiries.reload}
        />
      )}
    </DetailScreen>
  );
}
