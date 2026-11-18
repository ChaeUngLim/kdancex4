// 재배치 1/4 (2026-11-13): 강사 구역의 기존 블록(제목·소제목·보드 설명·보드)을 통째로 강사 기둥으로 옮긴다. 서로의 상대 위치는 그대로다.
const DX=6200, DY=-13067; let n=0;
for (const s of penpot.root.children) { if (s.x>=-50 && s.x<=2700 && s.y>=13060 && s.y<21240) { s.x+=DX; s.y+=DY; n++; } }
return '옮긴 도형 '+n;
