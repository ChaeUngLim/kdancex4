const out={};
try{const B=PAGE_O('_test_o',40000,'시험');out.owner=B.children.length;B.remove();}catch(e){out.owner='ERR '+e;}
return out;
