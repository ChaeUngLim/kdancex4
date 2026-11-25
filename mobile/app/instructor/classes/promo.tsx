/**
 * 홍보 이미지 · 소개 문구(보드 I32 · I32B · I32C · I32D · I41 · I42 · I43) — SX-6.9(앱 홍보 이미지·소개 문구 화면).
 * 주소 `/instructor/classes/promo?classId=…`. 수업 만들기 2/2 에서 「다음」을 누르면 임시 저장한 뒤 여기로 온다.
 *
 * 이 파일은 「불러오기」만 한다. 셋이 다 오면 PromoFlow(lib/instructor/promo-flow.tsx)가 처음 값을 한 번 정해 그린다.
 *   1. GET /api/classes/{classId}                       수업 데이터(이미지 위 글자 · 소개 문구 「그대로 가져온 값」)
 *   2. GET /api/ai/promo-image/options?classId=…         칩 · 예시 · 자동 조건 · 엔진 카드 · 남은 횟수 · 마지막 생성
 *   3. GET /api/classes/{classId}/promo-assets           저장해 둔 표지 · 소개 문구
 *   4. GET /api/files/{fileId}                           (1~3 이 온 뒤) 표지 사진을 data URI 로 — 안드로이드 <Image> 가 토큰 헤더를
 *      싣지 않아 401 이 나던 문제(2026-11-25) 때문에 사진도 보통 API 요청으로 미리 받는다. 못 받으면 사진 없이 연다
 */
import { router, useLocalSearchParams } from 'expo-router';

import { EmptyView, LoadingView } from '../../../lib/catalog/ui';
import { readRouteId, useApiResource } from '../../../lib/catalog/use-api-resource';
import { classPath, type ClassRegistration } from '../../../lib/instructor/class-api';
import { WideButton } from '../../../lib/instructor/promo-ui';
import { promoAssetsPath, promoOptionsPath, type PromoAssets, type PromoOptions } from '../../../lib/instructor/promo-api';
import { initialCoverPath } from '../../../lib/instructor/promo-cover';
import { apiFetchImageDataUri } from '../../../lib/api';
import { PromoFlow } from '../../../lib/instructor/promo-flow';
import { goBack, InstructorShell, StaffErrorView } from '../../../lib/instructor/staff-ui';

export default function PromoScreen() {
  const params = useLocalSearchParams<{ classId?: string }>();
  // 주소로 받은 id 는 검사한 뒤에만 쓴다(딥링크 값은 믿지 않는다)
  const classId = readRouteId(params.classId);
  const cls = useApiResource<ClassRegistration>(classId === null ? null : classPath(classId));
  const options = useApiResource<PromoOptions>(classId === null ? null : promoOptionsPath(classId));
  const assets = useApiResource<PromoAssets>(classId === null ? null : promoAssetsPath(classId));
  // 렌더 중 계산: 옵션·표지 정보가 다 오면 받아 둘 표지 사진 주소(없으면 null → 부르지 않음)
  const coverPath = options.state.status === 'ready' && assets.state.status === 'ready' ? initialCoverPath(options.state.data, assets.state.data) : null;
  const cover = useApiResource<string>(coverPath, undefined, apiFetchImageDataUri);
  const back = () => goBack('/instructor/classes/new');

  if (classId === null) {
    return (
      <InstructorShell title="홍보 이미지 · 소개 문구" active="classes" onBack={back}>
        <EmptyView title="수업 주소가 올바르지 않아요" />
      </InstructorShell>
    );
  }
  const failed = [cls, options, assets].find((r) => r.state.status === 'error');
  if (failed !== undefined && failed.state.status === 'error') {
    return (
      <InstructorShell title="홍보 이미지 · 소개 문구" active="classes" onBack={back}>
        <StaffErrorView error={failed.state.error} onRetry={failed.reload} />
      </InstructorShell>
    );
  }
  // 표지 사진은 다 받거나(ready) 못 받을(error) 때까지만 기다린다 — 사진이 없어도 화면은 열린다
  const coverWaiting = coverPath !== null && cover.state.status === 'loading';
  if (cls.state.status !== 'ready' || options.state.status !== 'ready' || assets.state.status !== 'ready' || coverWaiting) {
    return (
      <InstructorShell title="홍보 이미지 · 소개 문구" active="classes" onBack={back}>
        <LoadingView label="홍보 이미지 만들 준비를 하고 있어요" />
      </InstructorShell>
    );
  }
  // 임시 저장일 때만 이 단계를 거친다 — 승인 중·공개된 수업은 등록한 수업(I2S)으로
  if (cls.state.data.status !== 'draft') {
    const id = cls.state.data.classId;
    return (
      <InstructorShell title="홍보 이미지 · 소개 문구" active="classes" onBack={back}>
        <EmptyView title="이미 등록한 수업이에요" />
        <WideButton label="등록한 수업 보기" onPress={() => router.replace(`/instructor/classes/${id}`)} />
      </InstructorShell>
    );
  }
  const coverSrc = cover.state.status === 'ready' ? cover.state.data : null;
  return <PromoFlow cls={cls.state.data} options={options.state.data} assets={assets.state.data} initialCoverSrc={coverSrc} />;
}
