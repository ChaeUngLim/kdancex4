const B=penpot.currentPage.getShapeById('5c6cb615-037e-80f4-8008-ec4ef6f20b0c');
B.children.filter(s=>s.type==='text'&&(/^우리 학원 \(%\)$/.test(s.characters)||/^1\/2 지나기 전 구간을 50%/.test(s.characters))).forEach(s=>s.remove());
T(B,728,386,'우리 학원 (%)',12,'600',C.ink3,{w:96,align:'center'});
T(B,292,578,'1/2 지나기 전 구간을 50%에서 67%로 올렸어요 · 법정 2/3 은 67%로 올려 잡아요',11,'600',C.plum,{w:532});
return 'ok';
