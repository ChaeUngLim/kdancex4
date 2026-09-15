"use client";

import { useEffect, useState } from "react";
import { API_BASE_URL, fetchHealth } from "../lib/api-client";

export default function DashboardPage() {
  const [status, setStatus] = useState<string>("확인 중...");

  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal)
      .then((data) => setStatus(data.status))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setStatus("백엔드 연결 실패");
      });
    return () => controller.abort();
  }, []);

  return (
    <>
      <p>
        백엔드 상태: {status} <small>({API_BASE_URL})</small>
      </p>
      <section style={{ marginTop: 24 }}>
        <h2>대시보드</h2>
        <p>이번 슬라이스에서는 환불 정책 설정 화면만 제공합니다.</p>
      </section>
    </>
  );
}
