const B=FIND('W8 ·');const out=[];
for(const s of [...B.children]){const x=Math.round(s.x-B.x),y=Math.round(s.y-B.y);
 if(x>=268&&x<848){ if(y>=360&&y<=450){s.remove();out.push('opt3');} else if(y>=470&&y<=640&&s.name!=='card'){s.y=s.y-96;} }
 else if(x>=868&&x<1248){ if(y>=566&&y<=630){s.remove();out.push('row3');} else if(y>=636&&y<=660){s.y=s.y-56;} }}
return out.length;
