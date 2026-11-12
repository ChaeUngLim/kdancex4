const B=FIND('W9 ·');
let cx=268;[['후보 2',true],['다시 볼 것 1',false],['승인됨 6',false]].forEach(([s,on])=>{cx+=CHIP(B,cx,120,s,on?C.plum:'#ffffff',on?'#ffffff':C.ink2,12)+8;});
CARD(B,268,160,480,648,{r:16});
const Q=[['주차할 곳이 있나요?','최근 30일 문의 6번 · 후보','후보',C.plumL,C.plum,true],
['첫 수업에 신발은 뭘 신어요?','최근 30일 문의 4번 · 후보','후보',C.plumL,C.plum,false],
['환불은 언제 들어와요?','11/10 환불 공지가 바뀌어 다시 봐야 해요','다시 볼 것',C.warnL,C.warn,false],
['입문반은 언제 열려요?','승인 10/2 · 다시 볼 날 2027-04-02','승인됨','#ffffff',C.ink2,false]];
Q.forEach(([t,s,st,f,col,sel],i)=>{const y=176+i*84;if(sel)R(B,280,y,456,76,C.sel,{r:12,stroke:C.selLine,name:'선택한 질문'});else R(B,292,y-4,432,1,C.line);
 T(B,296,y+12,t,14,'700');T(B,296,y+38,s,12,'500',i===2?C.warn:C.ink3,{w:300});CHIP(B,724-tw(st,11)-20,y+12,st,f,col,11);});
T(B,292,528,'학원에 관한 답은 대표가, 앱 · 약관에 관한 답은 운영자가 승인해요.',11,'500',C.ink3,{w:432});
return B.id;
