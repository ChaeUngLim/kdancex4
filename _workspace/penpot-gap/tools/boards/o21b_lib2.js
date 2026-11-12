// 알림 한 줄(줄 수를 글의 \n 으로 직접 정한다 — 높이 추정이 어긋나 줄 간격이 들쭉날쭉하던 것을 고침)
function ITEM2(B,y,kind,tag,title,desc,act,time,unread){
 const nl=s=>s.split('\n').length;
 let cy=y+12;const th=nl(title)*21,dh=nl(desc)*18;
 let h=12+th+2+dh+(act?6+18:0)+12;h=Math.max(68,h);
 if(unread)R(B,20,y,350,h,'#fbf8f3');
 R(B,34,y+14,40,40,ICON[kind],{r:12});T(B,34,y+25,tag,10,'800',kind==='warn'?C.warn:C.plum,{w:40,align:'center'});
 T(B,86,cy,title,14,'800',C.ink,{w:226});cy+=th+2;
 T(B,86,cy,desc,12,'500',C.ink2,{w:226});cy+=dh+6;
 if(act)T(B,86,cy,act,12,'800',C.plum);
 T(B,316,y+14,time,11,'500',C.ink3,{w:38,align:'right'});
 R(B,20,y+h,350,1,'#efeae3');return h+1;}
