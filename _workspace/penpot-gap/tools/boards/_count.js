const roots=penpot.currentPage.root.children.filter(s=>s.type==='board');
const pick=re=>roots.filter(s=>re.test(s.name)&&!s.name.includes('이전 안')).map(s=>[s.name.split(' · ')[0],s.children.length]);
const c=pick(/^C\d+[A-D]? ·/),i=pick(/^I(1[6-9]|[2-4]\d)[B-D]? ·/),w=pick(/^W(9|1\d|2\d|8B) ·/),o=pick(/^O(2[3-9]|3\d) ·/);
const thin=a=>a.filter(x=>x[1]<8).map(x=>x.join(':'));
return {전체보드:roots.length,회원C:c.length,강사I:i.length,대표웹W:w.length,대표앱O:o.length,도형적은보드:{C:thin(c),I:thin(i),W:thin(w),O:thin(o)},대표웹목록:w.map(x=>x.join(':')).join(' ')};
