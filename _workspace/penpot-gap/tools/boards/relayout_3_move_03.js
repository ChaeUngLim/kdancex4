// 재배치 3/4 (2026-11-13): 보드를 역할 기둥의 흐름별 줄로 옮긴다 — 위치만 바꾸고 내용·클릭 연결은 그대로다. 묶음 3
const live=penpot.root.children.filter(b=>b.type==='board'&&!b.name.includes('이전 안')&&!b.name.includes('폐기'));
const miss=[]; let n=0;
for (const [k,x,y] of [["C25A", 1760, 18710], ["C32C", 2200, 18710], ["C27A", 2640, 18710], ["C8A", 0, 19838], ["C8B", 440, 19838], ["C16A", 880, 19838], ["C16B", 1320, 19838], ["C28A", 1760, 19838], ["C24A", 2200, 19838], ["C1A", 0, 20966], ["C22A", 440, 20966], ["C2A", 880, 20966], ["C2B", 1320, 20966], ["C30A", 1760, 20966], ["C11A", 2200, 20966], ["C19B", 2640, 20966], ["C10A", 0, 22094], ["C10B", 440, 22094]]) { const b=live.find(s=>s.name.startsWith(k+' ·')); if(!b){miss.push(k);continue;} b.x=x; b.y=y; n++; }
return n+'장'+(miss.length?' · 없음 '+miss.join(','):'');
