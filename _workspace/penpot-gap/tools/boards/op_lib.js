// 운영자(플랫폼) 관리자 웹 보드 공통 도우미 — 실행: python3 pp.py lib.js boards/web_lib.js boards/op_lib.js boards/<파일>.js
// 대표 콘솔과 같은 콘솔이고 사이드 메뉴만 다르다(FR-300). 내용은 x 268~1248, 제목은 (268,30) 28px.
const OP_GROUPS=[['플랫폼',['대시보드','장르별 결산','학원별 결산','상품·수단·지역','전체 결산표','지급 현황','수수료 근거','수수료율']],['운영',['공휴일','예금주 확인','사업자 점검']]];
// 운영자 사이드 메뉴 — SIDE 와 같은 모양, 소제목 두 개(플랫폼·운영)와 계정 카드만 다르다
function SIDE_OP(B,active,H){R(B,0,0,236,H,C.side,{name:'side'});R(B,24,28,28,28,C.gold,{r:9});T(B,62,30,'K-DanceX4 콘솔',16,'800','#f3efea');
 let y=78;
 OP_GROUPS.forEach(([g,items],gi)=>{T(B,28,y,g,11,'700',C.gold,{name:'메뉴 소제목'});y+=26;
  items.forEach(m=>{const on=m===active;if(on)R(B,16,y-5,204,32,C.sideOn,{r:12});R(B,28,y,18,18,on?'#f3efea':C.sideTx,{r:6});T(B,56,y-2,m,14,'600',on?'#ffffff':C.sideTx);y+=32;});
  y+=14;});
 R(B,16,H-83,204,61,C.sideOn,{r:14});R(B,28,H-71,36,36,C.plum,{r:10});T(B,74,H-73,'K-DanceX4 운영',14,'700','#ffffff');T(B,74,H-51,'운영자',12,'500',C.sideTx);}
// 운영자 관리자 웹 틀 — 관리자 웹 기둥(x 18600) 아래 임시 줄(y 24300)의 빈 자리에 놓는다
function WEB_OP(name,active,H=832){const y0=24300;let x=18600;const roots=penpot.currentPage.root.children.filter(s=>s.type==='board');while(roots.some(r=>r.x<x+1280&&r.x+r.width>x&&r.y<y0+H&&r.y+r.height>y0))x+=1330;const B=BOARD(name,x,y0,1280,H);SIDE_OP(B,active,H);return B;}
// 화면 맨 아래 작은 글 — 개인정보 비노출(FR-302)과 조회 기록
function FOOT_OP(B,H=832){T(B,268,H-34,'조회 기록이 남아요 · 수강생 이름·연락처·나이는 보이지 않아요 — 학원·강사·수업 단위로 모은 숫자만 보여요',12,'500',C.ink3);}
// 표 머리 + 구분선. cols=[{h:'열 이름',x:표 안 가로 위치,w:폭,a:'right'|'center'|undefined}]
function THEAD(B,x,y,cols,w){cols.forEach(c=>T(B,x+c.x,y,c.h,12,'600',C.ink3,{w:c.w,align:c.a}));R(B,x,y+26,w,1,C.line);}
// 표 줄. 셀은 문자열 또는 [글,색,굵기]. o.sel 줄 번호는 선택 바탕, o.bold 줄 번호는 굵게, o.sub 줄 번호는 들여쓰기·보조 색
function TROWS(B,x,rowTop,cols,rows,o={}){const rh=o.rh||40,fs=o.fs||13,w=o.w||948;
 rows.forEach((r,i)=>{const top=rowTop+i*rh;const sel=(o.sel||[]).includes(i),bold=(o.bold||[]).includes(i),sub=(o.sub||[]).includes(i);
  if(sel)R(B,x-8,top+2,w+16,rh-4,C.sel,{r:10,stroke:C.selLine,name:'선택 줄'});
  r.forEach((v,j)=>{const c=cols[j];const arr=Array.isArray(v)?v:[v];const col=arr[1]||(sub?C.ink2:C.ink);const fw=arr[2]||(bold?'800':sub?'500':'600');
   T(B,x+c.x+((sub&&j===0)?14:0),top+(rh-Math.ceil(fs*1.5))/2,arr[0],fs,fw,col,{w:c.w-((sub&&j===0)?14:0),align:c.a});});
  if(i<rows.length-1&&!sel&&!(o.sel||[]).includes(i+1))R(B,x,top+rh,w,1,C.line);});}
// 지표 카드: 이름·값·증감(▲▼)·비교 기준
function KPI(B,x,y,w,label,val,delta,base,up=true){CARD(B,x,y,w,104,{r:16});T(B,x+16,y+14,label,12,'600',C.ink3);T(B,x+16,y+36,val,22,'800',C.ink);T(B,x+16,y+72,delta,13,'800',up?C.plum:C.ink2);T(B,x+16+tw(delta,13)+8,y+74,base,11,'500',C.ink3);}
