const B=FIND('C4B ·');
CARD(B,20,284,350,256,{r:16});
const M=[['김서연 (나) · 여',true],['박지민 · 여',true],['한지우 · 여',true],['이수아 · 여',true],['정해준 · 남',true],['최도윤 · 남',true],['오민재 · 남',false]];
M.forEach(([n,on],i)=>{const y=286+i*36;if(i)R(B,36,y,318,1,C.line);T(B,36,y+8,n,13,on?'700':'500',on?C.ink:C.ink3);CHECK(B,332,y+7,on);});
return B.children.length;
