const express = require('express');
const { createPool } = require('../database');
const { defaults, readImage } = require('./images');
const { allowStandalone } = require('../store/rate-limits');

const pool = createPool(1);
const app = express();
app.disable('x-powered-by');
app.get('/storefront-images/:slot', async (req, res) => {
  const slot = req.params.slot;
  if (!defaults.has(slot)) return res.sendStatus(404);
  if (!await allowStandalone(req, res, pool, "media", 600)) return;
  res.set('Cache-Control', 'no-cache');
  try {
    const image = await readImage(pool, slot);
    if (image) return res.type('image/webp').send(image);
    res.status(204).end();
  } catch (error) {
    console.error('Media read failed:', error.message);
    res.sendStatus(503);
  }
});

const managed = Boolean(process.send);
const server = app.listen(managed ? 0 : Number(process.env.PORT || 3002), managed ? '127.0.0.1' : '0.0.0.0', () => {
  if (managed) process.send({ port: server.address().port });
});
function stop() {
  server.close(() => pool.end().finally(() => process.exit(0)));
}
process.once('SIGTERM', stop);
if (managed) process.once('disconnect', stop);
