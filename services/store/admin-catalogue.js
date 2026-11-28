"use strict";
module.exports = function registerAdminCatalogue(app,{pool,requireAdmin,requireOwner,requirePermission,cleanText,audit}) {
  app.get("/api/admin/catalogue/taxonomy",requireAdmin,requirePermission("products.view"),async(_req,res,next)=>{
    try{
      const r=await pool.query("SELECT id,data->>'name' AS name,data->>'category' AS category,data->>'brand' AS brand FROM products ORDER BY data->>'name'");
      const products=r.rows.map(x=>({id:x.id,name:x.name||x.id,category:x.category||"Uncategorised",brand:x.brand||""}));
      const totals=(field)=>Object.entries(products.reduce((m,x)=>(m[x[field]]=(m[x[field]]||0)+1,m),{})).filter(([name])=>field!=="brand"||name).map(([name,count])=>({name,count})).sort((a,b)=>a.name.localeCompare(b.name));
      res.json({products,categories:totals("category"),brands:totals("brand")});
    }catch(e){next(e);}
  });
  app.patch("/api/admin/catalogue/categories",requireAdmin,requireOwner,async(req,res,next)=>{
    try{
      const from=cleanText(req.body?.from,80),to=cleanText(req.body?.to,80);
      if(from.length<2||to.length<2||from===to)return res.status(400).json({error:"Choose an existing category and a different new category."});
      const r=await pool.query("UPDATE products SET data=jsonb_set(data,'{category}',to_jsonb($2::text),true), updated_at=NOW() WHERE data->>'category'=$1 RETURNING id",[from,to]);
      if(!r.rowCount)return res.status(404).json({error:"No products use this category."});
      await audit(req.adminSession,"catalogue.category.renamed",{from,to,count:r.rowCount});
      res.json({ok:true,updated:r.rowCount});
    }catch(e){next(e);}
  });
  app.patch("/api/admin/catalogue/brands",requireAdmin,requireOwner,async(req,res,next)=>{
    try{
      const productId=cleanText(req.body?.productId,150),brand=cleanText(req.body?.brand,80);
      if(!productId||brand.length<2)return res.status(400).json({error:"Select a product and enter a brand name of at least two characters."});
      const r=await pool.query("UPDATE products SET data=jsonb_set(data,'{brand}',to_jsonb($2::text),true),updated_at=NOW() WHERE id=$1 RETURNING id",[productId,brand]);
      if(!r.rowCount)return res.status(404).json({error:"Product not found."});
      await audit(req.adminSession,"catalogue.brand.assigned",{productId,brand});
      res.json({ok:true,productId,brand});
    }catch(e){next(e);}
  });
  app.get("/api/admin/backups/operational.json",requireAdmin,requireOwner,async(req,res,next)=>{
    try{
      const tables={
        products:"SELECT id,data,updated_at FROM products ORDER BY id",
        orders:"SELECT id,data,created_at,updated_at FROM orders ORDER BY created_at DESC",
        inventory:"SELECT product_id,color,size,sku,quantity,updated_at FROM inventory_variants",
        offers:"SELECT code,data,created_at FROM offers",
        banners:"SELECT id,data,active,sort_order FROM sales_banners",
        storefrontSettings:"SELECT key,data,updated_at FROM store_settings",
        audit:"SELECT actor,role,action,details,created_at FROM audit_logs ORDER BY id DESC LIMIT 10000"
      };
      const exportData={schema:"aerlon.operations.v1",exportedAt:new Date().toISOString(),notes:"Owner-only operational export; no credentials or media.",tables:{}};
      for(const [name,sql] of Object.entries(tables))exportData.tables[name]=(await pool.query(sql)).rows;
      await audit(req.adminSession,"backup.exported",{format:"json"});
      const filename="aerlon-operational-"+new Date().toISOString().slice(0,10)+".json";
      res.set({"Content-Type":"application/json; charset=utf-8","Content-Disposition":'attachment; filename="'+filename+'"',"Cache-Control":"no-store"});
      res.send(JSON.stringify(exportData));
    }catch(e){next(e);}
  });
};
