const B=FIND('C29A ·');
const ROW=(y,label,items)=>{T(B,20,y,label,12,'700',C.ink3);let x=20,yy=y+24;items.forEach(([s,on])=>{const w=tw(s,12)+20;if(x+w>370){x=20;yy+=32;}CHIP(B,x,yy,s,on?C.plum:'#ffffff',on?'#ffffff':C.ink2);x+=w+8;});return yy+32;};
let y=ROW(480,'시간',[['오전',false],['오후',false],['저녁 18~22시',true],['밤 22시 뒤',false]]);
y=ROW(y+12,'레벨',[['입문',true],['초급',false],['중급',false],['고급',false]]);
T(B,20,y+16,'고른 조건은 이 검색에만 써요. 가입 때 고른 관심 장르 · 지역 · 시간대는 바뀌지 않아요.',11,'500',C.ink3,{w:350});
BTN(B,20,778,'수업 18개 보기','primary',{w:350,h:54,r:18,fs:15});
return B.id;
