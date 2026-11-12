// 기존 보드의 탭바에서 켜진 탭(굵은 글자)을 읽어, 탭 종류·켜진 탭별로 원본 보드를 하나씩 고른다
const out={};
for(const b of penpot.currentPage.root.children){if(b.type!=='board'||b.name.includes('이전 안'))continue;
 const tb=(b.children||[]).find(c=>c.name&&c.name.startsWith('tabbar'));if(!tb)continue;
 const ts=(tb.children||[]).filter(c=>c.type==='text');const on=ts.find(t=>String(t.fontWeight)>='700');if(!on)continue;
 const kind=tb.name.includes('회원')?'member':tb.name.includes('강사')?'instructor':tb.name.includes('대표')?'owner':'?';
 const key=kind+'|'+on.characters;if(!out[key])out[key]=[];if(out[key].length<2)out[key].push(b.name.split(' · ')[0]);}
return out;
