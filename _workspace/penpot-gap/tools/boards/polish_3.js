// 다듬기 3 — W10 상태 칩의 빠진 글자, W11 강사 몫 칸의 접힌 글
const out=[];
let B=FIND('W10 ·');
const ST=[['부분 환불',C.ink2],['결제완료',C.plum],['만료',C.ink3],['환불',C.ink2]];
ST.forEach(([st,col],i)=>{const y=518+i*64;const w=tw(st,11)+20;T(B,768,y+22,st,11,'700',col,{w,align:'center'});});out.push('W10 칩 글자 4');
B=FIND('W11 ·');let n=0;
for(const t of [...B.children]){if(t.type==='text'&&t.characters==='정한 비율'){const x=Math.round(t.x-B.x),y=Math.round(t.y-B.y);t.remove();T(B,x,y,'정한 비율',12,'600',C.ink2);n++;}}
out.push('W11 다시 그림 '+n);
return out;
