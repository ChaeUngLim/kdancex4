// 재배치 3/4 (2026-11-13): 보드를 역할 기둥의 흐름별 줄로 옮긴다 — 위치만 바꾸고 내용·클릭 연결은 그대로다. 묶음 11
const live=penpot.root.children.filter(b=>b.type==='board'&&!b.name.includes('이전 안')&&!b.name.includes('폐기'));
const miss=[]; let n=0;
for (const [k,x,y] of [["O4", 18600, 12529], ["W7b", 19930, 12529], ["W11", 21260, 12529], ["W12", 22590, 12529], ["W13", 18600, 13471], ["W14", 19930, 13471], ["W28", 21260, 13471], ["W23", 18600, 14503], ["W30", 19930, 14503]]) { const b=live.find(s=>s.name.startsWith(k+' ·')); if(!b){miss.push(k);continue;} b.x=x; b.y=y; n++; }
return n+'장'+(miss.length?' · 없음 '+miss.join(','):'');
