return penpot.currentPage.root.children.filter(s=>s.type==='board'&&s.name.startsWith('_test')).map(s=>[s.name,s.children.length]);
