const s='제목은 100자까지 · 올린 뒤에는 고칠 수 없어요(고칠 일은 새로 올려요)';const out=[];
{const B=FIND('W5 ·');const src=B.children.find(c=>c.type==='text'&&c.characters.startsWith('회원에게는 보이지 않아요')&&Math.round(c.x-B.x)===712);
 const t=src.clone();t.characters=s;t.name='t:제목 100자·수정 불가 안내';t.x=B.x+712;t.y=B.y+684;out.push(['W5',Math.round(t.width),Math.round(t.height)]);}
{const B=FIND('O28 ·');const src=B.children.find(c=>c.type==='text'&&c.characters.startsWith('회원에게는 보이지 않아요'));
 const t=src.clone();t.characters=s;t.name='t:제목 100자·수정 불가 안내';t.resize(350,34);t.x=B.x+20;t.y=B.y+622;out.push(['O28',Math.round(t.width),Math.round(t.height)]);}
return out;
