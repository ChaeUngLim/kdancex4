// 이어 하기 전에: 중간에 끊겨 반만 그려졌을 수 있는 보드를 지운다(그 보드의 첫 스크립트부터 다시 실행된다)
const b=penpot.currentPage.root.children.filter(s=>s.type==='board'&&s.name.startsWith(PREFIX));
const out=b.map(x=>[x.name.slice(0,20),x.children.length]);for(const x of b)x.remove();return out;
