const P=penpot.currentPage.root.children;
const bd=n=>P.find(x=>x.name.startsWith(n));
const PK=bd('W1b ·'),OTP=bd('W1b2 ·'),REG=bd('W1b3 ·'),DASH=bd('W29 ·');
const rect=(b,x,y)=>b.children.find(s=>s.type==='rectangle'&&Math.round(s.x-b.x)===x&&Math.round(s.y-b.y)===y);
return [rect(PK,760,472),rect(REG,760,472),rect(OTP,760,472)].map(s=>{
  (s.interactions||[]).slice().forEach(i=>s.removeInteraction(i));
  s.addInteraction('click',{type:'navigate-to',destination:DASH});
  return s.interactions.map(i=>i.action.destination.name.slice(0,12));
});
