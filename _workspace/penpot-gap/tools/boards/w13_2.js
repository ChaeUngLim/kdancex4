const B=FIND('W13 ·');
const TABS=['원장','강사별 매출','주문 · 결제','강사 지급','지급 보류','정산 명세','이의 제기'],ON='정산 명세';
R(B,268,112,980,40,'#ffffff',{r:12,stroke:C.line,name:'정산 탭'});let x=280;
TABS.forEach(t=>{const w=tw(t,13)+28;if(t===ON)R(B,x,118,w,28,C.plum,{r:9});T(B,x,123,t,13,'700',t===ON?'#ffffff':C.ink2,{w,align:'center'});x+=w+6;});
CARD(B,268,168,600,640,{r:16});
BTN(B,292,188,'‹','ghost',{w:34,h:34});T(B,340,190,'2026년 11월분',18,'800');BTN(B,488,188,'›','ghost',{w:34,h:34});
CHIP(B,700,193,'12/5 (토) 지급 예정',C.plumL,C.plum,11);
R(B,292,240,552,1,C.line);
return B.id;
