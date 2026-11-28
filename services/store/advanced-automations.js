"use strict";
const crypto=require("node:crypto");
const rulesTypes=new Set(["low_stock","unpaid_orders","unfulfilled_orders"]);
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
async function evaluate(pool){
  const rules=await pool.query("SELECT id,type,threshold FROM automation_rules WHERE active=TRUE ORDER BY created_at ASC LIMIT 200");
  let created=0;
  for(const rule of rules.rows){
    let events=[];
    if(rule.type==="low_stock"){
      const r=await pool.query("SELECT id AS key,quantity::text AS detail FROM inventory_variants WHERE quantity <= $1 LIMIT 250",[rule.threshold]);
      events=r.rows;
    }else{
      const r=await pool.query("SELECT id AS key,data FROM orders WHERE created_at >= NOW()-INTERVAL '30 days' ORDER BY created_at DESC LIMIT 1000");
      events=r.rows.filter(x=>rule.type==="unpaid_orders"?
        x.data.paymentStatus!=="paid"&&x.data.orderStatus!=="cancelled":
        !["delivered","cancelled"].includes(x.data.orderStatus)).slice(0,250).map(x=>({key:x.key,detail:x.data.orderStatus}));
    }
    for(const event of events){
      const inserted=await pool.query("INSERT INTO automation_alerts(id,rule_id,entity_key,period,detail) VALUES($1,$2,$3,CURRENT_DATE,$4) ON CONFLICT(rule_id,entity_key,period) DO NOTHING RETURNING id",[crypto.randomUUID(),rule.id,String(event.key),String(event.detail||"")]);
      created+=inserted.rowCount;
    }
  }
  return {checked:rules.rows.length,created};
}
module.exports=function registerAutomations(app,{pool,requireAdmin,requireOwner,audit}){
  app.get("/api/admin/automations",requireAdmin,requireOwner,async(_req,res,next)=>{
    try{
      const [rules,alerts]=await Promise.all([
        pool.query("SELECT id,name,type,threshold,active,created_at FROM automation_rules ORDER BY created_at DESC LIMIT 200"),
        pool.query("SELECT a.id,a.rule_id,a.entity_key,a.period,a.detail,a.acknowledged,a.created_at,r.name AS rule_name FROM automation_alerts a JOIN automation_rules r ON r.id=a.rule_id ORDER BY a.created_at DESC LIMIT 200")
      ]);
      res.set("Cache-Control","no-store").json({rules:rules.rows,alerts:alerts.rows,delivery:"Admin centre only. No automatic emails or refunds."});
    }catch(e){next(e);}
  });
  app.post("/api/admin/automations",requireAdmin,requireOwner,async(req,res,next)=>{
    try{
      const name=String(req.body?.name||"").trim().slice(0,100),type=req.body?.type,threshold=Number(req.body?.threshold??5);
      if(name.length<3||!rulesTypes.has(type)||!Number.isSafeInteger(threshold)||threshold<0||threshold>10000)throw fail("Invalid rule name, trigger or threshold.");
      const id=crypto.randomUUID();
      await pool.query("INSERT INTO automation_rules(id,name,type,threshold,active) VALUES($1,$2,$3,$4,TRUE)",[id,name,type,threshold]);
      await audit(req.adminSession,"automation.created",{id,type});
      res.status(201).json({ok:true,id});
    }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
  });
  app.patch("/api/admin/automations/:id",requireAdmin,requireOwner,async(req,res,next)=>{
    try{
      const active=req.body?.active===true;
      const r=await pool.query("UPDATE automation_rules SET active=$2,updated_at=NOW() WHERE id=$1 RETURNING id",[req.params.id,active]);
      if(!r.rowCount)return res.status(404).json({error:"Automation rule not found."});
      await audit(req.adminSession,"automation.toggled",{id:req.params.id,active});
      res.json({ok:true,active});
    }catch(e){next(e);}
  });
  app.post("/api/admin/automations/run",requireAdmin,requireOwner,async(req,res,next)=>{
    try{const outcome=await evaluate(pool);await audit(req.adminSession,"automation.manual_run",outcome);res.json({ok:true,...outcome});}catch(e){next(e);}
  });
  app.patch("/api/admin/automations/alerts/:id",requireAdmin,requireOwner,async(req,res,next)=>{
    try{
      const r=await pool.query("UPDATE automation_alerts SET acknowledged=TRUE WHERE id=$1 RETURNING id",[req.params.id]);
      if(!r.rowCount)return res.status(404).json({error:"Alert not found."});
      await audit(req.adminSession,"automation.alert_acknowledged",{id:req.params.id});
      res.json({ok:true});
    }catch(e){next(e);}
  });
};
module.exports.evaluate=evaluate;
module.exports.start=(pool)=>{
  let running=false;
  const tick=async()=>{if(running)return;running=true;try{await evaluate(pool);}catch(e){console.error("Automation scan failed:",e.message);}finally{running=false;}};
  const interval=setInterval(tick,15*60*1000);
  interval.unref?.();
  tick();
  return()=>clearInterval(interval);
};