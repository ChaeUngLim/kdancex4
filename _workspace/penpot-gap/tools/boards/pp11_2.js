// O35 동의 기록: 같은 항목 이름을 맞춘다
const B=penpot.currentPage.getShapeById('332f2c70-6946-807b-8008-eda2389b01b9');
const at=(x,y)=>B.children.filter(s=>s.type==='text'&&Math.round(s.x-B.x)===x&&Math.round(s.y-B.y)===y);
[...at(36,530),...at(36,552)].forEach(s=>s.remove());
T(B,36,530,'1+1 할인권 안내 확인',13,'700');
T(B,36,552,'2026-10-01 10:31 확인 · 참여는 대표 선택',11,'500',C.ink3,{w:290});
return B.id;
