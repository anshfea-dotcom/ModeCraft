const defaults = new Map([
  ['slide-1', 'men'], ['slide-2', 'women'], ['slide-3', 'jackets'],
  ['men', 'men'], ['women', 'women'], ['jackets', 'jackets'], ['sneakers', 'sneakers']
]);

async function readImage(pool, slot) {
  const saved = await pool.query('SELECT data FROM store_settings WHERE key = $1', ['editorial_image_' + slot]);
  const encoded = saved.rows[0]?.data?.image;
  return encoded ? Buffer.from(encoded, 'base64') : null;
}

module.exports = { defaults, readImage };
