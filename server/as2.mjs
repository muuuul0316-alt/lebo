process.env.PORT='8718'; process.env.PUBLIC_BASE_URL='http://localhost:8718';
process.env.DATA_DIR='./data-as'; process.env.UPLOAD_DIR='./uploads-as';
import http from 'node:http';
await import('/home/user/lebo/server/src/index.js'); await new Promise(r=>setTimeout(r,500));
const OLD=process.argv[2];
const get=(u)=>new Promise(r=>http.get(u,(res)=>{res.resume();r(res.statusCode)}));
console.log('重启后用「重启前持久化在 packages.json 里的旧 URL」访问:', await get(OLD.replace('8717','8718')));
console.log('→ 403 = 重启前上传的所有照片/PPT 配图在电视上全变裂图');
