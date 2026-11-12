const B=FIND('I15B ·');const D=7;
for(const s of [...B.children]){const y=Math.round(s.y-B.y);const nm=s.name||'';
 if(nm.startsWith('tabbar')||y>=770)continue;
 if(nm==='card'&&y===146){s.resize(350,330+D*5);continue;}
 if(y>=150&&y<476){const i=Math.floor((y-150)/65);s.y=s.y+i*D;continue;}
 if(y>=476&&y<592){s.y=s.y+D*5; if(s.type==='rectangle'&&Math.round(s.height)===62&&Math.round(s.width)===350)s.resize(350,78);continue;}
 if(y>=592)s.y=s.y+D*5+16;}
return 'ok';
