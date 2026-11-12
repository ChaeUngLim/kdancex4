const ICON={pay:C.plumL,warn:C.warnL,info:'#e6ecf6',sel:C.sel};
// 알림 한 줄 — 제목·설명 줄 수에 맞춰 높이를 계산한다
function ITEM(B,y,kind,tag,title,desc,act,time,unread){
 const bg=unread?R(B,20,y,350,10,'#fbf8f3'):null;
 R(B,34,y+14,40,40,ICON[kind],{r:12});T(B,34,y+25,tag,10,'800',kind==='warn'?C.warn:C.plum,{w:40,align:'center'});
 let cy=y+12;const t1=T(B,86,cy,title,14,'800',C.ink,{w:222});cy+=t1.height+2;
 const t2=T(B,86,cy,desc,12,'500',C.ink2,{w:222});cy+=t2.height+6;
 if(act){T(B,86,cy,act,12,'800',C.plum);cy+=24;}
 T(B,316,y+14,time,11,'500',C.ink3,{w:38,align:'right'});
 const h=Math.max(68,cy-y+8);if(bg)bg.resize(350,h);
 R(B,20,y+h,350,1,'#efeae3');return h+1;}
