/**
 * GET 한 건을 불러오는 훅 — 로딩·오류·완료 세 상태를 화면에 넘긴다.
 *
 * 서버 캐시 라이브러리(TanStack Query 등)를 들이지 않은 이유: 새 패키지를 설치하지 않는다는
 * 이 Task(T-A5-3(홈·상세·결제 대기·캘린더 화면 + 취소 화면 이전))의 원칙. 필요한 것은
 * 「불러오기 · 다시 불러오기 · 화면을 떠나면 요청 취소」뿐이라 이 정도로 충분하다.
 *
 * 화면이 다시 보일 때(다른 화면에서 돌아왔을 때) 새로 읽고 싶으면 `useFocusEffect` 에서
 * `reload()` 를 부른다.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, apiFetch } from '../api';

export type ResourceState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: ApiError }
  | { status: 'ready'; data: T };

export interface ApiResource<T> {
  state: ResourceState<T>;
  /** 다시 불러온다. 이미 데이터가 있으면 로딩 화면으로 바꾸지 않고 뒤에서 갈아 끼운다. */
  reload: () => void;
}

/** 알 수 없는 예외를 화면이 다룰 수 있는 `ApiError` 로 맞춘다. 내부 문자열은 보여 주지 않는다. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  return new ApiError(0, 'UNEXPECTED_RESPONSE', '알 수 없는 오류가 났어요. 잠시 뒤 다시 시도해 주세요.');
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * @param path 부를 경로. null 이면 부르지 않는다(주소 인자가 잘못된 경우 등).
 * @param postBody 주면 GET 대신 이 본문으로 POST 한다. 「쓰지 않는 미리 보기」(release-preview 처럼 POST 로
 *   읽는 경로) 전용이다 — 무언가를 만드는 POST 는 이 훅이 아니라 버튼 핸들러에서 부른다.
 */
export function useApiResource<T>(path: string | null, postBody?: unknown): ApiResource<T> {
  const [state, setState] = useState<ResourceState<T>>({ status: 'loading' });
  const [version, setVersion] = useState(0);
  // 마지막으로 데이터를 받은 경로. 경로가 바뀌면 이전 데이터는 다른 자원이므로 로딩부터 보인다.
  const loadedPath = useRef<string | null>(null);
  // 본문은 렌더마다 새 객체라 글자로 바꿔 비교한다 — 같은 본문이면 다시 부르지 않는다
  const bodyKey = postBody === undefined ? null : JSON.stringify(postBody);

  useEffect(() => {
    if (path === null) {
      return undefined;
    }
    const controller = new AbortController();
    if (loadedPath.current !== path) {
      setState({ status: 'loading' });
    }
    const request = bodyKey === null ? { signal: controller.signal } : { method: 'POST' as const, body: JSON.parse(bodyKey) as unknown, signal: controller.signal };
    apiFetch<T>(path, request)
      .then((data) => {
        loadedPath.current = path;
        setState({ status: 'ready', data });
      })
      .catch((error: unknown) => {
        if (!isAbort(error)) {
          setState({ status: 'error', error: toApiError(error) });
        }
      });
    return () => controller.abort();
  }, [path, version, bodyKey]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { state, reload };
}

/**
 * 라우트 인자(`[id]`) 검사. 딥링크로 들어온 값은 믿지 않는다 —
 * 비었거나 경로를 깨는 문자가 있으면 null. 통과한 값도 `encodeURIComponent` 로 넣는다.
 */
export function readRouteId(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || raw.length > 100 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    return null;
  }
  return raw;
}

/**
 * `Idempotency-Key`(README §5(멱등 규칙), 8~200자). 회원 범위에서만 겹치지 않으면 되므로
 * 암호학적 난수까지는 필요 없다. `crypto.randomUUID` 가 모든 기기 런타임에 있다는 보장이 없어
 * 시각 + 난수로 만든다.
 */
export function newIdempotencyKey(): string {
  const random = Math.random().toString(36).slice(2, 12);
  return `m-${Date.now().toString(36)}-${random}`;
}
