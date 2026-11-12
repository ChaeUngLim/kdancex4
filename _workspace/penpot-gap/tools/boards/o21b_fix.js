const B=FIND('O21B ·');const ch=[...B.children];const mine=ch.slice(-8);const ids=new Set(mine.map(s=>s.id));
const line=mine[mine.length-1];const end=Math.round(line.y-B.y)+1;const delta=end-278;
if(delta>0){for(const s of ch){if(!ids.has(s.id)&&Math.round(s.y-B.y)>=278)s.y=s.y+delta;}B.resize(390,Math.round(B.height)+delta);}
return [end,delta,line.name,Math.round(line.width),Math.round(line.height)];
