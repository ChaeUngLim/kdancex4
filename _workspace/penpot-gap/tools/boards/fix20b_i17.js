const B=FIND('I17 ·');const D=penpot.currentPage.root.children.find(x=>x.name.startsWith('I17D ·')&&!/이전 안|폐기/.test(x.name));
const lab='받지 못했어요';const w=tw(lab,11)+18;
const r=R(B,160,381,w,22,'#ffffff',{r:11,stroke:C.warn,name:'btn:받지 못했어요'});
const t=T(B,160,384,lab,11,'700',C.warn,{w,align:'center'});
r.addInteraction('click',{type:'navigate-to',destination:D});t.addInteraction('click',{type:'navigate-to',destination:D});
return [w,!!D];
