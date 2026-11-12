const B=FIND('I6B');
const d=(s,lv)=>({n:s.name.slice(0,28),t:s.type,x:Math.round(s.x-B.x),y:Math.round(s.y-B.y),w:Math.round(s.width),h:Math.round(s.height),flex:!!s.flex,tx:s.type==='text'?s.characters.slice(0,44):undefined,fs:s.type==='text'?s.fontSize+'/'+s.fontWeight:undefined,fill:(s.fills&&s.fills[0]&&s.fills[0].fillColor)||undefined,st:(s.strokes&&s.strokes[0]&&s.strokes[0].strokeColor)||undefined,r:s.borderRadius,c:lv<3?(s.children||[]).map(k=>d(k,lv+1)):(s.children||[]).length});
return {name:B.name,x:B.x,y:B.y,w:B.width,h:B.height,flex:!!B.flex,kids:B.children.map(k=>d(k,0))};
