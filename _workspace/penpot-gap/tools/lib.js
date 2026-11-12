// 대표 관리 웹 보드 공통 도우미 — python3 pp.py lib.js <보드.js> 로 앞에 붙여 쓴다
// 좌표는 모두 보드 왼쪽 위 기준. 텍스트는 자동 크기가 안 돼 폭을 직접 계산한다(tw).
const C={bg:'#f4f1ec',side:'#2a1f2e',sideOn:'#3a2c40',sideTx:'#a9a2af',gold:'#d6b46a',ink:'#141216',ink2:'#5d5763',ink3:'#8b8490',line:'#e7e1d8',card:'#ffffff',plum:'#5b3a63',plumL:'#efe6f0',sel:'#f6efe2',selLine:'#e3cf9f',warn:'#b23a3a',warnL:'#f9e9e6',input:'#f8f6f2',note:'#f4f1ec'};
const FONT={fontFamily:'Noto Sans KR',fontId:'gfont-noto-sans-kr'};
function tw(s,fs){let w=0;for(const ch of s){if(/[가-힣]/.test(ch))w+=1.02;else if(/[0-9]/.test(ch))w+=.62;else if(ch===' ')w+=.3;else if(/[A-Z]/.test(ch))w+=.68;else if(/[a-z]/.test(ch))w+=.56;else w+=.42;}return Math.ceil(w*fs*1.05)+2;}
function R(B,x,y,w,h,fill,o={}){const r=penpot.createRectangle();B.appendChild(r);r.name=o.name||'Rectangle';r.x=B.x+x;r.y=B.y+y;r.resize(w,h);r.borderRadius=o.r||0;r.fills=fill?[{fillColor:fill,fillOpacity:o.op??1}]:[];if(o.stroke)r.strokes=[{strokeColor:o.stroke,strokeOpacity:1,strokeWidth:o.sw||1,strokeAlignment:'inner',strokeStyle:o.dash?'dashed':'solid'}];return r;}
function T(B,x,y,s,fs=14,fw='500',col=C.ink,o={}){const t=penpot.createText(s);B.appendChild(t);t.name=o.name||'Text';Object.assign(t,FONT);t.fontSize=String(fs);t.fontWeight=String(fw);t.fontVariantId=String(fw);t.growType='fixed';const lh=o.lh||1.5;t.lineHeight=String(lh);
 const lines=o.w?Math.max(1,Math.ceil(tw(s,fs)/o.w)):1;const w=o.w||tw(s,fs);t.resize(w,Math.ceil(fs*lh*lines));
 if(o.align){t.align=o.align;} t.x=B.x+x; t.y=B.y+y; t.fills=[{fillColor:col,fillOpacity:1}]; t.getRange(0,s.length).fills=[{fillColor:col,fillOpacity:1}]; return t;}
function BTN(B,x,y,label,kind='primary',o={}){const fs=o.fs||13;const w=o.w||tw(label,fs)+36;const h=o.h||34;
 const fill=kind==='primary'?C.plum:kind==='danger'?C.warn:'#ffffff';const col=(kind==='primary'||kind==='danger')?'#ffffff':C.ink;
 R(B,x,y,w,h,fill,{r:o.r??10,stroke:kind==='ghost'?C.line:null,name:'btn:'+label});
 T(B,x,y+(h-Math.ceil(fs*1.5))/2,label,fs,'700',col,{w,align:'center'});return w;}
function CARD(B,x,y,w,h,o={}){return R(B,x,y,w,h,o.fill||C.card,{r:o.r??18,stroke:o.stroke||C.line,name:o.name||'card'});}
function CHIP(B,x,y,label,fill=C.plumL,col=C.plum,fs=12){const w=tw(label,fs)+20;R(B,x,y,w,24,fill,{r:12,name:'chip:'+label});T(B,x,y+3,label,fs,'700',col,{w,align:'center'});return w;}
function TOG(B,x,y,on){R(B,x,y,36,20,on?C.plum:'#ddd6cf',{r:10,name:on?'toggle:on':'toggle:off'});const e=penpot.createEllipse();B.appendChild(e);e.resize(16,16);e.x=B.x+x+(on?18:2);e.y=B.y+y+2;e.fills=[{fillColor:'#ffffff',fillOpacity:1}];}
function RADIO(B,x,y,on){const e=penpot.createEllipse();B.appendChild(e);e.resize(20,20);e.x=B.x+x;e.y=B.y+y;e.fills=[{fillColor:'#ffffff',fillOpacity:1}];e.strokes=[{strokeColor:on?C.plum:'#cfc8c0',strokeOpacity:1,strokeWidth:on?6:1.5,strokeAlignment:'inner'}];}
function INPUT(B,x,y,w,val,o={}){R(B,x,y,w,o.h||36,o.fill||C.input,{r:10,stroke:o.stroke||C.line,name:'input'});T(B,x+12,y+((o.h||36)-21)/2,val,o.fs||14,o.fw||'600',o.col||C.ink,{});}
const MENU=['대시보드','수업 · 포스터 등록','예약 · 명단','강사 관리','학원 공지','환불 처리','정산 · 원장','1+1 · 순위판','입점 · 설정'];
function SIDE(B,active,H){R(B,0,0,236,H,C.side,{name:'side'});R(B,24,28,28,28,C.gold,{r:9});T(B,62,30,'K-DanceX4 콘솔',16,'800','#f3efea');
 MENU.forEach((m,i)=>{const y=81+34*i;const on=m===active;if(on)R(B,16,y-5,204,32,C.sideOn,{r:12});R(B,28,y,18,18,on?'#f3efea':C.sideTx,{r:6});T(B,56,y-2,m,14,'600',on?'#ffffff':C.sideTx);});
 R(B,16,H-83,204,61,C.sideOn,{r:14});R(B,28,H-71,36,36,C.plum,{r:10});T(B,74,H-73,'라틴하우스 강남',14,'700','#ffffff');T(B,74,H-51,'대표',12,'500',C.sideTx);}
function BOARD(name,x,y,w,h){const B=penpot.createBoard();B.name=name;B.x=x;B.y=y;B.resize(w,h);B.fills=[{fillColor:C.bg,fillOpacity:1}];B.clipContent=true;try{B.showInViewMode=true;}catch(e){}return B;}
const FIND=p=>penpot.currentPage.root.children.find(s=>s.type==='board'&&s.name.startsWith(p));
