const b=penpot.currentPage.root.children.filter(s=>s.type==='board'&&s.name.startsWith('C3C ·'));
return b.map(x=>({id:x.id,n:x.children.length,x:Math.round(x.x),y:Math.round(x.y)}));
