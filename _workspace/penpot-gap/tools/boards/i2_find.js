const out=[];
for(const b of penpot.currentPage.root.children){ if(b.type!=='board'||!/^I2/.test(b.name))continue;
 const tx=[];const walk=s=>{for(const c of (s.children||[])){if(c.type==='text')tx.push(Math.round(c.y-b.y)+':'+(c.characters||'').replace(/\n/g,' ').slice(0,40));else walk(c);}};walk(b);
 out.push({name:b.name.slice(0,90),id:b.id,x:Math.round(b.x),y:Math.round(b.y),w:b.width,h:Math.round(b.height),flex:!!b.flex,tx});}
return out;
