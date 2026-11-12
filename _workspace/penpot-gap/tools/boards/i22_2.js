const B=FIND('I22 ·');
function STEP(y,label,hint,val,minOff,plusOff){T(B,20,y+2,label,14,'700');T(B,20,y+24,hint,11,'500',minOff||plusOff?C.warn:C.ink3,{w:160});
 R(B,190,y,40,36,'#ffffff',{r:10,stroke:C.line,name:'btn:−'});T(B,190,y+6,'−',16,'800',minOff?'#cfc8c0':C.ink,{w:40,align:'center'});
 R(B,238,y,64,36,C.input,{r:10,stroke:C.line,name:'input:숫자'});T(B,238,y+7,String(val),15,'800',C.ink,{w:64,align:'center'});
 R(B,310,y,40,36,'#ffffff',{r:10,stroke:C.line,name:'btn:+'});T(B,310,y+6,'+',16,'800',plusOff?'#cfc8c0':C.ink,{w:40,align:'center'});}
STEP(346,'남','9 아래로는 못 줄여요',10,false,false);
STEP(394,'여','이미 10명이 신청했어요',10,true,false);
T(B,20,450,'현장 등록',13,'800');
T(B,20,472,'현장·전화로 받은 인원만 넣어요. 앱으로 결제한 수강생은 여기서 빠지지 않아요.',11,'500',C.ink3,{w:350});
STEP(514,'남','최대 2명',1,false,false);
STEP(562,'여','자리가 없어요',0,true,true);
R(B,20,618,350,96,C.plumL,{r:12,name:'box · 현장 안내'});
T(B,34,628,'현장에서 받은 돈은 앱 정산에 들어가지 않아요',12,'800',C.plum,{w:322});
T(B,34,652,'현장 인원을 빼면 그 성별 대기 1번에게 알려요. 누가 언제 바꿨는지 기록돼 대표도 봐요.',11,'500',C.ink2,{w:322});
BTN(B,20,778,'저장','primary',{w:350,h:54,r:18,fs:15});
return B.children.length;
