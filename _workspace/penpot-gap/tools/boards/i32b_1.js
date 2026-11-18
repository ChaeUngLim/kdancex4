// I32B — 홍보 이미지 1단계 「만들기」: 필수 4항목 칩으로 문장을 채운다 (spec FR-061a 2026-11-13 개정). 1/2: 단계·장르·누가·분위기
const B=PAGE('I32B · 홍보 이미지 · 만들기 (필수 4항목 칩 누가·분위기·장소·색감 · 고르면 문장이 채워짐 · 빠지면 만들기 잠김 · 장르는 수업에서 · 자동으로 더해지는 조건은 보여 주고 끌 수 있음)',5280,'홍보 이미지 만들기');
const S=['1 만들기','2 검토·고치기','3 등록'];let x=20;
S.forEach((s,i)=>{const w=tw(s,11)+18;R(B,x,88,w,26,i===0?C.plum:'#ffffff',{r:13,stroke:i===0?null:C.line});T(B,x,93,s,11,'700',i===0?'#ffffff':C.ink3,{w,align:'center'});x+=w;if(i<2){T(B,x+3,92,'›',12,'700',C.ink3);x+=14;}});
T(B,20,130,'장르',12,'700',C.ink3);
CHIP(B,62,126,'쌈바 · 수업에서 가져왔어요',C.sel,C.ink2,11);
const ROW=(y,label,items,on)=>{T(B,20,y,label,12,'700',C.ink3);let cx=20;items.forEach(s=>{cx+=CHIP(B,cx,y+20,s,s===on?C.plum:'#ffffff',s===on?'#ffffff':C.ink2,11)+4;});};
ROW(162,'누가 · 필수',['커플','단체','솔로'],'커플');
ROW(216,'분위기 · 필수',['열정적인','우아한','경쾌한','로맨틱한','편안한'],'열정적인');
return B.id;
