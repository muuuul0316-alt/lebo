process.env.PORT='8717'; process.env.PUBLIC_BASE_URL='http://localhost:8717';
process.env.DATA_DIR='./data-as'; process.env.UPLOAD_DIR='./uploads-as';
import fs from 'node:fs'; import http from 'node:http';
const { assetUrl } = await import('/home/user/lebo/server/src/assets.js');
await import('/home/user/lebo/server/src/index.js'); await new Promise(r=>setTimeout(r,500));
fs.mkdirSync('./uploads-as/pkg_x',{recursive:true}); fs.writeFileSync('./uploads-as/pkg_x/p1.png','fakepng');
const url = assetUrl('pkg_x/p1.png');
const get=(u)=>new Promise(r=>http.get(u,(res)=>{res.resume();r(res.statusCode)}));
console.log('本次进程签发的素材 URL:', url);
console.log('本进程内访问:', await get(url), '（200 = 正常）');
// packages.json 会把这条 URL 持久化；模拟服务重启 → assetSecret 重新随机
console.log('\n模拟 systemctl restart lebo（ASSET_SECRET 未配置 → 密钥重新随机生成）');
