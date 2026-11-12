"""retext.json 의 글 바꾸기를 Penpot 스크립트로 만들어 묶음(기본 8개)마다 실행한다.
사용: python3 retext.py [now|after-draw]
보드 안에서 글이 old 로 시작하는 글자 노드를 찾아 지우고, 같은 자리·크기·굵기·색으로 new 를 다시 그린다
(이미 있는 글자의 characters 를 바꾸면 화면에 반영되지 않기 때문). flex 안의 글자는 절대 위치로 얹는다.
"""
import json, subprocess, sys

WHEN = sys.argv[1] if len(sys.argv) > 1 else "now"
BATCH = 8
items = [i for i in json.load(open("boards/retext.json", encoding="utf-8")) if i.get("when", "now") == WHEN]

JS = r"""
const ITEMS=%s;const out=[];
const walk=(s,acc)=>{for(const c of (s.children||[])){if(c.type==='text')acc.push(c);else walk(c,acc);}return acc;};
for(const it of ITEMS){
  const B=penpot.currentPage.root.children.find(s=>s.type==='board'&&s.name.startsWith(it.board+' ·')&&!s.name.includes('이전 안'));
  if(!B){out.push([it.board,'보드 없음']);continue;}
  const t=walk(B,[]).find(c=>(c.characters||'').startsWith(it.old));
  if(!t){out.push([it.board,'글 없음',it.old.slice(0,20)]);continue;}
  const x=t.x,y=t.y,w=t.width,h=t.height,fs=t.fontSize,fw=t.fontWeight,al=t.align,lh=t.lineHeight;
  const col=(t.fills&&t.fills[0]&&t.fills[0].fillColor)||'#141216';const parent=t.parent;
  const n=penpot.createText(it.new);parent.appendChild(n);n.name='t:'+it.new.slice(0,12);
  try{if(parent.flex)n.layoutChild.absolute=true;}catch(e){}
  Object.assign(n,FONT);n.fontSize=String(fs);n.fontWeight=String(fw);n.fontVariantId=String(fw);n.growType='fixed';if(lh)n.lineHeight=String(lh);if(al)n.align=al;
  const need=tw(it.new,Number(fs));const lines=Math.max(1,Math.ceil(need/Math.max(w,40)));
  n.resize(Math.max(w,lines>1?w:need),Math.max(h,Math.ceil(Number(fs)*1.5*lines)));n.x=x;n.y=y;
  n.fills=[{fillColor:col,fillOpacity:1}];n.getRange(0,it.new.length).fills=[{fillColor:col,fillOpacity:1}];
  if(parent.flex){t.opacity=0;}else{t.remove();}
  out.push([it.board,'ok',lines]);
}
return out;
"""

for k in range(0, len(items), BATCH):
    chunk = [{"board": i["board"], "old": i["old"], "new": i["new"]} for i in items[k:k + BATCH]]
    open("boards/_retext_run.js", "w", encoding="utf-8").write(JS % json.dumps(chunk, ensure_ascii=False))
    r = subprocess.run(["python3", "pp.py", "lib.js", "boards/_retext_run.js"], capture_output=True, text=True)
    print(f"[{k}~{k + len(chunk) - 1}]", " ".join(r.stdout.split())[:400])
    if "No Penpot plugin" in r.stdout:
        print("STOPPED: 플러그인 연결 확인 필요"); break
