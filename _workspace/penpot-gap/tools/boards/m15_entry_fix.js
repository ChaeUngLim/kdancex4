// M15 는 자동 배치(flex) 보드라 새 버튼이 맨 아래로 밀렸다 — 버튼과 글자를 고정 위치로 바꿔 수업 목록 아래에 놓는다 (2026-11-13)
const B=penpot.currentPage.root.children.find(s=>s.type==='board'&&s.name.startsWith('M15 ·')&&!s.name.includes('이전 안'));
const r=B.children.find(c=>c.type==='rectangle'&&(c.name||'').startsWith('btn:AI 플래너에게'));
const i=B.children.indexOf(r);const t=B.children.slice(i+1).find(c=>c.type==='text');
if(!r||!t) return '도형을 못 찾음';
r.layoutChild.absolute=true;t.layoutChild.absolute=true;
r.x=B.x+20;r.y=B.y+798;t.x=B.x+20;t.y=B.y+806;
return [Math.round(r.x-B.x),Math.round(r.y-B.y),Math.round(t.x-B.x),Math.round(t.y-B.y),t.characters].join(' ');
