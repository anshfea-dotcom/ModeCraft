'use strict';

const express = require('express');
const path = require('node:path');
const managedService = require('../managed-service');
const { defaults, readImage } = require('./images');
const { validateWebp } = require('../store/validate-input');

module.exports = function registerImages(app, pool, requireAdmin, requireOwner, audit) {
  const media = managedService(path.join(__dirname, 'server.js'), process.env.MEDIA_SERVICE_URL);

  async function loadImage(slot) {
    if (media.endpoint) {
      try {
        const response = await fetch(new URL('/storefront-images/' + slot, media.endpoint), {
          signal: AbortSignal.timeout(3000), redirect: 'error'
        });
        if (response.status === 204) return null;
        if (response.status === 200 && response.headers.get('content-type') === 'image/webp') {
          return Buffer.from(await response.arrayBuffer());
        }
        await response.body?.cancel();
      } catch (error) {
        console.warn('Media service unavailable:', error.message);
      }
    }
    return readImage(pool, slot);
  }

  const adminPath = '/api/admin/storefront/images/:slot';
  function slot(req, res, next) {
    if (!defaults.has(req.params.slot)) return res.sendStatus(404);
    next();
  }
  const key = req => 'editorial_image_' + req.params.slot;
  app.get('/storefront-images/:slot', slot, async (req, res) => {
    res.set('Cache-Control', 'no-cache');
    try {
      const image = await loadImage(req.params.slot);
      if (image) return res.type('image/webp').send(image);
    } catch (error) {
      console.error('Could not load storefront image:', error.message);
    }
    return res.redirect(302, '/editorial/' + defaults.get(req.params.slot) + '.webp');
  });
  app.put(adminPath, requireAdmin, requireOwner, slot, express.raw({type:'image/webp', limit:'1mb'}), validateWebp, async (req, res, next) => {
    const image = req.body;
    if (!Buffer.isBuffer(image) || image.length < 30 || image.toString('ascii',0,4) !== 'RIFF' ||
        image.toString('ascii',8,12) !== 'WEBP' || image.readUInt32LE(4) !== image.length - 8 ||
        !['VP8 ', 'VP8L', 'VP8X'].includes(image.toString('ascii',12,16))) {
      return res.status(400).json({error:'Choose a valid photo and try again.'});
    }
    try {
      await pool.query('INSERT INTO store_settings (key,data,updated_at) VALUES ($1,$2::jsonb,NOW()) ON CONFLICT (key) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()', [key(req), JSON.stringify({image:image.toString('base64')})]);
      await audit(req.session.admin, 'storefront.image.update', {slot:req.params.slot});
      res.json({ok:true});
    } catch (error) { next(error); }
  });
  app.delete(adminPath, requireAdmin, requireOwner, slot, async (req,res,next) => {
    try {
      await pool.query('DELETE FROM store_settings WHERE key=$1', [key(req)]);
      await audit(req.session.admin, 'storefront.image.restore', {slot:req.params.slot});
      res.json({ok:true});
    } catch (error) { next(error); }
  });
  return media;
};
