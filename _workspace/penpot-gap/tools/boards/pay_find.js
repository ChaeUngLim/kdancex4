const out={};
for(const b of penpot.currentPage.root.children){ if(b.type!=='board')continue;
  const hits=[];
  const walk=(s,path)=>{for(const c of (s.children||[])){ if(c.type==='text'){const t=c.characters||''; if(/가상계좌|계좌이체|신용|체크카드|간편결제|카카오페이|네이버페이|토스페이|결제 ?수단|무통장/.test(t))hits.push({id:c.id,t:t.slice(0,60),x:Math.round(c.x-b.x),y:Math.round(c.y-b.y),p:path.slice(-2).join('>')});} else walk(c,path.concat(c.name));}};
  walk(b,[]);
  if(hits.length)out[b.name.slice(0,70)]={id:b.id,x:Math.round(b.x),y:Math.round(b.y),w:b.width,h:b.height,hits};
}
return out;
