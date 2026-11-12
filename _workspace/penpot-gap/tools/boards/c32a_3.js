const B=FIND('C32A ·');
const ROW=(i,[n,ac,d,seat,ch])=>{const y=206+i*52;if(i)R(B,36,y,318,1,C.line);T(B,36,y+8,String(i+1),16,"800",C.plum,{w:26,align:"center"});T(B,64,y+5,n,13,"700");T(B,230,y+7,seat,11,"700",seat.startsWith("마감")?C.warn:C.ink2,{w:124,align:"right"});const tw0=tw(ac,11)+12;R(B,64,y+27,tw0,18,C.sel,{r:6,stroke:C.selLine,name:"tag:1+1 참여학원"});T(B,70,y+27,ac,11,"600",C.ink2);T(B,64+tw0+8,y+28,d,11,"500",C.ink3);T(B,310,y+28,ch,11,"700",ch==="NEW"?C.plum:C.ink3,{w:44,align:"right"});};
[['살사 LA 초급','엘 리트모 신촌','12/6 (일) 17:00 개강','잔여 남 2 · 여 4','▲ 3'],['바차타 풋워크','살사홀릭 강남','12/2 (수) 21:00 개강','잔여 남 5 · 여 3','▼ 2'],['살사 레이디 스타일','댄스랩 서초','12/4 (금) 19:00 개강','잔여 여 4','—'],['바차타 소셜 입문','라틴스텝 강남','12/5 (토) 18:00 개강','잔여 남 1 · 여 1','▲ 4']].forEach((r,i)=>ROW(i+6,r));
T(B,20,740,'6시간마다 갱신',11,'500',C.ink3);
T(B,230,739,'1+1 참여학원 12곳 ›',12,'700',C.plum,{w:140,align:'right'});
return B.id;
