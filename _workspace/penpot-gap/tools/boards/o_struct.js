const res={};
for(const pre of ['O21 ·','O22 ·']){const B=FIND(pre);
 const d=(s,lv)=>({n:s.name.slice(0,26),t:s.type,x:Math.round(s.x-B.x),y:Math.round(s.y-B.y),w:Math.round(s.width),h:Math.round(s.height),flex:!!s.flex,tx:s.type==='text'?s.characters.slice(0,46):undefined,fs:s.type==='text'?s.fontSize:undefined,fw:s.type==='text'?s.fontWeight:undefined,fill:(s.fills&&s.fills[0]&&s.fills[0].fillColor)||undefined,c:lv<3?(s.children||[]).map(k=>d(k,lv+1)):(s.children||[]).length});
 res[pre]={id:B.id,w:B.width,h:B.height,flex:!!B.flex,kids:B.children.map(k=>d(k,0))};}
return res;
