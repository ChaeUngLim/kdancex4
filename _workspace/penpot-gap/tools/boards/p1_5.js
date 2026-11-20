const B=FIND('P1 ·');
const base=736;
for(let d=1;d<=30;d++){const dow=(d-1)%7;const v=1.5+0.6*Math.sin(d*0.8)+((dow===0||dow===6)?0.55:0);const h=Math.round(v*80);R(B,338+(d-1)*30.4,base-h,20,h,C.plum,{r:4,name:'막대 '+d+'일'});}
// 직전 달 일평균(1,430,000원) 점선
R(B,336,base-Math.round(1.43*80),892,1,C.warn,{dash:true,stroke:C.warn,name:'10월 일평균'});
T(B,1100,base-Math.round(1.43*80)-20,'10월 일평균 143만',11,'700',C.warn,{w:128,align:'right'});
return B.id;
