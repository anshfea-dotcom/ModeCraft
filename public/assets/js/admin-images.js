(() => {
  const groups = [
    ['Homepage slideshow', [['slide-1','Slide 1'],['slide-2','Slide 2'],['slide-3','Slide 3']]],
    ['Shop by collection', [['men','Men'],['women','Women'],['jackets','Jackets'],['sneakers','Sneakers']]]
  ];
  async function optimise(file) {
    if (!file || !['image/jpeg','image/png','image/webp'].includes(file.type)) throw Error('Choose a JPG, PNG or WebP photo.');
    if (file.size > 20 * 1024 * 1024) throw Error('Choose a photo smaller than 20 MB.');
    const image = await createImageBitmap(file);
    try {
      const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.8));
      if (!blob || blob.type !== 'image/webp' || blob.size > 1048576) throw Error('Try a smaller photo or another browser.');
      return blob;
    } finally { image.close(); }
  }
  for (const [group, slots] of groups) {
    const section = document.createElement('div');
    section.className = 'media-group';
    const title = document.createElement('h2');
    title.textContent = group;
    const grid = document.createElement('div');
    grid.className = 'media-grid';
    section.append(title, grid);
    document.querySelector('#imageEditor').append(section);
    for (const [slot,label] of slots) {
      const card = document.createElement('article');
      card.className = 'media-card';
      card.innerHTML = `<img alt="${label} preview" loading="lazy"><div><h3>${label}</h3>
        <label for="file-${slot}">Choose replacement photo</label>
        <input type="file" id="file-${slot}" accept="image/jpeg,image/png,image/webp">
        <div class="actions"><button type="button" class="btn gold" disabled>Save photo</button>
        <button type="button" class="btn">Restore original</button></div><small role="status"></small></div>`;
      grid.append(card);
      const preview = card.querySelector('img'), input = card.querySelector('input');
      const [save,restore] = card.querySelectorAll('button');
      const status = card.querySelector('small');
      const url = '/storefront-images/' + slot;
      let pending, objectURL;
      preview.src = url;
      function clearPreview() {
        if (objectURL) URL.revokeObjectURL(objectURL);
        objectURL = null;
        pending = null;
        save.disabled = true;
      }
      input.onchange = async () => {
        clearPreview();
        preview.src = url;
        if (!input.files.length) { status.textContent = ''; return; }
        input.disabled = restore.disabled = true;
        try {
          pending = await optimise(input.files[0]);
          objectURL = URL.createObjectURL(pending);
          preview.src = objectURL;
          save.disabled = false;
          status.textContent = 'Preview ready. Save to publish.';
        } catch (e) { status.textContent = e.message; }
        finally { input.disabled = restore.disabled = false; }
      };
      async function publish(reset) {
        if (reset && !confirm('Restore the original photo for '+label+'?')) return;
        input.disabled = save.disabled = restore.disabled = true;
        try {
          await api('/api/admin/storefront/images/'+slot, reset ? {method:'DELETE'} :
            {method:'PUT', headers:{'Content-Type':'image/webp'}, body:pending});
          clearPreview();
          input.value = '';
          preview.src = url+'?v='+Date.now();
          status.textContent = reset ? 'Original photo restored.' : 'Photo is live.';
        } catch (e) { status.textContent = e.message; }
        finally { input.disabled = restore.disabled = false; save.disabled = !pending; }
      }
      save.onclick = () => publish(false);
      restore.onclick = () => publish(true);
    }
  }
})();
