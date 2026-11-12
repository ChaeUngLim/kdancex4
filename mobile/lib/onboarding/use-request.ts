/**
 * 화면에서 API 를 한 번 부르는 동안의 상태(진행 중·오류 문구) — T-A5-2(가입·취향 화면 5종).
 *
 * 다섯 화면이 똑같이 「누르면 진행 중 → 성공이면 다음 화면 / 실패면 문구 또는 다른 화면」을 하므로
 * 그 흐름을 한 곳에 모았다. 401 이면 로그인 화면으로, 가입 미완료면 본인확인 화면으로 보낸다.
 */
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { toErrorOutcome } from './errors';

export interface RequestState {
  readonly loading: boolean;
  readonly error: string | null;
  /** 작업을 돌린다. 실패하면 오류 문구를 채우고 null 을, 성공하면 결과를 돌려준다. */
  readonly run: <T>(task: () => Promise<T>) => Promise<T | null>;
  readonly clearError: () => void;
}

export function useRequest(): RequestState {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 화면이 닫힌 뒤 도착한 응답으로 상태를 바꾸지 않기 위한 표시.
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async <T,>(task: () => Promise<T>): Promise<T | null> => {
      setLoading(true);
      setError(null);
      try {
        return await task();
      } catch (caught: unknown) {
        // 화면이 스스로 끊은 요청(AbortController)은 오류가 아니다.
        if (caught instanceof Error && caught.name === 'AbortError') {
          return null;
        }
        const outcome = await toErrorOutcome(caught);
        if (mounted.current) {
          setError(outcome.message);
        }
        if (outcome.kind === 'redirect') {
          router.replace(outcome.to);
        }
        return null;
      } finally {
        if (mounted.current) {
          setLoading(false);
        }
      }
    },
    [router],
  );

  const clearError = useCallback(() => setError(null), []);

  return { loading, error, run, clearError };
}
