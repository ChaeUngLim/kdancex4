const B=FIND('W12 ·');
const TABS=['원장','강사별 매출','주문 · 결제','강사 지급','지급 보류','정산 명세','이의 제기'],ON='지급 보류';
R(B,268,112,980,40,'#ffffff',{r:12,stroke:C.line,name:'정산 탭'});let x=280;
TABS.forEach(t=>{const w=tw(t,13)+28;if(t===ON)R(B,x,118,w,28,C.plum,{r:9});T(B,x,123,t,13,'700',t===ON?'#ffffff':C.ink2,{w,align:'center'});x+=w+6;});
const K=[['카드 이의제기','90,000원','1건 · 소명 기한 12/14 (월)',C.warn],['지급 실패','126,000원','1건 · 강사 지급 반송',C.ink],['환불 요청 처리 중','70,000원','1건 · 처리하면 풀려요',C.ink]];
K.forEach(([k,v,s,col],i)=>{const x0=268+i*200;CARD(B,x0,168,188,92,{r:14});T(B,x0+16,180,k,12,'600',C.ink3);T(B,x0+16,200,v,18,'800',col);T(B,x0+16,232,s,11,'500',C.ink3);});
return B.id;
