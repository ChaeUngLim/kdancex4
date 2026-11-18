// 방금 그린 M10F 한 장만 지운다 — 강사 프로필(M15)의 수업 데이터와 맞춰 다시 그리기 위해 (2026-11-13)
const b=penpot.currentPage.root.children.filter(s=>s.type==='board'&&s.name.startsWith('M10F ·'));
if(b.length!==1) return '지우지 않음: M10F '+b.length+'장';
b[0].remove(); return 'M10F 지움';
