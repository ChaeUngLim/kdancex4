const B=FIND('C29A ·');
T(B,20,400,'요일 · 여러 날 고를 수 있어요',12,'700',C.ink3);
['월','화','수','목','금','토','일'].forEach((d,i)=>{const x=20+i*50,on=(i===1||i===3);R(B,x,424,44,36,on?C.plum:'#ffffff',{r:10,stroke:on?null:C.line,name:'요일:'+d});T(B,x,432,d,13,'700',on?'#ffffff':C.ink2,{w:44,align:'center'});});
return B.id;
