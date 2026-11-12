const B=FIND('M9 · 결제');
const d=(s,lv)=>({n:s.name,t:s.type,x:Math.round(s.x-B.x),y:Math.round(s.y-B.y),w:Math.round(s.width),h:Math.round(s.height),flex:!!s.flex,abs:s.layoutChild?s.layoutChild.absolute:undefined,tx:s.type==='text'?s.characters.slice(0,24):undefined,fs:s.type==='text'?s.fontSize:undefined,fill:(s.fills&&s.fills[0]&&s.fills[0].fillColor)||undefined,c:lv<2?(s.children||[]).map(k=>d(k,lv+1)):(s.children||[]).length});
const occupied=penpot.currentPage.root.children.filter(s=>s.type==='board'&&Math.abs(s.y-3698)<1000&&s.x>=3400&&s.x<4400).map(s=>[s.name.slice(0,20),s.x,s.y]);
return {flex:!!B.flex,kids:B.children.map(k=>d(k,0)),occupied};
