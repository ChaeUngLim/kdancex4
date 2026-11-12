const B=FIND('O22 ·');
const tb=B.children.find(c=>c.name.startsWith('tabbar'));
const ADD=72;const top=Math.round(tb.y-B.y); // 687
B.resize(390,Math.round(B.height)+ADD);
tb.y=tb.y+ADD;
R(B,20,top-14,350,58,'#ffffff',{r:16,stroke:C.line,name:'card · 운영자에게 문의'});
T(B,36,top-6,'앱이나 결제 시스템에 문제가 있나요?',13,'700');
T(B,36,top+16,'계정·앱 오류·결제 장애는 운영자가 답해요',11,'500',C.ink3);
T(B,256,top+5,'운영자에게 문의 ›',12,'800',C.plum,{w:100,align:'right'});
penpot.selection=[];penpot.viewport.zoomIntoView([FIND('O21 ·'),FIND('O21B ·'),B]);
return [top,B.height,Math.round(tb.y-B.y)];
