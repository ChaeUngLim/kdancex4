const roots=penpot.currentPage.root.children.filter(s=>s.type==='board'&&Math.round(s.y)===13100);
penpot.selection=[];penpot.viewport.zoomIntoView(roots.slice(0,12));return roots.length;
