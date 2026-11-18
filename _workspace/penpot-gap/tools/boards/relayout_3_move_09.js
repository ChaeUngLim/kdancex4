// 재배치 3/4 (2026-11-13): 보드를 역할 기둥의 흐름별 줄로 옮긴다 — 위치만 바꾸고 내용·클릭 연결은 그대로다. 묶음 9
const live=penpot.root.children.filter(b=>b.type==='board'&&!b.name.includes('이전 안')&&!b.name.includes('폐기'));
const miss=[]; let n=0;
for (const [k,x,y] of [["O42", 14600, 6052], ["O8", 12400, 7180], ["W1a", 18600, 197], ["W1b", 19930, 197], ["W1b3", 21260, 197], ["W1b2", 22590, 197], ["W1c", 18600, 1139], ["W2a", 18600, 2171], ["W2b", 19930, 2171], ["W26", 21260, 2171], ["W22", 22590, 2171], ["W29", 18600, 3271], ["W3a", 18600, 4351], ["W3b", 19930, 4351], ["W3b2", 21260, 4351], ["W3c", 22590, 4351], ["W24", 18600, 5325], ["W15", 18600, 6357]]) { const b=live.find(s=>s.name.startsWith(k+' ·')); if(!b){miss.push(k);continue;} b.x=x; b.y=y; n++; }
return n+'장'+(miss.length?' · 없음 '+miss.join(','):'');
