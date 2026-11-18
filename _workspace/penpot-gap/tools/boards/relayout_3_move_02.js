// 재배치 3/4 (2026-11-13): 보드를 역할 기둥의 흐름별 줄로 옮긴다 — 위치만 바꾸고 내용·클릭 연결은 그대로다. 묶음 2
const live=penpot.root.children.filter(b=>b.type==='board'&&!b.name.includes('이전 안')&&!b.name.includes('폐기'));
const miss=[]; let n=0;
for (const [k,x,y] of [["C4A", 1760, 15326], ["C4B", 2200, 15326], ["C5A", 2640, 15326], ["C7A", 3080, 15326], ["C9B", 3520, 15326], ["C33A", 3960, 15326], ["C3A", 0, 16454], ["C3B", 440, 16454], ["C3C", 880, 16454], ["C18A", 1320, 16454], ["C24B", 0, 17582], ["C26A", 440, 17582], ["C4C", 880, 17582], ["C15D", 1320, 17582], ["C15A", 0, 18710], ["C15B", 440, 18710], ["C15C", 880, 18710], ["C9A", 1320, 18710]]) { const b=live.find(s=>s.name.startsWith(k+' ·')); if(!b){miss.push(k);continue;} b.x=x; b.y=y; n++; }
return n+'장'+(miss.length?' · 없음 '+miss.join(','):'');
