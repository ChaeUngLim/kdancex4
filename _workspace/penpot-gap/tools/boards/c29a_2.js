const B=FIND('C29A ·');
const ROW=(y,label,items)=>{T(B,20,y,label,12,'700',C.ink3);let x=20,yy=y+24;items.forEach(([s,on])=>{const w=tw(s,12)+20;if(x+w>370){x=20;yy+=32;}CHIP(B,x,yy,s,on?C.plum:'#ffffff',on?'#ffffff':C.ink2);x+=w+8;});return yy+32;};
let y=ROW(244,'장르 · 관심 장르에서',[['살사',true],['바차타',true],['쌈바',false],['스윙',false]]);
y=ROW(y+12,'지역',[['강남구',true],['서초구',false],['+ 지역 추가',false]]);
return B.id;
