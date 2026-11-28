"use strict";
const fs=require("node:fs");
const BASE={title:"AERLON — Wear Your Identity",description:"Discover elevated everyday fashion at AERLON.",ogTitle:"AERLON — Premium Fashion",ogDescription:"Modern wardrobe essentials by AERLON.",ogImage:""};
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function validated(v){
  const p={};
  for(const [key,max] of [["title",75],["description",180],["ogTitle",95],["ogDescription",200]]){
    p[key]=String(v?.[key]??"").trim();
    if(p[key].length<4||p[key].length>max)throw Object.assign(new Error("Invalid "+key+" (4–"+max+" characters)."),{status:400});
  }
  p.ogImage=String(v?.ogImage||"").trim();
  if(p.ogImage&&(!/^https:\/\//i.test(p.ogImage)||p.ogImage.length>1200))throw Object.assign(new Error("Image URL must be HTTPS."),{status:400});
  return p;
}
function render(template,profile){
  const boundary=template.indexOf("</head>");
  if(boundary<0)throw Error("SEO page template missing head.");
  const meta='<title>'+esc(profile.title)+'</title>\n'
   +'<meta name="description" content="'+esc(profile.description)+'">\n'
   +'<link rel="canonical" href="https://aerlon.in/">\n'
   +'<meta property="og:type" content="website"><meta property="og:site_name" content="AERLON">\n'
   +'<meta property="og:url" content="https://aerlon.in/"><meta property="og:title" content="'+esc(profile.ogTitle)+'">\n'
   +'<meta property="og:description" content="'+esc(profile.ogDescription)+'">\n'
   +'<meta name="twitter:card" content="'+(profile.ogImage?"summary_large_image":"summary")+'">\n'
   +'<meta name="twitter:title" content="'+esc(profile.ogTitle)+'">\n'
   +'<meta name="twitter:description" content="'+esc(profile.ogDescription)+'">\n'
   +(profile.ogImage?'<meta property="og:image" content="'+esc(profile.ogImage)+'"><meta name="twitter:image" content="'+esc(profile.ogImage)+'">\n':"");
  const head=template.slice(0,boundary).replace(/<title>[\s\S]*?<\/title>/i,"")
    .replace(/<meta\s+name="description"[^>]*>/gi,"")
    .replace(/<meta\s+property="og:[^>]*>/gi,"")
    .replace(/<meta\s+name="twitter:[^>]*>/gi,"")
    .replace(/<link\s+rel="canonical"[^>]*>/gi,"");
  return head+meta+template.slice(boundary);
}
module.exports=function registerSEO(app,{pool,requireAdmin,requireOwner,audit},templatePath){
  const template=fs.readFileSync(templatePath,"utf8");
  async function current(){
    const found=await pool.query("SELECT data FROM store_settings WHERE key=$1",["seo_profile"]);
    return {...BASE,...(found.rows[0]?.data||{})};
  }
  app.get("/",async(req,res)=>{
    try{const profile=await current();res.set("Cache-Control","public, max-age=120").type("html").send(render(template,profile));}
    catch(e){console.error("SEO render fallback:",e.message);res.type("html").send(render(template,BASE));}
  });
  app.get("/api/admin/seo",requireAdmin,requireOwner,async(_req,res,next)=>{
    try{res.set("Cache-Control","no-store").json({profile:await current(),canonical:"https://aerlon.in/"});}catch(e){next(e);}
  });
  app.put("/api/admin/seo",requireAdmin,requireOwner,async(req,res,next)=>{
    try{const p=validated(req.body);
      await pool.query("INSERT INTO store_settings(key,data,updated_at) VALUES($1,$2::jsonb,NOW()) ON CONFLICT(key) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()",["seo_profile",JSON.stringify(p)]);
      await audit(req.adminSession,"seo.profile.updated",{title:p.title});
      res.json({ok:true,profile:p,canonical:"https://aerlon.in/"});
    }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
  });
};
module.exports.renderSEO=render;
module.exports.validateSEO=validated;