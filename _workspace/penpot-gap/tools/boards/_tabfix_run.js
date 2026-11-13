
const ITEMS=[{"board": "O48", "role": "owner", "tab": "홈"}, {"board": "O48B", "role": "owner", "tab": "홈"}, {"board": "O49", "role": "owner", "tab": "학원"}];const out=[];const roots=penpot.currentPage.root.children.filter(s=>s.type==='board');
const tabOf=b=>(b.children||[]).find(c=>c.name&&c.name.startsWith('tabbar'));
const onOf=tb=>{const t=(tb.children||[]).filter(c=>c.type==='text').find(t=>String(t.fontWeight)>='700');return t?t.characters:null;};
const kindOf=tb=>tb.name.includes('회원')?'member':tb.name.includes('강사')?'instructor':tb.name.includes('대표')?'owner':'?';
const src={};for(const b of roots){if(b.name.includes('이전 안'))continue;const tb=tabOf(b);if(!tb)continue;const on=onOf(tb);if(!on)continue;const k=kindOf(tb)+'|'+on;if(!src[k])src[k]=tb;}
for(const it of ITEMS){
  const B=roots.find(s=>s.name.startsWith(it.board+' ·')&&!s.name.includes('이전 안'));if(!B){out.push([it.board,'보드 없음']);continue;}
  const old=tabOf(B);if(!old){out.push([it.board,'탭 없음']);continue;}
  if(onOf(old)===it.tab){out.push([it.board,'그대로']);continue;}
  const s=src[it.role+'|'+it.tab];if(!s){out.push([it.board,'원본 없음 '+it.tab]);continue;}
  const x=old.x,y=old.y;const c=s.clone();B.appendChild(c);c.x=x;c.y=y;old.remove();out.push([it.board,'→ '+it.tab]);
}
return out;
