// 재배치 3/4 (2026-11-13): 보드를 역할 기둥의 흐름별 줄로 옮긴다 — 위치만 바꾸고 내용·클릭 연결은 그대로다. 묶음 1
const live=penpot.root.children.filter(b=>b.type==='board'&&!b.name.includes('이전 안')&&!b.name.includes('폐기'));
const miss=[]; let n=0;
for (const [k,x,y] of [["C14A", 0, 13070], ["C14B", 440, 13070], ["C6A", 880, 13070], ["C6B", 1320, 13070], ["C19A", 1760, 13070], ["C21A", 2200, 13070], ["C29A", 0, 14198], ["C22B", 440, 14198], ["C31A", 880, 14198], ["C32A", 1320, 14198], ["C32B", 1760, 14198], ["M10F", 2200, 14198], ["M10G", 2640, 14198], ["C23A", 3080, 14198], ["C13A", 0, 15326], ["C13B", 440, 15326], ["C17A", 880, 15326], ["C17B", 1320, 15326]]) { const b=live.find(s=>s.name.startsWith(k+' ·')); if(!b){miss.push(k);continue;} b.x=x; b.y=y; n++; }
return n+'장'+(miss.length?' · 없음 '+miss.join(','):'');
