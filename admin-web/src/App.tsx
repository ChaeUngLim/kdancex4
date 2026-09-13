import { useEffect, useState } from "react";

function App() {
  const [status, setStatus] = useState<string>("확인 중...");

  useEffect(() => {
    fetch("http://localhost:8000/health")
      .then((res) => res.json())
      .then((data) => setStatus(data.status))
      .catch(() => setStatus("백엔드 연결 실패"));
  }, []);

  return (
    <main>
      <h1>kdance 관리자 콘솔</h1>
      <p>백엔드 상태: {status}</p>
    </main>
  );
}

export default App;
