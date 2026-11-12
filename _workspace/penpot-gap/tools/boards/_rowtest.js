const rows=penpot.currentPage.root.children.filter(s=>s.type==='board'&&s.y<ROW_Y+1100&&s.y+s.height>ROW_Y-50).map(s=>[s.name.slice(0,24),Math.round(s.x),Math.round(s.y),Math.round(s.height)]);
const B=PAGE_M('_test',20,'시험');const n=B.children.length;B.remove();
return {clash:rows,children:n};
