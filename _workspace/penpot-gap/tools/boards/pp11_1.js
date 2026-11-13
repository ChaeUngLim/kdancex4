// W2a 입점 조건 동의: 「1+1 할인권 참여 조건」 → 「1+1 할인권 안내 확인」(체크만 필수, 참여는 대표 선택)
const B=penpot.currentPage.getShapeById('01d157ae-65ea-80a4-8008-eafbedd2364c');
const at=(x,y)=>B.children.filter(s=>Math.round(s.x-B.x)===x&&Math.round(s.y-B.y)===y);
[...at(798,416),...at(798,438),...at(1138,416),...at(1142,417)].forEach(s=>s.remove());
T(B,798,414,'1+1 할인권 안내 확인',14,'700');
T(B,798,436,'참여는 선택이에요 · 입점 뒤 1+1 화면에서 골라요',11,'500',C.ink3,{w:372});
T(B,798,453,'참여하면 실시간 인기 순위·검색 노출, 신규 회원 유도 이벤트 혜택',11,'500',C.ink3,{w:372});
R(B,1110,416,62,20,'#efeae3',{r:10});
T(B,1110,417,'확인 필수',11,'700','#4e4853',{w:62,align:'center'});
return B.id;
