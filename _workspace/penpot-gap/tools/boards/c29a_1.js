const B=PAGE_M('C29A · 검색 거르기 시트 (검색 결과의 거르기 칩을 누르면 · 장르·지역·요일·시간·레벨 · 여러 개 고름 · 이 검색에만 적용 · 몇 개인지 바로 보임)',48,'검색');
INPUT(B,20,86,350,'살사',{h:44});
let x=20;[['거르기 5',true],['📍 내 주변',false],['1+1만',false]].forEach(([s,on])=>{x+=CHIP(B,x,140,s,on?C.plum:'#ffffff',on?'#ffffff':C.ink2)+8;});
R(B,0,0,390,176,C.ink,{op:0.35,name:'어둡게'});
R(B,0,176,390,668,'#ffffff',{r:24,stroke:C.line,name:'시트'});
R(B,175,188,40,4,'#ddd6cf',{r:2,name:'손잡이'});
T(B,20,204,'거르기',17,'800');
T(B,310,208,'초기화',13,'700',C.plum,{w:60,align:'right'});
return B.id;
