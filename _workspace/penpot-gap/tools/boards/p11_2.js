const B=FIND('P11 ·');
[['전체','128곳',C.ink],['계속 사업','125곳',C.ink],['휴업','1곳',C.warn],['폐업','1곳',C.warn],['조회 실패','1곳',C.ink2]].forEach(([l,v,c],i)=>{const x=268+i*198;CARD(B,x,112,184,76,{r:16});T(B,x+16,126,l,12,'600',C.ink3);T(B,x+16,148,v,20,'800',c);});
return B.id;
