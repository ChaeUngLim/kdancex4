
const out={};for(const p of ['W4a ·','W4b ·','O21B ·']){const B=FIND(p);if(!B){out[p]='없음';continue;}const a=[];
const walk=(s,d)=>{for(const c of (s.children||[])){if(c.type==='text')a.push([Math.round(c.x-B.x),Math.round(c.y-B.y),Math.round(c.width),Math.round(c.height),c.fontSize,c.fontWeight,(c.fills&&c.fills[0]&&c.fills[0].fillColor)||'',d,c.characters]);else walk(c,d+1);}};walk(B,0);
a.sort((p,q)=>p[1]-q[1]||p[0]-q[0]);out[p]=a;}
return out;
