// 다듬기 1 — 탭이 없어야 하는 화면의 하단 탭 지우기, 탭 첫 화면의 뒤로 버튼 지우기, W8 을 이전 안으로
const out=[];const roots=penpot.currentPage.root.children.filter(s=>s.type==='board');
const find=p=>roots.find(s=>s.name.startsWith(p)&&!s.name.includes('이전 안'));
for(const p of ['C14A ·','C14B ·','C20B ·']){const B=find(p);if(!B){out.push([p,'없음']);continue;}
  const tb=B.children.find(c=>c.name.startsWith('tabbar'));if(tb){tb.remove();out.push([p,'탭 지움']);}else out.push([p,'탭 없음']);}
for(const p of ['I19 ·','I19B ·','O23 ·','O24 ·','O25 ·']){const B=find(p);if(!B){out.push([p,'없음']);continue;}
  const walk=(s,acc)=>{for(const c of (s.children||[])){if(c.name==='back')acc.push(c);else if(c.type==='text'&&c.characters==='‹')acc.push(c);else walk(c,acc);}return acc;};
  const bs=walk(B,[]);for(const b of bs)b.remove();out.push([p,'뒤로 '+bs.length]);}
const W=find('W8 ·');
if(W){let x=5320;const y=34054;while(roots.some(r=>r.id!==W.id&&r.x<x+1280&&r.x+r.width>x&&r.y<y+900&&r.y+r.height>y))x+=1330;
  W.x=x;W.y=y;W.name='W8 · (이전 안 · 2026-11-10 폐기 — W8B 로 대체) 노쇼 회차 정산 기준 고르기';out.push(['W8','이전 안으로',x]);}
return out;
