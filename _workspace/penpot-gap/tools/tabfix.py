"""tabmap.json 대로 새 보드의 하단 탭을 「그 탭이 켜진」 기존 보드의 탭바로 바꿔 끼운다.
사용: python3 tabfix.py   (묶음 6개씩 실행. 원본 탭바가 없는 조합은 건너뛴다)"""
import json, subprocess
items = json.load(open("boards/tabmap.json", encoding="utf-8"))
JS = r"""
const ITEMS=%s;const out=[];const roots=penpot.currentPage.root.children.filter(s=>s.type==='board');
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
"""
for k in range(0, len(items), 6):
    chunk = [{"board": i["board"], "role": i["role"], "tab": i["tab"]} for i in items[k:k + 6]]
    open("boards/_tabfix_run.js", "w", encoding="utf-8").write(JS % json.dumps(chunk, ensure_ascii=False))
    r = subprocess.run(["python3", "pp.py", "lib.js", "boards/_tabfix_run.js"], capture_output=True, text=True)
    print(f"[{k}]", " ".join(r.stdout.split())[:330])
    if "No Penpot plugin" in r.stdout:
        print("STOPPED: 플러그인 연결 확인 필요"); break
