// 대표 관리 웹 보드 틀 — 대표 웹 줄(y=21504)의 W8 오른쪽(x=25270)부터 slot 칸(1330px)마다 놓는다.
// active 는 사이드 메뉴에서 켜질 이름(MENU 중 하나). 내용은 x 268~1248, 제목은 (268,30) 28px.
function WEB(name,slot,active,H=832){const B=BOARD(name,25270+slot*1330,21504,1280,H);SIDE(B,active,H);return B;}
function CHECK(B,x,y,on,dim){R(B,x,y,22,22,on?C.plum:'#ffffff',{r:7,stroke:on?null:(dim?'#e3ddd5':'#cfc8c0'),sw:1.5});if(on)T(B,x,y+2,'✓',12,'800','#ffffff',{w:22,align:'center'});}
