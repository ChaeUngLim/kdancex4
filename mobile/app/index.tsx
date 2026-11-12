/**
 * 진입 화면(`/`) — 앱을 켜면 가장 먼저 열리고, 어디로 보낼지만 정한다(T-A5-2·3 후속(mobile 진입·세션·테마 정리)).
 *
 *  - 저장된 세션 토큰이 없으면 → 로그인(`/login`)
 *  - 토큰이 있으면 `GET /api/me` 로 어디까지 했는지 보고 남은 단계로 보낸다
 *    - 403 `SIGNUP_INCOMPLETE` → 본인확인(`/identity`). 로그인 화면과 같은 규칙이다
 *    - 가입 끝 → 취향 / 기준 장르 / 홈 중 남은 곳(`nextOnboardingRoute`(가입 흐름 다음 화면))
 *  - 그 밖의 오류 → 로그인. 401 이면 `apiFetch` 가 이미 토큰을 지웠다
 *
 * 이동은 expo-router 의 `<Redirect>` 로 한다. 렌더 중에 주소를 바꾸면 기록에 `/` 가 남지 않게 대체된다.
 */
import { Redirect, type Href } from 'expo-router';
import { useEffect, useState } from 'react';

import { ApiError } from '../lib/api';
import { LoadingView } from '../lib/catalog/ui';
import { nextOnboardingRoute } from '../lib/onboarding/flow';
import { fetchMe } from '../lib/onboarding/members-api';
import { getSessionToken } from '../lib/session';

const LOGIN_ROUTE = '/login';

/** 토큰 확인 → 내 정보 확인 → 갈 주소. 실패는 모두 로그인으로 모은다. */
async function resolveEntryRoute(signal: AbortSignal): Promise<Href> {
  const token = await getSessionToken();
  if (!token) {
    return LOGIN_ROUTE;
  }
  try {
    return nextOnboardingRoute(await fetchMe(signal));
  } catch (error: unknown) {
    if (error instanceof ApiError && error.code === 'SIGNUP_INCOMPLETE') {
      return '/identity';
    }
    throw error;
  }
}

export default function EntryScreen() {
  const [target, setTarget] = useState<Href | null>(null);

  useEffect(() => {
    // 화면이 닫히면 요청을 끊고, 늦게 온 결과로 상태를 바꾸지 않는다.
    const controller = new AbortController();
    resolveEntryRoute(controller.signal)
      .then((route) => {
        if (!controller.signal.aborted) {
          setTarget(route);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setTarget(LOGIN_ROUTE);
        }
      });
    return () => controller.abort();
  }, []);

  if (target === null) {
    return <LoadingView label="로그인 상태를 확인하고 있어요" />;
  }
  return <Redirect href={target} />;
}
