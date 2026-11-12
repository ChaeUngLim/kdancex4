// 정원 조절 — − + 버튼 사이의 숫자를 직접 입력칸으로 (I2D·I2E)
const out=[];
for(const p of ['I2D ·','I2E ·']){const B=FIND(p);if(!B){out.push([p,'없음']);continue;}
  let n=0;
  for(const t of [...B.children]){if(t.type!=='text')continue;const c=t.characters||'';const x=Math.round(t.x-B.x),y=Math.round(t.y-B.y);
    if(/^\d+$/.test(c)&&y>=120&&y<=140){t.remove();R(B,x-4,y-5,40,34,C.input,{r:9,stroke:C.selLine,sw:1.5,name:'input:정원'});T(B,x-4,y,c,15,'800',C.ink,{w:40,align:'center'});n++;}
    else if(c==='정원 · 남·여 따로'){t.remove();T(B,x,y,'정원 · 남·여 따로 · 숫자를 눌러 직접 넣어도 돼요',12,'700',C.ink3);}}
  out.push([p,'입력칸 '+n]);}
penpot.selection=[];penpot.viewport.zoomIntoView([FIND('I2D ·'),FIND('I2E ·')]);
return out;
