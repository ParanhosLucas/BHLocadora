const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function ligarLightbox() {
  const lb = document.getElementById('lightbox');
  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('zoom')) { lb.querySelector('img').src = e.target.src; lb.classList.add('on'); }
    else if (lb.contains(e.target)) lb.classList.remove('on');
  });
}
