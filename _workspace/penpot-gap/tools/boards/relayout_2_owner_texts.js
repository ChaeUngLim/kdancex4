// 재배치 2/4 (2026-11-13): 대표·관리자 웹의 기존 보드 설명 글을 새 자리로 옮기고, 이전 안(OA1~OA4)을 보관 구역으로 보내고, 번호가 바뀌는 옛 제목 5개를 지운다.
const P=penpot.root.children; const out=[];
const tx=pre=>P.find(s=>s.type==='text'&&(s.characters||'').startsWith(pre));
for (const [pre,x,y] of [["O2 포스터로", 21260, 6305], ["O3 환불 요청 처리", 18600, 11397], ["O4 정산 · 원장", 18600, 12477], ["O5P 대표 휴대폰", 12400, 129], ["O5 대표 앱 수업 승인", 12840, 129], ["O6 대표 앱 홈", 13280, 129], ["O1 대시보드", 6650, 35148], ["03-3 대표 앱 · 조회 전용", 0, 36170], ["06 · 대표 앱 (390×844)", 0, 36206], ["OA1 요약", 0, 36249], ["OA2 강사", 440, 36249], ["OA3 회원", 880, 36249], ["OA4 정산", 1320, 36249]]) { const t=tx(pre); if(!t){out.push('없음:'+pre);continue;} t.x=x; t.y=y; }
[1,2,3,4].forEach((n,i)=>{ const b=P.find(s=>s.type==='board'&&s.name.includes('OA'+n+' ·')); if(!b){out.push('없음:OA'+n);return;} b.x=i*440; b.y=36300; });
for (const pre of ['03 · 대표 콘솔','대시보드 → 포스터 등록 → 환불 처리','03-1 대표 콘솔 (웹)','03-2 대표 앱 ·','03-4 대표 앱 ·']) { const t=tx(pre); if(!t){out.push('없음:'+pre);continue;} t.remove(); }
return out.length?out.join(' / '):'끝';
