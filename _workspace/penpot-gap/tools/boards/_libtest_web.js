const out={};
try{const B=WEB('_test_w',60,'대시보드');out.web=B.children.length;B.remove();}catch(e){out.web='ERR '+e;}
return out;
